// Today / "What should I do next?" cockpit aggregation.
//
// Pure synthesis layer for the Today view. Given the already-parsed renderer
// view-models (applications, scouting, the outreach log, the liveness map) it
// produces ONE ranked feed of next actions across the whole pipeline, so the
// user doesn't have to sweep five tabs to find the highest-value thing to do.
//
// Everything here is a pure function of its inputs — no filesystem, no DOM, no
// zustand, and an injectable `now` clock — so the ranking logic is exhaustively
// unit-testable. The view (`components/today/`) owns the I/O and the wiring of
// each item's `action` onto a navigation/spawn handler.
//
// Signal taxonomy (each item carries a `kind`):
//   deadline   — an application's listing deadline is near (urgent / this month)
//   followup   — a sent application has gone quiet past the follow-up cadence
//   outreach   — a logged contact is due a nudge (data/outreach.md cadence)
//   scouting   — a fresh, high-fit scouting hit you haven't pursued yet
//
// Ranking is by a numeric `urgencyScore` (higher = more pressing), with
// severity and `kind` priority as tie-breaks, so the feed always surfaces the
// most time-sensitive, highest-leverage action first.

import { parseDeadline } from './utils'
import { livenessKey, type Liveness } from './scanHistory'
import type { ApplicationEntry, ScoutingEntry } from '@/types'

// ─── Tunables ─────────────────────────────────────────────────────────────────

// Follow-up cadence: a sent application with no logged movement for this many
// days is "quiet" and worth a nudge. Mirrors the spirit of the backend
// followup cadence — a recruiter who hasn't replied in ~10 days is fair game
// for a polite check-in.
export const FOLLOWUP_QUIET_DAYS = 10
// After this long with no movement, a sent application reads as fully stalled
// — escalate the urgency so it doesn't rot silently at the bottom of the feed.
export const FOLLOWUP_STALE_DAYS = 21

// Scouting freshness: only surface hits evaluated within this window. Older
// high-fit hits are the Database's job, not the "act now" cockpit's.
export const SCOUTING_FRESH_DAYS = 14
// Minimum overall score (out of 10) for a scouting hit to be worth surfacing as
// a next action. 7.0 is the documented apply threshold in modes/_shared.md.
export const SCOUTING_MIN_SCORE = 7.0

const DAY_MS = 1000 * 60 * 60 * 24

// Statuses that mean the application is "in flight" — sent and awaiting some
// move from the other side. These are the rows a follow-up cadence applies to.
const IN_FLIGHT: ReadonlySet<string> = new Set(['Applied', 'Responded', 'Interview'])

// Statuses that mean the listing is already engaged or dead — a scouting hit in
// one of these is no longer a "fresh, unpursued" lead.
const ENGAGED_OR_DEAD: ReadonlySet<string> = new Set([
  'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP',
])

// ─── Public types ─────────────────────────────────────────────────────────────

export type CockpitKind = 'deadline' | 'followup' | 'outreach' | 'scouting'

// The action the view should wire onto the item. Kept as a small enum the view
// translates to a real handler (navigate / spawn) so this lib stays I/O-free.
export type CockpitAction =
  | { type: 'apply'; company: string; role: string }            // → Applying / report
  | { type: 'viewReport'; company: string; role: string }       // → Reports slide-over
  | { type: 'draftFollowup'; company: string; role: string }    // → Draft Application
  | { type: 'draftOutreach'; company: string; contact: string } // → contacto mode

export interface CockpitItem {
  /** Stable key for React lists — `kind:company:role|contact`. */
  id: string
  kind: CockpitKind
  /** Higher = act sooner. Drives the single ranked order. */
  urgencyScore: number
  /** One-word severity for the chip colour. */
  severity: 'critical' | 'high' | 'medium' | 'low'
  company: string
  /** Role or contact subtitle — the second line of the row. */
  subtitle: string
  /** The headline verb-phrase, e.g. "Deadline in 2 days". */
  title: string
  /** Supporting one-liner explaining WHY this surfaced now. */
  detail: string
  /** What the row's primary button does. */
  action: CockpitAction
  /** Primary-button label. */
  actionLabel: string
}

