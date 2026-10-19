import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterByDateWindow,
  avg, median,
  buildByDate, buildTopBy, isNoiseLabel,
  buildDistribution, SCORE_BANDS, APPLY_WORTHY_VERDICTS, scoredOnly, isApplyWorthy,
  buildFunnel,
  buildDimensionProfile, PROFILE_DIMENSIONS, MIN_WINNERS_FOR_DELTA,
  buildTargetingMomentum, MIN_PER_HALF_FOR_MOMENTUM, MOMENTUM_DEADBANDS,
  buildArchetypeMix, MIN_PER_HALF_FOR_MIX,
  isoToFlag, locationFlag,
} from '@/lib/trendsAnalytics'
import { makeScoreEntry, makeApplication, makeBlockedEntry } from '@/test-utils/fixtures'
import { TIER_COLORS } from '@/types'

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

// ─── scored rows / apply-worthy ──────────────────────────────────────────────

// A scored row: Want and Ease drive every v2 analytic.
const s = (want: number, ease: number, over: Parameters<typeof makeScoreEntry>[0] = {}) =>
  makeScoreEntry({ want, ease, ...over })

test('scoredOnly drops blocked and unscored rows; apply-worthy is go / stretch / solid', () => {
  const rows = [s(8, 8), makeBlockedEntry(), makeScoreEntry()]
  assert.equal(scoredOnly(rows).length, 1)
  assert.deepEqual([...APPLY_WORTHY_VERDICTS].sort(), ['go', 'solid', 'stretch'])
  assert.equal(isApplyWorthy(s(8, 8)), true)    // go
  assert.equal(isApplyWorthy(s(8, 6)), true)    // stretch
  assert.equal(isApplyWorthy(s(7, 7)), true)    // solid
  assert.equal(isApplyWorthy(s(7, 6)), false)   // thin
  assert.equal(isApplyWorthy(s(9, 4)), false)   // growth
  assert.equal(isApplyWorthy(makeBlockedEntry()), false)
})

// ─── avg / median ────────────────────────────────────────────────────────────

test('avg averages a numeric field, skips nulls, and returns 0 for an empty set', () => {
  assert.equal(avg([s(6, 5), s(8, 7), makeBlockedEntry()], 'want'), 7)
  assert.equal(avg([], 'want'), 0)
})

test('median handles odd, even, and empty sets', () => {
  assert.equal(median([s(1, 1), s(9, 1), s(5, 1)], 'want'), 5)
  assert.equal(median([s(2, 1), s(4, 1)], 'want'), 3)
  assert.equal(median([], 'want'), 0)
})

// ─── buildByDate ─────────────────────────────────────────────────────────────

test('buildByDate buckets by day with Want / Ease averages over scored rows only', () => {
  const rows = [
    s(8, 6, { date: '2026-06-02' }),
    s(6, 8, { date: '2026-06-02T09:00:00Z', skills_match: 7 }),
    makeBlockedEntry('x', { date: '2026-06-02' }),
    s(7, 7, { date: '2026-06-01' }),
    s(7, 7, { date: '' }),
  ]
  const b = buildByDate(rows)
  assert.deepEqual(b.map(x => x.label), ['2026-06-01', '2026-06-02'])
  assert.equal(b[1].count, 3)
  assert.equal(b[1].blocked, 1)
  assert.equal(b[1].avg_want, 7)
  assert.equal(b[1].avg_ease, 7)
  assert.equal(b[1].avg_skills_match, 7)
})

// ─── buildTopBy ──────────────────────────────────────────────────────────────

test('isNoiseLabel flags blanks, n/d, dashes and "unknown" case-insensitively', () => {
  for (const l of ['', ' ', 'n/d', 'N/D', '—', '-', 'Unknown']) assert.equal(isNoiseLabel(l), true, l)
  assert.equal(isNoiseLabel('Acme'), false)
})

