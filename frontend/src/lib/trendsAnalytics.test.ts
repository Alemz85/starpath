import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterByDateWindow,
  avg, median,
  buildByDate, buildTopBy, isNoiseLabel,
  buildDistribution, SCORE_BANDS,
  buildFunnel,
  buildDimensionProfile, PROFILE_DIMENSIONS, MIN_WINNERS_FOR_DELTA, APPLY_THRESHOLD,
  buildTargetingMomentum, MIN_PER_HALF_FOR_MOMENTUM, MOMENTUM_DEADBAND,
  buildArchetypeMix, MIN_PER_HALF_FOR_MIX,
  isoToFlag, locationFlag,
} from '@/lib/trendsAnalytics'
import { makeScoreEntry, makeApplication } from '@/test-utils/fixtures'

// A fixed clock so the time-window cutoffs are exact and TZ-independent.
// Dates are stored as YYYY-MM-DD and compared as ISO prefixes, so the diff
// math is absolute.
const NOW = new Date('2026-06-25T12:00:00Z')

// ─── filterByDateWindow ──────────────────────────────────────────────────────

test('filterByDateWindow returns the input untouched for "all"', () => {
  const rows = [makeScoreEntry({ date: '2020-01-01' }), makeScoreEntry({ date: '2026-06-25' })]
  const out = filterByDateWindow(rows, 'all', NOW)
  assert.equal(out, rows)            // same reference, no copy
  assert.equal(out.length, 2)
})

test('filterByDateWindow keeps rows inside the trailing window, drops older', () => {
  // 30-day window from 2026-06-25. The exact cutoff day is TZ-sensitive
  // (the filter computes it via local-midnight `setHours`, matching the
  // original view), so assert rows that sit unambiguously inside/outside
  // the boundary rather than pinning the boundary day itself.
  const rows = [
    makeScoreEntry({ date: '2026-06-25' }),  // today — in
    makeScoreEntry({ date: '2026-06-10' }),  // ~15 days ago — in
    makeScoreEntry({ date: '2026-04-20' }),  // ~66 days ago — out
    makeScoreEntry({ date: '2026-01-01' }),  // way out
  ]
  const out = filterByDateWindow(rows, '1m', NOW)
  assert.deepEqual(out.map(r => r.date), ['2026-06-25', '2026-06-10'])
})

test('filterByDateWindow drops rows with no date', () => {
  const rows = [makeScoreEntry({ date: '' }), makeScoreEntry({ date: '2026-06-20' })]
  const out = filterByDateWindow(rows, '6m', NOW)
  assert.deepEqual(out.map(r => r.date), ['2026-06-20'])
})

test('filterByDateWindow works on any dated row (applications)', () => {
  const apps = [
    makeApplication({ date: '2026-06-20' }),
    makeApplication({ date: '2024-06-20' }),
  ]
  const out = filterByDateWindow(apps, '1y', NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].date, '2026-06-20')
})

// ─── avg / median ────────────────────────────────────────────────────────────

test('avg averages a numeric field and returns 0 for an empty set', () => {
  const rows = [makeScoreEntry({ overall: 6 }), makeScoreEntry({ overall: 8 })]
  assert.equal(avg(rows, 'overall'), 7)
  assert.equal(avg([], 'overall'), 0)
})

test('median handles odd, even, and empty sets', () => {
  assert.equal(median([5, 1, 3].map(o => makeScoreEntry({ overall: o })), 'overall'), 3)
  assert.equal(median([1, 2, 3, 4].map(o => makeScoreEntry({ overall: o })), 'overall'), 2.5)
  assert.equal(median([], 'overall'), 0)
})

test('median is robust to a skewed tail where the mean is not', () => {
  const rows = [2, 2, 2, 2, 10].map(o => makeScoreEntry({ overall: o }))
  assert.equal(median(rows, 'overall'), 2)            // the typical value
  assert.equal(avg(rows, 'overall'), 3.6)             // dragged up by the 10
})

// ─── buildByDate ─────────────────────────────────────────────────────────────