// One contact's collapsed cadence record, as produced by the backend
// outreach-cadence collapse step. The view passes these in; this lib only reads
// the fields it needs and treats the action verbatim (the backend owns the
// cadence math). We re-derive nothing here.
export interface OutreachCadenceEntry {
  company: string
  contact: string
  role?: string
  channel?: string
  /** YYYY-MM-DD of the most recent touch. */
  lastTouch?: string
  daysSince?: number | null
  /** The backend cadence verdict. We surface only 'nudge'. */
  action: 'nudge' | 'waiting' | 'cold' | 'done' | string
  reason?: string
}

export interface CockpitInput {
  applications: ApplicationEntry[]
  scouting: ScoutingEntry[]
  /** Collapsed-and-classified outreach contacts (may be empty / absent). */
  outreach?: OutreachCadenceEntry[]
  /** company|role → liveness, from deriveLiveness(). Used to suppress
   *  scouting hits whose listing has already closed. */
  liveness?: Record<string, Liveness>
}

export interface CockpitFeed {
  items: CockpitItem[]
  counts: Record<CockpitKind, number>
  /** Items whose severity is 'critical' or 'high' — the "act now" total. */
  actionable: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntilDeadline(deadline: string, now: Date): number | null {
  const target = parseDeadline(deadline)
  if (!target) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / DAY_MS)
}

function daysSince(dateStr: string, now: Date): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) return null
  const d = new Date(dateStr.trim() + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return Math.floor((today.getTime() - d.getTime()) / DAY_MS)
}

