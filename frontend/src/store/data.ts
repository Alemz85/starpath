import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { ScoreEntry, ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile, AppStatus, ScoutingTier } from '@/types'

interface DataState {
  scoreHistory: ScoreEntry[]
  scouting:     ScoutingEntry[]
  applications: ApplicationEntry[]
  pipeline:     PipelineUrl[]
  reports:      ReportFile[]
  scansThisMonth: number   // unique scan-run dates in the current month
  liveness:     Record<string, 'active' | 'stale' | 'closed'>  // company|role key
  /** Tombstone set of company|role keys the user has marked Not Interested.
   *  Persisted to data/discarded.tsv. Views (Database, Scouting board)
   *  filter their rows through this set so discarded listings disappear
   *  without destroying the underlying score-history record. */
  discarded:    Set<string>
  loaded:       boolean
  loading:      boolean

  load:    () => Promise<void>
  refresh: (opts?: { resync?: boolean }) => Promise<void>

  // Application writeback. Both write to data/applications.md, then the
  // chokidar watcher resyncs the SQLite cache and refresh() is called to
  // mirror disk into the renderer.
  promoteToApplication: (args: {
    company: string
    role: string
    overall: number
    tier: string
    reportPath?: string
  }) => Promise<void>
  setApplicationStatus: (company: string, role: string, status: AppStatus) => Promise<void>
  /** Tombstone-discard for "Not interested". Appends to data/discarded.tsv
   *  so the listing disappears from Database/Scouting views. If the entry
   *  also exists in applications.md (already applied), its status is
   *  flipped to SKIP — preserves the application history. Score-history
   *  rows stay on disk so positioning/peer-rank analytics remain intact. */
  discardListing: (company: string, role: string) => Promise<void>
}