test('buildByDate buckets by calendar day, sorted ascending, with per-day averages', () => {
  const rows = [
    makeScoreEntry({ date: '2026-06-02', overall: 8, current_fit: 7 }),
    makeScoreEntry({ date: '2026-06-01', overall: 6, current_fit: 5 }),
    makeScoreEntry({ date: '2026-06-02', overall: 6, current_fit: 9 }),
  ]
  const out = buildByDate(rows)
  assert.deepEqual(out.map(b => b.label), ['2026-06-01', '2026-06-02'])
  assert.equal(out[0].count, 1)
  assert.equal(out[1].count, 2)
  assert.equal(out[1].avg_overall, 7)       // (8 + 6) / 2
  assert.equal(out[1].avg_current_fit, 8)   // (7 + 9) / 2
})

test('buildByDate slices a datetime stamp down to the day and ignores undated rows', () => {
  const rows = [
    makeScoreEntry({ date: '2026-06-02T14:00:00Z', overall: 8 }),
    makeScoreEntry({ date: '', overall: 9 }),
  ]
  const out = buildByDate(rows)
  assert.equal(out.length, 1)
  assert.equal(out[0].label, '2026-06-02')
})

// ─── isNoiseLabel / buildTopBy ───────────────────────────────────────────────

test('isNoiseLabel flags blanks, n/d, dashes and "unknown" case-insensitively', () => {
  for (const s of ['', '  ', 'n/d', 'N/D', '—', '-', 'Unknown']) assert.equal(isNoiseLabel(s), true, s)
  for (const s of ['Stripe', 'Remote', 'Dublin']) assert.equal(isNoiseLabel(s), false, s)
})

test('buildTopBy ranks by avg score desc, breaks ties on count, and honours the limit', () => {
  const rows = [
    makeScoreEntry({ company: 'Alpha', overall: 9 }),
    makeScoreEntry({ company: 'Alpha', overall: 9 }),   // Alpha avg 9, n=2
    makeScoreEntry({ company: 'Beta',  overall: 9 }),   // Beta  avg 9, n=1
    makeScoreEntry({ company: 'Gamma', overall: 6 }),   // Gamma avg 6, n=1
  ]
  const out = buildTopBy(rows, e => e.company, 2)
  assert.equal(out.length, 2)
  // Alpha and Beta tie on avg 9; Alpha wins on count, Gamma drops off the limit.
  assert.deepEqual(out.map(r => r.label), ['Alpha', 'Beta'])
  assert.equal(out[0].count, 2)
})

test('buildTopBy skips noise labels and zero-score-only groups', () => {
  const rows = [
    makeScoreEntry({ company: 'n/d', overall: 9 }),     // noise key — dropped
    makeScoreEntry({ company: 'Zero', overall: 0 }),    // avg 0 — filtered out
    makeScoreEntry({ company: 'Real', overall: 7 }),
  ]
  const out = buildTopBy(rows, e => e.company, 6)
  assert.deepEqual(out.map(r => r.label), ['Real'])
})

// ─── buildDistribution ───────────────────────────────────────────────────────

test('SCORE_BANDS tile the score line without gaps or overlap', () => {
  for (let i = 1; i < SCORE_BANDS.length; i++) {
    assert.equal(SCORE_BANDS[i].lo, SCORE_BANDS[i - 1].hi, `band ${i} should start where the previous ends`)
  }
  // Only the three ≥7 bands are apply-worthy.
  assert.deepEqual(SCORE_BANDS.map(b => b.applyWorthy), [false, false, true, true, true])
})

test('buildDistribution bins scores, excludes non-positive overalls, and computes applyPct', () => {
  const rows = [
    makeScoreEntry({ overall: 4 }),   // sub-floor
    makeScoreEntry({ overall: 6 }),   // below bar
    makeScoreEntry({ overall: 7 }),   // decent (apply-worthy)
    makeScoreEntry({ overall: 8.5 }), // good (apply-worthy)
    makeScoreEntry({ overall: 9.5 }), // stellar (apply-worthy)
    makeScoreEntry({ overall: 0 }),   // legacy/unscored — excluded
  ]
  const dist = buildDistribution(rows)
  assert.equal(dist.total, 5)                              // the 0 is excluded
  assert.deepEqual(dist.bands.map(b => b.count), [1, 1, 1, 1, 1])
  assert.equal(dist.applyPct, 60)                          // 3 of 5
  assert.equal(dist.max, 1)
  assert.equal(dist.median, 7)                             // median of [4,6,7,8.5,9.5]
})