test('buildTopBy ranks by mean Priority, shows Want and Ease, honours the limit', () => {
  const rows = [
    s(9, 9, { company: 'Top' }),
    s(8, 4, { company: 'Mid' }), s(8, 4, { company: 'Mid' }),
    s(5, 5, { company: 'Low' }),
    s(6, 6, { company: 'n/d' }),
    makeBlockedEntry('x', { company: 'Blocked' }),
  ]
  const top = buildTopBy(rows, e => e.company, 2)
  assert.deepEqual(top.map(r => r.label), ['Top', 'Mid'])
  assert.equal(top[1].count, 2)
  assert.equal(top[1].avgWant, 8)
  assert.equal(top[1].avgEase, 4)
  assert.ok(Math.abs(top[1].avgPriority - Math.sqrt(32)) < 0.01)
  assert.ok(!buildTopBy(rows, e => e.company, 9).some(r => r.label === 'Blocked'))
})

// ─── buildDistribution ───────────────────────────────────────────────────────

test('SCORE_BANDS are the seven verdicts, best first, coloured by their tier', () => {
  assert.deepEqual(SCORE_BANDS.map(b => b.key), ['go', 'stretch', 'solid', 'growth', 'thin', 'skip', 'blocked'])
  assert.deepEqual(SCORE_BANDS.find(b => b.key === 'go')!.chip, TIER_COLORS.T1)
  assert.deepEqual(SCORE_BANDS.find(b => b.key === 'thin')!.chip, TIER_COLORS.T2)
  assert.deepEqual(SCORE_BANDS.find(b => b.key === 'growth')!.chip, TIER_COLORS.T3)
  assert.deepEqual(SCORE_BANDS.find(b => b.key === 'blocked')!.chip, TIER_COLORS.T4)
  assert.deepEqual(SCORE_BANDS.filter(b => b.applyWorthy).map(b => b.key), ['go', 'stretch', 'solid'])
})

test('buildDistribution counts verdicts (blocked included) and states applyPct over scored rows', () => {
  const rows = [
    s(9, 9), s(8, 6), s(7, 6), s(5, 5),
    makeBlockedEntry(), makeBlockedEntry(),
    s(7, 7, { eligibility: 'amber' }),
  ]
  const d = buildDistribution(rows)
  const count = (k: string) => d.bands.find(b => b.key === k)!.count
  assert.equal(count('go'), 1)
  assert.equal(count('stretch'), 1)
  assert.equal(count('solid'), 1)
  assert.equal(count('thin'), 1)
  assert.equal(count('skip'), 1)
  assert.equal(count('blocked'), 2)
  assert.equal(d.total, 7)
  assert.equal(d.scored, 5)
  assert.equal(d.applyPct, 60)        // go + stretch + solid of 5 scored
  assert.equal(d.medianWant, 7)
  assert.deepEqual(d.eligibility, { green: 4, amber: 1, red: 2 })
  assert.equal(d.max, 2)
})

