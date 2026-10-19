import path from 'path'
import fs from 'fs'
import BetterSqlite3 from 'better-sqlite3'
import chokidar, { type FSWatcher } from 'chokidar'
import { initSchema } from './schema'
import { syncAll, syncApplications, syncScouting, syncScoreHistory, syncPipeline, syncReports } from './sync'

type Database = BetterSqlite3.Database

let db: Database | null = null
let dbSlug: string | null = null
let watcher: FSWatcher | null = null
let watchedRepoPath: string | null = null

// One derived cache per search profile — a profile switch swaps what the
// canonical data/reports paths contain wholesale, so mixing rows across
// profiles in a single file would corrupt both. `default` is the slug for
// pre-migration repos (no profiles/ dir).
function dbFilePath(userDataDir: string, slug: string): string {
  return path.join(userDataDir, `cache-${slug}.db`)
}

export function openDb(userDataDir: string, slug = 'default'): Database {
  if (db && dbSlug === slug) return db
  // Profile changed under us (switch, or an out-of-band CLI switch noticed
  // on the next query) — release the old cache and its watcher; the caller
  // restarts the watcher against the re-pointed symlinks.
  if (db) closeDb()
  const file = dbFilePath(userDataDir, slug)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new BetterSqlite3(file)
  dbSlug = slug
  initSchema(db)
  return db
}

export function closeDb(): void {
  watcher?.close()
  watcher = null
  watchedRepoPath = null
  db?.close()
  db = null
  dbSlug = null
}

// Await-able teardown for the app-quit path. chokidar's close() returns a
// Promise, and on macOS the underlying native fsevents handle MUST be fully
// released before the Node/Electron runtime tears down — otherwise
// fse_instance_destroy aborts (SIGABRT → "quit unexpectedly") while
// napi_release_threadsafe_function runs during node::Stop. closeDb() above
// fires-and-forgets the watcher close, which is fine where the process keeps
// running (rebuild / window-close on macOS); this one is for real exit.
export async function shutdownDb(): Promise<void> {
  const w = watcher
  watcher = null
  watchedRepoPath = null
  try { await w?.close() } catch { /* already gone */ }
  try { db?.close() } catch { /* already gone */ }
  db = null
  dbSlug = null
}

// Drop everything (including the file) and reopen. Use after a hard reset.
export function rebuildDb(userDataDir: string, slug = 'default'): Database {
  closeDb()
  const file = dbFilePath(userDataDir, slug)
  try { fs.unlinkSync(file) } catch { /* ok */ }
  return openDb(userDataDir, slug)
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

export interface WatcherCallbacks {
  onChanged: (sources: string[]) => void
}

const SOURCE_FILES = [
  'data/applications.md',
  'data/scouting.md',
  'data/pipeline.md',
  'data/score-history.tsv',
] as const

export function startWatcher(repoPath: string, cb: WatcherCallbacks): void {
  if (watcher && watchedRepoPath === repoPath) return
  watcher?.close()
  watchedRepoPath = repoPath

  const reportsGlob = path.join(repoPath, 'reports/**/*.md')
  const dataPaths = SOURCE_FILES.map(f => path.join(repoPath, f))

  watcher = chokidar.watch([...dataPaths, reportsGlob], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  })

  // Coalesce bursts: chokidar may emit multiple events for one logical write
  // (Claude Code rewriting a file, a merge script touching multiple sources).
  // Buffer for 200ms, dedupe by source, then sync once per affected source.
  let pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null

  const schedule = (filePath: string) => {
    pending.add(filePath)
    if (timer) return
    timer = setTimeout(() => {
      const batch = pending
      pending = new Set()
      timer = null
      processBatch(repoPath, batch, cb)
    }, 200)
  }

  watcher.on('add',    schedule)
  watcher.on('change', schedule)
  watcher.on('unlink', schedule)
}

// Force a fresh watch even for the same repo path. Needed after a profile
// switch: the canonical data/reports paths are unchanged strings, but they
// are symlinks whose targets just moved — chokidar resolved the old targets
// when the watch started, so only a restart picks up writes to the new
// profile's files.
export function restartWatcher(repoPath: string, cb: WatcherCallbacks): void {
  watcher?.close()
  watcher = null
  watchedRepoPath = null
  startWatcher(repoPath, cb)
}

