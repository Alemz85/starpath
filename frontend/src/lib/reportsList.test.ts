import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getScoreBand, ALL_BANDS, BAND_DETAILS,
  filterReportRows, sortReportRows, corpusBands, bandCounts,
  buildScoreIndex, matchScore,
  distanceToNextBand, fixabilityScore, isNearMiss,
  type ScoreBand, type ReportRowLike, type FixabilityRow,
} from '@/lib/reportsList'
import { makeScoreEntry } from '@/test-utils/fixtures'

// A report row carries only the handful of fields the grid reads.
function row(over: Partial<ReportRowLike> = {}): ReportRowLike {
  return { company: 'Acme', role: 'Analyst', tier: 'T2', overall: 7.5, mtime: 0, ...over }
}

// ─── getScoreBand ────────────────────────────────────────────────────────────

test('getScoreBand bins by overall score across every boundary', () => {
  assert.equal(getScoreBand(9.0, 'T3'), 'stellar')   // ≥9 wins regardless of tier
  assert.equal(getScoreBand(8.9, 'T3'), 'strong')
  assert.equal(getScoreBand(8.0, 'T3'), 'strong')
  assert.equal(getScoreBand(7.9, 'T3'), 'decent')
  assert.equal(getScoreBand(7.0, 'T3'), 'decent')
  assert.equal(getScoreBand(6.9, 'T1'), 'pass')      // score present → tier ignored
  assert.equal(getScoreBand(5.0, 'T1'), 'pass')
  assert.equal(getScoreBand(4.9, 'T1'), 'skip')
})

test('getScoreBand falls back to tier when score is null/zero/missing', () => {
  for (const noScore of [null, undefined, 0] as const) {
    assert.equal(getScoreBand(noScore, 'T1'), 'stellar')
    assert.equal(getScoreBand(noScore, 't2-high'), 'strong')   // case-insensitive
    assert.equal(getScoreBand(noScore, 'T2'), 'decent')
    assert.equal(getScoreBand(noScore, 'T3'), 'pass')
    assert.equal(getScoreBand(noScore, 'T4'), 'skip')
    assert.equal(getScoreBand(noScore, ''), 'skip')            // unknown tier
  }
})

test('every band has display details and ALL_BANDS lists them high→low', () => {
  assert.deepEqual([...ALL_BANDS], ['stellar', 'strong', 'decent', 'pass', 'skip'])
  for (const b of ALL_BANDS) assert.ok(BAND_DETAILS[b]?.label, `${b} has a label`)
})

// ─── filterReportRows ────────────────────────────────────────────────────────

test('filterReportRows with no query and no bands returns the input untouched', () => {
  const rows = [row(), row({ company: 'Beta' })]
  const out = filterReportRows(rows, {})
  assert.equal(out, rows)        // same reference — no needless copy
})

test('filterReportRows matches the query against company OR role, case-insensitively', () => {
  const rows = [
    row({ company: 'Stripe', role: 'Risk Analyst' }),
    row({ company: 'Acme', role: 'ML Engineer' }),
    row({ company: 'Wise', role: 'Data Analyst' }),
  ]
  assert.deepEqual(filterReportRows(rows, { query: 'analyst' }).map(r => r.company), ['Stripe', 'Wise'])
  assert.deepEqual(filterReportRows(rows, { query: 'STRIPE' }).map(r => r.company), ['Stripe'])
})

test('filterReportRows treats the band set as an OR multi-select', () => {
  const rows = [
    row({ overall: 9.2 }),  // stellar
    row({ overall: 8.1 }),  // strong
    row({ overall: 7.2 }),  // decent
    row({ overall: 4.0 }),  // skip
  ]
  const bands = new Set<ScoreBand>(['stellar', 'decent'])
  assert.deepEqual(filterReportRows(rows, { bands }).map(r => r.overall), [9.2, 7.2])
})

test('filterReportRows ANDs the query with the band set', () => {
  const rows = [
    row({ company: 'Stripe', overall: 9.2 }),  // stellar + matches
    row({ company: 'Acme', overall: 9.1 }),    // stellar but no match
    row({ company: 'Stripe', overall: 6.0 }),  // matches but wrong band
  ]
  const out = filterReportRows(rows, { query: 'stripe', bands: new Set<ScoreBand>(['stellar']) })
  assert.deepEqual(out.map(r => r.overall), [9.2])
})

