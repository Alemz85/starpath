import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterByDateWindow,
  avg, median,
  buildByPeriod, pickGranularity, listingKey, isStrongMatch, MAX_WEEKS_FOR_WEEKLY,
  buildTopBy, latestPerListing, isNoiseLabel, primaryPlace,
  APPLY_WORTHY_VERDICTS, scoredOnly, isApplyWorthy,
  buildFunnel,
  PROFILE_DIMENSIONS,
  buildTargetingMomentum, MIN_PER_HALF_FOR_MOMENTUM, MOMENTUM_DEADBANDS,
  buildArchetypeMix, MIN_PER_HALF_FOR_MIX,
  isoToFlag, locationFlag,
} from '@/lib/trendsAnalytics'
import { makeScoreEntry, makeApplication, makeBlockedEntry } from '@/test-utils/fixtures'
import { GATES } from '@/lib/scoringStats'

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

// A scored row: Match and Ease drive every v2 analytic.
const s = (match: number, ease: number, over: Parameters<typeof makeScoreEntry>[0] = {}) =>
  makeScoreEntry({ match, ease, ...over })

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
  assert.equal(avg([s(6, 5), s(8, 7), makeBlockedEntry()], 'match'), 7)
  assert.equal(avg([], 'match'), 0)
})

test('median handles odd, even, and empty sets', () => {
  assert.equal(median([s(1, 1), s(9, 1), s(5, 1)], 'match'), 5)
  assert.equal(median([s(2, 1), s(4, 1)], 'match'), 3)
  assert.equal(median([], 'match'), 0)
})

// ─── buildByPeriod ───────────────────────────────────────────────────────────

// Fixtures share company + role by default; a URL per listing keeps them apart.
let seq = 0
const job = (over: Parameters<typeof makeScoreEntry>[0] = {}) => ({ url: `https://example.com/jobs/${++seq}`, ...over })
// n scored listings on one day, every one at the given Match.
const scoredOn = (date: string, n: number, match = 7) =>
  Array.from({ length: n }, () => s(match, 6, job({ date })))

test('buildByPeriod counts blocked listings in the bar and in blocked, never in strongMatch', () => {
  const rows = [
    ...scoredOn('2026-06-02', 3, 8.5),
    makeBlockedEntry('x', job({ date: '2026-06-03' })),
    makeBlockedEntry('y', job({ date: '2026-06-04' })),
  ]
  const [june] = buildByPeriod(rows, 'month')
  assert.equal(june.listings, 5)
  assert.equal(june.blocked, 2)
  assert.equal(june.strongMatch, 3)
  // Counts only: no mean, no gate, whatever the period's size.
  assert.equal('avgMatch' in june, false)
})

test('buildByPeriod counts a re-evaluated listing once, where it was first seen, at its latest Match', () => {
  const url = 'https://example.com/jobs/re-evaluated'
  const rows = [
    s(5, 6, { url, date: '2026-06-20' }),
    s(6, 6, { url, date: '2026-06-10' }),   // first seen in June
    s(9, 6, { url, date: '2026-07-02' }),   // latest judgment (strong match), a month later
  ]
  const months = buildByPeriod(rows, 'month')
  assert.deepEqual(months.map(m => [m.start, m.listings, m.strongMatch]), [['2026-06-01', 1, 1]])
})

test('buildByPeriod starts weeks on Monday, keeps empty periods as zero bars, drops undated rows', () => {
  const rows = [
    s(7, 7, job({ date: '2026-06-07' })),   // Sunday → week of Jun 1
    s(7, 7, job({ date: '2026-06-22T09:00:00Z' })),
    s(7, 7, job({ date: '' })),
  ]
  const weeks = buildByPeriod(rows, 'week')
  assert.deepEqual(weeks.map(w => [w.start, w.listings]), [
    ['2026-06-01', 1], ['2026-06-08', 0], ['2026-06-15', 0], ['2026-06-22', 1],
  ])
  assert.equal(weeks[0].label, 'Jun 1')
  assert.equal(weeks[0].title, 'Week of Jun 1, 2026')
})

test('buildByPeriod months roll over the year and label with it', () => {
  const months = buildByPeriod([s(7, 7, job({ date: '2025-12-30' })), s(7, 7, job({ date: '2026-01-02' }))], 'month')
  assert.deepEqual(months.map(m => m.label), ['Dec 2025', 'Jan 2026'])
  assert.equal(months[1].title, 'January 2026')
  assert.deepEqual(buildByPeriod([], 'week'), [])
})

test('buildByPeriod places a listing in the period it was posted, else where it was first evaluated', () => {
  const postedEarly = job({ date: '2026-07-03' })
  const noPostDate = job({ date: '2026-07-04' })
  const rows = [s(8.5, 6, postedEarly), s(7, 6, noPostDate)]
  const posted: Record<string, string> = { [postedEarly.url]: '2026-05-20' }
  const months = buildByPeriod(rows, 'month', { postedDate: e => posted[e.url] ?? null })
  // The posted row and the evaluation-date-only row land in different buckets,
  // and each bucket says which date placed its listings.
  assert.deepEqual(months.map(m => [m.start, m.listings, m.posted, m.evaluated]), [
    ['2026-05-01', 1, 1, 0], ['2026-06-01', 0, 0, 0], ['2026-07-01', 1, 0, 1],
  ])
  // Without posting dates every listing falls back to its first evaluation.
  assert.deepEqual(buildByPeriod(rows, 'month').map(m => [m.start, m.listings, m.posted, m.evaluated]), [['2026-07-01', 2, 0, 2]])
})

