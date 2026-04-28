import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import { parseScouting, parseApplications, parsePipeline, parseReportPath } from '../../src/lib/parsers/markdown'
import { parseScoreHistory } from '../../src/lib/parsers/tsv'
import { getMeta, setMeta } from './schema'

// Sources of truth on disk. Frontend must never sync from elsewhere.
const FILES = {
  applications: 'data/applications.md',
  scouting:     'data/scouting.md',
  pipeline:     'data/pipeline.md',
  scoreHistory: 'data/score-history.tsv',
  reportsDir:   'reports',
} as const

function statMtime(absPath: string): number | null {
  try { return Math.floor(fs.statSync(absPath).mtimeMs) } catch { return null }
}

function read(absPath: string): string | null {
  try { return fs.readFileSync(absPath, 'utf-8') } catch { return null }
}

function deriveTier(scoreNum: number | null, status: string): string {
  if (status === 'SKIP') return 'T4'
  if (scoreNum == null) return ''
  if (scoreNum >= 9.0)  return 'T1'
  if (scoreNum >= 7.0)  return 'T2'
  return 'T3'
}

function parseScoreNum(raw: string): number | null {
  const m = raw.match(/^([\d.]+)/)
  if (!m) return null
  const n = parseFloat(m[1])
  return Number.isFinite(n) ? n : null
}

// ─── Per-source sync ──────────────────────────────────────────────────────────

export function syncApplications(db: Database.Database, repoPath: string): { changed: boolean; rows: number } {
  const fullPath = path.join(repoPath, FILES.applications)
  const mtime = statMtime(fullPath)
  if (mtime == null) return { changed: false, rows: 0 }

  const cached = getMeta(db, 'applications_mtime')
  if (cached === String(mtime)) return { changed: false, rows: 0 }

  const text = read(fullPath)
  if (text == null) return { changed: false, rows: 0 }

  const rows = parseApplications(text)
  const insert = db.prepare(`
    INSERT INTO applications (num, date, company, role, score_raw, score_num, status, pdf, deadline, report, notes, tier)
    VALUES (@num, @date, @company, @role, @score_raw, @score_num, @status, @pdf, @deadline, @report, @notes, @tier)
  `)

  const tx = db.transaction((entries: typeof rows) => {
    db.exec('DELETE FROM applications')
    for (const r of entries) {
      const score_num = parseScoreNum(r.score)
      insert.run({
        num: r.num,
        date: r.date,
        company: r.company,
        role: r.role,
        score_raw: r.score,
        score_num,
        status: r.status,
        pdf: r.pdf ? 1 : 0,
        deadline: r.deadline,
        report: r.report,
        notes: r.notes,
        tier: deriveTier(score_num, r.status),
      })
    }
  })
  tx(rows)
  setMeta(db, 'applications_mtime', String(mtime))
  return { changed: true, rows: rows.length }
}

export function syncScouting(db: Database.Database, repoPath: string): { changed: boolean; rows: number } {
  const fullPath = path.join(repoPath, FILES.scouting)
  const mtime = statMtime(fullPath)
  if (mtime == null) return { changed: false, rows: 0 }

  const cached = getMeta(db, 'scouting_mtime')
  if (cached === String(mtime)) return { changed: false, rows: 0 }

  const text = read(fullPath)
  if (text == null) return { changed: false, rows: 0 }

  const rows = parseScouting(text)
  const insert = db.prepare(`
    INSERT INTO scouting (num, date, company, role, score_raw, score_num, tier, cfaf, report, deadline, promotion_hint, notes)
    VALUES (@num, @date, @company, @role, @score_raw, @score_num, @tier, @cfaf, @report, @deadline, @promotion_hint, @notes)
  `)

  const tx = db.transaction((entries: typeof rows) => {
    db.exec('DELETE FROM scouting')
    for (const r of entries) {
      insert.run({
        num: r.num,
        date: r.date,
        company: r.company,
        role: r.role,
        score_raw: r.score,
        score_num: parseScoreNum(r.score),
        tier: r.tier,
        cfaf: r.cfaf,
        report: r.report,
        deadline: r.deadline,
        promotion_hint: r.promotionHint,
        notes: r.notes,
      })
    }
  })
  tx(rows)
  setMeta(db, 'scouting_mtime', String(mtime))
  return { changed: true, rows: rows.length }
}

