// Status log — the history of every application's status, as the app sees it.
//
// The log itself is `status-log.tsv` beside data/applications.md, written only
// by scripts/lib/status-ledger.mjs (the CLI `set-status.mjs`, the merge
// scripts, and this app through the `tracker:set-status` IPC). The renderer
// never writes it or applications.md's Status cell directly. These are the
// shared request/response shapes plus pure readers over the entries; keep the
// module free of zustand/ipc/React (Electron main imports its types).

import type { AppStatus } from '@/types'

/** One row of status-log.tsv. `from` is '' on an origin row (the status the
 *  application started with). `date` is when it happened (may be in the past),
 *  `logged_at` when it was written (ISO). */
export interface StatusLogEntry {
  num: number
  date: string
  company: string
  role: string
  from: string
  to: string
  stage: string
  source: string
  note: string
  logged_at: string
}

/** What a caller may ask for. Identify the application by `num`, or by
 *  company + role (case-insensitive, the tracker's identity key); giving both
 *  makes main refuse a number that now points at a different listing. */
export interface StatusChangeRequest {
  num?: number
  company?: string
  role?: string
  status: AppStatus
  /** YYYY-MM-DD, today or earlier. Defaults to today (local). */
  date?: string
  /** Free text: where it happened (e.g. the interview round of a rejection). */
  stage?: string
  note?: string
  /** Who made the change. The app sends 'app' or 'chat'. */
  source?: 'app' | 'chat'
}

export type StatusChangeResult =
  | { ok: true; changed: boolean; to: AppStatus; date: string; entries: StatusLogEntry[] }
  | { ok: false; error: string; code: string | null }

/** Correct the date and/or stage of an application's latest logged move to
 *  `status` (scripts/lib/status-ledger.mjs `amendStatus*`). Fields left out
 *  are kept; `stage: ''` clears it. applications.md is not touched. */
export interface StatusAmendRequest {
  num?: number
  company?: string
  role?: string
  status: AppStatus
  date?: string
  stage?: string
  source?: 'app' | 'chat'
}

export type StatusAmendResult =
  | { ok: true; changed: boolean; entry: StatusLogEntry }
  | { ok: false; error: string; code: string | null }

/** Filter for a history read; empty reads the whole log. */
export interface StatusHistoryQuery {
  num?: number
  company?: string
  role?: string
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase()

/** Oldest first: by event date, then the order written. */
export function sortStatusLog(entries: StatusLogEntry[]): StatusLogEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i))
    .map(x => x.e)
}

/** One application's entries from the whole log. A number match counts only
 *  when the entry's company/role (when present) agree, so a reused number
 *  never borrows another listing's history. */
export function historyFor(
  log: StatusLogEntry[],
  app: { num: number; company: string; role: string },
): StatusLogEntry[] {
  return sortStatusLog(log.filter(e => {
    if (e.num !== app.num) return false
    if (!e.company && !e.role) return true
    return norm(e.company) === norm(app.company) && norm(e.role) === norm(app.role)
  }))
}

/**
 * Where a rejection happened: the explicit `stage` on the latest move to
 * Rejected, else the status it was rejected from (Applied = no reply beyond
 * the application, Interview = after interviewing, …). Null when the history
 * has no move to Rejected.
 */
export function rejectionStage(history: StatusLogEntry[]): { stage: string; from: string; date: string; explicit: boolean } | null {
  const sorted = sortStatusLog(history)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]
    if (e.to !== 'Rejected') continue
    if (e.stage) return { stage: e.stage, from: e.from, date: e.date, explicit: true }
    return { stage: e.from || 'unknown', from: e.from, date: e.date, explicit: false }
  }
  return null
}