test('strong match = Match at or above the high band and not blocked; each bar splits on it', () => {
  assert.equal(isStrongMatch({ match: 8, eligibility: 'green' }), true)
  assert.equal(isStrongMatch({ match: 7.99, eligibility: 'green' }), false)
  assert.equal(isStrongMatch({ match: 9, eligibility: 'red' }), false)
  assert.equal(isStrongMatch({ match: null, eligibility: null }), false)
  const rows = [
    s(8.5, 4, job({ date: '2026-06-02' })),   // strong match even at low Ease (Growth target)
    s(6, 9, job({ date: '2026-06-03' })),
    makeBlockedEntry('x', job({ date: '2026-06-04' })),
  ]
  const [june] = buildByPeriod(rows, 'month')
  assert.equal(june.listings, 3)
  assert.equal(june.strongMatch, 1)
  assert.equal(june.blocked, 1)
})

test('pickGranularity uses weeks while the listings span a readable number of weeks', () => {
  assert.equal(pickGranularity([...scoredOn('2026-06-01', 1), ...scoredOn('2026-06-08', 1)]), 'week')
  const lastWeek = new Date(Date.UTC(2026, 5, 1 + 7 * (MAX_WEEKS_FOR_WEEKLY - 1))).toISOString().slice(0, 10)
  const tooFar = new Date(Date.UTC(2026, 5, 1 + 7 * MAX_WEEKS_FOR_WEEKLY)).toISOString().slice(0, 10)
  assert.equal(pickGranularity([...scoredOn('2026-06-01', 1), ...scoredOn(lastWeek, 1)]), 'week')
  assert.equal(pickGranularity([...scoredOn('2026-06-01', 1), ...scoredOn(tooFar, 1)]), 'month')
  // A posting date can widen the span.
  const early = job({ date: '2026-06-08' })
  assert.equal(pickGranularity([s(7, 7, early), ...scoredOn('2026-06-08', 1)], { postedDate: e => (e.url === early.url ? '2025-12-01' : null) }), 'month')
})

test('listingKey prefers the URL and falls back to company|role', () => {
  assert.equal(listingKey(makeScoreEntry({ url: ' https://example.com/x ' })), 'https://example.com/x')
  assert.equal(listingKey(makeScoreEntry({ company: 'Nimbus Robotics', role: 'Analyst ' })), 'nimbus robotics|analyst')
})

// ─── buildTopBy ──────────────────────────────────────────────────────────────

test('isNoiseLabel flags blanks, n/d, dashes and "unknown" case-insensitively', () => {
  for (const l of ['', ' ', 'n/d', 'N/D', '—', '-', 'Unknown']) assert.equal(isNoiseLabel(l), true, l)
  assert.equal(isNoiseLabel('Acme'), false)
})

test('buildTopBy ranks on the named axis, shows both, and honours the limit', () => {
  const rows = [
    s(9, 4, job({ company: 'Matched' })),
    s(5, 9, job({ company: 'Easy' })),
    s(7, 7, job({ company: 'Both' })), s(7, 7, job({ company: 'Both' })),
    s(6, 6, job({ company: 'n/d' })),
    makeBlockedEntry('x', job({ company: 'Blocked' })),
  ]
  assert.deepEqual(buildTopBy(rows, e => e.company, 'ease', 2).map(r => r.label), ['Easy', 'Both'])
  const byMatch = buildTopBy(rows, e => e.company, 'match', 9)
  assert.deepEqual(byMatch.map(r => r.label), ['Matched', 'Both', 'Easy'])
  assert.equal(byMatch[1].count, 2)
  assert.equal(byMatch[1].avgEase, 7)
  assert.ok(!byMatch.some(r => r.label === 'Blocked'))
})

test('buildTopBy breaks a tie on the axis by count, then by the other axis', () => {
  const rows = [
    s(8, 5, job({ company: 'One' })),
    s(8, 5, job({ company: 'Two' })), s(8, 5, job({ company: 'Two' })),
    s(8, 9, job({ company: 'Easier' })),
  ]
  assert.deepEqual(buildTopBy(rows, e => e.company, 'match', 3).map(r => r.label), ['Two', 'Easier', 'One'])
})

test('buildTopBy counts a re-evaluated listing once, at its latest evaluation', () => {
  const url = 'https://example.com/jobs/again'
  const rows = [
    s(5, 5, { url, company: 'Nimbus Robotics', date: '2026-06-01' }),
    s(8, 8, { url, company: 'Nimbus Robotics', date: '2026-06-09' }),
  ]
  const [row] = buildTopBy(rows, e => e.company, 'match', 5)
  assert.equal(row.count, 1)
  assert.equal(row.avgMatch, 8)
  assert.equal(latestPerListing(rows).length, 1)
})

