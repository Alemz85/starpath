import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS_GROUPS,
  URGENCY_RANK,
  FOLLOWUP_CADENCE_DAYS,
  STAGE_FLOW,
  compareByDeadline,
  groupByStatus,
  getSpawnId,
  followUpState,
  cardAttention,
  countActNow,
  stageIndex,
  nextStage,
  stageProgress,
  nextStep,
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

// ─── stage flow / progress ─────────────────────────────────────────────────────

test('STAGE_FLOW mirrors the board lane order exactly', () => {
  assert.deepEqual(STAGE_FLOW, STATUS_GROUPS)
  assert.deepEqual(STAGE_FLOW, ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer'])
})

test('stageIndex locates funnel stages and rejects off-flow statuses', () => {
  assert.equal(stageIndex('Evaluated'), 0)
  assert.equal(stageIndex('Interview'), 3)
  assert.equal(stageIndex('Offer'), 4)
  for (const off of ['Rejected', 'Discarded', 'SKIP'] as AppStatus[]) {
    assert.equal(stageIndex(off), -1, `${off} is off the funnel`)
  }
})

test('nextStage walks the funnel and terminates at Offer', () => {
  assert.equal(nextStage('Evaluated'), 'Applied')
  assert.equal(nextStage('Applied'), 'Responded')
  assert.equal(nextStage('Responded'), 'Interview')
  assert.equal(nextStage('Interview'), 'Offer')
  assert.equal(nextStage('Offer'), null, 'Offer is terminal — nowhere to advance')
  // Off-flow statuses have no next stage.
  for (const off of ['Rejected', 'Discarded', 'SKIP'] as AppStatus[]) {
    assert.equal(nextStage(off), null)
  }
})

test('stageProgress counts cleared stages including the current one', () => {
  assert.deepEqual(stageProgress('Evaluated'), { index: 0, cleared: 1, total: 5, complete: false })
  assert.deepEqual(stageProgress('Responded'), { index: 2, cleared: 3, total: 5, complete: false })
  assert.deepEqual(stageProgress('Offer'),     { index: 4, cleared: 5, total: 5, complete: true })
})

test('stageProgress reports zero cleared for an off-flow row (no false progress)', () => {
  const p = stageProgress('Rejected')
  assert.equal(p.index, -1)
  assert.equal(p.cleared, 0)
  assert.equal(p.complete, false)
})

// ─── nextStep recommendation ────────────────────────────────────────────────────

test('nextStep: Evaluated with no CV nudges toward tailoring first', () => {
  const s = nextStep(makeApplication({ status: 'Evaluated', pdf: false, deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'tailor-cv')
  assert.equal(s.tone, 'normal')
  assert.equal(s.toStage, null)
})

test('nextStep: Evaluated with a CV ready recommends advancing to Applied', () => {
  const s = nextStep(makeApplication({ status: 'Evaluated', pdf: true, deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'advance')
  assert.equal(s.toStage, 'Applied')
  assert.equal(s.label, 'Apply')
})

test('nextStep: Evaluated with an urgent deadline forces "Apply now" even without a CV', () => {
  // A closing deadline outranks the tailor-first nudge — you apply before it shuts.
  const s = nextStep(makeApplication({ status: 'Evaluated', pdf: false, deadline: ymd(3) }), NOW)
  assert.equal(s.kind, 'advance')
  assert.equal(s.toStage, 'Applied')
  assert.equal(s.tone, 'urgent')
  assert.match(s.label, /Apply now/)
})

test('nextStep: Evaluated with a this-month deadline reads as "due" tone', () => {
  const s = nextStep(makeApplication({ status: 'Evaluated', pdf: true, deadline: ymd(20) }), NOW)
  assert.equal(s.kind, 'advance')
  assert.equal(s.tone, 'due')
})

test('nextStep: Applied still waiting recommends logging a reply (calm advance)', () => {
  const s = nextStep(makeApplication({ status: 'Applied', date: ymd(-2), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'advance')
  assert.equal(s.toStage, 'Responded')
  assert.equal(s.tone, 'normal')
})

test('nextStep: Applied past the cadence surfaces an urgent follow-up', () => {
  const s = nextStep(makeApplication({ status: 'Applied', date: ymd(-14), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'draft')
  assert.equal(s.tone, 'urgent')
  assert.equal(s.label, 'Send follow-up')
  assert.match(s.reason, /overdue/)
})

test('nextStep: Responded within the reply window surfaces a due reply', () => {
  // Responded cadence is 3d; day 3 is due-soon (due today).
  const s = nextStep(makeApplication({ status: 'Responded', date: ymd(-3), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'draft')
  assert.equal(s.tone, 'due')
  assert.equal(s.label, 'Reply now')
})

test('nextStep: Responded with the reply handled recommends moving to interview', () => {
  const s = nextStep(makeApplication({ status: 'Responded', date: ymd(0), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'advance')
  assert.equal(s.toStage, 'Interview')
})

test('nextStep: Interview defaults to prep, flips to thank-you once the note is due', () => {
  const prep = nextStep(makeApplication({ status: 'Interview', date: ymd(0), deadline: 'n/d' }), NOW)
  // Interview cadence is 1d → day 0 is due-soon (thank-you due today).
  assert.equal(prep.kind, 'draft')
  assert.equal(prep.label, 'Thank-you note')

  // A future-dated interview row (moved tomorrow) has no due note yet → prep.
  const future = nextStep(makeApplication({ status: 'Interview', date: ymd(5), deadline: 'n/d' }), NOW)
  assert.equal(future.kind, 'prep')
  assert.equal(future.tone, 'normal')
})

test('nextStep: Offer recommends reviewing the offer', () => {
  const s = nextStep(makeApplication({ status: 'Offer', deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'review')
  assert.equal(s.toStage, null)
})

test('nextStep: an off-flow row falls back to a safe review, never crashes', () => {
  for (const off of ['Rejected', 'Discarded', 'SKIP'] as AppStatus[]) {
    const s = nextStep(makeApplication({ status: off }), NOW)
    assert.equal(s.kind, 'review')
    assert.equal(s.toStage, null)
  }
})

// ─── groupByStatus edge cases ────────────────────────────────────────────────

test('groupByStatus with an empty input returns all five empty columns', () => {
  const g = groupByStatus([], NOW)
  for (const s of STATUS_GROUPS) {
    assert.deepEqual(g[s], [], `${s} column should be an empty array`)
  }
})

test('groupByStatus handles multiple entries in different statuses simultaneously', () => {
  const apps = [
    makeApplication({ company: 'A', status: 'Interview', deadline: ymd(2) }),
    makeApplication({ company: 'B', status: 'Interview', deadline: ymd(15) }),
    makeApplication({ company: 'C', status: 'Interview', deadline: 'n/d' }),
  ]
  const col = groupByStatus(apps, NOW).Interview.map(a => a.company)
  // urgent (2d) < month (15d) < none (n/d)
  assert.deepEqual(col, ['A', 'B', 'C'])
})

// ─── compareByDeadline edge cases ─────────────────────────────────────────────

test('compareByDeadline: rolling vs real far-out date — rolling sinks below real upcoming dates', () => {
  // rolling → deadlineUrgency returns 'upcoming' with Infinity deadlineTime
  // a real upcoming date → also 'upcoming' but with a finite time
  // So rolling should sort AFTER the real upcoming date within the same bucket
  const rolling = makeApplication({ deadline: 'rolling' })
  const upcoming = makeApplication({ deadline: ymd(60) })
  // They are in the same urgency bucket ('upcoming'); rolling has Infinity time
  assert.ok(compareByDeadline(upcoming, rolling, NOW) < 0, 'real upcoming date floats above rolling')
})

test('compareByDeadline: two n/d entries with same urgency produce NaN (Infinity - Infinity)', () => {
  // Both are 'none' urgency, so ra === rb (rank tie). Then the tie-break is
  // deadlineTime(n/d) - deadlineTime(n/d) = +Infinity - +Infinity = NaN.
  // This is the current behavior; sort() treats NaN as 0 (stable), so the
  // relative order of no-deadline rows is stable in practice.
  const a = makeApplication({ deadline: 'n/d' })
  const b = makeApplication({ deadline: 'n/d' })
  assert.ok(isNaN(compareByDeadline(a, b, NOW)))
})

// ─── getSpawnId edge cases ─────────────────────────────────────────────────────

test('getSpawnId is stable across repeated calls for the same app', () => {
  const app = makeApplication({ company: 'Stripe', role: 'Risk Analyst' })
  const id1 = getSpawnId('tailor', app)
  const id2 = getSpawnId('tailor', app)
  assert.equal(id1, id2)
})

test('getSpawnId collapses numbers + alphanumeric chars cleanly', () => {
  const app = makeApplication({ company: 'X1 Corp', role: 'ML Eng-2' })
  const id = getSpawnId('p', app)
  // non-alphanumeric chars become dashes; consecutive non-alphanumeric collapse
  assert.equal(id, 'p-x1-corp-ml-eng-2')
})

// ─── followUpState: Responded cadence ─────────────────────────────────────────

test('followUpState: Responded waits 3d, then goes due, then overdue', () => {
  // Day 1 → still waiting (cadence is 3)
  const waiting = followUpState(makeApplication({ status: 'Responded', date: ymd(-1) }), NOW)
  assert.equal(waiting.kind, 'waiting')
  assert.equal(waiting.dueInDays, 2)

  // Day 3 → due today
  const dueToday = followUpState(makeApplication({ status: 'Responded', date: ymd(-3) }), NOW)
  assert.equal(dueToday.kind, 'due-soon')
  assert.equal(dueToday.dueInDays, 0)
  assert.match(dueToday.reason, /due today/i)

  // Day 2 → due tomorrow (within 1-day due-soon window)
  const dueTomorrow = followUpState(makeApplication({ status: 'Responded', date: ymd(-2) }), NOW)
  assert.equal(dueTomorrow.kind, 'due-soon')
  assert.equal(dueTomorrow.dueInDays, 1)
  assert.match(dueTomorrow.reason, /tomorrow/i)

  // Day 5 → 2 days overdue
  const overdue = followUpState(makeApplication({ status: 'Responded', date: ymd(-5) }), NOW)
  assert.equal(overdue.kind, 'overdue')
  assert.equal(overdue.dueInDays, -2)
  assert.match(overdue.reason, /2d overdue/i)
  assert.match(overdue.reason, /reply/i)
})

// ─── cardAttention: follow-up wins when deadline is calm ──────────────────────

test('cardAttention: overdue follow-up at a calm deadline → followup source', () => {
  // Responded, 5 days ago (overdue), no deadline
  const a = cardAttention(makeApplication({ status: 'Responded', date: ymd(-5), deadline: 'n/d' }), NOW)
  assert.equal(a.level, 'act-now')
  assert.equal(a.source, 'followup')
})

test('cardAttention: due-soon follow-up at a calm deadline → soon via followup', () => {
  // Responded exactly 2 days ago → dueInDays=1 (due-soon)
  const a = cardAttention(makeApplication({ status: 'Responded', date: ymd(-2), deadline: 'n/d' }), NOW)
  assert.equal(a.level, 'soon')
  assert.equal(a.source, 'followup')
})

test('cardAttention: both clocks calm → level=calm, source=null', () => {
  const a = cardAttention(makeApplication({ status: 'Evaluated', date: ymd(0), deadline: 'n/d' }), NOW)
  assert.equal(a.level, 'calm')
  assert.equal(a.source, null)
  assert.equal(a.reason, '')
})

// ─── nextStep: Evaluated with month deadline + no CV → 'due' tone ─────────────

test('nextStep: Evaluated with a this-month deadline and no CV → tailor-cv with due tone', () => {
  const s = nextStep(makeApplication({ status: 'Evaluated', pdf: false, deadline: ymd(20) }), NOW)
  assert.equal(s.kind, 'tailor-cv')
  assert.equal(s.tone, 'due')
})

// ─── nextStep: Applied due-soon (not yet overdue) ─────────────────────────────

test('nextStep: Applied due-soon (day 6 of 7) → draft with due tone', () => {
  const s = nextStep(makeApplication({ status: 'Applied', date: ymd(-6), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'draft')
  assert.equal(s.tone, 'due')
  assert.equal(s.label, 'Send follow-up')
})

// ─── nextStep: Interview due-soon thank-you note ──────────────────────────────

test('nextStep: Interview due-soon (cadence 1d, moved exactly yesterday) → thank-you note, due tone', () => {
  const s = nextStep(makeApplication({ status: 'Interview', date: ymd(-1), deadline: 'n/d' }), NOW)
  assert.equal(s.kind, 'draft')
  assert.equal(s.tone, 'due')
  assert.equal(s.label, 'Thank-you note')
})

// ─── stageProgress: all stages ────────────────────────────────────────────────

test('stageProgress covers every in-flow stage without gaps', () => {
  const expectedCleared = [1, 2, 3, 4, 5]
  STATUS_GROUPS.forEach((s, i) => {
    const p = stageProgress(s)
    assert.equal(p.index, i)
    assert.equal(p.cleared, expectedCleared[i])
    assert.equal(p.total, 5)
    assert.equal(p.complete, s === 'Offer')
  })
})

// ─── countActNow edge cases ────────────────────────────────────────────────────

test('countActNow returns 0 for an empty list', () => {
  assert.equal(countActNow([], NOW), 0)
})

test('countActNow returns 0 when all cards are calm', () => {
  const apps = [
    makeApplication({ status: 'Evaluated', date: ymd(0), deadline: 'n/d' }),
    makeApplication({ status: 'Offer',     date: ymd(0), deadline: 'n/d' }),
  ]
  assert.equal(countActNow(apps, NOW), 0)
})