// ─── sortReportRows ──────────────────────────────────────────────────────────

test('sortReportRows by score desc/asc, treating missing scores as 0', () => {
  const rows = [row({ overall: 7 }), row({ overall: null }), row({ overall: 9 })]
  assert.deepEqual(sortReportRows(rows, 'score', 'desc').map(r => r.overall), [9, 7, null])
  assert.deepEqual(sortReportRows(rows, 'score', 'asc').map(r => r.overall), [null, 7, 9])
})

test('sortReportRows by date keys off mtime (newest first on desc)', () => {
  const rows = [row({ mtime: 100 }), row({ mtime: 300 }), row({ mtime: 200 })]
  assert.deepEqual(sortReportRows(rows, 'date', 'desc').map(r => r.mtime), [300, 200, 100])
})

test('sortReportRows by tier uses the canonical order, unknown tiers last', () => {
  const rows = [
    row({ tier: 'T3' }), row({ tier: 'T1' }), row({ tier: 'T2-high' }), row({ tier: 'Tx' }),
  ]
  assert.deepEqual(sortReportRows(rows, 'tier', 'desc').map(r => r.tier), ['T1', 'T2-high', 'T3', 'Tx'])
})

test('sortReportRows does not mutate its input', () => {
  const rows = [row({ overall: 1 }), row({ overall: 9 })]
  const before = rows.map(r => r.overall)
  sortReportRows(rows, 'score', 'desc')
  assert.deepEqual(rows.map(r => r.overall), before)
})

// ─── corpusBands / bandCounts ────────────────────────────────────────────────

test('corpusBands lists only the bands actually present, in canonical order', () => {
  const rows = [row({ overall: 7.5 }), row({ overall: 9.5 })]  // decent + stellar
  assert.deepEqual(corpusBands(rows), ['stellar', 'decent'])
  assert.deepEqual(corpusBands([]), [])
})

test('bandCounts tallies per band and respects the query', () => {
  const rows = [
    row({ company: 'Stripe', overall: 9.5 }),  // stellar
    row({ company: 'Stripe', overall: 7.5 }),  // decent
    row({ company: 'Acme', overall: 9.1 }),    // stellar (filtered out by query)
  ]
  const all = bandCounts(rows)
  assert.equal(all.stellar, 2)
  assert.equal(all.decent, 1)
  assert.equal(all.skip, 0)

  const scoped = bandCounts(rows, 'stripe')
  assert.equal(scoped.stellar, 1)
  assert.equal(scoped.decent, 1)
})

// ─── buildScoreIndex / matchScore ────────────────────────────────────────────

test('matchScore resolves an exact company|role hit first', () => {
  const exact = makeScoreEntry({ company: 'Stripe', role: 'Risk Analyst', overall: 8 })
  const other = makeScoreEntry({ company: 'Stripe', role: 'ML Engineer', overall: 9 })
  const idx = buildScoreIndex([exact, other])
  const hit = matchScore(idx, { company: 'stripe', role: 'RISK ANALYST' })  // trims+lowers
  assert.equal(hit?.role, 'Risk Analyst')
})

test('matchScore falls back to a prefix role within the same company', () => {
  const entry = makeScoreEntry({ company: 'Stripe', role: 'Risk Analyst', overall: 8 })
  const idx = buildScoreIndex([entry])
  // report role is a longer form of the score-history role (or vice versa)
  const hit = matchScore(idx, { company: 'Stripe', role: 'Risk Analyst II' })
  assert.equal(hit?.role, 'Risk Analyst')
})

test('matchScore falls back to the highest-overall entry for the company', () => {
  const lo = makeScoreEntry({ company: 'Stripe', role: 'Ops', overall: 6 })
  const hi = makeScoreEntry({ company: 'Stripe', role: 'Strategy', overall: 9 })
  const idx = buildScoreIndex([lo, hi])
  const hit = matchScore(idx, { company: 'Stripe', role: 'Totally Unrelated Title' })
  assert.equal(hit?.overall, 9)
})

test('matchScore returns null when the company is absent from score history', () => {
  const idx = buildScoreIndex([makeScoreEntry({ company: 'Stripe', role: 'Ops' })])
  assert.equal(matchScore(idx, { company: 'Nobody', role: 'X' }), null)
})

// ─── fixability / near-miss ──────────────────────────────────────────────────

