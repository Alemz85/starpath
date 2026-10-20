// Pure board logic for the Applying view: which Kanban column a card lands
// in (groupByStatus), how cards stack within it (compareByDeadline), and how a
// rejection reads (rejectionInfo, rejectionStageOptions). Extracted from
// ApplyingView so the bucketing + ordering is unit-testable without mounting
// the view. The board tracks; it never suggests a next action (the user
// follows up and replies outside the app). The timezone-safe deadline
// *primitives* (deadlineUrgency, deadlineTime) live in lib/utils.
// Clock-dependent fns take an injectable `now`.

import { deadlineUrgency, deadlineTime } from '@/lib/utils'
import { historyFor, rejectionStage, type StatusLogEntry } from '@/lib/statusLog'
import type { AppStatus, ApplicationEntry } from '@/types'

// The Kanban columns, in board order: the five live stages, then Rejected.
// Discarded falls to the "Closed" strip and SKIP never enters the board.
export const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected']

// Board display label. "Evaluated" in the tracker means "promoted, not applied
// yet", which on this board reads as "To apply". The stored status is unchanged.
export function boardLabel(status: AppStatus): string {
  return status === 'Evaluated' ? 'To apply' : status
}

// The stages a card can be set to from its dropdown (same as the columns).
export const BOARD_STAGES: readonly AppStatus[] = STATUS_GROUPS

/** The dropdown's stages for a card: an Evaluated card was never sent, so it
 *  can't be rejected (its way off the board is Remove → Discarded). */
export function stagesFor(status: AppStatus): readonly AppStatus[] {
  return status === 'Evaluated' ? BOARD_STAGES.filter(s => s !== 'Rejected') : BOARD_STAGES
}

/** What a board move really writes. Evaluated → Rejected becomes Discarded:
 *  nothing was applied to, and a rejection row from Evaluated would count
 *  in response rates. Every other move is written as asked. */
export function boardMoveTarget(from: AppStatus, to: AppStatus): AppStatus {
  return from === 'Evaluated' && to === 'Rejected' ? 'Discarded' : to
}

// Urgency bucket → sort rank (lower = nearer deadline, floats to the top of its
// column). 'none' (Rolling / no deadline) and 'missed' sink below live dates.
export const URGENCY_RANK: Record<ReturnType<typeof deadlineUrgency>, number> = {
  urgent: 0, month: 1, upcoming: 2, none: 3, missed: 4,
}

// Order cards within a column so the nearest live deadline never sits buried
// under months-out rows: by urgency bucket first, then the actual date.
export function compareByDeadline(a: ApplicationEntry, b: ApplicationEntry, now: Date = new Date()): number {
  const ra = URGENCY_RANK[deadlineUrgency(a.deadline, now)]
  const rb = URGENCY_RANK[deadlineUrgency(b.deadline, now)]
  if (ra !== rb) return ra - rb
  return deadlineTime(a.deadline) - deadlineTime(b.deadline)
}

// Bucket applications into the board columns. Live columns are sorted by
// compareByDeadline; Rejected is newest rejection first (`rejectedOn`, else the
// row's date), since a deadline means nothing there. Statuses outside
// STATUS_GROUPS (SKIP / Discarded) are dropped.
export function groupByStatus(
  applications: ApplicationEntry[],
  now: Date = new Date(),
  rejectedOn: (a: ApplicationEntry) => string | null = () => null,
): Record<AppStatus, ApplicationEntry[]> {
  const map = {} as Record<AppStatus, ApplicationEntry[]>
  for (const s of STATUS_GROUPS) map[s] = []
  for (const a of applications) {
    if (a.status in map) map[a.status].push(a)
  }
  for (const s of STATUS_GROUPS) {
    if (s === 'Rejected') {
      const day = (a: ApplicationEntry) => rejectedOn(a) ?? a.date ?? ''
      map[s].sort((x, y) => day(y).localeCompare(day(x)))
    } else {
      map[s].sort((x, y) => compareByDeadline(x, y, now))
    }
  }
  return map
}

// ─── Rejections ──────────────────────────────────────────────────────────────

export interface RejectionInfo {
  /** When it happened (the logged event date), null when the log has no move
   *  to Rejected for this application (a row older than the log). */
  date: string | null
  /** The status it was rejected from, '' when unknown. */
  from: string
  /** The refining stage the user picked ('' when none): wins over `from`. */
  stage: string
  /** The one line a card shows: the picked stage, else one inferred from `from`. */
  label: string
}

// How a rejection reads from the stage it left. Plain words, no blame.
const FROM_LABEL: Record<string, string> = {
  Applied:   'after applying',
  Responded: 'after they replied',
  Interview: 'after interviewing',
  Offer:     'at the offer',
}

/** The inferred line for a rejection from `from` ("after interviewing"). */
export function inferredRejectionLabel(from: string): string {
  return FROM_LABEL[from] ?? 'stage unknown'
}

/** A rejected application's date and stage from the status log
 *  (`rejectionStage(historyFor(log, app))`). Null for any other status. */
export function rejectionInfo(log: StatusLogEntry[], app: ApplicationEntry): RejectionInfo | null {
  if (app.status !== 'Rejected') return null
  const r = rejectionStage(historyFor(log, app))
  if (!r) return { date: null, from: '', stage: '', label: inferredRejectionLabel('') }
  const stage = r.explicit ? r.stage : ''
  return { date: r.date || null, from: r.from, stage, label: stage || inferredRejectionLabel(r.from) }
}

// One-click refinements the rejection dialog offers, each tied to the stages
// it can follow. Free text is never needed: the inferred stage stands when
// none is picked.
const STAGE_OPTIONS: ReadonlyArray<{ label: string; after: readonly string[] }> = [
  { label: 'at the CV screen',          after: ['Applied'] },
  { label: 'after an online test',      after: ['Applied', 'Responded'] },
  { label: 'after the recruiter call',  after: ['Responded', 'Interview'] },
  { label: 'after the case study',      after: ['Responded', 'Interview'] },
  { label: 'after the first round',     after: ['Interview'] },
  { label: 'after the final round',     after: ['Interview', 'Offer'] },
  { label: 'offer withdrawn',           after: ['Offer'] },
]

/** The refining chips for a rejection from `from`; every chip when `from` is
 *  unknown. */
export function rejectionStageOptions(from: string): string[] {
  const fit = STAGE_OPTIONS.filter(o => o.after.includes(from))
  return (fit.length ? fit : STAGE_OPTIONS).map(o => o.label)
}
