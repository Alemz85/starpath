import path from 'path'
import fs from 'fs'
import BetterSqlite3 from 'better-sqlite3'
import chokidar, { type FSWatcher } from 'chokidar'
import { initSchema } from './schema'
import { syncAll, syncApplications, syncScouting, syncScoreHistory, syncPipeline, syncReports } from './sync'

type Database = BetterSqlite3.Database

let db: Database | null = null
let watcher: FSWatcher | null = null
let watchedRepoPath: string | null = null

function dbFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'cache.db')
}

export function openDb(userDataDir: string): Database {
  if (db) return db
  const file = dbFilePath(userDataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new BetterSqlite3(file)
  initSchema(db)
  return db
}

export function closeDb(): void {
  watcher?.close()
  watcher = null
  watchedRepoPath = null
  db?.close()
  db = null
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
}

// Drop everything (including the file) and reopen. Use after a hard reset.
export function rebuildDb(userDataDir: string): Database {
  closeDb()
  const file = dbFilePath(userDataDir)
  try { fs.unlinkSync(file) } catch { /* ok */ }
  return openDb(userDataDir)
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
// frontend can render the tier badge and overall score without a second pass.
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
  //     disambiguation. Reports written under the current pipeline always
  //     have a URL; the sync extracts it from the markdown body.
  //  2. Fallback: for legacy reports that pre-date URL tracking, fall back
  //     to (company, role) matching — exact → prefix → "same company,
  //     highest overall" so the badge isn't blank for the historic ~35
  //     orphan reports.
  // Most rows hit (1); (2) only fires when reports_index.url is empty.
  const sql = `
    WITH score_by_url AS (
      SELECT url, overall, current_fit, aspirational_fit
      FROM score_history
      WHERE url <> ''
      GROUP BY url
    ),
    fallback AS (
      SELECT
        r.path,
        s.overall,
        s.current_fit,
        s.aspirational_fit,
        ROW_NUMBER() OVER (
          PARTITION BY r.path
          ORDER BY
            CASE
              WHEN LOWER(TRIM(s.role))    = LOWER(TRIM(r.role))    THEN 0
              WHEN LOWER(TRIM(s.role)) LIKE LOWER(TRIM(r.role)) || '%' THEN 1
              WHEN LOWER(TRIM(r.role)) LIKE LOWER(TRIM(s.role)) || '%' THEN 1
              ELSE 2
            END,
            s.overall DESC
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
      COALESCE(u.overall,          f.overall)          AS overall,
      COALESCE(u.current_fit,      f.current_fit)      AS current_fit,
      COALESCE(u.aspirational_fit, f.aspirational_fit) AS aspirational_fit
    FROM reports_index r
    LEFT JOIN score_by_url u ON r.url <> '' AND u.url = r.url
    LEFT JOIN fallback    f ON f.path = r.path AND f.rn = 1
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY r.path
    ORDER BY r.tier, r.company
  `
  return need().prepare(sql).all(params)
}

// applications joined with their evaluation score (from score_history).
export function queryApplicationsWithScores() {
  return need().prepare(`
    SELECT
      a.*,
      s.overall AS overall,
      s.current_fit AS current_fit,
      s.aspirational_fit AS aspirational_fit,
      s.archetype AS archetype
    FROM applications a
    LEFT JOIN score_history s
      ON s.company = a.company AND s.role = a.role
    GROUP BY a.num
    ORDER BY a.num
  `).all()
}

// Pre-aggregated trends for TrendsView. Buckets by full date (matches the
// pre-DB grouping behaviour) and by archetype, plus a tier histogram.
// Bucketing by month is left to the renderer if needed — collapsing in JS
// over a few dozen day rows is essentially free.
export function queryTrends() {
  const byDate = need().prepare(`
    SELECT
      substr(date, 1, 10) AS label,
      COUNT(*)            AS count,
      AVG(overall)        AS avg_overall,
      AVG(current_fit)    AS avg_current_fit,
      AVG(aspirational_fit) AS avg_aspirational_fit,
      AVG(skills_match)   AS avg_skills_match,
      AVG(brand_value)    AS avg_brand_value,
      AVG(growth_mobility) AS avg_growth,
      AVG(work_life_balance) AS avg_wlb
    FROM score_history
    WHERE date != ''
    GROUP BY label
    ORDER BY label
  `).all()

  const byArchetype = need().prepare(`
    SELECT
      archetype          AS label,
      COUNT(*)           AS count,
      AVG(overall)       AS avg_overall,
      AVG(current_fit)   AS avg_current_fit,
      AVG(aspirational_fit) AS avg_aspirational_fit,
      AVG(skills_match)  AS avg_skills_match,
      AVG(brand_value)   AS avg_brand_value,
      AVG(growth_mobility) AS avg_growth,
      AVG(work_life_balance) AS avg_wlb
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

  return { byDate, byArchetype, tierDistribution }
}

export function resync(repoPath: string) {
  return syncAll(need(), repoPath, { force: true })
}

export function ensureSynced(repoPath: string) {
  return syncAll(need(), repoPath)
}