function fixRow(over: Partial<FixabilityRow> = {}): FixabilityRow {
  return { company: 'Acme', role: 'Analyst', tier: 'T3', overall: 6.9, mtime: 0, ...over }
}

test('distanceToNextBand measures points to the next band floor', () => {
  assert.equal(distanceToNextBand(6.9, 'T3'), 0.1)   // decent floor 7.0
  assert.equal(distanceToNextBand(7.0, 'T2'), 1.0)   // strong floor 8.0
  assert.equal(distanceToNextBand(5.1, 'T3'), 1.9)   // decent floor 7.0
})

test('distanceToNextBand returns null for the top band and for unscored rows', () => {
  assert.equal(distanceToNextBand(9.2, 'T1'), null)   // stellar — no band above
  assert.equal(distanceToNextBand(null, 'T3'), null)
  assert.equal(distanceToNextBand(0, 'T3'), null)
})

test('fixabilityScore: a lever-backed near-miss outranks a closer lever-less one', () => {
  const withLever  = fixRow({ overall: 6.5, fixability: { hasLever: true } })
  const noLever     = fixRow({ overall: 6.9, fixability: { hasLever: false } })   // closer, but no lever
  assert.ok(fixabilityScore(withLever) > fixabilityScore(noLever))
})

test('fixabilityScore is 0 for top-band and unscored rows (not in the ranking)', () => {
  assert.equal(fixabilityScore(fixRow({ overall: 9.3, tier: 'T1', fixability: { hasLever: true } })), 0)
  assert.equal(fixabilityScore(fixRow({ overall: null, fixability: { hasLever: true } })), 0)
})

test('fixabilityScore rises as the gap to the next band shrinks (lever-less)', () => {
  const far   = fixRow({ overall: 5.2, fixability: { hasLever: false } })
  const near  = fixRow({ overall: 6.8, fixability: { hasLever: false } })
  assert.ok(fixabilityScore(near) > fixabilityScore(far))
})

test('isNearMiss: small gap OR a concrete lever qualifies; top-band never does', () => {
  assert.equal(isNearMiss(fixRow({ overall: 6.9, fixability: { hasLever: false } })), true)  // 0.1 gap
  assert.equal(isNearMiss(fixRow({ overall: 5.5, fixability: { hasLever: false } })), false) // 1.5 gap, no lever
  assert.equal(isNearMiss(fixRow({ overall: 5.5, fixability: { hasLever: true } })), true)   // lever overrides gap
  assert.equal(isNearMiss(fixRow({ overall: 9.4, tier: 'T1', fixability: { hasLever: true } })), false)
})

test('filterReportRows nearMissOnly keeps only near-miss rows', () => {
  const rows = [
    fixRow({ company: 'Close',  overall: 6.95, fixability: { hasLever: false } }),  // 0.05 gap
    fixRow({ company: 'Lever',  overall: 5.4,  fixability: { hasLever: true } }),   // lever
    fixRow({ company: 'Far',    overall: 5.4,  fixability: { hasLever: false } }),  // out
    fixRow({ company: 'Top',    overall: 9.2, tier: 'T1', fixability: { hasLever: true } }), // out
  ]
  assert.deepEqual(
    filterReportRows(rows, { nearMissOnly: true }).map(r => r.company).sort(),
    ['Close', 'Lever'],
  )
})

test('sortReportRows by fixable puts the cheapest upgrade first under desc', () => {
  const rows = [
    fixRow({ company: 'Far',   overall: 5.3, fixability: { hasLever: false } }),
    fixRow({ company: 'Lever', overall: 6.4, fixability: { hasLever: true } }),
    fixRow({ company: 'Close', overall: 6.95, fixability: { hasLever: false } }),
    fixRow({ company: 'Top',   overall: 9.3, tier: 'T1', fixability: { hasLever: true } }),
  ]
  const order = sortReportRows(rows, 'fixable', 'desc').map(r => r.company)
  // Lever-backed near-miss leads; the closer lever-less row follows; the two
  // zero-fixability rows (Far = too far, Top = no upgrade target) trail, and
  // among equal fixability the higher raw overall wins the tie-break.
  assert.equal(order[0], 'Lever')
  assert.equal(order[1], 'Close')
  assert.deepEqual(order.slice(2), ['Top', 'Far'])   // both fixability 0, tie-break by overall desc
})
