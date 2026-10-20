import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  boardLabel,
  STATUS_GROUPS,
  URGENCY_RANK,
  compareByDeadline,
  groupByStatus,
  boardMoveTarget,
  inferredRejectionLabel,
  rejectionInfo,
  rejectionStageOptions,
  stagesFor,
} from '@/lib/applyingBoard'
import type { StatusLogEntry } from '@/lib/statusLog'
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

test('STATUS_GROUPS is the five live stages then Rejected, in board order', () => {
  assert.deepEqual(STATUS_GROUPS, ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected'])
  for (const closed of ['SKIP', 'Discarded'] as AppStatus[]) {
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

test('groupByStatus buckets board statuses and drops SKIP / Discarded', () => {
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
  assert.equal(g.Rejected.length, 1)
  // SKIP and Discarded never become board columns.
  assert.equal((g as Record<string, unknown>).SKIP, undefined)
  assert.equal((g as Record<string, unknown>).Discarded, undefined)
  const total = STATUS_GROUPS.reduce((n, s) => n + g[s].length, 0)
  assert.equal(total, 4, 'SKIP and Discarded are dropped from the board')
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

test('groupByStatus with an empty input returns every column empty', () => {
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

test('groupByStatus puts the newest rejection first, by logged date, else the row date', () => {
  const apps = [
    makeApplication({ company: 'Old', status: 'Rejected', date: '2026-03-01' }),
    makeApplication({ company: 'Logged', status: 'Rejected', date: '2026-01-01' }),
    makeApplication({ company: 'Recent', status: 'Rejected', date: '2026-05-01' }),
  ]
  const on = (a: { company: string }) => (a.company === 'Logged' ? '2026-06-01' : null)
  assert.deepEqual(groupByStatus(apps, NOW, on).Rejected.map(a => a.company), ['Logged', 'Recent', 'Old'])
})

// ─── Rejections ──────────────────────────────────────────────────────────────

const entry = (over: Partial<StatusLogEntry>): StatusLogEntry => ({
  num: 1, date: '2026-06-01', company: 'Nimbus Robotics', role: 'Strategy Analyst',
  from: '', to: 'Evaluated', stage: '', source: 'app', note: '', logged_at: '2026-06-01T10:00:00Z',
  ...over,
})

test('rejectionInfo infers the stage from the status it left', () => {
  const app = makeApplication({ num: 1, company: 'Nimbus Robotics', role: 'Strategy Analyst', status: 'Rejected' })
  const log = [
    entry({ to: 'Applied', from: 'Evaluated', date: '2026-06-02' }),
    entry({ to: 'Interview', from: 'Applied', date: '2026-06-10' }),
    entry({ to: 'Rejected', from: 'Interview', date: '2026-06-20' }),
  ]
  assert.deepEqual(rejectionInfo(log, app), { date: '2026-06-20', from: 'Interview', stage: '', label: 'after interviewing' })
})

test('rejectionInfo: a picked stage wins; no log entry reads as not recorded', () => {
  const app = makeApplication({ num: 1, company: 'Nimbus Robotics', role: 'Strategy Analyst', status: 'Rejected' })
  const log = [entry({ to: 'Rejected', from: 'Interview', date: '2026-06-20', stage: 'after the final round' })]
  assert.equal(rejectionInfo(log, app)?.label, 'after the final round')
  assert.equal(rejectionInfo(log, app)?.stage, 'after the final round')
  assert.deepEqual(rejectionInfo([], app), { date: null, from: '', stage: '', label: 'stage unknown' })
  assert.equal(rejectionInfo(log, makeApplication({ status: 'Applied' })), null)
})

test('rejectionStageOptions fit the stage it was rejected from', () => {
  assert.ok(rejectionStageOptions('Interview').includes('after the final round'))
  assert.ok(!rejectionStageOptions('Applied').includes('after the final round'))
  assert.ok(rejectionStageOptions('Applied').includes('at the CV screen'))
  assert.ok(rejectionStageOptions('').length >= rejectionStageOptions('Interview').length)
  assert.equal(inferredRejectionLabel('Responded'), 'after they replied')
})

test('an Evaluated card cannot be rejected: the move becomes Discarded and the dropdown omits Rejected', () => {
  assert.equal(boardMoveTarget('Evaluated', 'Rejected'), 'Discarded')
  assert.equal(boardMoveTarget('Applied', 'Rejected'), 'Rejected')
  assert.equal(boardMoveTarget('Evaluated', 'Applied'), 'Applied')
  assert.ok(!stagesFor('Evaluated').includes('Rejected'))
  assert.ok(stagesFor('Applied').includes('Rejected'))
  assert.ok(stagesFor('Rejected').includes('Rejected'))
})

test('a logged Evaluated → Rejected move reads as no rejection on record', () => {
  const app = makeApplication({ num: 1, company: 'Nimbus Robotics', role: 'Strategy Analyst', status: 'Rejected' })
  const log = [entry({ to: 'Rejected', from: 'Evaluated', date: '2026-06-20' })]
  assert.deepEqual(rejectionInfo(log, app), { date: null, from: '', stage: '', label: 'stage unknown' })
})

test('boardLabel: Evaluated reads as "To apply" on the board, other statuses unchanged', () => {
  assert.equal(boardLabel('Evaluated'), 'To apply')
  assert.equal(boardLabel('Applied'), 'Applied')
  assert.equal(boardLabel('Rejected'), 'Rejected')
})
