// Pure board logic for the Applying cockpit: which Kanban column a card lands
// in (groupByStatus) and how cards stack within it (compareByDeadline).
// Extracted from ApplyingView so the bucketing + ordering is unit-testable
// without mounting the view. The timezone-safe deadline *primitives* it builds
// on (deadlineUrgency, deadlineTime) live in lib/utils — this module only owns
// the board-specific composition. Clock-dependent fns take an injectable `now`.

import { deadlineUrgency, deadlineTime, parseDeadline } from '@/lib/utils'
import type { AppStatus, ApplicationEntry } from '@/types'

// The five active Kanban stages, in board order. Rejected / Discarded fall to
// the "Closed" strip and SKIP never enters the board — none appear here.
export const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer']

// Urgency bucket → sort rank (lower = more pressing, floats to the top of its
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

// Bucket applications into the five active stages, each column sorted by
// compareByDeadline. Statuses outside STATUS_GROUPS (SKIP / Rejected /
// Discarded) are dropped — they don't belong on the board.
export function groupByStatus(
  applications: ApplicationEntry[],
  now: Date = new Date(),
): Record<AppStatus, ApplicationEntry[]> {
  const map = {} as Record<AppStatus, ApplicationEntry[]>
  for (const s of STATUS_GROUPS) map[s] = []
  for (const a of applications) {
    if (a.status in map) map[a.status].push(a)
  }
  for (const s of STATUS_GROUPS) map[s].sort((x, y) => compareByDeadline(x, y, now))
  return map
}

// Deterministic spawn id for a per-card action (Tailor CV / Draft / Prep), so
// re-clicking the same card's action targets the same in-flight spawn.
export function getSpawnId(prefix: string, app: ApplicationEntry): string {
  const cleanCompany = app.company.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const cleanRole = app.role.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `${prefix}-${cleanCompany}-${cleanRole}`
}

// ─── Follow-up cadence ───────────────────────────────────────────────────────
// "Is a nudge due on this application?" — derived purely from its status + the
// date in its row (when it last moved). Mirrors the canonical backend cadence
// in scripts/followup-cadence.mjs so the cockpit's "due" signal agrees with
// `node scripts/followup-cadence.mjs`. The frontend store doesn't load a
// per-application outreach log, so this is the zero-prior-nudge baseline: it
// answers "given the row's date, how overdue is the *first* outreach for this
// stage?". Once a user logs a nudge (notes / status bump), the row date moves
// and the clock resets — the same way the script treats a fresh follow-up.
//
// Cadence thresholds (calendar days), keyed by stage:
//   Applied   → first nudge after 7d of silence
//   Responded → reply within 3d of the company reaching out
//   Interview → thank-you note within 1d
// Stages outside this set (Evaluated / Offer / closed) have no cadence — an
// Evaluated row is waiting on *you to apply* (a deadline concern, not a nudge),
// and an Offer is waiting on your decision.
export const FOLLOWUP_CADENCE_DAYS: Partial<Record<AppStatus, number>> = {
  Applied: 7,
  Responded: 3,
  Interview: 1,
}

export type FollowUpKind = 'overdue' | 'due-soon' | 'waiting' | 'none'

export interface FollowUpState {
  /** overdue = past the cadence window; due-soon = within 1 day of it;
   *  waiting = on the clock but not yet due; none = stage has no cadence. */
  kind: FollowUpKind
  /** Whole calendar days since the row's date (the last time it moved).
   *  null when the row has no parseable date. */
  daysSince: number | null
  /** Days until the nudge is due (negative once overdue). null when n/a. */
  dueInDays: number | null
  /** One-line, human-readable reason — drives the card tooltip / label. */
  reason: string
}

// Parse a `YYYY-MM-DD` application-row date to local midnight. Reuses the same
// timezone-safe primitive the deadline column trusts (parseDeadline accepts a
// bare ISO date and rejects rolling/n/d), so the two date columns can never
// disagree about which calendar day a string lands on.
function rowDate(date: string): Date | null {
  return parseDeadline(date)
}

