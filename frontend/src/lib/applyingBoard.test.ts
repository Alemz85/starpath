import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS_GROUPS,
  URGENCY_RANK,
  compareByDeadline,
  groupByStatus,
  getSpawnId,
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