test('buildDistribution puts a boundary score in the upper band (lo inclusive)', () => {
  // 7.0 is exactly the apply threshold → "decent" (7–8), not "below bar".
  const dist = buildDistribution([makeScoreEntry({ overall: 7 })])
  const decent = dist.bands.find(b => b.key === 'decent')!
  assert.equal(decent.count, 1)
  assert.equal(dist.applyPct, 100)
})

test('buildDistribution over an empty corpus is all-zero, not NaN', () => {
  const dist = buildDistribution([])
  assert.equal(dist.total, 0)
  assert.equal(dist.applyPct, 0)
  assert.equal(dist.max, 1)        // floored at 1 so bar scaling never divides by zero
  assert.equal(dist.median, 0)
})

// ─── buildFunnel ─────────────────────────────────────────────────────────────

test('buildFunnel counts cumulative stage-reach from current statuses', () => {
  const apps = [
    makeApplication({ status: 'Applied' }),
    makeApplication({ status: 'Responded' }),
    makeApplication({ status: 'Interview' }),
    makeApplication({ status: 'Offer' }),
    makeApplication({ status: 'Rejected' }),
    makeApplication({ status: 'Evaluated' }),   // never sent — counts nowhere
  ]
  const f = buildFunnel(apps)
  // Applied/Responded/Interview/Offer/Rejected all imply "sent"; Evaluated doesn't.
  assert.equal(f.sent, 5)
  assert.equal(f.responded, 3)   // Responded, Interview, Offer
  assert.equal(f.interview, 2)   // Interview, Offer
  assert.equal(f.offer, 1)
  assert.equal(f.rejected, 1)
})

test('buildFunnel does not count a rejection as a real response', () => {
  const f = buildFunnel([makeApplication({ status: 'Rejected' })])
  assert.equal(f.sent, 1)
  assert.equal(f.responded, 0)   // conservative: pre-interview auto-rejects aren't "responses"
  assert.equal(f.rejected, 1)
})

// ─── buildDimensionProfile ───────────────────────────────────────────────────

// Enough winners (overall >= 7) to clear MIN_WINNERS_FOR_DELTA so delta ranking
// is active. We make current_fit the strongest *driver*: high in winners, low
// in losers. brand_value is flat across both groups (a non-discriminator).
function profileCorpus() {
  const winners = Array.from({ length: MIN_WINNERS_FOR_DELTA }, () =>
    makeScoreEntry({ overall: 9, current_fit: 9, brand_value: 6, skills_match: 8 }),
  )
  const losers = [
    makeScoreEntry({ overall: 4, current_fit: 3, brand_value: 6, skills_match: 5 }),
    makeScoreEntry({ overall: 5, current_fit: 4, brand_value: 6, skills_match: 5 }),
  ]
  return [...winners, ...losers]
}

test('buildDimensionProfile counts scored rows and the apply-worthy subset', () => {
  const p = buildDimensionProfile(profileCorpus())
  assert.equal(p.scoredCount, MIN_WINNERS_FOR_DELTA + 2)
  assert.equal(p.winnerCount, MIN_WINNERS_FOR_DELTA)
  assert.equal(p.lowSignal, false)
})

test('buildDimensionProfile excludes non-positive overalls from both groups', () => {
  const rows = [
    makeScoreEntry({ overall: 0, current_fit: 9 }),   // unscored — dropped entirely
    makeScoreEntry({ overall: 8, current_fit: 8 }),
  ]
  const p = buildDimensionProfile(rows)
  assert.equal(p.scoredCount, 1)
  assert.equal(p.winnerCount, 1)
})

test('buildDimensionProfile ranks the strongest driver (highest winners-minus-all delta) first', () => {
  const p = buildDimensionProfile(profileCorpus())
  // current_fit separates winners from losers the most → top of the list.
  assert.equal(p.dims[0].field, 'current_fit')
  assert.ok(p.dims[0].delta > 0, 'driver delta should be positive')
  // brand_value is identical (6) across every row → ~zero delta, ranks below.
  const brand = p.dims.find(d => d.field === 'brand_value')!
  assert.ok(Math.abs(brand.delta) < 1e-9, 'a flat dimension has no discriminating power')
  assert.ok(p.dims.indexOf(brand) > 0)
})