export const useDataStore = create<DataState>((set) => ({
  scoreHistory: [],
  scouting:     [],
  applications: [],
  pipeline:     [],
  reports:      [],
  scansThisMonth: 0,
  liveness:     {},
  discarded:    new Set<string>(),
  loaded:       false,
  loading:      false,

  load: async () => {
    const state = useDataStore.getState()
    if (state.loaded || state.loading) return
    set({ loading: true })
    await loadAll()
    set({ loading: false, loaded: true })
  },

  // Coalesces overlapping calls — rapid clicks of the Settings refresh button
  // (and chokidar bursts that arrive while we're already mid-refresh) all
  // return the same in-flight promise. Pass `{ resync: true }` to force a
  // full DB rebuild from disk; default re-reads what's already in the DB
  // (the watcher keeps it current).
  refresh: async (opts) => {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = (async () => {
      set({ loading: true })
      try {
        if (opts?.resync) await ipc.db.resync()
        await loadAll()
      } finally {
        set({ loading: false })
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  },

  promoteToApplication: async ({ company, role, overall, tier, reportPath }) => {
    const path = 'data/applications.md'
    const raw = await ipc.readFile(path) ?? ''
    const next = upsertApplicationRow(raw, {
      company, role, overall, tier, reportPath,
    })
    // Only touch disk when something actually changed (the listing was new,
    // or its score/report moved). When it's already tracked and unchanged we
    // still refresh so a stale in-memory store re-syncs — the Apply affordance
    // then flips to the status dropdown rather than offering a second Apply.
    if (next !== raw) await ipc.writeFile(path, next)
    await useDataStore.getState().refresh()
  },

  setApplicationStatus: async (company, role, status) => {
    const path = 'data/applications.md'
    const raw = await ipc.readFile(path) ?? ''
    const next = updateApplicationStatus(raw, company, role, status)
    if (next === raw) return  // no matching row
    await ipc.writeFile(path, next)
    await useDataStore.getState().refresh()
  },

  discardListing: async (company, role) => {
    const tombstonePath = 'data/discarded.tsv'
    const key = livenessKey(company, role)

    // 1. Append to the tombstone file. Header + one row per discard so
    //    the file is human-readable / hand-editable for undo.
    const existing = await ipc.readFile(tombstonePath) ?? ''
    const today = new Date().toISOString().slice(0, 10)
    const header = 'company\trole\tdate'
    const alreadyTombstoned = existing
      .split('\n')
      .slice(1)
      .some(line => {
        const [c, r] = line.split('\t')
        if (!c || !r) return false
        return livenessKey(c, r) === key
      })
    if (!alreadyTombstoned) {
      const body = existing.trim()
        ? existing.trimEnd() + '\n' + `${company}\t${role}\t${today}` + '\n'
        : header + '\n' + `${company}\t${role}\t${today}` + '\n'
      await ipc.writeFile(tombstonePath, body)
    }

    // 2. If the entry exists in applications.md (already applied), flip
    //    its status to SKIP — keeps the application record for history
    //    while signaling it's no longer active. If it doesn't exist
    //    there, updateApplicationStatus is a no-op.
    const appsPath = 'data/applications.md'
    const appsRaw = await ipc.readFile(appsPath) ?? ''
    const appsNext = updateApplicationStatus(appsRaw, company, role, 'SKIP' as AppStatus)
    if (appsNext !== appsRaw) await ipc.writeFile(appsPath, appsNext)

    // 3. Optimistically update the in-memory tombstone set so the UI
    //    hides the row immediately (the chokidar watcher will pick up
    //    discarded.tsv and refresh() will re-derive on the next round).
    set(state => {
      const next = new Set(state.discarded)
      next.add(key)
      return { discarded: next }
    })
    await useDataStore.getState().refresh()
  },
}))

let refreshInFlight: Promise<void> | null = null

// ─── Loading ──────────────────────────────────────────────────────────────────

async function loadAll() {
  const [apps, scouting, scoreRows, pipelineRows, reportRows, scanHistRaw, discardedRaw] = await Promise.all([
    ipc.db.applications(),
    ipc.db.scouting(),
    ipc.db.scoreHistory(),
    ipc.db.pipeline(),
    ipc.db.reports(),
    ipc.readFile('data/scan-history.tsv'),
    ipc.readFile('data/discarded.tsv'),
  ])

  useDataStore.setState({
    applications: (apps         ?? []).map(toApplicationEntry),
    scouting:     (scouting     ?? []).map(toScoutingEntry),
    scoreHistory: (scoreRows    ?? []).map(toScoreEntry),
    pipeline:     (pipelineRows ?? []).map(toPipelineUrl),
    reports:      (reportRows   ?? []).map(toReportFile),
    scansThisMonth: countScansThisMonth(scanHistRaw),
    liveness:     deriveLiveness(scanHistRaw),
    discarded:    parseDiscarded(discardedRaw),
  })
}

// data/discarded.tsv is a flat tombstone log written by discardListing().
// Header row + `company\trole\tdate` per row; we collapse to a Set of
// livenessKey(company, role) so Database/Scouting views can do O(1) tests.
function parseDiscarded(raw: string | null): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  const lines = raw.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t')
    const company = (cells[0] ?? '').trim()
    const role    = (cells[1] ?? '').trim()
    if (!company || !role) continue
    out.add(livenessKey(company, role))
  }
  return out
}

// ─── Liveness ─────────────────────────────────────────────────────────────────
//
// Score-history entries don't have URLs but they do have company+role and a
// `source` (often the URL). scan-history.tsv has the canonical URL → date list.
// We can't perfectly join them, but we can map company+role → most-recent
// scan_dates entry and derive liveness from the recency.
//
// active: seen <14d ago
// stale:  seen 14–90d ago
// closed: seen >90d ago, or never-mapped
function deriveLiveness(raw: string | null): Record<string, 'active' | 'stale' | 'closed'> {
  if (!raw) return {}
  const lines = raw.split('\n')
  if (lines.length < 2) return {}
  const header = lines[0].split('\t')
  const companyIdx = header.indexOf('company')
  const titleIdx   = header.indexOf('title')
  const datesIdx   = header.indexOf('scan_dates')
  if (companyIdx < 0 || titleIdx < 0 || datesIdx < 0) return {}

  const today = new Date()
  const dayMs = 1000 * 60 * 60 * 24
  const out: Record<string, 'active' | 'stale' | 'closed'> = {}

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t')
    if (row.length < 3) continue
    const company = (row[companyIdx] ?? '').trim()
    const title   = (row[titleIdx] ?? '').trim()
    const dates   = (row[datesIdx] ?? '').split('|').filter(Boolean)
    if (!company || !title || dates.length === 0) continue

    const last = dates[dates.length - 1]
    const lastDate = new Date(last)
    if (Number.isNaN(lastDate.getTime())) continue
    const daysAgo = (today.getTime() - lastDate.getTime()) / dayMs

    const liveness: 'active' | 'stale' | 'closed' =
      daysAgo < 14  ? 'active' :
      daysAgo < 90  ? 'stale' : 'closed'

    const key = livenessKey(company, title)
    // Keep the freshest verdict if the same company+role appears in multiple rows.
    const cur = out[key]
    if (!cur || rank(liveness) > rank(cur)) out[key] = liveness
  }
  return out
}

