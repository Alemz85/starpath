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
}

export const useDataStore = create<DataState>((set) => ({
  scoreHistory: [],
  scouting:     [],
  applications: [],
  pipeline:     [],
  reports:      [],
  scansThisMonth: 0,
  liveness:     {},
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
    const next = appendApplicationRow(raw, {
      company, role, overall, tier, reportPath,
    })
    await ipc.writeFile(path, next)
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
}))

let refreshInFlight: Promise<void> | null = null

// ─── Loading ──────────────────────────────────────────────────────────────────

async function loadAll() {
  const [apps, scouting, scoreRows, pipelineRows, reportRows, scanHistRaw] = await Promise.all([
    ipc.db.applications(),
    ipc.db.scouting(),
    ipc.db.scoreHistory(),
    ipc.db.pipeline(),
    ipc.db.reports(),
    ipc.readFile('data/scan-history.tsv'),
  ])

  useDataStore.setState({
    applications: (apps         ?? []).map(toApplicationEntry),
    scouting:     (scouting     ?? []).map(toScoutingEntry),
    scoreHistory: (scoreRows    ?? []).map(toScoreEntry),
    pipeline:     (pipelineRows ?? []).map(toPipelineUrl),
    reports:      (reportRows   ?? []).map(toReportFile),
    scansThisMonth: countScansThisMonth(scanHistRaw),
    liveness:     deriveLiveness(scanHistRaw),
  })
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
// We append a new row at the bottom on Apply, and rewrite the Status cell of
// a matching row on status change. We never mutate other cells.

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

function tierFolder(tier: string): string {
  if (tier === 'T1') return 'tier-1'
  if (tier === 'T2' || tier === 'T2-high') return 'tier-2'
  if (tier === 'T3') return 'tier-3'
  return 'tier-4'
}

export function appendApplicationRow(raw: string, args: {
  company: string
  role: string
  overall: number
  tier: string
  reportPath?: string
}): string {
  const lines = raw.split('\n')

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