export function syncScoreHistory(db: Database.Database, repoPath: string): { changed: boolean; rows: number } {
  const fullPath = path.join(repoPath, FILES.scoreHistory)
  const mtime = statMtime(fullPath)
  if (mtime == null) return { changed: false, rows: 0 }

  const cached = getMeta(db, 'score_history_mtime')
  if (cached === String(mtime)) return { changed: false, rows: 0 }

  const text = read(fullPath)
  if (text == null) return { changed: false, rows: 0 }

  const rows = parseScoreHistory(text)
  const insert = db.prepare(`
    INSERT INTO score_history (
      date, archetype, skills_match, ease_of_entry, strategic_fit, current_fit,
      growth_mobility, optionality_exit, brand_value, sales_trap_risk, aspirational_fit,
      overall, best_cities, salary_adj_city, work_life_balance, best_fit_roles,
      mode, company, role, tier, source, location, employment_type, duration, salary_raw,
      url
    ) VALUES (
      @date, @archetype, @skills_match, @ease_of_entry, @strategic_fit, @current_fit,
      @growth_mobility, @optionality_exit, @brand_value, @sales_trap_risk, @aspirational_fit,
      @overall, @best_cities, @salary_adj_city, @work_life_balance, @best_fit_roles,
      @mode, @company, @role, @tier, @source, @location, @employment_type, @duration, @salary_raw,
      @url
    )
  `)

  const tx = db.transaction((entries: typeof rows) => {
    db.exec('DELETE FROM score_history')
    for (const r of entries) insert.run(r)
  })
  tx(rows)
  setMeta(db, 'score_history_mtime', String(mtime))
  return { changed: true, rows: rows.length }
}

export function syncPipeline(db: Database.Database, repoPath: string): { changed: boolean; rows: number } {
  const fullPath = path.join(repoPath, FILES.pipeline)
  const mtime = statMtime(fullPath)
  if (mtime == null) return { changed: false, rows: 0 }

  const cached = getMeta(db, 'pipeline_mtime')
  if (cached === String(mtime)) return { changed: false, rows: 0 }

  const text = read(fullPath)
  if (text == null) return { changed: false, rows: 0 }

  const rows = parsePipeline(text)
  const insert = db.prepare(`
    INSERT OR REPLACE INTO pipeline (url, added_date, is_stale)
    VALUES (?, ?, ?)
  `)

  const tx = db.transaction((entries: typeof rows) => {
    db.exec('DELETE FROM pipeline')
    for (const r of entries) {
      insert.run(r.url, r.addedDate ?? null, r.isStale ? 1 : 0)
    }
  })
  tx(rows)
  setMeta(db, 'pipeline_mtime', String(mtime))
  return { changed: true, rows: rows.length }
}