function rank(l: 'active' | 'stale' | 'closed'): number {
  return l === 'active' ? 2 : l === 'stale' ? 1 : 0
}

export function livenessKey(company: string, role: string): string {
  return `${company.trim().toLowerCase()}|${role.trim().toLowerCase()}`
}

// Count unique scan-run *dates* in the current calendar month. Each row of
// scan-history.tsv has a `scan_dates` column (pipe-separated YYYY-MM-DD list);
// many rows can share a scan date because a single scan adds many URLs at once,
// so we union dates across rows and dedupe before counting.
function countScansThisMonth(raw: string | null): number {
  if (!raw) return 0
  const lines = raw.split('\n')
  if (lines.length < 2) return 0
  const header = lines[0].split('\t')
  const datesIdx = header.indexOf('scan_dates')
  if (datesIdx === -1) return 0

  const monthPrefix = new Date().toISOString().slice(0, 7)  // "YYYY-MM"
  const seen = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t')
    const cell = row[datesIdx]
    if (!cell) continue
    for (const d of cell.split('|')) {
      if (d.startsWith(monthPrefix)) seen.add(d)
    }
  }
  return seen.size
}

// ─── Live reload ──────────────────────────────────────────────────────────────
//
// When chokidar detects a file change in the repo and the sync layer mutates
// the DB, main broadcasts `db:changed`. We re-pull silently so the UI mirrors
// disk without the user clicking refresh.

if (typeof window !== 'undefined') {
  // Defer subscription until window.electron is available (preload runs first
  // in production but not in plain-browser dev contexts).
  const subscribe = () => {
    if (!window.electron?.onDbChanged) return false
    ipc.db.onChanged(() => { void loadAll() })
    return true
  }
  if (!subscribe()) {
    // Retry once after the next tick in case preload hasn't bridged yet.
    setTimeout(subscribe, 0)
  }
}

// ─── DB row → typed entity ────────────────────────────────────────────────────

import type {
  DbApplicationRow, DbScoutingRow, DbScoreHistoryRow, DbPipelineRow, DbReportRow,
} from '@/lib/ipc'

const KNOWN_STATUSES: AppStatus[] = ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP']

function parseCitiesJson(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : []
  } catch { return [] }
}

function toApplicationEntry(row: DbApplicationRow): ApplicationEntry {
  const status = (KNOWN_STATUSES as string[]).includes(row.status)
    ? row.status as AppStatus
    : 'Evaluated'
  return {
    num:      row.num,
    date:     row.date,
    company:  row.company,
    role:     row.role,
    score:    row.score_raw,
    status,
    pdf:      Boolean(row.pdf),
    deadline: row.deadline,
    report:   row.report,
    notes:    row.notes,
    entityId: row.entity_id ?? '',
    cities:   parseCitiesJson(row.cities),
  }
}

