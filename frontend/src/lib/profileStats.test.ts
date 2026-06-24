// Pin the timezone before anything touches Date — buildHeatmap mixes local
// day arithmetic with UTC date strings, so a fixed TZ keeps the grid
// assertions deterministic across machines/CI.
process.env.TZ = 'UTC'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tierHeatColor,
  buildHeatmap,
  computeStreak,
  longestStreak,
  badges,
  buildHighlights,
} from '@/lib/profileStats'
import { TIER_HEX } from '@/lib/tier'
import { makeScoreEntry, makeApplication } from '@/test-utils/fixtures'

const NOW = new Date('2026-06-24T00:00:00Z')

// ─── tierHeatColor ────────────────────────────────────────────────────────────

test('tierHeatColor: empty days are the panel wash, scored days take the tier hue', () => {
  assert.equal(tierHeatColor('', 0), '#F1F4F7')
  assert.equal(tierHeatColor('T1', 3), TIER_HEX.T1)
  assert.equal(tierHeatColor('T2-high', 1), TIER_HEX['T2-high'])
  assert.equal(tierHeatColor('???', 1), TIER_HEX.T4)   // unknown tier → faded slate
})

// ─── buildHeatmap ─────────────────────────────────────────────────────────────

function cellFor(weeks: { date: string; count: number; bestTier: string }[][], date: string) {
  return weeks.flat().find(c => c.date === date)
}

test('buildHeatmap returns a rectangular Sun-aligned grid of 7-day weeks', () => {
  const weeks = buildHeatmap([], NOW)
  assert.ok(weeks.length >= 13)               // ~90 days ≈ 13–14 weeks
  assert.ok(weeks.every(w => w.length === 7)) // every week is full
})

test('buildHeatmap aggregates count and keeps the best tier per day', () => {
  const weeks = buildHeatmap([
    makeScoreEntry({ date: '2026-06-20', tier: 'T3' }),
    makeScoreEntry({ date: '2026-06-20', tier: 'T1' }),  // same day, stronger tier
    makeScoreEntry({ date: '2026-06-20', tier: 'T4' }),
  ], NOW)
  const cell = cellFor(weeks, '2026-06-20')
  assert.equal(cell?.count, 3)
  assert.equal(cell?.bestTier, 'T1')          // highest TIER_RANK wins
})

test('buildHeatmap leaves untouched days at count 0', () => {
  const weeks = buildHeatmap([makeScoreEntry({ date: '2026-06-20', tier: 'T2' })], NOW)
  assert.equal(cellFor(weeks, '2026-06-19')?.count, 0)
})

// ─── computeStreak ────────────────────────────────────────────────────────────

test('computeStreak counts consecutive days ending today', () => {
  const streak = computeStreak([
    makeScoreEntry({ date: '2026-06-24' }),
    makeScoreEntry({ date: '2026-06-23' }),
    makeScoreEntry({ date: '2026-06-22' }),
  ], NOW)
  assert.equal(streak, 3)
})

test('computeStreak collapses multiple evals on the same day', () => {
  const streak = computeStreak([
    makeScoreEntry({ date: '2026-06-24', company: 'A' }),
    makeScoreEntry({ date: '2026-06-24', company: 'B' }),
    makeScoreEntry({ date: '2026-06-23' }),
  ], NOW)
  assert.equal(streak, 2)
})

test('computeStreak breaks on a gap', () => {
  const streak = computeStreak([
    makeScoreEntry({ date: '2026-06-24' }),
    makeScoreEntry({ date: '2026-06-22' }),  // 23rd missing
  ], NOW)
  assert.equal(streak, 1)
})

test('computeStreak is 0 when nothing landed today (the streak you are on)', () => {
  assert.equal(computeStreak([makeScoreEntry({ date: '2026-06-23' })], NOW), 0)
  assert.equal(computeStreak([], NOW), 0)
})

// ─── longestStreak (all-time, badge-facing) ──────────────────────────────────

test('longestStreak finds the best historical run, ignoring recency', () => {
  // A 5-day run back in January, then a long gap, then a recent single day.
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-06-24']
  assert.equal(longestStreak(days.map(date => makeScoreEntry({ date }))), 5)
})

