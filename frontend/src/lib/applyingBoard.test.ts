import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS_GROUPS,
  URGENCY_RANK,
  FOLLOWUP_CADENCE_DAYS,
  compareByDeadline,
  groupByStatus,
  getSpawnId,
  followUpState,
  cardAttention,
  countActNow,
} from '@/lib/applyingBoard'
import { makeApplication } from '@/test-utils/fixtures'
import type { AppStatus } from '@/types'

// A local-constructed clock: YYYY-MM-DD deadlines parse as local calendar
// dates (lib/utils.deadlineUrgency), so building `now` from local components
// keeps every "days until" assertion exact and timezone-independent.
const NOW = new Date(2026, 5, 25, 12, 0, 0) // Thu 2026-06-25, local noon

// 'YYYY-MM-DD' for a date `offset` days from NOW's calendar day. Date()
// normalises month/year rollover, so ymd(60) and ymd(-5) are valid strings.
function ymd(offset: number): string {
  const d = new Date(2026, 5, 25 + offset)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// ─── STATUS_GROUPS ───────────────────────────────────────────────────────────

test('STATUS_GROUPS is exactly the five active stages, in board order', () => {
  assert.deepEqual(STATUS_GROUPS, ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer'])
  for (const closed of ['SKIP', 'Rejected', 'Discarded'] as AppStatus[]) {
    assert.ok(!STATUS_GROUPS.includes(closed), `${closed} must not be a board stage`)
  }
})

// ─── URGENCY_RANK ────────────────────────────────────────────────────────────

test('URGENCY_RANK ranks pressing buckets above slack ones', () => {
  assert.ok(URGENCY_RANK.urgent < URGENCY_RANK.month)
  assert.ok(URGENCY_RANK.month < URGENCY_RANK.upcoming)
  assert.ok(URGENCY_RANK.upcoming < URGENCY_RANK.none)
  assert.ok(URGENCY_RANK.none < URGENCY_RANK.missed)
})

// ─── groupByStatus ───────────────────────────────────────────────────────────

test('groupByStatus buckets active statuses and drops SKIP / Rejected / Discarded', () => {
  const apps = [
    makeApplication({ company: 'A', status: 'Evaluated' }),
    makeApplication({ company: 'B', status: 'Applied' }),
    makeApplication({ company: 'C', status: 'Offer' }),
    makeApplication({ company: 'D', status: 'SKIP' }),
    makeApplication({ company: 'E', status: 'Rejected' }),
    makeApplication({ company: 'F', status: 'Discarded' }),
  ]
  const g = groupByStatus(apps, NOW)
  assert.equal(g.Evaluated.length, 1)
  assert.equal(g.Applied.length, 1)
  assert.equal(g.Offer.length, 1)
  assert.equal(g.Responded.length, 0)
  // Closed statuses never become board columns.
  assert.equal((g as Record<string, unknown>).SKIP, undefined)
  assert.equal((g as Record<string, unknown>).Rejected, undefined)
  assert.equal((g as Record<string, unknown>).Discarded, undefined)
  const total = STATUS_GROUPS.reduce((n, s) => n + g[s].length, 0)
  assert.equal(total, 3, 'the three closed rows are dropped from the board')
})

test('groupByStatus orders a column by urgency bucket, then date', () => {
  // rolling → "upcoming" bucket but +Infinity time, so it sits behind a
  // real far-out date in the same bucket; missed sinks to the very bottom.
  const apps = [
    makeApplication({ company: 'Rolling',   status: 'Applied', deadline: 'rolling' }),
    makeApplication({ company: 'FarOut',    status: 'Applied', deadline: ymd(60) }),  // upcoming
    makeApplication({ company: 'Urgent',    status: 'Applied', deadline: ymd(3) }),   // urgent
    makeApplication({ company: 'ThisMonth', status: 'Applied', deadline: ymd(20) }),  // month
    makeApplication({ company: 'Missed',    status: 'Applied', deadline: ymd(-5) }),  // missed
  ]
  const col = groupByStatus(apps, NOW).Applied.map(a => a.company)
  assert.deepEqual(col, ['Urgent', 'ThisMonth', 'FarOut', 'Rolling', 'Missed'])
})

// ─── compareByDeadline ───────────────────────────────────────────────────────

test('compareByDeadline puts the nearer deadline first within the same bucket', () => {
  const sooner = makeApplication({ deadline: ymd(1) })
  const later = makeApplication({ deadline: ymd(2) })
  assert.ok(compareByDeadline(sooner, later, NOW) < 0)
  assert.ok(compareByDeadline(later, sooner, NOW) > 0)
  assert.equal(compareByDeadline(sooner, sooner, NOW), 0)
})

test('compareByDeadline ranks a pressing deadline ahead of a slack one', () => {
  const urgent = makeApplication({ deadline: ymd(2) })   // urgent bucket
  const faraway = makeApplication({ deadline: ymd(90) }) // upcoming bucket
  assert.ok(compareByDeadline(urgent, faraway, NOW) < 0)
})

// ─── getSpawnId ──────────────────────────────────────────────────────────────

test('getSpawnId slugs company + role into a stable, reusable id', () => {
  const app = makeApplication({ company: 'McKinsey & Co.', role: 'Data Scientist' })
  assert.equal(getSpawnId('app-tailor-cv', app), 'app-tailor-cv-mckinsey---co--data-scientist')
  // Same listing → same id (so re-clicking targets the in-flight spawn).
  assert.equal(getSpawnId('app-draft', app), getSpawnId('app-draft', app))
})

// ─── followUpState ───────────────────────────────────────────────────────────

test('followUpState: stages without a cadence return kind=none', () => {
  for (const status of ['Evaluated', 'Offer', 'Rejected', 'Discarded', 'SKIP'] as const) {
    const fu = followUpState(makeApplication({ status, date: ymd(-30) }), NOW)
    assert.equal(fu.kind, 'none', `${status} has no follow-up cadence`)
    assert.equal(fu.dueInDays, null)
  }
})

test('followUpState: cadence thresholds match the canonical backend', () => {
  // Mirrors scripts/followup-cadence.mjs CADENCE: applied_first 7, responded 3,
  // interview thank-you 1.
  assert.equal(FOLLOWUP_CADENCE_DAYS.Applied, 7)
  assert.equal(FOLLOWUP_CADENCE_DAYS.Responded, 3)
  assert.equal(FOLLOWUP_CADENCE_DAYS.Interview, 1)
})

test('followUpState: Applied waits, then comes due, then goes overdue', () => {
  // Day 3 of silence → still waiting (cadence is 7).
  const waiting = followUpState(makeApplication({ status: 'Applied', date: ymd(-3) }), NOW)
  assert.equal(waiting.kind, 'waiting')
  assert.equal(waiting.daysSince, 3)
  assert.equal(waiting.dueInDays, 4)

  // Day 7 → due today.
  const dueToday = followUpState(makeApplication({ status: 'Applied', date: ymd(-7) }), NOW)
  assert.equal(dueToday.kind, 'due-soon')
  assert.equal(dueToday.dueInDays, 0)
  assert.match(dueToday.reason, /due today/)

  // Day 6 → due tomorrow (within the 1-day due-soon window).
  const dueTomorrow = followUpState(makeApplication({ status: 'Applied', date: ymd(-6) }), NOW)
  assert.equal(dueTomorrow.kind, 'due-soon')
  assert.equal(dueTomorrow.dueInDays, 1)

  // Day 10 → 3 days overdue.
  const overdue = followUpState(makeApplication({ status: 'Applied', date: ymd(-10) }), NOW)
  assert.equal(overdue.kind, 'overdue')
  assert.equal(overdue.dueInDays, -3)
  assert.match(overdue.reason, /3d overdue/)
})

test('followUpState: Interview thank-you is overdue the day after the move', () => {
  const sameDay = followUpState(makeApplication({ status: 'Interview', date: ymd(0) }), NOW)
  assert.equal(sameDay.kind, 'due-soon') // due today
  const nextDay = followUpState(makeApplication({ status: 'Interview', date: ymd(-2) }), NOW)
  assert.equal(nextDay.kind, 'overdue')
  assert.match(nextDay.reason, /thank-you/i)
})

test('followUpState: a row with no parseable date stays quiet (kind=none)', () => {
  const fu = followUpState(makeApplication({ status: 'Applied', date: 'n/d' }), NOW)
  assert.equal(fu.kind, 'none')
  assert.equal(fu.daysSince, null)
})

// ─── cardAttention ───────────────────────────────────────────────────────────

test('cardAttention: a calm card with no deadline and no due nudge', () => {
  const a = cardAttention(makeApplication({ status: 'Applied', date: ymd(-2), deadline: 'n/d' }), NOW)
  assert.equal(a.level, 'calm')
  assert.equal(a.source, null)
})

test('cardAttention: an overdue follow-up escalates to act-now via the followup clock', () => {
  const a = cardAttention(makeApplication({ status: 'Applied', date: ymd(-14), deadline: 'n/d' }), NOW)
  assert.equal(a.level, 'act-now')
  assert.equal(a.source, 'followup')
  assert.match(a.reason, /follow-up/i)
})

test('cardAttention: an urgent deadline escalates to act-now via the deadline clock', () => {
  const a = cardAttention(makeApplication({ status: 'Applied', date: ymd(0), deadline: ymd(3) }), NOW)
  assert.equal(a.level, 'act-now')
  assert.equal(a.source, 'deadline')
})

test('cardAttention: deadline outranks follow-up when both are act-now', () => {
  // 14d-silent Applied (overdue nudge) AND a deadline in 2 days (urgent).
  const a = cardAttention(makeApplication({ status: 'Applied', date: ymd(-14), deadline: ymd(2) }), NOW)
  assert.equal(a.level, 'act-now')
  assert.equal(a.source, 'deadline', 'hard close date wins the tie over a soft nudge')
  // …but the follow-up state is still exposed for the secondary chip.
  assert.equal(a.followUp.kind, 'overdue')
})

test('cardAttention: a this-month deadline is "soon", not "act-now"', () => {
  const a = cardAttention(makeApplication({ status: 'Evaluated', date: ymd(0), deadline: ymd(20) }), NOW)
  assert.equal(a.level, 'soon')
  assert.equal(a.source, 'deadline')
})

// ─── countActNow ─────────────────────────────────────────────────────────────

test('countActNow tallies only the cards that need action today', () => {
  const apps = [
    makeApplication({ status: 'Applied', date: ymd(-14), deadline: 'n/d' }), // overdue nudge → act-now
    makeApplication({ status: 'Applied', date: ymd(0),   deadline: ymd(3) }), // urgent deadline → act-now
    makeApplication({ status: 'Applied', date: ymd(-2),  deadline: ymd(20) }), // this-month → soon
    makeApplication({ status: 'Evaluated', date: ymd(0), deadline: 'n/d' }),  // calm
  ]
  assert.equal(countActNow(apps, NOW), 2)
})