test('buildDistribution over an empty corpus is all-zero, not NaN', () => {
  const d = buildDistribution([])
  assert.equal(d.total, 0)
  assert.equal(d.applyPct, 0)
  assert.equal(d.medianWant, 0)
  assert.equal(d.max, 1)
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

// Enough apply-worthy rows to clear MIN_WINNERS_FOR_DELTA. Ease is the
// strongest driver (high in winners, low in the rest); brand_value is flat.
function profileCorpus() {
  return [
    ...Array.from({ length: 4 }, () => s(8.5, 8, { brand_value: 7 })),    // go
    ...Array.from({ length: 4 }, () => s(8.5, 3, { brand_value: 7 })),    // growth
    makeBlockedEntry(),
  ]
}

test('buildDimensionProfile counts scored rows and the apply-worthy subset (blocked excluded)', () => {
  const p = buildDimensionProfile(profileCorpus())
  assert.equal(p.scoredCount, 8)
  assert.equal(p.winnerCount, 4)
  assert.equal(p.lowSignal, false)
})

test('buildDimensionProfile ranks the strongest driver first; delta = winners − all', () => {
  const p = buildDimensionProfile(profileCorpus())
  assert.equal(p.dims[0].field, 'ease')
  assert.equal(p.dims[0].delta, 8 - 5.5)
  const brand = p.dims.find(d => d.field === 'brand_value')!
  assert.equal(brand.delta, 0)
})

test('buildDimensionProfile flags low signal below the winner floor', () => {
  const p = buildDimensionProfile([s(9, 9), s(5, 5)])
  assert.equal(p.lowSignal, true)
  assert.ok(MIN_WINNERS_FOR_DELTA > 1)
})

test('buildDimensionProfile over an empty corpus is all-zero, not NaN', () => {
  const p = buildDimensionProfile([])
  assert.equal(p.scoredCount, 0)
  assert.ok(p.dims.every(d => d.avgAll === 0 && d.delta === 0))
})

test('PROFILE_DIMENSIONS lead with Want and Ease and are real ScoreEntry fields', () => {
  assert.deepEqual(PROFILE_DIMENSIONS.slice(0, 2).map(d => d.field), ['want', 'ease'])
  const sample = makeScoreEntry()
  for (const d of PROFILE_DIMENSIONS) assert.ok(d.field in sample, String(d.field))
})

// ─── buildTargetingMomentum ──────────────────────────────────────────────────

const day = (i: number) => `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`

test('buildTargetingMomentum splits chronologically into equal halves (earlier takes the extra)', () => {
  const rows = Array.from({ length: 11 }, (_, i) => s(7, 7, { date: day(i) }))
  const m = buildTargetingMomentum(rows)
  assert.equal(m.earlier.count, 6)
  assert.equal(m.recent.count, 5)
  assert.equal(m.scoredCount, 11)
})

test('Want and Ease each get their own direction against their own deadband', () => {
  assert.deepEqual(MOMENTUM_DEADBANDS, { want: 0.30, ease: 0.35 })
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => s(7.0, 5.0, { date: day(i) })),
    ...Array.from({ length: 5 }, (_, i) => s(7.2, 6.0, { date: day(10 + i) })),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.lowSignal, false)
  assert.equal(m.wantDirection, 'steady')      // +0.2 < 0.30
  assert.equal(m.easeDirection, 'improving')   // +1.0
  assert.ok(Math.abs(m.wantMedianDelta - 0.2) < 1e-9)
  assert.equal(m.easeMedianDelta, 1)
})

test('a falling half reads as declining; the Ease floor is 0.35', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => s(8, 6.0, { date: day(i) })),
    ...Array.from({ length: 5 }, (_, i) => s(7, 5.66, { date: day(10 + i) })),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.wantDirection, 'declining')
  assert.equal(m.easeDirection, 'steady')      // −0.34
})

test('buildTargetingMomentum flags low signal and forces steady when a half is thin', () => {
  const m = buildTargetingMomentum([s(5, 5, { date: day(0) }), s(9, 9, { date: day(1) })])
  assert.equal(m.lowSignal, true)
  assert.equal(m.wantDirection, 'steady')
  assert.equal(m.easeDirection, 'steady')
  assert.ok(MIN_PER_HALF_FOR_MOMENTUM >= 2)
})

test('buildTargetingMomentum drops undated and blocked rows, and reports applyPct per half', () => {
  const rows = [
    s(8, 8, { date: day(0) }), s(5, 5, { date: day(1) }),
    s(8, 8, { date: '' }), makeBlockedEntry('x', { date: day(2) }),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.scoredCount, 2)
  assert.equal(m.earlier.applyPct, 100)
  assert.equal(m.recent.applyPct, 0)
  assert.equal(m.applyPctDelta, -100)
})

test('buildTargetingMomentum flags a same-day corpus as low signal, however many rows it has', () => {
  const n = MIN_PER_HALF_FOR_MOMENTUM * 3
  const rows = Array.from({ length: n }, (_, i) => s(i < n / 2 ? 8.5 : 6, 7, { date: '2026-06-10' }))
  const m = buildTargetingMomentum(rows)
  assert.equal(m.scoredCount, n)
  assert.ok(m.earlier.count >= MIN_PER_HALF_FOR_MOMENTUM)
  assert.ok(m.recent.count >= MIN_PER_HALF_FOR_MOMENTUM)
  assert.equal(m.lowSignal, true)
  assert.equal(m.wantDirection, 'steady')
})

test('buildTargetingMomentum treats ISO timestamps on the same day as one date', () => {
  const n = MIN_PER_HALF_FOR_MOMENTUM * 2
  const rows = Array.from({ length: n }, (_, i) =>
    s(i < n / 2 ? 5 : 9, 7, { date: `2026-06-10T${String(8 + i).padStart(2, '0')}:00:00Z` }))
  const m = buildTargetingMomentum(rows)
  assert.equal(m.lowSignal, true)
  assert.equal(m.wantDirection, 'steady')
})