function wholeDaysBetween(from: Date, to: Date): number {
  const a = new Date(from); a.setHours(0, 0, 0, 0)
  const b = new Date(to);   b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export function followUpState(app: ApplicationEntry, now: Date = new Date()): FollowUpState {
  const cadence = FOLLOWUP_CADENCE_DAYS[app.status]
  if (cadence === undefined) {
    return { kind: 'none', daysSince: null, dueInDays: null, reason: '' }
  }

  const moved = rowDate(app.date)
  if (!moved) {
    // Stage has a cadence but no usable date — we can't time it, so stay quiet
    // rather than nag on a guess.
    return { kind: 'none', daysSince: null, dueInDays: null, reason: 'No date on file' }
  }

  const daysSince = wholeDaysBetween(moved, now)
  const dueInDays = cadence - daysSince

  const label = app.status === 'Interview'
    ? 'Send a thank-you note'
    : app.status === 'Responded'
      ? 'Reply to the company'
      : 'Send a follow-up'

  if (dueInDays < 0) {
    const overdueBy = -dueInDays
    return {
      kind: 'overdue',
      daysSince,
      dueInDays,
      reason: `${label} — ${overdueBy}d overdue`,
    }
  }
  if (dueInDays <= 1) {
    return {
      kind: 'due-soon',
      daysSince,
      dueInDays,
      reason: dueInDays === 0 ? `${label} — due today` : `${label} — due tomorrow`,
    }
  }
  return {
    kind: 'waiting',
    daysSince,
    dueInDays,
    reason: `${label} in ${dueInDays}d`,
  }
}

// ─── Card attention rollup ───────────────────────────────────────────────────
// A single "how much does this card want my attention?" verdict that fuses the
// two independent clocks a card runs on — its application *deadline* (closing
// date) and its follow-up *cadence* (outreach nudge). The view surfaces ONE
// dominant signal per card so the user isn't parsing two competing badges; the
// more pressing of the two wins.

export type AttentionLevel = 'act-now' | 'soon' | 'calm'

export type AttentionSource = 'deadline' | 'followup' | null

export interface CardAttention {
  level: AttentionLevel
  /** Which clock drove the verdict — lets the card tint the right chip. */
  source: AttentionSource
  /** Human-readable reason for the dominant signal (tooltip / aria-label). */
  reason: string
  /** The follow-up state, exposed so the card can render its own nudge chip
   *  even when the deadline is the dominant attention driver. */
  followUp: FollowUpState
}

export function cardAttention(app: ApplicationEntry, now: Date = new Date()): CardAttention {
  const fu = followUpState(app, now)
  const urgency = deadlineUrgency(app.deadline, now)

  // Deadline pressure → attention level. A live deadline inside a week is
  // act-now; this month is soon. 'missed'/'none'/'upcoming' don't escalate.
  const deadlineLevel: AttentionLevel =
    urgency === 'urgent' ? 'act-now' : urgency === 'month' ? 'soon' : 'calm'

  // Follow-up pressure → attention level.
  const followLevel: AttentionLevel =
    fu.kind === 'overdue' ? 'act-now' : fu.kind === 'due-soon' ? 'soon' : 'calm'

  // The more pressing clock wins; on a tie at the top, the deadline (a hard
  // external close date) outranks a follow-up nudge (a soft internal cadence).
  const rank: Record<AttentionLevel, number> = { 'act-now': 2, soon: 1, calm: 0 }
  const deadlineReason =
    urgency === 'urgent' ? 'Deadline within a week'
    : urgency === 'month' ? 'Deadline this month'
    : ''

  if (rank[deadlineLevel] >= rank[followLevel] && deadlineLevel !== 'calm') {
    return { level: deadlineLevel, source: 'deadline', reason: deadlineReason, followUp: fu }
  }
  if (followLevel !== 'calm') {
    return { level: followLevel, source: 'followup', reason: fu.reason, followUp: fu }
  }
  return { level: 'calm', source: null, reason: '', followUp: fu }
}

// Count how many cards in a list are asking for attention today (act-now).
// Drives the column header's "needs action" pip and the board-level total.
export function countActNow(apps: ApplicationEntry[], now: Date = new Date()): number {
  return apps.reduce((n, a) => n + (cardAttention(a, now).level === 'act-now' ? 1 : 0), 0)
}