test('buildDimensionProfile delta = winners-avg minus all-avg, exactly', () => {
  const p = buildDimensionProfile(profileCorpus())
  for (const d of p.dims) {
    assert.ok(Math.abs(d.delta - (d.avgWinners - d.avgAll)) < 1e-9, d.label)
  }
})

test('buildDimensionProfile flags low signal and falls back to avg-rank below the winner floor', () => {
  // Only 1 winner — under MIN_WINNERS_FOR_DELTA, so delta is untrustworthy.
  const rows = [
    makeScoreEntry({ overall: 9, current_fit: 5, brand_value: 9 }),  // winner, but brand_value is its top dim
    makeScoreEntry({ overall: 4, current_fit: 5, brand_value: 2 }),
  ]
  const p = buildDimensionProfile(rows)
  assert.equal(p.lowSignal, true)
  // Ranking falls back to raw average: brand_value avg (5.5) > current_fit avg (5).
  assert.equal(p.dims[0].field, 'brand_value')
})

test('buildDimensionProfile over an empty corpus is all-zero, not NaN', () => {
  const p = buildDimensionProfile([])
  assert.equal(p.scoredCount, 0)
  assert.equal(p.winnerCount, 0)
  assert.equal(p.lowSignal, true)
  for (const d of p.dims) {
    assert.equal(d.avgAll, 0)
    assert.equal(d.avgWinners, 0)
    assert.equal(d.delta, 0)
  }
})

test('PROFILE_DIMENSIONS and APPLY_THRESHOLD stay aligned with the documented scale', () => {
  assert.equal(APPLY_THRESHOLD, 7.0)
  assert.equal(PROFILE_DIMENSIONS.length, 6)
  // Every profile dimension must be a real numeric ScoreEntry field.
  const probe = makeScoreEntry()
  for (const { field } of PROFILE_DIMENSIONS) {
    assert.equal(typeof probe[field], 'number', String(field))
  }
})

// ─── buildTargetingMomentum ──────────────────────────────────────────────────

// A clean two-half corpus: an EARLIER block of low scores followed (by date) by
// a RECENT block of high scores. With MIN_PER_HALF_FOR_MOMENTUM rows on each
// side the split clears low-signal, so the verdict is live.
function risingCorpus() {
  const earlier = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-01-0${i + 1}`, overall: 5, current_fit: 5, brand_value: 6 }),
  )
  const recent = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-06-0${i + 1}`, overall: 8, current_fit: 8, brand_value: 6 }),
  )
  return [...earlier, ...recent]
}

test('buildTargetingMomentum splits chronologically into equal halves (earlier gets the extra row on odd n)', () => {
  // 5 rows by date → ceil(5/2)=3 earlier, 2 recent. Input is deliberately
  // shuffled to prove the split sorts by date first.
  const rows = [
    makeScoreEntry({ date: '2026-03-01', overall: 7 }),
    makeScoreEntry({ date: '2026-01-01', overall: 5 }),
    makeScoreEntry({ date: '2026-05-01', overall: 9 }),
    makeScoreEntry({ date: '2026-02-01', overall: 6 }),
    makeScoreEntry({ date: '2026-04-01', overall: 8 }),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.scoredCount, 5)
  assert.equal(m.earlier.count, 3)               // ceil(5/2)
  assert.equal(m.recent.count, 2)
  assert.equal(m.earlier.dateFrom, '2026-01-01') // sorted ascending
  assert.equal(m.earlier.dateTo, '2026-03-01')
  assert.equal(m.recent.dateFrom, '2026-04-01')
  assert.equal(m.recent.dateTo, '2026-05-01')
})

test('buildTargetingMomentum reads a rising recent half as "improving"', () => {
  const m = buildTargetingMomentum(risingCorpus())
  assert.equal(m.lowSignal, false)
  assert.equal(m.earlier.medianOverall, 5)
  assert.equal(m.recent.medianOverall, 8)
  assert.equal(m.medianDelta, 3)
  assert.equal(m.direction, 'improving')
  // earlier half is all below the 7.0 bar, recent half all above it.
  assert.equal(m.earlier.applyPct, 0)
  assert.equal(m.recent.applyPct, 100)
  assert.equal(m.applyPctDelta, 100)
})

