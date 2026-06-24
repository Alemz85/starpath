import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { upsertApplicationRow, updateApplicationStatus } from '@/lib/applicationsDoc'
import { livenessKey, parseDiscarded, deriveLiveness, countScansThisMonth } from '@/lib/scanHistory'
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

// ─── Scan-history derivations ───────────────────────────────────────────────
//
// The pure logic (entity key, discard parsing, liveness, monthly scan count)
// lives in `@/lib/scanHistory` so it's testable with an injectable clock — the
// store imports it above and owns only the I/O. `livenessKey` is re-exported
// for API stability (it's the canonical entity-key builder).
export { livenessKey }

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
// The pure table-transform logic (upsert / status rewrite, plus the row
// parsing primitives) now lives in `@/lib/applicationsDoc` so it can be
// unit-tested without dragging in zustand/ipc. The store imports them above
// and owns only the I/O. Re-exported here for API stability — they used to be
// defined in this file and a couple of call sites import them from here.
export { upsertApplicationRow, updateApplicationStatus }