// Reports: walk the tree, store (path, mtime, derived metadata). The body is
// never cached — it's read on demand when the user opens a report.
export function syncReports(db: Database.Database, repoPath: string): { changed: boolean; rows: number } {
  const reportsDir = path.join(repoPath, FILES.reportsDir)
  if (!fs.existsSync(reportsDir)) {
    db.exec('DELETE FROM reports_index')
    return { changed: true, rows: 0 }
  }

  const seen: Array<{ path: string; mtime: number; company: string; role: string; tier: string; url: string }> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fp)
      else if (entry.name.endsWith('.md')) {
        const rel = path.relative(repoPath, fp)
        const parsed = parseReportPath(rel)
        if (!parsed) continue
        const mt = statMtime(fp)
        if (mt == null) continue
        // Pull URL from the report's `**URL:** ...` header line. Reports are
        // small; reading them at sync time is cheap and gives us the stable
        // join key against score_history.url.
        const url = extractUrl(read(fp) ?? '')
        seen.push({ path: rel, mtime: mt, company: parsed.company, role: parsed.role, tier: parsed.tier, url })
      }
    }
  }
  walk(reportsDir)

  // Compare against existing rows. Only touch what actually changed so
  // chokidar bursts (e.g. report regenerations) stay cheap.
  const existing = db.prepare(`SELECT path, mtime FROM reports_index`).all() as Array<{ path: string; mtime: number }>
  const existingMap = new Map(existing.map(r => [r.path, r.mtime]))

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO reports_index (path, company, role, tier, url, mtime)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const del = db.prepare(`DELETE FROM reports_index WHERE path = ?`)

  let touched = 0
  const tx = db.transaction(() => {
    for (const r of seen) {
      if (existingMap.get(r.path) !== r.mtime) {
        upsert.run(r.path, r.company, r.role, r.tier, r.url, r.mtime)
        touched++
      }
      existingMap.delete(r.path)
    }
    for (const stale of existingMap.keys()) {
      del.run(stale)
      touched++
    }
  })
  tx()

  return { changed: touched > 0, rows: seen.length }
}

// Backfill score_history.url for legacy rows that pre-date the column.
// The match is on `(company, role)` against reports_index — for rows where
// the score-history TSV was written before url was added but a matching
// report markdown does have a URL header. Cheap: runs once after each sync.
function backfillScoreHistoryUrls(db: Database.Database): void {
  db.exec(`
    UPDATE score_history AS s
    SET url = (
      SELECT r.url FROM reports_index r
      WHERE r.url <> ''
        AND LOWER(TRIM(r.company)) = LOWER(TRIM(s.company))
        AND (
          LOWER(TRIM(r.role)) = LOWER(TRIM(s.role))
          OR LOWER(TRIM(r.role)) LIKE LOWER(TRIM(s.role)) || '%'
          OR LOWER(TRIM(s.role)) LIKE LOWER(TRIM(r.role)) || '%'
        )
      LIMIT 1
    )
    WHERE s.url = ''
      AND EXISTS (
        SELECT 1 FROM reports_index r
        WHERE r.url <> ''
          AND LOWER(TRIM(r.company)) = LOWER(TRIM(s.company))
      )
  `)
}

// Pull "**URL:** https://..." out of a report's body. The colon may be
// followed by any whitespace; the URL ends at the first whitespace.
function extractUrl(text: string): string {
  const m = text.match(/^\*\*URL:\*\*\s*(\S+)/im)
  if (!m) return ''
  const u = m[1].trim()
  return /^https?:\/\//i.test(u) ? u : ''
}

// ─── Public entry points ──────────────────────────────────────────────────────

export function syncAll(db: Database.Database, repoPath: string, opts: { force?: boolean } = {}) {
  if (opts.force) {
    setMeta(db, 'applications_mtime', '')
    setMeta(db, 'scouting_mtime',     '')
    setMeta(db, 'score_history_mtime','')
    setMeta(db, 'pipeline_mtime',     '')
    db.exec('DELETE FROM reports_index')
  }

  const apps    = syncApplications(db, repoPath)
  const scout   = syncScouting(db, repoPath)
  const scores  = syncScoreHistory(db, repoPath)
  const pipe    = syncPipeline(db, repoPath)
  const reports = syncReports(db, repoPath)

  // Reports may have been synced after score_history; backfill URLs from
  // report markdown for any legacy score-history rows that lack one.
  if (scores.changed || reports.changed) backfillScoreHistoryUrls(db)

  return { applications: apps, scouting: scout, scoreHistory: scores, pipeline: pipe, reports }
}
