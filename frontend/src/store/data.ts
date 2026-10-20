import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { upsertApplicationRow, updateApplicationStatus } from '@/lib/applicationsDoc'
import { livenessKey, parseDiscarded, deriveLiveness, countScansThisMonth } from '@/lib/scanHistory'
import { normalizeEligibility, normalizeVerdict } from '@/lib/scoreBands'
import { normalizeTier } from '@/lib/tierLevers'
import { canWriteNow } from './dataRoot'
import type { ScoreEntry, ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile, AppStatus } from '@/types'
import type { StatusAmendResult, StatusChangeResult, StatusLogEntry } from '@/lib/statusLog'
import { buildListingDateQueries, type ListingDatesMap } from '@/lib/listingDates'

/** Optional detail for a status change (all recorded in the status log). */
export interface StatusChangeDetail {
  /** YYYY-MM-DD, today or earlier; defaults to today. */
  date?: string
  /** Free text, e.g. the round a rejection came at. */
  stage?: string
  note?: string
  /** 'chat' when a chat confirm card made the change. */
  source?: 'app' | 'chat'
}

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
  /** Every status change on record (status-log.tsv beside applications.md),
   *  oldest first. Pair with `historyFor` / `rejectionStage` from
   *  `@/lib/statusLog` to read one application's history. */
  statusLog:    StatusLogEntry[]
  /** Deadline / posting date / first-scan date per listing from
   *  scan-history.tsv, keyed by `listingDateKey(company, role)` (every
   *  application and evaluated listing the scans saw). Filled just after the
   *  rest of a load; empty until then. */
  listingDates: ListingDatesMap
  loaded:       boolean
  loading:      boolean

  load:    () => Promise<void>
  refresh: (opts?: { resync?: boolean }) => Promise<void>

  // Application writeback. promoteToApplication writes data/applications.md
  // (main takes the tracker lock); status changes go through
  // `tracker:set-status` in main, which also logs them. The chokidar watcher
  // resyncs the SQLite cache and refresh() mirrors disk into the renderer.
  promoteToApplication: (args: {
    company: string
    role: string
    /** Want / Ease written as the `W8.3 E5.6` Score cell (scoring v2 §8.3). */
    want: number | null
    ease: number | null
    tier: string
    reportPath?: string
  }) => Promise<void>
  /** The app's only status write: validated, locked and logged in main
   *  (scripts/lib/status-ledger.mjs). Resolves to the result (`ok: false`
   *  carries the reason), or null when writes are off (demo). */
  setApplicationStatus: (company: string, role: string, status: AppStatus, detail?: StatusChangeDetail) => Promise<StatusChangeResult | null>
  /** Correct the date and/or stage of the latest logged move to `status`
   *  (e.g. a rejection backfilled with an approximate date). Only the status
   *  log changes; `stage: ''` clears it. Null when writes are off (demo). */
  amendStatusEntry: (company: string, role: string, status: AppStatus, detail: { date?: string; stage?: string }) => Promise<StatusAmendResult | null>
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
  statusLog:    [],
  listingDates: {},
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

  // The three writers below are no-ops in demo mode (read-only data): the
  // controls are disabled there, this is the backstop — main refuses the
  // write too (demo-read-only).
  promoteToApplication: async ({ company, role, want, ease, tier, reportPath }) => {
    if (!canWriteNow()) return
    const path = 'data/applications.md'
    const raw = await ipc.readFile(path) ?? ''
    const next = upsertApplicationRow(raw, {
      company, role, want, ease, tier, reportPath,
    })
    // Only touch disk when something actually changed (the listing was new,
    // or its score/report moved). When it's already tracked and unchanged we
    // still refresh so a stale in-memory store re-syncs — the Apply affordance
    // then flips to the status dropdown rather than offering a second Apply.
    if (next !== raw) await ipc.writeFile(path, next)
    await useDataStore.getState().refresh()
  },

  setApplicationStatus: async (company, role, status, detail) => {
    if (!canWriteNow()) return null
    const result = await ipc.tracker.setStatus({
      company, role, status,
      date: detail?.date, stage: detail?.stage, note: detail?.note,
      source: detail?.source ?? 'app',
    })
    if (!result) return null
    if (!result.ok) console.error(`[status] ${company} — ${role} → ${status}: ${result.error}`)
    else if (result.changed) await useDataStore.getState().refresh()
    return result
  },

  amendStatusEntry: async (company, role, status, detail) => {
    if (!canWriteNow()) return null
    const result = await ipc.tracker.amendStatus({
      company, role, status, date: detail.date, stage: detail.stage, source: 'app',
    })
    if (!result) return null
    if (!result.ok) console.error(`[status] amend ${company} — ${role} (${status}): ${result.error}`)
    else if (result.changed) await useDataStore.getState().refresh()
    return result
  },

  discardListing: async (company, role) => {
    if (!canWriteNow()) return
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
    //    its status to SKIP through the status write path (so it's logged)
    //    — keeps the application record for history while signaling it's
    //    no longer active. A listing that was never applied to answers
    //    `ok: false` (no such application), which is fine here.
    await ipc.tracker.setStatus({ company, role, status: 'SKIP' as AppStatus, note: 'marked not interested', source: 'app' })

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
  const [apps, scouting, scoreRows, pipelineRows, reportRows, scanHistRaw, discardedRaw, statusLog] = await Promise.all([
    ipc.db.applications(),
    ipc.db.scouting(),
    ipc.db.scoreHistory(),
    ipc.db.pipeline(),
    ipc.db.reports(),
    ipc.readFile('data/scan-history.tsv'),
    ipc.readFile('data/discarded.tsv'),
    ipc.tracker.statusHistory(),
  ])

  const applications = (apps ?? []).map(toApplicationEntry)
  const scoreHistory = (scoreRows ?? []).map(toScoreEntry)
  useDataStore.setState({
    applications,
    scouting:     (scouting     ?? []).map(toScoutingEntry),
    scoreHistory,
    pipeline:     (pipelineRows ?? []).map(toPipelineUrl),
    reports:      (reportRows   ?? []).map(toReportFile),
    scansThisMonth: countScansThisMonth(scanHistRaw),
    liveness:     deriveLiveness(scanHistRaw),
    discarded:    parseDiscarded(discardedRaw),
    statusLog:    statusLog ?? [],
  })

  // Dates second: main joins every listing to scan-history in one pass, and
  // nothing above waits on it.
  const listingDates = await ipc.listings.dates(buildListingDateQueries(applications, scoreHistory)).catch(() => null)
  useDataStore.setState({ listingDates: listingDates ?? {} })
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
  return {
    num:           row.num,
    date:          row.date,
    company:       row.company,
    role:          row.role,
    want:          row.want ?? null,
    ease:          row.ease ?? null,
    tier:          normalizeTier(row.tier) ?? 'T4',
    eligibility:   normalizeEligibility(row.eligibility),
    eligibilityReason: row.eligibility_reason ?? '',
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
    skills_match:      row.skills_match ?? null,
    experience_bar:    row.experience_bar ?? null,
    competition:       row.competition ?? null,
    ease:              row.ease ?? null,
    growth_mobility:   row.growth_mobility ?? null,
    optionality_exit:  row.optionality_exit ?? null,
    brand_value:       row.brand_value ?? null,
    role_content:      row.role_content ?? null,
    best_cities:       row.best_cities ?? null,
    salary_adj_city:   row.salary_adj_city ?? null,
    work_life_balance: row.work_life_balance ?? null,
    want:              row.want ?? null,
    priority:          row.priority ?? null,
    eligibility:       normalizeEligibility(row.eligibility),
    eligibility_flags: row.eligibility_flags ?? '',
    verdict:           normalizeVerdict(row.verdict),
    best_fit_roles:    row.best_fit_roles,
    mode:              (row.mode === 'oferta' ? 'oferta' : 'scouting'),
    company:           row.company,
    role:              row.role,
    tier:              normalizeTier(row.tier, {
      verdict: normalizeVerdict(row.verdict), want: row.want, ease: row.ease,
      eligibility: normalizeEligibility(row.eligibility),
    }),
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
    url:           row.url,
    addedDate:     row.added_date ?? undefined,
    isStale:       Boolean(row.is_stale),
    company:       row.company ?? undefined,
    title:         row.title ?? undefined,
    relevance:     row.relevance ?? undefined,
    relevanceNote: row.relevance_note ?? undefined,
  }
}

function toReportFile(row: DbReportRow): ReportFile {
  return {
    path:    row.path,
    company: row.company,
    role:    row.role,
    tier:    row.tier,
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
