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

// ─── Stage flow + progress ────────────────────────────────────────────────────
// The linear funnel a healthy application walks: Evaluated → Applied →
// Responded → Interview → Offer. This is the *same* ordering as STATUS_GROUPS
// (the board columns) but named separately because it carries a different
// meaning — STATUS_GROUPS is "which lanes exist", STAGE_FLOW is "the path a
// card travels". Keeping them as one constant would conflate layout with
// progression; an alias keeps them in lockstep without duplicating the list.
export const STAGE_FLOW = STATUS_GROUPS

// Zero-based position of a status in the funnel, or -1 for the closed/non-flow
// statuses (Rejected / Discarded / SKIP) that never sit on the path.
export function stageIndex(status: AppStatus): number {
  return STAGE_FLOW.indexOf(status)
}

// The next stage up the funnel from `status`, or null when there's nowhere
// further to advance (already at Offer, or a closed/non-flow status). Drives
// the card's one-click "advance" affordance — the writeback target.
export function nextStage(status: AppStatus): AppStatus | null {
  const i = stageIndex(status)
  if (i === -1 || i >= STAGE_FLOW.length - 1) return null
  return STAGE_FLOW[i + 1]
}

export interface StageProgress {
  /** Zero-based index of the current stage in STAGE_FLOW, or -1 if off-flow. */
  index: number
  /** How many stages of the funnel are cleared INCLUDING the current one
   *  (1…STAGE_FLOW.length). 0 when the card is off-flow. */
  cleared: number
  /** Total stages in the funnel — the denominator for a progress read. */
  total: number
  /** True once the card has reached the terminal Offer stage. */
  complete: boolean
}

// How far an application has travelled down the funnel — drives the compact
// progress strip on the card (e.g. ●●●○○ for a card that reached Responded).
// An off-flow status (closed/SKIP) reports zero cleared so the strip stays
// empty rather than implying progress on a dead row.
export function stageProgress(status: AppStatus): StageProgress {
  const index = stageIndex(status)
  const total = STAGE_FLOW.length
  return {
    index,
    cleared: index === -1 ? 0 : index + 1,
    total,
    complete: status === 'Offer',
  }
}

// ─── Next-step recommendation ─────────────────────────────────────────────────
// "What is the single highest-value thing to do on this card right now?" The
// board already surfaces two raw signals — a deadline clock and a follow-up
// cadence (see cardAttention) — but the user still has to translate "3d
// overdue" into an action and find the right button. This engine closes that
// gap: it folds status + both clocks into ONE concrete, ranked recommendation
// the card can render as a single primary button.
//
// It maps onto affordances the board already has, so the recommendation is
// always actionable:
//   - 'advance'   → bump status to the next funnel stage (the drag-to-column
//                   writeback, one-click). Carries `toStage`.
//   - 'tailor-cv' → launch the Tailor CV spawn (modes/pdf.md).
//   - 'draft'     → launch the Draft Application spawn (modes/apply.md).
//   - 'prep'      → launch the Prep Application spawn (modes/interview-prep.md).
//   - 'review'    → open the report (read + decide; used at the Offer terminal
//                   and as the calm fallback).
// The view binds each kind to its existing handler — this module owns only the
// decision, never the side effect, so it stays pure and unit-testable.

export type NextStepKind = 'advance' | 'tailor-cv' | 'draft' | 'prep' | 'review'

// Visual weight the card should give the step. 'urgent' = a hard close date or
// an overdue nudge is forcing the issue (render in danger); 'due' = it's coming
// due (warning); 'normal' = the natural next move with no clock pressure.
export type NextStepTone = 'urgent' | 'due' | 'normal'

export interface NextStep {
  kind: NextStepKind
  /** Short button label, e.g. "Apply", "Send follow-up", "Thank-you note". */
  label: string
  /** One-line rationale for the tooltip / aria-label. */
  reason: string
  tone: NextStepTone
  /** For kind='advance': the status to write back. null for non-advance kinds. */
  toStage: AppStatus | null
}