function processBatch(repoPath: string, files: Set<string>, cb: WatcherCallbacks): void {
  if (!db) return
  const changed: string[] = []

  const has = (suffix: string) => Array.from(files).some(f => f.endsWith(suffix))
  const hasReport = Array.from(files).some(f => f.includes(`${path.sep}reports${path.sep}`))

  try {
    if (has('applications.md')   && syncApplications(db, repoPath).changed)  changed.push('applications')
    if (has('scouting.md')       && syncScouting(db, repoPath).changed)      changed.push('scouting')
    if (has('pipeline.md')       && syncPipeline(db, repoPath).changed)      changed.push('pipeline')
    if (has('score-history.tsv') && syncScoreHistory(db, repoPath).changed)  changed.push('score_history')
    if (hasReport                && syncReports(db, repoPath).changed)       changed.push('reports')
  } catch (e) {
    console.error('[db] sync error:', e)
    return
  }

  if (changed.length) cb.onChanged(changed)
}

// ─── Query helpers ────────────────────────────────────────────────────────────

interface AppFilters { tier?: string; status?: string; search?: string }
interface ScoutingFilters { tier?: string; search?: string }
interface ScoreFilters { since?: string; until?: string; company?: string; tier?: string }
interface ReportFilters { tier?: string; search?: string }

function need(): Database {
  if (!db) throw new Error('db not opened')
  return db
}

export function queryApplications(f: AppFilters = {}) {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.tier)   { where.push('tier = @tier');     params.tier = f.tier }
  if (f.status) { where.push('status = @status'); params.status = f.status }
  if (f.search) {
    where.push('(company LIKE @q OR role LIKE @q OR notes LIKE @q)')
    params.q = `%${f.search}%`
  }
  const sql = `SELECT * FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY num`
  return need().prepare(sql).all(params)
}

export function queryScouting(f: ScoutingFilters = {}) {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.tier) { where.push('tier = @tier'); params.tier = f.tier }
  if (f.search) {
    where.push('(company LIKE @q OR role LIKE @q OR notes LIKE @q)')
    params.q = `%${f.search}%`
  }
  const sql = `SELECT * FROM scouting ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY num`
  return need().prepare(sql).all(params)
}

export function queryScoreHistory(f: ScoreFilters = {}) {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.since)   { where.push('date >= @since');   params.since = f.since }
  if (f.until)   { where.push('date <= @until');   params.until = f.until }
  if (f.company) { where.push('company = @company'); params.company = f.company }
  if (f.tier)    { where.push('tier = @tier');     params.tier = f.tier }
  const sql = `SELECT * FROM score_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date`
  return need().prepare(sql).all(params)
}

export function queryPipeline() {
  return need().prepare(`SELECT * FROM pipeline ORDER BY rowid`).all()
}

// Reports listing joined with the latest matching score_history row, so the
// frontend can render the tier/verdict badge and the Want · Ease pair without
// a second pass. Blocked rows carry NULL want/ease/priority — the renderer
// shows their eligibility reason instead (docs/scoring-v2.md §1.3).
export function queryReports(f: ReportFilters = {}) {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (f.tier) { where.push('r.tier = @tier'); params.tier = f.tier }
  if (f.search) {
    where.push('(r.company LIKE @q OR r.role LIKE @q)')
    params.q = `%${f.search}%`
  }
  // Join strategy:
  //  1. Primary: match on `url` — the listing URL is the only stable join
  //     key that survives filename sanitization and multi-city
  //     disambiguation. The latest evaluation per URL wins (SQLite returns
  //     the bare columns from the MAX(date) row).
  //  2. Fallback: for reports without a URL header, fall back to
  //     (company, role) matching — exact → prefix → "same company, highest
  //     priority" so the badge isn't blank for orphan reports.
  // Most rows hit (1); (2) only fires when reports_index.url is empty.
  const sql = `
    WITH score_by_url AS (
      SELECT url, MAX(date) AS d, want, ease, priority, verdict, eligibility, eligibility_flags
      FROM score_history
      WHERE url <> ''
      GROUP BY url
    ),
    fallback AS (
      SELECT
        r.path,
        s.want,
        s.ease,
        s.priority,
        s.verdict,
        s.eligibility,
        s.eligibility_flags,
        ROW_NUMBER() OVER (
          PARTITION BY r.path
          ORDER BY
            CASE
              WHEN LOWER(TRIM(s.role))    = LOWER(TRIM(r.role))    THEN 0
              WHEN LOWER(TRIM(s.role)) LIKE LOWER(TRIM(r.role)) || '%' THEN 1
              WHEN LOWER(TRIM(r.role)) LIKE LOWER(TRIM(s.role)) || '%' THEN 1
              ELSE 2
            END,
            s.priority DESC NULLS LAST,
            s.date DESC
        ) AS rn
      FROM reports_index r
      LEFT JOIN score_history s
        ON LOWER(TRIM(s.company)) = LOWER(TRIM(r.company))
      WHERE r.url = ''
    )
    SELECT
      r.path     AS path,
      r.company  AS company,
      r.role     AS role,
      r.tier     AS tier,
      r.url      AS url,
      r.mtime    AS mtime,
      CASE WHEN u.url IS NOT NULL THEN u.want              ELSE f.want              END AS want,
      CASE WHEN u.url IS NOT NULL THEN u.ease              ELSE f.ease              END AS ease,
      CASE WHEN u.url IS NOT NULL THEN u.priority          ELSE f.priority          END AS priority,
      CASE WHEN u.url IS NOT NULL THEN u.verdict           ELSE f.verdict           END AS verdict,
      CASE WHEN u.url IS NOT NULL THEN u.eligibility       ELSE f.eligibility       END AS eligibility,
      CASE WHEN u.url IS NOT NULL THEN u.eligibility_flags ELSE f.eligibility_flags END AS eligibility_flags
    FROM reports_index r
    LEFT JOIN score_by_url u ON r.url <> '' AND u.url = r.url
    LEFT JOIN fallback    f ON f.path = r.path AND f.rn = 1
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY r.path
    ORDER BY r.tier, r.company
  `
  return need().prepare(sql).all(params)
}

