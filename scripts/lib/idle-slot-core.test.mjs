import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  usageHistogram, awakeHistogram, parsePmsetAwake, rankSlots, daysPerWeekday,
  formatSlot, slotIndex, FALLBACK_SLOT,
} from './idle-slot-core.mjs'

// Local-time helpers: the module buckets by local weekday/hour, so the tests
// build dates the same way and pass in any time zone.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
// 2026-10-26 is a Monday; the 8 weeks before it are Mon 2026-08-31 .. Sun 2026-10-25.
const NOW = at(2026, 10, 26, 12)
const WEEK0_MONDAY = at(2026, 8, 31)

/** Timestamps for "active" on the given weekday/hours in each of 8 weeks. */
function weeklyActivity(spec, weeks = 8) {
  const out = []
  for (let w = 0; w < weeks; w++) {
    for (const [weekday, hours] of Object.entries(spec)) {
      const offset = (Number(weekday) + 6) % 7 // Monday-based day offset
      for (const h of hours) {
        out.push(at(2026, 8, 31 + w * 7 + offset, h, 10 + (h % 40)))
      }
    }
  }
  return out
}

test('formatSlot names weekday and zero-pads the time', () => {
  assert.equal(formatSlot({ weekday: 2, hour: 9, minute: 0 }), 'Tuesday 09:00')
  assert.equal(formatSlot({ weekday: 0, hour: 17, minute: 5 }), 'Sunday 17:05')
})

test('daysPerWeekday counts calendar days per weekday', () => {
  const c = daysPerWeekday(WEEK0_MONDAY, at(2026, 10, 25, 23))
  assert.deepEqual(c, [8, 8, 8, 8, 8, 8, 8])
})

test('usageHistogram counts distinct active days per slot, not messages', () => {
  // 40 messages inside one Monday-10:00 hour is one active day.
  const burst = Array.from({ length: 40 }, (_, i) => at(2026, 10, 19, 10, i % 60))
  const u = usageHistogram(burst, { now: NOW, weeks: 8 })
  assert.equal(u.activeDays[slotIndex(1, 10)], 1)
  assert.equal(u.total, 40)
  // First timestamp is Oct 19, so only ~1 Monday of history counts, not 8.
  assert.equal(u.dayCounts[1], 2)
})

test('usageHistogram ignores timestamps outside the window and in the future', () => {
  const u = usageHistogram([at(2026, 1, 5, 9), at(2026, 11, 2, 9), at(2026, 10, 20, 9)], { now: NOW, weeks: 8 })
  assert.equal(u.total, 1)
})

test('usageHistogram drops timestamps inside excluded windows (our own earlier runs)', () => {
  const run = { start: at(2026, 10, 20, 9), end: at(2026, 10, 20, 11) }
  const u = usageHistogram([at(2026, 10, 20, 9, 30), at(2026, 10, 20, 14)], { now: NOW, weeks: 8, excludeWindows: [run] })
  assert.equal(u.total, 1)
  assert.equal(u.activeDays[slotIndex(2, 9)], 0)
  assert.equal(u.activeDays[slotIndex(2, 14)], 1)
})

test('parsePmsetAwake: Wake..Sleep is awake, DarkWake maintenance is not', () => {
  const log = [
    '2026-10-19 01:52:59 +0200 DarkWake            \tDarkWake from Deep Idle [CDNPB] : due to rtc/Maintenance Using AC',
    '2026-10-19 02:06:16 +0200 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\':TCPKeepAlive=active',
    '2026-10-19 02:06:18 +0200 Wake Requests       \t[process=dasd request=SleepService deltaSecs=947]',
    '2026-10-19 08:30:00 +0200 Wake                \tWake from Deep Idle [CDNVA] : due to lid UserActivity Assertion',
    '2026-10-19 08:30:05 +0200 Notification        \tDisplay is turned on     ',
    '2026-10-19 12:00:00 +0200 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\'',
  ].join('\n')
  const { intervals, from } = parsePmsetAwake(log, { now: Date.parse('2026-10-20T00:00:00+02:00') })
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].start, Date.parse('2026-10-19T08:30:00+02:00'))
  assert.equal(intervals[0].end, Date.parse('2026-10-19T12:00:00+02:00'))
  assert.equal(from, Date.parse('2026-10-19T01:52:59+02:00'))
})

test('parsePmsetAwake closes a still-open wake at now and treats Display-on as a wake', () => {
  const log = '2026-10-19 09:00:00 +0200 Notification        \tDisplay is turned on'
  const now = Date.parse('2026-10-19T10:00:00+02:00')
  const { intervals } = parsePmsetAwake(log, { now })
  assert.deepEqual(intervals, [{ start: Date.parse('2026-10-19T09:00:00+02:00'), end: now }])
})