// Resolve the recommended next step. Pure: clock-dependent only through `now`.
// Off-flow rows (Rejected / Discarded / SKIP) never reach this in the UI (they
// live in the Closed strip, not the board), but we still return a safe 'review'
// so callers can't crash on one.
export function nextStep(app: ApplicationEntry, now: Date = new Date()): NextStep {
  const urgency = deadlineUrgency(app.deadline, now)
  const fu = followUpState(app, now)
  const advanceTo = nextStage(app.status)

  switch (app.status) {
    // Evaluated → the move is to apply. A closing deadline makes it urgent and
    // the label sharpens to "Apply now"; otherwise it's the natural next step.
    // When the row has no CV yet, nudge toward tailoring first — a tailored CV
    // is what makes the application worth sending (funnel → conversion).
    case 'Evaluated': {
      if (urgency === 'urgent') {
        return {
          kind: 'advance', toStage: advanceTo, tone: 'urgent',
          label: 'Apply now',
          reason: 'Deadline within a week — apply before it closes',
        }
      }
      if (!app.pdf) {
        return {
          kind: 'tailor-cv', toStage: null, tone: urgency === 'month' ? 'due' : 'normal',
          label: 'Tailor CV',
          reason: 'Tailor your CV to this role before applying',
        }
      }
      return {
        kind: 'advance', toStage: advanceTo, tone: urgency === 'month' ? 'due' : 'normal',
        label: 'Apply',
        reason: urgency === 'month' ? 'Deadline this month — apply soon' : 'CV ready — mark applied once sent',
      }
    }

    // Applied → you're waiting on the company. The action is a follow-up, gated
    // by the cadence clock: overdue / due → surface it; still waiting → the calm
    // move is to draft the application answers while you wait.
    case 'Applied': {
      if (fu.kind === 'overdue' || fu.kind === 'due-soon') {
        return {
          kind: 'draft', toStage: null,
          tone: fu.kind === 'overdue' ? 'urgent' : 'due',
          label: 'Send follow-up',
          reason: fu.reason,
        }
      }
      return {
        kind: 'advance', toStage: advanceTo, tone: 'normal',
        label: 'Log reply',
        reason: 'Heard back? Move it to Responded',
      }
    }

    // Responded → the company is engaging; the cadence wants a prompt reply.
    // Past that, the natural next move is to advance into the interview loop.
    case 'Responded': {
      if (fu.kind === 'overdue' || fu.kind === 'due-soon') {
        return {
          kind: 'draft', toStage: null,
          tone: fu.kind === 'overdue' ? 'urgent' : 'due',
          label: 'Reply now',
          reason: fu.reason,
        }
      }
      return {
        kind: 'advance', toStage: advanceTo, tone: 'normal',
        label: 'Move to interview',
        reason: 'Interview scheduled? Advance the stage',
      }
    }

    // Interview → two beats: prep before it, thank-you note right after. The
    // cadence (1-day thank-you window) flips to urgent the day after the move;
    // otherwise the high-value action is to prep with the story bank.
    case 'Interview': {
      if (fu.kind === 'overdue' || fu.kind === 'due-soon') {
        return {
          kind: 'draft', toStage: null,
          tone: fu.kind === 'overdue' ? 'urgent' : 'due',
          label: 'Thank-you note',
          reason: fu.reason,
        }
      }
      return {
        kind: 'prep', toStage: null, tone: 'normal',
        label: 'Prep interview',
        reason: 'Prep answers from your story bank before the round',
      }
    }

    // Offer → the ball is in your court; the move is to review and decide.
    case 'Offer':
      return {
        kind: 'review', toStage: null, tone: 'normal',
        label: 'Review offer',
        reason: 'Offer in hand — open the report to weigh it',
      }

    // Off-flow (closed) rows: safe, inert fallback.
    default:
      return {
        kind: 'review', toStage: null, tone: 'normal',
        label: 'Open report',
        reason: '',
      }
  }
}