function toScoutingEntry(row: DbScoutingRow): ScoutingEntry {
  // T2-high collapses to T2 at the ingest boundary so the UI never sees it.
  // Backend mode files / scouting.md still use T2-high in their scoring math —
  // this is a display-layer normalization only.
  const tierMap: Record<string, ScoutingTier> = { 'T1':'T1','T2-high':'T2','T2':'T2','T3':'T3','T4':'T4' }
  return {
    num:           row.num,
    date:          row.date,
    company:       row.company,
    role:          row.role,
    score:         row.score_raw,
    tier:          tierMap[row.tier] ?? 'T4',
    cfaf:          row.cfaf,
    report:        row.report,
    deadline:      row.deadline,
    promotionHint: row.promotion_hint,
    notes:         row.notes,
    entityId:      row.entity_id ?? '',
    cities:        parseCitiesJson(row.cities),
  }
}

function toScoreEntry(row: DbScoreHistoryRow): ScoreEntry {
  return {
    date:              row.date,
    archetype:         row.archetype,
    skills_match:      row.skills_match,
    ease_of_entry:     row.ease_of_entry,
    strategic_fit:     row.strategic_fit,
    current_fit:       row.current_fit,
    growth_mobility:   row.growth_mobility,
    optionality_exit:  row.optionality_exit,
    brand_value:       row.brand_value,
    sales_trap_risk:   row.sales_trap_risk,
    aspirational_fit:  row.aspirational_fit,
    overall:           row.overall,
    best_cities:       row.best_cities,
    salary_adj_city:   row.salary_adj_city,
    work_life_balance: row.work_life_balance,
    best_fit_roles:    row.best_fit_roles,
    mode:              (row.mode === 'oferta' ? 'oferta' : 'scouting'),
    company:           row.company,
    role:              row.role,
    tier:              row.tier === 'T2-high' ? 'T2' : row.tier,
    source:            row.source,
    location:          row.location,
    employment_type:   row.employment_type,
    duration:          row.duration,
    salary_raw:        row.salary_raw,
    url:               row.url ?? '',
  }
}

function toPipelineUrl(row: DbPipelineRow): PipelineUrl {
  return {
    url:       row.url,
    addedDate: row.added_date ?? undefined,
    isStale:   Boolean(row.is_stale),
  }
}

function toReportFile(row: DbReportRow): ReportFile {
  return {
    path:    row.path,
    company: row.company,
    role:    row.role,
    tier:    row.tier === 'T2-high' ? 'T2' : row.tier,
    url:     row.url ?? '',
  }
}

// ─── applications.md helpers ──────────────────────────────────────────────────
//
// applications.md is a thin markdown table the user can also hand-edit:
//
//   | # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
//   |---|------|---------|------|-------|--------|-----|----------|--------|-------|
//   | 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Evaluated | ❌ | n/d | [#1](…) | … |
//
// applications.md holds at most one row per (company, role) — see CLAUDE.md
// "Pipeline Integrity". upsertApplicationRow refreshes an existing listing's
// Score / Report in place (or appends when it's new); updateApplicationStatus
// rewrites the Status cell of matching rows. Neither touches unrelated cells.

function isTableSeparator(line: string): boolean {
  return /^\|\s*-+/.test(line)
}

function isTableDataRow(line: string): boolean {
  return line.startsWith('|') && !isTableSeparator(line) && !/^\|\s*#\s*\|/i.test(line)
}

function splitRow(line: string): string[] {
  // Strip the leading and trailing pipe, split, trim cells.
  return line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}

function joinRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