test('awakeHistogram marks each touched hour once per day and borrows pooled hours when a weekday has few days', () => {
  const from = at(2026, 10, 19) // Monday
  const now = at(2026, 10, 26) // next Monday: Mon..Sun once each, plus Monday again at 00:00
  const ivs = [
    { start: at(2026, 10, 19, 8, 30), end: at(2026, 10, 19, 10, 15) },
    { start: at(2026, 10, 20, 9, 0), end: at(2026, 10, 20, 10, 0) },
  ]
  const a = awakeHistogram(ivs, { from, now })
  assert.equal(a.awakeDays[slotIndex(1, 8)], 1)
  assert.equal(a.awakeDays[slotIndex(1, 9)], 1)
  assert.equal(a.awakeDays[slotIndex(1, 10)], 1)
  assert.equal(a.awakeDays[slotIndex(1, 11)], 0)
  // One sample per weekday (< minDays) -> pooled by hour of day: 09:00 awake on 2 of 8 counted days.
  assert.ok(a.fraction[slotIndex(5, 9)] > 0, 'Friday 09 borrows the pooled 09:00 fraction')
  assert.equal(a.fraction[slotIndex(5, 9)], a.pooled[9])
})

test('rankSlots picks the least-used usually-awake hour and shows its evidence', () => {
  // Busy every day 10:00-18:00 and 20:00-23:00; quiet before 10 and at 19.
  const busy = [10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23]
  const spec = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, busy]))
  const usage = usageHistogram(weeklyActivity(spec), { now: NOW, weeks: 8 })
  // Mac awake 08:00-23:59 every day, asleep before.
  const ivs = []
  for (let d = 0; d < 56; d++) ivs.push({ start: at(2026, 8, 31 + d, 8), end: at(2026, 8, 31 + d, 24) })
  const awake = awakeHistogram(ivs, { from: WEEK0_MONDAY, now: NOW })
  const r = rankSlots({ usage, awake })
  assert.equal(r.picks.length, 3)
  assert.equal(new Set(r.picks.map((p) => p.weekday)).size, 3, 'one pick per weekday')
  for (const p of r.picks) {
    assert.ok(p.hour >= 8 && p.hour <= 9, `hour ${p.hour} is in the awake, quiet morning window`)
  }
  // 08:00 has a free neighbour hour (09:00), 09:00 has a busy one (10:00): 08:00 wins.
  assert.equal(r.picks[0].hour, 8)
  assert.equal(r.picks[0].usedDays, 0)
  assert.match(r.picks[0].evidence, /on 0 of 8/)
  assert.equal(r.fallback, false)
})

test('rankSlots never picks an hour the Mac is usually asleep, even if it is the quietest', () => {
  const spec = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]]))
  const usage = usageHistogram(weeklyActivity(spec), { now: NOW, weeks: 8 })
  const ivs = []
  for (let d = 0; d < 56; d++) ivs.push({ start: at(2026, 8, 31 + d, 9), end: at(2026, 8, 31 + d, 22) })
  const awake = awakeHistogram(ivs, { from: WEEK0_MONDAY, now: NOW })
  const r = rankSlots({ usage, awake })
  for (const p of r.picks) assert.ok(p.hour >= 9 && p.hour <= 21, `picked ${p.hour}:00 while the Mac sleeps`)
})

test('rankSlots without a power log skips the small hours', () => {
  const usage = usageHistogram(weeklyActivity({ 1: [10] }), { now: NOW, weeks: 8 })
  const r = rankSlots({ usage, awake: null })
  for (const p of r.picks) assert.ok(p.hour >= 7)
  assert.equal(r.picks[0].awakeFraction, null)
})

test('rankSlots falls back to the default slot with no data at all', () => {
  const usage = usageHistogram([], { now: NOW, weeks: 8 })
  const empty = { ...usage, dayCounts: new Array(7).fill(0) }
  const r = rankSlots({ usage: empty, awake: null })
  assert.equal(r.fallback, true)
  assert.equal(r.picks[0].weekday, FALLBACK_SLOT.weekday)
  assert.equal(r.picks[0].hour, FALLBACK_SLOT.hour)
  assert.equal(r.confidence, 'low')
})

test('rankSlots confidence is low on thin data', () => {
  const usage = usageHistogram(weeklyActivity({ 1: [10] }, 2), { now: NOW, weeks: 8 })
  assert.equal(rankSlots({ usage, awake: null }).confidence, 'low')
})