test('buildTopBy drops a listing whose latest evaluation is blocked', () => {
  const url = 'https://example.com/jobs/now-blocked'
  const rows = [
    s(8, 8, { url, company: 'Nimbus Robotics', date: '2026-06-01' }),
    makeBlockedEntry('x', { url, company: 'Nimbus Robotics', date: '2026-06-09' }),
  ]
  assert.deepEqual(buildTopBy(rows, e => e.company, 'match', 5), [])
})

test('primaryPlace keys a multi-city listing by its first listed place, with its country', () => {
  assert.equal(primaryPlace('Lyon, France; Vienna, Austria; Prague, Czechia'), 'Lyon, France')
  assert.equal(primaryPlace('Lyon, France'), 'Lyon, France')
  assert.equal(primaryPlace('Porto / Lyon'), 'Porto')
  assert.equal(primaryPlace('Lyon, Vienna'), 'Lyon')
  assert.equal(primaryPlace('Dublin, Ireland (on-site)'), 'Dublin, Ireland')
  assert.equal(primaryPlace('Remote / Lyon'), 'Lyon')
  assert.equal(primaryPlace('Italy'), 'Italy')
  assert.equal(primaryPlace('Remote'), 'Remote')
  assert.equal(primaryPlace(''), '')
})

test('top locations group a multi-city listing with its primary city', () => {
  const rows = [
    s(8, 6, job({ location: 'Lyon, France; Vienna, Austria' })),
    s(6, 6, job({ location: 'Lyon, France' })),
    s(7, 6, job({ location: 'Vienna, Austria' })),
  ]
  const top = buildTopBy(rows, e => primaryPlace(e.location), 'match', 5)
  // Lyon's two listings average Match 7, tied with Vienna; the larger n leads.
  assert.deepEqual(top.map(r => [r.label, r.count]), [['Lyon, France', 2], ['Vienna, Austria', 1]])
  assert.equal(top[0].avgMatch, 7)
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

// ─── dimensions ──────────────────────────────────────────────────────────────

test('PROFILE_DIMENSIONS lead with Match and Ease and are real ScoreEntry fields', () => {
  assert.deepEqual(PROFILE_DIMENSIONS.slice(0, 2).map(d => d.field), ['match', 'ease'])
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

test('Match and Ease each get their own direction against their own deadband', () => {
  assert.deepEqual(MOMENTUM_DEADBANDS, { match: 0.30, ease: 0.35 })
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => s(7.0, 5.0, { date: day(i) })),
    ...Array.from({ length: 5 }, (_, i) => s(7.2, 6.0, { date: day(10 + i) })),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.lowSignal, false)
  assert.equal(m.matchDirection, 'steady')      // +0.2 < 0.30
  assert.equal(m.easeDirection, 'improving')   // +1.0
  assert.ok(Math.abs(m.matchMedianDelta - 0.2) < 1e-9)
  assert.equal(m.easeMedianDelta, 1)
})

test('a falling half reads as declining; the Ease floor is 0.35', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => s(8, 6.0, { date: day(i) })),
    ...Array.from({ length: 5 }, (_, i) => s(7, 5.66, { date: day(10 + i) })),
  ]
  const m = buildTargetingMomentum(rows)
  assert.equal(m.matchDirection, 'declining')
  assert.equal(m.easeDirection, 'steady')      // −0.34
})

test('buildTargetingMomentum flags low signal and forces steady when a half is thin', () => {
  const m = buildTargetingMomentum([s(5, 5, { date: day(0) }), s(9, 9, { date: day(1) })])
  assert.equal(m.lowSignal, true)
  assert.equal(m.matchDirection, 'steady')
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
  assert.equal(m.matchDirection, 'steady')
})

test('buildTargetingMomentum treats ISO timestamps on the same day as one date', () => {
  const n = MIN_PER_HALF_FOR_MOMENTUM * 2
  const rows = Array.from({ length: n }, (_, i) =>
    s(i < n / 2 ? 5 : 9, 7, { date: `2026-06-10T${String(8 + i).padStart(2, '0')}:00:00Z` }))
  const m = buildTargetingMomentum(rows)
  assert.equal(m.lowSignal, true)
  assert.equal(m.matchDirection, 'steady')
})

test('buildTargetingMomentum lifts the same-day guard once a second date appears', () => {
  const earlier = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, () => s(5, 7, { date: '2026-06-09' }))
  const recent = Array.from({ length: MIN_PER_HALF_FOR_MOMENTUM }, () => s(8, 7, { date: '2026-06-10' }))
  const m = buildTargetingMomentum([...earlier, ...recent])
  assert.equal(m.lowSignal, false)
  assert.equal(m.matchDirection, 'improving')
  assert.equal(m.easeDirection, 'steady')
})

test('buildTargetingMomentum over an empty corpus is all-zero, not NaN', () => {
  const m = buildTargetingMomentum([])
  assert.equal(m.scoredCount, 0)
  assert.equal(m.matchMedianDelta, 0)
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
  assert.equal(m.slices[0].avgMatch, 7)
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