// Parse a score string like "7.2/10" or "8.0/10" → 7.2. Returns null when it
// isn't a /10 score (scouting also logs /5 in some legacy rows — we skip those
// rather than mis-rank them an order of magnitude off).
export function parseScore10(raw: string): number | null {
  const m = (raw ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*10$/)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

function pluralDays(n: number): string {
  const a = Math.abs(n)
  return `${a} ${a === 1 ? 'day' : 'days'}`
}

// ─── Signal builders ──────────────────────────────────────────────────────────

// 1. Deadlines — applications whose listing closes soon. Missed deadlines are
//    dropped (acting on them is pointless); rolling/no-date rows never surface.
//    Urgency climbs steeply as the day count shrinks.
function deadlineItems(apps: ApplicationEntry[], now: Date): CockpitItem[] {
  const out: CockpitItem[] = []
  for (const a of apps) {
    // Closed-out / decided applications don't need a deadline nudge.
    if (a.status === 'Discarded' || a.status === 'SKIP' || a.status === 'Rejected' || a.status === 'Offer') continue
    const days = daysUntilDeadline(a.deadline, now)
    if (days === null) continue       // rolling / no date
    if (days < 0) continue            // missed — nothing to act on
    if (days > 31) continue           // beyond this-month horizon — not "today"

    // 0 days → 100, 7 days → ~82, 31 days → ~20. Monotonic, front-loaded.
    const urgencyScore = Math.round(100 - days * 2.6)
    const severity: CockpitItem['severity'] =
      days <= 2 ? 'critical' : days <= 7 ? 'high' : 'medium'

    const when =
      days === 0 ? 'today' :
      days === 1 ? 'tomorrow' :
      `in ${pluralDays(days)}`

    // An Evaluated row with a near deadline means "apply before it closes";
    // an already-sent row means "this is locked in, just a heads-up" — but we
    // still surface sent rows because interview scheduling often keys off it.
    const notYetSent = a.status === 'Evaluated'
    out.push({
      id: `deadline:${livenessKey(a.company, a.role)}`,
      kind: 'deadline',
      urgencyScore,
      severity,
      company: a.company,
      subtitle: a.role,
      title: `Deadline ${when}`,
      detail: notYetSent
        ? `Evaluated but not applied — the window closes ${when}.`
        : `Application is in (${a.status}); deadline closes ${when}.`,
      action: notYetSent
        ? { type: 'apply', company: a.company, role: a.role }
        : { type: 'viewReport', company: a.company, role: a.role },
      actionLabel: notYetSent ? 'Apply now' : 'Open report',
    })
  }
  return out
}

// 2. Follow-ups — sent applications that have gone quiet. We can't see the true
//    last-contact date (the tracker logs the apply date), so we use the row
//    date as a floor: an Applied/Responded row untouched past the cadence is
//    worth a check-in. Interview rows with a long gap are escalated.
function followupItems(apps: ApplicationEntry[], now: Date): CockpitItem[] {
  const out: CockpitItem[] = []
  for (const a of apps) {
    if (!IN_FLIGHT.has(a.status)) continue
    const quiet = daysSince(a.date, now)
    if (quiet === null) continue
    if (quiet < FOLLOWUP_QUIET_DAYS) continue

    const stalled = quiet >= FOLLOWUP_STALE_DAYS
    // Base 40, +1 per quiet day, capped so a deadline always outranks a
    // same-day follow-up. Interview rows get a lift (a live process going cold
    // is costlier than an un-acked application).
    const interviewing = a.status === 'Interview'
    const urgencyScore = Math.min(
      85,
      40 + quiet + (stalled ? 12 : 0) + (interviewing ? 10 : 0),
    )
    const severity: CockpitItem['severity'] =
      stalled || interviewing ? 'high' : 'medium'

    out.push({
      id: `followup:${livenessKey(a.company, a.role)}`,
      kind: 'followup',
      urgencyScore,
      severity,
      company: a.company,
      subtitle: a.role,
      title: interviewing
        ? `Interview quiet ${pluralDays(quiet)}`
        : `No reply in ${pluralDays(quiet)}`,
      detail: interviewing
        ? `In-process but no movement for ${pluralDays(quiet)} — nudge your contact.`
        : `${a.status} ${pluralDays(quiet)} ago with no reply logged — a polite follow-up keeps it warm.`,
      action: { type: 'draftFollowup', company: a.company, role: a.role },
      actionLabel: 'Draft follow-up',
    })
  }
  return out
}

// 3. Outreach nudges — straight pass-through of the backend cadence verdict.
//    We only surface action === 'nudge'; waiting/cold/done are not "act now".
//    The cadence math (windows, touch ceilings) is owned by outreach-core; this
//    lib trusts it and only maps to a feed item.
function outreachItems(entries: OutreachCadenceEntry[], now: Date): CockpitItem[] {
  const out: CockpitItem[] = []
  for (const e of entries) {
    if (e.action !== 'nudge') continue
    const days = typeof e.daysSince === 'number' ? e.daysSince : daysSince(e.lastTouch ?? '', now)
    // Base 45, +1.5 per day overdue, capped under the deadline ceiling.
    const over = days ?? 0
    const urgencyScore = Math.min(80, Math.round(45 + over * 1.5))
    const severity: CockpitItem['severity'] = over >= 14 ? 'high' : 'medium'

    out.push({
      id: `outreach:${e.company.trim().toLowerCase()}|${e.contact.trim().toLowerCase()}`,
      kind: 'outreach',
      urgencyScore,
      severity,
      company: e.company,
      subtitle: e.contact + (e.role ? ` · ${e.role}` : ''),
      title: days != null ? `Nudge due (${pluralDays(days)})` : 'Nudge due',
      detail: e.reason || `Reach out to ${e.contact} again — a referral lifts your response rate.`,
      action: { type: 'draftOutreach', company: e.company, contact: e.contact },
      actionLabel: 'Draft nudge',
    })
  }
  return out
}

// 4. Fresh scouting hits — recent, high-fit, not-yet-pursued evaluations. These
//    are the top of the funnel: a strong match you haven't acted on. We suppress
//    any whose listing has already closed (liveness) or that you've already
//    engaged (an applications.md row in an engaged/dead status).
function scoutingItems(
  scouting: ScoutingEntry[],
  apps: ApplicationEntry[],
  liveness: Record<string, Liveness>,
  now: Date,
): CockpitItem[] {
  // Build the "already engaged" key set once.
  const engaged = new Set<string>()
  for (const a of apps) {
    if (ENGAGED_OR_DEAD.has(a.status)) engaged.add(livenessKey(a.company, a.role))
  }

  // Dedup to the freshest row per entity (scouting.md can carry re-evals).
  const bestByKey = new Map<string, { entry: ScoutingEntry; score: number; age: number }>()
  for (const s of scouting) {
    const score = parseScore10(s.score)
    if (score === null || score < SCOUTING_MIN_SCORE) continue
    const age = daysSince(s.date, now)
    if (age === null || age > SCOUTING_FRESH_DAYS) continue

    const key = livenessKey(s.company, s.role)
    if (engaged.has(key)) continue
    if (liveness[key] === 'closed') continue   // listing already dead

    const prev = bestByKey.get(key)
    // Prefer the most recent; on a tie, the higher score.
    if (!prev || age < prev.age || (age === prev.age && score > prev.score)) {
      bestByKey.set(key, { entry: s, score, age })
    }
  }

  const out: CockpitItem[] = []
  for (const { entry, score, age } of bestByKey.values()) {
    // Score drives base (7.0 → 30, 9.0 → 50); recency adds a small lift so a
    // hit from today edges out an equally-strong one from last week. Caps below
    // the deadline/followup ceilings — a fresh lead is important but rarely as
    // time-critical as a closing deadline.
    const scoreLift = Math.round((score - SCOUTING_MIN_SCORE) * 10)   // 0..30
    const recencyLift = Math.max(0, SCOUTING_FRESH_DAYS - age)        // 0..14
    const urgencyScore = Math.min(70, 30 + scoreLift + recencyLift)
    const severity: CockpitItem['severity'] = score >= 8.0 ? 'high' : 'medium'

    out.push({
      id: `scouting:${livenessKey(entry.company, entry.role)}`,
      kind: 'scouting',
      urgencyScore,
      severity,
      company: entry.company,
      subtitle: entry.role,
      title: `Fresh ${score.toFixed(1)} match`,
      detail: `Scored ${entry.tier} ${age === 0 ? 'today' : `${pluralDays(age)} ago`} and not yet pursued — strong fit worth a look.`,
      action: { type: 'apply', company: entry.company, role: entry.role },
      actionLabel: 'Review & apply',
    })
  }
  return out
}

// ─── Aggregate + rank ─────────────────────────────────────────────────────────

// Kind priority breaks urgency-score ties — a deadline and a follow-up tied on
// raw urgency should put the deadline first (it's irreversible).
const KIND_RANK: Record<CockpitKind, number> = {
  deadline: 0,
  followup: 1,
  outreach: 2,
  scouting: 3,
}

const SEVERITY_RANK: Record<CockpitItem['severity'], number> = {
  critical: 3, high: 2, medium: 1, low: 0,
}

/**
 * Build the single ranked Today feed from all signals.
 * @param input  the renderer view-models (apps, scouting, outreach, liveness)
 * @param now    injectable clock (defaults to real time) for deterministic tests
 */
export function buildCockpitFeed(input: CockpitInput, now: Date = new Date()): CockpitFeed {
  const liveness = input.liveness ?? {}
  const items = [
    ...deadlineItems(input.applications, now),
    ...followupItems(input.applications, now),
    ...outreachItems(input.outreach ?? [], now),
    ...scoutingItems(input.scouting, input.applications, liveness, now),
  ]

  items.sort((a, b) =>
    (b.urgencyScore - a.urgencyScore) ||
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
    (KIND_RANK[a.kind] - KIND_RANK[b.kind]) ||
    a.company.localeCompare(b.company),
  )

  const counts: Record<CockpitKind, number> = { deadline: 0, followup: 0, outreach: 0, scouting: 0 }
  let actionable = 0
  for (const it of items) {
    counts[it.kind]++
    if (it.severity === 'critical' || it.severity === 'high') actionable++
  }

  return { items, counts, actionable }
}