test('buildTargetingMomentum lifts the same-day guard once a second date appears', () => {
  const earlier = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, () => s(5, 7, { date: '2026-06-09' }))
  const recent = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, () => s(8, 7, { date: '2026-06-10' }))
  const m = buildTargetingMomentum([...earlier, ...recent])
  assert.equal(m.lowSignal, false)
  assert.equal(m.wantDirection, 'improving')
  assert.equal(m.easeDirection, 'steady')
})

test('buildTargetingMomentum over an empty corpus is all-zero, not NaN', () => {
  const m = buildTargetingMomentum([])
  assert.equal(m.scoredCount, 0)
  assert.equal(m.wantMedianDelta, 0)
  assert.equal(m.easeMedianDelta, 0)
})

// ─── buildArchetypeMix ───────────────────────────────────────────────────────

const canon = (x: string) => x.trim().toLowerCase()

test('buildArchetypeMix buckets scored rows by canonical archetype, biggest focus first', () => {
  const rows = [
    s(8, 6, { archetype: 'Data Analyst' }),
    s(6, 8, { archetype: 'data analyst' }),
    s(9, 9, { archetype: 'Strategy' }),
    makeBlockedEntry('x', { archetype: 'Strategy' }),
    s(7, 7, { archetype: 'n/d' }),
  ]
  const m = buildArchetypeMix(rows, canon)
  assert.equal(m.scoredCount, 3)
  assert.equal(m.distinct, 2)
  assert.deepEqual(m.slices.map(x => x.label), ['data analyst', 'strategy'])
  assert.equal(m.slices[0].sharePct, 67)
  assert.equal(m.slices[0].avgWant, 7)
  assert.equal(m.slices[0].avgEase, 7)
  assert.equal(m.slices[1].count, 1)
})

test('buildArchetypeMix ranks a same-count tie by mean Priority', () => {
  const m = buildArchetypeMix([s(5, 5, { archetype: 'A' }), s(9, 9, { archetype: 'B' })], canon)
  assert.deepEqual(m.slices.map(x => x.label), ['b', 'a'])
})

test('buildArchetypeMix concentration is 1 for one archetype and falls as focus spreads', () => {
  assert.equal(buildArchetypeMix([s(7, 7, { archetype: 'A' }), s(7, 7, { archetype: 'A' })]).concentration, 1)
  const spread = buildArchetypeMix([s(7, 7, { archetype: 'A' }), s(7, 7, { archetype: 'B' })])
  assert.equal(spread.concentration, 0.5)
})

test('buildArchetypeMix surfaces a focus shift as signed share-points', () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => s(7, 7, { archetype: 'A', date: day(i) })),
    ...Array.from({ length: 3 }, (_, i) => s(7, 7, { archetype: 'B', date: day(10 + i) })),
  ]
  const m = buildArchetypeMix(rows, canon)
  assert.equal(m.lowSignal, false)
  assert.equal(m.slices.find(x => x.label === 'a')!.shareShift, -100)
  assert.equal(m.slices.find(x => x.label === 'b')!.shareShift, 100)
})

test('buildArchetypeMix zeroes the share shift below the per-half floor', () => {
  const m = buildArchetypeMix([s(7, 7, { archetype: 'A', date: day(0) }), s(7, 7, { archetype: 'B', date: day(1) })], canon)
  assert.equal(m.lowSignal, true)
  assert.ok(m.slices.every(x => x.shareShift === 0))
  assert.ok(MIN_PER_HALF_FOR_MIX >= 2)
})

test('buildArchetypeMix over an empty corpus is all-zero, not NaN', () => {
  const m = buildArchetypeMix([])
  assert.equal(m.scoredCount, 0)
  assert.equal(m.concentration, 0)
})

test('buildArchetypeMix default canonicalizer just trims (no UI rules pulled in)', () => {
  const m = buildArchetypeMix([
    s(8, 8, { archetype: '  Strategy  ' }),
    s(6, 6, { archetype: 'Strategy' }),
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