// applications joined with their latest evaluation (from score_history).
export function queryApplicationsWithScores() {
  return need().prepare(`
    SELECT
      a.*,
      s.want        AS sh_want,
      s.ease        AS sh_ease,
      s.priority    AS priority,
      s.verdict     AS verdict,
      s.eligibility AS eligibility,
      s.archetype   AS archetype,
      MAX(s.date)   AS sh_date
    FROM applications a
    LEFT JOIN score_history s
      ON s.company = a.company AND s.role = a.role
    GROUP BY a.num
    ORDER BY a.num
  `).all()
}

// Pre-aggregated trends. Buckets by full date and by archetype, plus tier,
// verdict and eligibility histograms. Score averages are over SCORED rows
// only — blocked (red) rows have no Want/Ease and are excluded from every
// score average, but they are counted in the eligibility distribution
// (docs/scoring-v2.md §9).
const TREND_COLUMNS = `
      COUNT(*)                                                    AS count,
      SUM(CASE WHEN eligibility = 'red' THEN 1 ELSE 0 END)        AS blocked,
      AVG(CASE WHEN eligibility = 'red' THEN NULL ELSE want END)  AS avg_want,
      AVG(CASE WHEN eligibility = 'red' THEN NULL ELSE ease END)  AS avg_ease,
      AVG(CASE WHEN eligibility = 'red' THEN NULL ELSE priority END) AS avg_priority,
      AVG(skills_match)      AS avg_skills_match,
      AVG(brand_value)       AS avg_brand_value,
      AVG(growth_mobility)   AS avg_growth,
      AVG(work_life_balance) AS avg_wlb`

export function queryTrends() {
  const byDate = need().prepare(`
    SELECT substr(date, 1, 10) AS label, ${TREND_COLUMNS}
    FROM score_history
    WHERE date != ''
    GROUP BY label
    ORDER BY label
  `).all()

  const byArchetype = need().prepare(`
    SELECT archetype AS label, ${TREND_COLUMNS}
    FROM score_history
    WHERE archetype != ''
    GROUP BY archetype
    ORDER BY count DESC
  `).all()

  const tierDistribution = need().prepare(`
    SELECT tier, COUNT(*) AS count
    FROM score_history
    WHERE tier != ''
    GROUP BY tier
  `).all()

  const verdictDistribution = need().prepare(`
    SELECT verdict, COUNT(*) AS count
    FROM score_history
    WHERE verdict IS NOT NULL AND verdict != ''
    GROUP BY verdict
  `).all()

  const eligibilityDistribution = need().prepare(`
    SELECT eligibility, COUNT(*) AS count
    FROM score_history
    WHERE eligibility IS NOT NULL AND eligibility != ''
    GROUP BY eligibility
  `).all()

  return { byDate, byArchetype, tierDistribution, verdictDistribution, eligibilityDistribution }
}

export function resync(repoPath: string) {
  return syncAll(need(), repoPath, { force: true })
}

export function ensureSynced(repoPath: string) {
  return syncAll(need(), repoPath)
}