test('buildTargetingMomentum reads a falling recent half as "declining"', () => {
  // Reverse the rising corpus's dates so the high scores are the EARLIER half.
  const high = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-01-0${i + 1}`, overall: 8 }),
  )
  const low = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-06-0${i + 1}`, overall: 5 }),
  )
  const m = buildTargetingMomentum([...high, ...low])
  assert.equal(m.lowSignal, false)
  assert.equal(m.medianDelta, -3)
  assert.equal(m.direction, 'declining')
})

test('buildTargetingMomentum treats a sub-deadband wobble as "steady"', () => {
  // medianDelta below MOMENTUM_DEADBAND in magnitude → steady, not a trend.
  const wobble = MOMENTUM_DEADBAND / 2
  const earlier = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-01-0${i + 1}`, overall: 7 }),
  )
  const recent = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, (_, i) =>
    makeScoreEntry({ date: `2026-06-0${i + 1}`, overall: 7 + wobble }),
  )
  const m = buildTargetingMomentum([...earlier, ...recent])
  assert.equal(m.lowSignal, false)
  assert.ok(Math.abs(m.medianDelta) < MOMENTUM_DEADBAND)
  assert.equal(m.direction, 'steady')
})

test('buildTargetingMomentum flags low signal and forces "steady" when a half is too thin', () => {
  // Only 2 rows per half — under MIN_PER_HALF_FOR_MOMENTUM (3). Even with a big
  // score jump the verdict must not assert a direction.
  const m = buildTargetingMomentum([
    makeScoreEntry({ date: '2026-01-01', overall: 4 }),
    makeScoreEntry({ date: '2026-01-02', overall: 4 }),
    makeScoreEntry({ date: '2026-06-01', overall: 9 }),
    makeScoreEntry({ date: '2026-06-02', overall: 9 }),
  ])
  assert.equal(m.lowSignal, true)
  assert.equal(m.direction, 'steady')   // forced flat under low signal
  assert.ok(m.medianDelta > 0)          // the raw delta is still reported…
})

test('buildTargetingMomentum drops undated and non-positive rows from the split', () => {
  const m = buildTargetingMomentum([
    makeScoreEntry({ date: '', overall: 9 }),          // undated — can't place on timeline
    makeScoreEntry({ date: '2026-01-01', overall: 0 }), // unscored — dropped
    makeScoreEntry({ date: '2026-02-01', overall: 6 }),
    makeScoreEntry({ date: '2026-03-01', overall: 8 }),
  ])
  assert.equal(m.scoredCount, 2)        // only the two dated, positive rows
  assert.equal(m.earlier.count, 1)
  assert.equal(m.recent.count, 1)
})

test('buildTargetingMomentum dimShifts are recent-minus-earlier, sorted by absolute movement', () => {
  // current_fit climbs +3 (the big mover); brand_value is flat across halves.
  const m = buildTargetingMomentum(risingCorpus())
  assert.equal(m.dimShifts[0].field, 'current_fit')
  assert.ok(Math.abs(m.dimShifts[0].delta - 3) < 1e-9)
  for (const s of m.dimShifts) {
    assert.ok(Math.abs(s.delta - (s.recent - s.earlier)) < 1e-9, s.label)
  }
  const brand = m.dimShifts.find(s => s.field === 'brand_value')!
  assert.ok(Math.abs(brand.delta) < 1e-9)                    // flat dimension
  // Every dimShift covers a real profile dimension.
  assert.equal(m.dimShifts.length, PROFILE_DIMENSIONS.length)
})

test('buildTargetingMomentum over an empty corpus is all-zero, not NaN', () => {
  const m = buildTargetingMomentum([])
  assert.equal(m.scoredCount, 0)
  assert.equal(m.lowSignal, true)
  assert.equal(m.direction, 'steady')
  assert.equal(m.medianDelta, 0)
  assert.equal(m.applyPctDelta, 0)
  assert.equal(m.earlier.count, 0)
  assert.equal(m.recent.count, 0)
})

// ─── buildArchetypeMix ───────────────────────────────────────────────────────

// A toy canonicalizer so the mix math is tested without pulling in the real
// archetype rules: lower-cases and trims, nothing more. The component injects
// the real `canonicalizeArchetype` at the call site.
const canon = (s: string) => s.trim().toLowerCase()

test('buildArchetypeMix buckets scored rows by canonical archetype, biggest focus first', () => {
  const rows = [
    makeScoreEntry({ archetype: 'Data Analyst', overall: 8 }),
    makeScoreEntry({ archetype: 'data analyst', overall: 6 }),   // same bucket after canon
    makeScoreEntry({ archetype: 'Strategy',     overall: 9 }),
  ]
  const m = buildArchetypeMix(rows, canon)
  assert.equal(m.scoredCount, 3)
  assert.equal(m.distinct, 2)
  assert.deepEqual(m.slices.map(s => s.label), ['data analyst', 'strategy'])
  assert.equal(m.slices[0].count, 2)
  assert.equal(m.slices[0].sharePct, 67)         // 2/3 rounded
  assert.equal(m.slices[0].avgScore, 7)          // (8+6)/2
  assert.equal(m.slices[1].sharePct, 33)
})

test('buildArchetypeMix excludes non-positive overalls and noise archetype labels', () => {
  const rows = [
    makeScoreEntry({ archetype: 'Data Analyst', overall: 0 }),   // unscored — dropped
    makeScoreEntry({ archetype: 'n/d',          overall: 8 }),   // noise label — dropped
    makeScoreEntry({ archetype: '—',            overall: 9 }),   // noise label — dropped
    makeScoreEntry({ archetype: 'Strategy',     overall: 7 }),
  ]
  const m = buildArchetypeMix(rows, canon)
  assert.equal(m.scoredCount, 1)
  assert.deepEqual(m.slices.map(s => s.label), ['strategy'])
})

test('buildArchetypeMix ranks a same-count tie by avg score', () => {
  const rows = [
    makeScoreEntry({ archetype: 'Alpha', overall: 6 }),
    makeScoreEntry({ archetype: 'Beta',  overall: 9 }),
  ]
  const m = buildArchetypeMix(rows, canon)
  // Both n=1 → tie broken by avgScore desc: Beta (9) before Alpha (6).
  assert.deepEqual(m.slices.map(s => s.label), ['beta', 'alpha'])
})

test('buildArchetypeMix concentration is 1 for a single archetype and falls as focus spreads', () => {
  const one = buildArchetypeMix(
    [makeScoreEntry({ archetype: 'A', overall: 8 }), makeScoreEntry({ archetype: 'A', overall: 8 })],
    canon,
  )
  assert.equal(one.concentration, 1)             // all attention in one bucket

  // Four archetypes, one row each → Herfindahl = 4 * (1/4)^2 = 0.25.
  const spread = buildArchetypeMix(
    ['A', 'B', 'C', 'D'].map(a => makeScoreEntry({ archetype: a, overall: 8 })),
    canon,
  )
  assert.ok(Math.abs(spread.concentration - 0.25) < 1e-9)
  assert.ok(spread.concentration < one.concentration)
})

test('buildArchetypeMix splits the dated corpus chronologically into equal halves', () => {
  // 4 dated rows → 2 earlier, 2 recent. Shuffled to prove the date sort.
  const rows = [
    makeScoreEntry({ date: '2026-03-01', archetype: 'Strategy', overall: 8 }),
    makeScoreEntry({ date: '2026-01-01', archetype: 'Data',     overall: 7 }),
    makeScoreEntry({ date: '2026-04-01', archetype: 'Strategy', overall: 9 }),
    makeScoreEntry({ date: '2026-02-01', archetype: 'Data',     overall: 6 }),
  ]
  const m = buildArchetypeMix(rows, canon)
  assert.equal(m.earlierTotal, 2)
  assert.equal(m.recentTotal, 2)
  // Earlier half = Jan(Data) + Feb(Data); Recent half = Mar(Strategy) + Apr(Strategy).
  const data = m.slices.find(s => s.label === 'data')!
  const strat = m.slices.find(s => s.label === 'strategy')!
  assert.equal(data.earlierCount, 2)
  assert.equal(data.recentCount, 0)
  assert.equal(strat.earlierCount, 0)
  assert.equal(strat.recentCount, 2)
})

test('buildArchetypeMix surfaces a focus shift as signed share-points (recent minus earlier)', () => {
  // Earlier half: all Data. Recent half: all Strategy. 3 per half clears the floor.
  const earlier = Array.from({ length: MIN_PER_HALF_FOR_MIX }, (_, i) =>
    makeScoreEntry({ date: `2026-01-0${i + 1}`, archetype: 'Data', overall: 8 }),
  )
  const recent = Array.from({ length: MIN_PER_HALF_FOR_MIX }, (_, i) =>
    makeScoreEntry({ date: `2026-06-0${i + 1}`, archetype: 'Strategy', overall: 8 }),
  )
  const m = buildArchetypeMix([...earlier, ...recent], canon)
  assert.equal(m.lowSignal, false)
  const data = m.slices.find(s => s.label === 'data')!
  const strat = m.slices.find(s => s.label === 'strategy')!
  assert.equal(data.earlierSharePct, 100)
  assert.equal(data.recentSharePct, 0)
  assert.equal(data.shareShift, -100)            // Data faded out
  assert.equal(strat.earlierSharePct, 0)
  assert.equal(strat.recentSharePct, 100)
  assert.equal(strat.shareShift, 100)            // Strategy took over
})

test('buildArchetypeMix zeroes the share shift and flags low signal below the per-half floor', () => {
  // Only 2 dated rows per half — under MIN_PER_HALF_FOR_MIX (3). Even a clean
  // earlier→recent swing must not assert a drift.
  const m = buildArchetypeMix([
    makeScoreEntry({ date: '2026-01-01', archetype: 'Data',     overall: 8 }),
    makeScoreEntry({ date: '2026-01-02', archetype: 'Data',     overall: 8 }),
    makeScoreEntry({ date: '2026-06-01', archetype: 'Strategy', overall: 8 }),
    makeScoreEntry({ date: '2026-06-02', archetype: 'Strategy', overall: 8 }),
  ], canon)
  assert.equal(m.lowSignal, true)
  for (const s of m.slices) assert.equal(s.shareShift, 0)   // suppressed under low signal
})

test('buildArchetypeMix counts undated rows in the overall mix but not in either half', () => {
  const m = buildArchetypeMix([
    makeScoreEntry({ date: '',           archetype: 'Data', overall: 8 }),   // in mix, not in a half
    makeScoreEntry({ date: '2026-01-01', archetype: 'Data', overall: 8 }),
    makeScoreEntry({ date: '2026-06-01', archetype: 'Data', overall: 8 }),
  ], canon)
  const data = m.slices.find(s => s.label === 'data')!
  assert.equal(data.count, 3)                    // all three count toward focus
  assert.equal(m.earlierTotal + m.recentTotal, 2) // only the two dated rows are split
})

test('buildArchetypeMix over an empty corpus is all-zero, not NaN', () => {
  const m = buildArchetypeMix([], canon)
  assert.equal(m.scoredCount, 0)
  assert.equal(m.distinct, 0)
  assert.equal(m.concentration, 0)
  assert.equal(m.lowSignal, true)
  assert.deepEqual(m.slices, [])
})

test('buildArchetypeMix default canonicalizer just trims (no UI rules pulled in)', () => {
  const m = buildArchetypeMix([
    makeScoreEntry({ archetype: '  Strategy  ', overall: 8 }),
    makeScoreEntry({ archetype: 'Strategy',     overall: 6 }),
  ])
  assert.equal(m.distinct, 1)
  assert.equal(m.slices[0].label, 'Strategy')
})

// ─── location flags ──────────────────────────────────────────────────────────

test('isoToFlag maps an alpha-2 code to regional-indicator emoji', () => {
  assert.equal(isoToFlag('IE'), '🇮🇪')
  assert.equal(isoToFlag('US'), '🇺🇸')
})

test('locationFlag matches a city or country inside a messy location string', () => {
  assert.equal(locationFlag('Dublin, Ireland (on-site)'), isoToFlag('IE'))
  assert.equal(locationFlag('Madrid'), isoToFlag('ES'))
  assert.equal(locationFlag('Remote — Germany'), isoToFlag('DE'))
})

test('locationFlag returns null when nothing recognizable is present', () => {
  assert.equal(locationFlag('Fully remote'), null)
  assert.equal(locationFlag(''), null)
})