test('longestStreak: collapses same-day duplicates and takes the max of multiple runs', () => {
  const days = [
    '2026-02-01', '2026-02-01',                 // dup → one day
    '2026-02-02', '2026-02-03',                 // run of 3 (Feb 1–3)
    '2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13',  // run of 4
  ]
  assert.equal(longestStreak(days.map(date => makeScoreEntry({ date }))), 4)
})

test('longestStreak: single day is 1, empty is 0, scattered singles are 1', () => {
  assert.equal(longestStreak([makeScoreEntry({ date: '2026-06-24' })]), 1)
  assert.equal(longestStreak([]), 0)
  assert.equal(longestStreak(['2026-01-01', '2026-03-01', '2026-09-01'].map(date => makeScoreEntry({ date }))), 1)
})

test('longestStreak: ignores malformed date strings', () => {
  const out = longestStreak([
    makeScoreEntry({ date: '2026-06-22' }),
    makeScoreEntry({ date: 'not-a-date' }),
    makeScoreEntry({ date: '2026-06-23' }),
  ])
  assert.equal(out, 2)  // the two valid consecutive days
})

// ─── badges ───────────────────────────────────────────────────────────────────

test('badges unlock on evaluation-count and tier thresholds', () => {
  const history = Array.from({ length: 12 }, (_, i) =>
    makeScoreEntry({ date: '2026-06-24', tier: i === 0 ? 'T1' : 'T3', company: `C${i}` }))
  const map = Object.fromEntries(badges(history, []).map(b => [b.id, b.unlocked]))
  assert.equal(map.first, true)    // ≥1
  assert.equal(map.ten, true)      // ≥10
  assert.equal(map.fifty, false)   // <50
  assert.equal(map.t1first, true)  // one T1 present
  assert.equal(map.t1five, false)
})

test('badges reflect application status progression', () => {
  const apps = [
    makeApplication({ company: 'A', status: 'Applied' }),
    makeApplication({ company: 'B', status: 'Interview' }),
    makeApplication({ company: 'C', status: 'Offer' }),
  ]
  const map = Object.fromEntries(badges([makeScoreEntry()], apps).map(b => [b.id, b.unlocked]))
  assert.equal(map.applied, true)
  assert.equal(map.interview, true)
  assert.equal(map.offer, true)
})

test('the streak badge stays earned after a day off (achievement, not current state)', () => {
  // A 3-day run that ENDED days ago — nothing landed "today".
  const history = ['2026-06-10', '2026-06-11', '2026-06-12'].map(date => makeScoreEntry({ date }))
  // The live current streak is 0 (the header would show no active streak)…
  assert.equal(computeStreak(history, NOW), 0)
  // …but the badge stays unlocked, because it keys off the all-time longest run.
  const streakBadge = badges(history, []).find(b => b.id === 'streak')
  assert.equal(streakBadge?.unlocked, true)
})

// ─── buildHighlights ──────────────────────────────────────────────────────────

test('buildHighlights returns null below 3 scored evaluations', () => {
  assert.equal(buildHighlights([makeScoreEntry({ overall: 8 }), makeScoreEntry({ overall: 7 })]), null)
})

test('buildHighlights surfaces top score, most-explored company, busiest day', () => {
  const hl = buildHighlights([
    makeScoreEntry({ company: 'Stripe', overall: 9.2, date: '2026-06-20' }),
    makeScoreEntry({ company: 'Stripe', overall: 6.0, date: '2026-06-20' }),
    makeScoreEntry({ company: 'Acme',   overall: 7.1, date: '2026-06-19' }),
  ])
  assert.ok(hl)
  const byLabel = Object.fromEntries(hl!.map(h => [h.label, h]))
  assert.equal(byLabel['Top score'].value, '9.2')
  assert.equal(byLabel['Top score'].sub, 'Stripe')
  assert.equal(byLabel['Most explored'].value, 'Stripe')      // 2 rows
  assert.equal(byLabel['Most explored'].sub, '2 evaluations')
  assert.equal(byLabel['Busiest day'].sub, '2 in one day')    // 2026-06-20
})