// Index of the first data row matching (company, role), case-insensitive —
// the single identity key for a listing across applications.md. Shared by the
// upsert (skip / refresh) and consistent with ApplyAction's findApplication.
// Returns -1 when not present.
function findApplicationRowIndex(lines: string[], company: string, role: string): number {
  const c = company.trim().toLowerCase()
  const r = role.trim().toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDataRow(lines[i])) continue
    const cells = splitRow(lines[i])
    if (cells.length < 6) continue
    if (cells[2].toLowerCase() === c && cells[3].toLowerCase() === r) return i
  }
  return -1
}

function tierFolder(tier: string): string {
  if (tier === 'T1') return 'tier-1'
  if (tier === 'T2' || tier === 'T2-high') return 'tier-2'
  if (tier === 'T3') return 'tier-3'
  return 'tier-4'
}

export function upsertApplicationRow(raw: string, args: {
  company: string
  role: string
  overall: number
  tier: string
  reportPath?: string
}): string {
  const lines = raw.split('\n')

  // Upsert on (company, role): applications.md holds at most one row per
  // listing. If it's already tracked, refresh the Score in place (and the
  // Report link when a fresh path is given) — preserving Status / Date / PDF /
  // Deadline / Notes — instead of appending a duplicate. The frontend Apply
  // path used to append blindly, which is the documented source of same-listing
  // dupes (CLAUDE.md "Pipeline Integrity"); `node scripts/dedup-tracker.mjs`
  // cleans up any that already slipped in.
  const existingIdx = findApplicationRowIndex(lines, args.company, args.role)
  if (existingIdx !== -1) {
    const cells = splitRow(lines[existingIdx])
    if (args.overall > 0 && cells.length > 4) cells[4] = `${args.overall.toFixed(1)}/10`
    if (args.reportPath && cells.length > 8) cells[8] = `[#${cells[0] || ''}](${args.reportPath})`
    lines[existingIdx] = joinRow(cells)
    return lines.join('\n')
  }

  // Find the highest existing # so we can increment.
  let maxNum = 0
  for (const line of lines) {
    if (!isTableDataRow(line)) continue
    const cells = splitRow(line)
    const n = parseInt(cells[0] ?? '', 10)
    if (Number.isFinite(n) && n > maxNum) maxNum = n
  }

  const num = maxNum + 1
  const today = new Date().toISOString().slice(0, 10)
  const score = args.overall > 0 ? `${args.overall.toFixed(1)}/10` : '—'
  const reportLink = args.reportPath
    ? `[#${num}](${args.reportPath})`
    : `[#${num}](reports/${tierFolder(args.tier)}/${args.company} - ${args.role}.md)`
  const newRow = joinRow([
    String(num),
    today,
    args.company,
    args.role,
    score,
    'Evaluated',
    '❌',
    'n/d',
    reportLink,
    '',
  ])

  // Find last existing data row index, otherwise append after the separator.
  let insertAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTableDataRow(lines[i])) { insertAt = i; break }
  }
  if (insertAt === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (isTableSeparator(lines[i])) { insertAt = i; break }
    }
  }

  if (insertAt === -1) {
    // No table at all — append at end.
    return raw.trimEnd() + '\n' + newRow + '\n'
  }
  const next = [...lines]
  next.splice(insertAt + 1, 0, newRow)
  return next.join('\n')
}

export function updateApplicationStatus(
  raw: string,
  company: string,
  role: string,
  status: AppStatus,
): string {
  const lines = raw.split('\n')
  const c = company.trim().toLowerCase()
  const r = role.trim().toLowerCase()
  let mutated = false
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDataRow(lines[i])) continue
    const cells = splitRow(lines[i])
    if (cells.length < 6) continue
    if (cells[2].toLowerCase() === c && cells[3].toLowerCase() === r) {
      cells[5] = status
      lines[i] = joinRow(cells)
      mutated = true
    }
  }
  return mutated ? lines.join('\n') : raw
}
