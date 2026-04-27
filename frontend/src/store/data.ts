import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { ScoreEntry, ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile, AppStatus, ScoutingTier } from '@/types'

interface DataState {
  scoreHistory: ScoreEntry[]
  scouting:     ScoutingEntry[]
  applications: ApplicationEntry[]
  pipeline:     PipelineUrl[]
  reports:      ReportFile[]
  loaded:       boolean
  loading:      boolean

  load:    () => Promise<void>
  refresh: (opts?: { resync?: boolean }) => Promise<void>
}

export const useDataStore = create<DataState>((set) => ({
  scoreHistory: [],
  scouting:     [],
  applications: [],
  pipeline:     [],
  reports:      [],
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
}))

let refreshInFlight: Promise<void> | null = null

// ─── Loading ──────────────────────────────────────────────────────────────────

async function loadAll() {
  const [apps, scouting, scoreRows, pipelineRows, reportRows] = await Promise.all([
    ipc.db.applications(),
    ipc.db.scouting(),
    ipc.db.scoreHistory(),
    ipc.db.pipeline(),
    ipc.db.reports(),
  ])

  useDataStore.setState({
    applications: (apps         ?? []).map(toApplicationEntry),
    scouting:     (scouting     ?? []).map(toScoutingEntry),
    scoreHistory: (scoreRows    ?? []).map(toScoreEntry),
    pipeline:     (pipelineRows ?? []).map(toPipelineUrl),
    reports:      (reportRows   ?? []).map(toReportFile),
  })
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
  }
}

function toScoutingEntry(row: DbScoutingRow): ScoutingEntry {
  const tierMap: Record<string, ScoutingTier> = { 'T1':'T1','T2-high':'T2-high','T2':'T2','T3':'T3','T4':'T4' }
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
    tier:              row.tier,
    source:            row.source,
    location:          row.location,
    employment_type:   row.employment_type,
    duration:          row.duration,
    salary_raw:        row.salary_raw,
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
    tier:    row.tier,
  }
}
