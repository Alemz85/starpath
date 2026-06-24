import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterByDateWindow,
  avg, median,
  buildByDate, buildTopBy, isNoiseLabel,
  buildDistribution, SCORE_BANDS,
  buildFunnel,
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
