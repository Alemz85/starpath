import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCompany, normalizeRole, listingKey,
  overallBand, classifyDelta,
  listingTrajectories, trajectorySummary,
  landscapeTrend, trendRecommendations, analyzeScoreTrend,
  DIMENSIONS, OVERALL_NOISE_FLOOR,
} from '@/lib/scoreTrend'
import { GATES } from '@/lib/scoringStats'
import { makeScoreEntry } from '@/test-utils/fixtures'
import type { ScoreEntry } from '@/types'

// ─── Key normalization (must match dedup-index.mjs) ──────────────────────────

test('normalizeCompany strips all non-alphanumerics and lowercases', () => {
  assert.equal(normalizeCompany('Celonis'), 'celonis')
  assert.equal(normalizeCompany('celonis '), 'celonis')
  assert.equal(normalizeCompany('S&P Global'), 'spglobal')
})

test('normalizeRole collapses internal whitespace and trims', () => {
  assert.equal(normalizeRole('Strategy  Analyst  Internship'), 'strategy analyst internship')
  assert.equal(normalizeRole('  Data Analyst '), 'data analyst')
})

test('listingKey collapses spelling drift onto one key', () => {
  assert.equal(
    listingKey('Celonis', 'Strategy  Analyst  Internship'),
    listingKey('celonis ', 'Strategy Analyst Internship'),
  )
})

// ─── Band + delta classification ─────────────────────────────────────────────

test('overallBand maps the documented thresholds', () => {
  assert.equal(overallBand(7.5), 'strong')
  assert.equal(overallBand(7.0), 'solid')
  assert.equal(overallBand(6.0), 'pass')
  assert.equal(overallBand(5.9), 'weak')
  assert.equal(overallBand(NaN), 'unknown')
})

test('classifyDelta honors the stable dead-band', () => {
  assert.equal(classifyDelta(0.3), 'improving')
  assert.equal(classifyDelta(-0.3), 'declining')
  assert.equal(classifyDelta(0.2), 'stable')   // inside default ±0.25 band
  assert.equal(classifyDelta(0.2, 0.1), 'improving') // tighter band flips it
  assert.equal(classifyDelta(NaN), 'unknown')
})

// ─── Per-listing trajectories ────────────────────────────────────────────────

test('a single evaluation is not a trajectory', () => {
  const rows = [makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 7 })]
  assert.equal(listingTrajectories(rows).length, 0)
})

test('two evals on distinct dates form an improving trajectory', () => {
  const rows = [
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 6.0 }),
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-02-01', overall: 7.5 }),
  ]
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 2)
  assert.equal(t.firstOverall, 6.0)
  assert.equal(t.latestOverall, 7.5)
  assert.equal(t.delta, 1.5)
  assert.equal(t.verdict, 'improving')
  assert.equal(t.bandFrom, 'pass')
  assert.equal(t.bandTo, 'strong')
  assert.equal(t.bandChanged, true)
})

test('same-date duplicate writes collapse to the last row (no fake movement)', () => {
  const rows = [
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 6.0 }),
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 9.0 }),
  ]
  // Both on the same date → collapses to one row → not a trajectory.
  assert.equal(listingTrajectories(rows).length, 0)
})

test('spelling drift across re-evals collapses onto one trajectory', () => {
  const rows = [
    makeScoreEntry({ company: 'Celonis', role: 'Strategy Analyst', date: '2026-01-01', overall: 7 }),
    makeScoreEntry({ company: 'celonis ', role: 'Strategy  Analyst', date: '2026-02-01', overall: 8 }),
  ]
  const traj = listingTrajectories(rows)
  assert.equal(traj.length, 1)
  assert.equal(traj[0].evals, 2)
})

test('topMover identifies the dimension that moved most', () => {
  const rows = [
    makeScoreEntry({
      company: 'Acme', role: 'Analyst', date: '2026-01-01',
      overall: 6, skills_match: 5, brand_value: 5, strategic_fit: 5,
    }),
    makeScoreEntry({
      company: 'Acme', role: 'Analyst', date: '2026-02-01',
      overall: 7, skills_match: 9, brand_value: 6, strategic_fit: 4,
    }),
  ]
  const [t] = listingTrajectories(rows)
  assert.equal(t.topMover?.key, 'skills_match')   // +4, biggest absolute mover
  assert.equal(t.topMover?.delta, 4)
})

test('peak/trough capture volatility a first→latest delta hides', () => {
  const rows = [
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 6 }),
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-01-15', overall: 9 }),
    makeScoreEntry({ company: 'Acme', role: 'Analyst', date: '2026-02-01', overall: 6.5 }),
  ]
  const [t] = listingTrajectories(rows)
  assert.equal(t.peakOverall, 9)
  assert.equal(t.troughOverall, 6)
  assert.equal(t.delta, 0.5)  // first→latest only
  assert.equal(t.sequence.length, 3)
})

test('trajectories sort by absolute delta, biggest first', () => {
  const rows = [
    makeScoreEntry({ company: 'Small', role: 'X', date: '2026-01-01', overall: 7.0 }),
    makeScoreEntry({ company: 'Small', role: 'X', date: '2026-02-01', overall: 7.3 }),
    makeScoreEntry({ company: 'Big', role: 'Y', date: '2026-01-01', overall: 5.0 }),
    makeScoreEntry({ company: 'Big', role: 'Y', date: '2026-02-01', overall: 8.0 }),
  ]
  const traj = listingTrajectories(rows)
  assert.equal(traj[0].company, 'Big')   // |3.0| > |0.3|
  assert.equal(traj[1].company, 'Small')
})

// ─── Trajectory summary ──────────────────────────────────────────────────────

test('trajectorySummary tallies verdicts and band moves', () => {
  const rows = [
    // improving + band upgrade (pass → strong)
    makeScoreEntry({ company: 'A', role: 'r', date: '2026-01-01', overall: 6 }),
    makeScoreEntry({ company: 'A', role: 'r', date: '2026-02-01', overall: 8 }),
    // declining + band downgrade (solid → weak)
    makeScoreEntry({ company: 'B', role: 'r', date: '2026-01-01', overall: 7 }),
    makeScoreEntry({ company: 'B', role: 'r', date: '2026-02-01', overall: 5 }),
    // stable
    makeScoreEntry({ company: 'C', role: 'r', date: '2026-01-01', overall: 7 }),
    makeScoreEntry({ company: 'C', role: 'r', date: '2026-02-01', overall: 7.1 }),
  ]
  const s = trajectorySummary(listingTrajectories(rows))
  assert.equal(s.reevaluated, 3)
  assert.equal(s.verdicts.improving, 1)
  assert.equal(s.verdicts.declining, 1)
  assert.equal(s.verdicts.stable, 1)
  assert.equal(s.bandUpgrades, 1)
  assert.equal(s.bandDowngrades, 1)
})

// ─── Landscape trend ─────────────────────────────────────────────────────────

test('landscapeTrend reports insufficientData below the row floor', () => {
  const rows = [
    makeScoreEntry({ date: '2026-01-01', overall: 7 }),
    makeScoreEntry({ date: '2026-02-01', overall: 8 }),
  ]
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, true)
})

test('landscapeTrend splits into older vs recent and reads improving', () => {
  const rows = [
    ...[0, 1, 2].map(i => makeScoreEntry({ date: `2026-01-0${i + 1}`, overall: 5 })),
    ...[0, 1, 2].map(i => makeScoreEntry({ date: `2026-02-0${i + 1}`, overall: 8 })),
  ]
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, false)
  if (!t.insufficientData) {
    assert.equal(t.older.avgOverall, 5)
    assert.equal(t.recent.avgOverall, 8)
    assert.equal(t.delta, 3)
    assert.equal(t.verdict, 'improving')
    assert.equal(t.older.count, 3)
    assert.equal(t.recent.count, 3)
  }
})

test('landscapeTrend reports concentration when no balanced split exists', () => {
  // 6 rows but only 2 distinct dates, lopsided 5/1 — no boundary clears
  // minPerWindow=3 on both sides.
  const rows = [
    ...[0, 1, 2, 3, 4].map(() => makeScoreEntry({ date: '2026-01-01', overall: 6 })),
    makeScoreEntry({ date: '2026-02-01', overall: 9 }),
  ]
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, true)
})

// ─── Recommendations ─────────────────────────────────────────────────────────

test('trendRecommendations surfaces sharpest decliner and improver', () => {
  const rows = [
    makeScoreEntry({ company: 'Sliding', role: 'r', date: '2026-01-01', overall: 8 }),
    makeScoreEntry({ company: 'Sliding', role: 'r', date: '2026-02-01', overall: 6 }),
    makeScoreEntry({ company: 'Rising', role: 'r', date: '2026-01-01', overall: 6 }),
    makeScoreEntry({ company: 'Rising', role: 'r', date: '2026-02-01', overall: 8 }),
  ]
  const traj = listingTrajectories(rows)
  const trend = landscapeTrend(rows)
  const recs = trendRecommendations(traj, trend)
  assert.ok(recs.some(r => r.action.includes('Re-check') && r.action.includes('Sliding')))
  assert.ok(recs.some(r => r.action.includes('Prioritize') && r.action.includes('Rising')))
})

test('trendRecommendations stays quiet under the minDelta floor', () => {
  const rows = [
    makeScoreEntry({ company: 'Flat', role: 'r', date: '2026-01-01', overall: 7.0 }),
    makeScoreEntry({ company: 'Flat', role: 'r', date: '2026-02-01', overall: 7.3 }),
  ]
  const traj = listingTrajectories(rows)
  const trend = landscapeTrend(rows)  // insufficientData with 2 rows
  // 0.3 < default minDelta 0.5, and the trend is insufficient → no recs.
  assert.equal(trendRecommendations(traj, trend).length, 0)
})

// ─── Top-level analysis ──────────────────────────────────────────────────────

test('analyzeScoreTrend errors on empty input', () => {
  assert.ok(analyzeScoreTrend([]).error)
})

test('analyzeScoreTrend returns a fully shaped analysis', () => {
  const rows = [
    makeScoreEntry({ company: 'A', role: 'r', date: '2026-01-01', overall: 6 }),
    makeScoreEntry({ company: 'A', role: 'r', date: '2026-02-01', overall: 8 }),
    makeScoreEntry({ company: 'B', role: 'r', date: '2026-01-02', overall: 7 }),
    makeScoreEntry({ company: 'C', role: 'r', date: '2026-02-02', overall: 9 }),
  ]
  const a = analyzeScoreTrend(rows)
  assert.equal(a.error, undefined)
  assert.equal(a.metadata?.evaluated, 4)
  assert.equal(a.metadata?.reevaluatedListings, 1)
  assert.equal(a.metadata?.dateRange.from, '2026-01-01')
  assert.equal(a.metadata?.dateRange.to, '2026-02-02')
  assert.ok(Array.isArray(a.listingTrajectories))
  assert.ok(a.trajectorySummary)
  assert.ok(a.landscapeTrend)
})

test('DIMENSIONS keys are real numeric ScoreEntry fields', () => {
  const e = makeScoreEntry()
  for (const { key } of DIMENSIONS) {
    assert.equal(typeof e[key], 'number')
  }
})

// ─── Statistical contract (docs/scoring-statistical-design.md) ───────────────
//
// Legacy `verdict` / `stable` keep their ±0.25 and ±0.15 dead-bands (docs § 5);
// the ADDED fields are the honest read and are what renderers must use.

const traj = (company: string, points: Array<[string, number]>): ScoreEntry[] =>
  points.map(([date, overall]) => makeScoreEntry({ company, role: 'r', date, overall }))

test('a delta EXACTLY at the noise floor is detectable movement', () => {
  const [t] = listingTrajectories(traj('Edge', [['2026-01-01', 7.0], ['2026-02-01', 7.3]]))
  assert.equal(t.delta, 0.3)
  assert.equal(t.movementClass, 'improving')
  assert.equal(t.detectable, true)
  assert.equal(t.noiseFloor, OVERALL_NOISE_FLOOR)
})

test('a delta one hundredth under the floor is flat within noise, both directions', () => {
  const [up] = listingTrajectories(traj('Up', [['2026-01-01', 7.0], ['2026-02-01', 7.29]]))
  assert.equal(up.delta, 0.29)
  assert.equal(up.movementClass, 'within-noise')
  assert.equal(up.detectable, false)
  // …and the LEGACY verdict disagrees, on purpose: 0.29 clears its ±0.25
  // dead-band. Docs § 5 — the contract field is the correct answer.
  assert.equal(up.verdict, 'improving')

  const [down] = listingTrajectories(traj('Down', [['2026-01-01', 7.29], ['2026-02-01', 7.0]]))
  assert.equal(down.movementClass, 'within-noise')
  assert.equal(down.verdict, 'declining')
})

test('one Current-Fit dimension wobbling a step never reads as movement', () => {
  // 0.70/3 = 0.2333 → rounds to 0.23 in Overall; still under the floor.
  const [t] = listingTrajectories(traj('Wobble', [['2026-01-01', 7.0], ['2026-02-01', 7.23]]))
  assert.equal(t.movementClass, 'within-noise')
})

test('trajectory confidence is the tier over the evaluation count (gate 2)', () => {
  const tiers = ([2, 3, 4, 8] as const).map(n => {
    const points: Array<[string, number]> = Array.from({ length: n }, (_, i) => [
      `2026-0${i + 1}-01`, 7 + i * 0.5,
    ])
    return listingTrajectories(traj(`N${n}`, points))[0].confidence
  })
  assert.deepEqual(tiers, ['low', 'low', 'moderate', 'high'])
  assert.equal(GATES.trendMinEvals, 2)
})

test('trajectorySummary counts the noise-floor split alongside the legacy one', () => {
  const rows = [
    ...traj('Real',  [['2026-01-01', 6.0], ['2026-02-01', 8.0]]),   // +2.0 → improving
    ...traj('Slid',  [['2026-01-01', 8.0], ['2026-02-01', 7.0]]),   // −1.0 → declining
    ...traj('Jitter', [['2026-01-01', 7.0], ['2026-02-01', 7.29]]), // +0.29 → within-noise
  ]
  const s = trajectorySummary(listingTrajectories(rows))
  assert.equal(s.reevaluated, 3)
  assert.equal(s.movement.improving, 1)
  assert.equal(s.movement.declining, 1)
  assert.equal(s.movement['within-noise'], 1)
  assert.equal(s.withinNoise, 1)
  assert.equal(s.detectable, 2)
  assert.equal(s.noiseFloor, OVERALL_NOISE_FLOOR)
  // Legacy split still counts the 0.29 jitter as "improving" — kept for
  // compatibility, never rendered as the answer.
  assert.equal(s.verdicts.improving, 2)
})

// A landscape of `perWindow` evals per side, with the given window averages.
// Dates are real ISO days (one eval per day) so the balanced-split search has
// a genuine calendar axis to cut on, at any window size.
function isoDay(start: string, offset: number): string {
  const d = new Date(`${start}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function windows(perWindow: number, olderAvg: number, recentAvg: number): ScoreEntry[] {
  return [
    ...Array.from({ length: perWindow }, (_, i) =>
      makeScoreEntry({ company: `O${i}`, role: 'r', date: isoDay('2025-11-01', i), overall: olderAvg })),
    ...Array.from({ length: perWindow }, (_, i) =>
      makeScoreEntry({ company: `R${i}`, role: 'r', date: isoDay('2026-03-01', i), overall: recentAvg })),
  ]
}

test('a corpus verdict under the per-window gate is withheld, not weakened', () => {
  const t = landscapeTrend(windows(9, 5, 8))   // 9 per window < 10
  assert.equal(t.insufficientData, false)
  assert.equal(t.reportableVerdict, 'insufficient-data')
  assert.equal(t.verdictConfidence, 'insufficient')
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.verdictGate.minPerWindow, GATES.trendMinPerWindowForVerdict)
  assert.equal(t.verdictGate.olderCount, 9)
  assert.equal(t.verdictGate.recentCount, 9)
  assert.match(String(t.verdictGate.reason), /9 eval\(s\) in the earlier window/)
  if (!t.insufficientData) {
    // The legacy verdict still says "improving" — that's exactly why the
    // contract field exists and why renderers must read it instead.
    assert.equal(t.verdict, 'improving')
  }
})

test('exactly 10 evals per window unlocks the verdict, at low confidence', () => {
  const t = landscapeTrend(windows(10, 5, 8))   // ← boundary
  assert.equal(t.insufficientData, false)
  assert.equal(t.reportableVerdict, 'improving')
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.verdictConfidence, 'low')      // 10–19 per window
  if (!t.insufficientData) assert.equal(t.delta, 3)
})

test('corpus confidence climbs at 2× and 4× the window gate', () => {
  assert.equal(landscapeTrend(windows(19, 5, 8)).verdictConfidence, 'low')
  assert.equal(landscapeTrend(windows(20, 5, 8)).verdictConfidence, 'moderate')  // ← 2× gate
  assert.equal(landscapeTrend(windows(39, 5, 8)).verdictConfidence, 'moderate')
  assert.equal(landscapeTrend(windows(40, 5, 8)).verdictConfidence, 'high')      // ← 4× gate
})

test('above the gate but under the floor, the corpus verdict is flat within noise', () => {
  const t = landscapeTrend(windows(12, 7.0, 7.2))   // Δ 0.20 < 0.30
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.reportableVerdict, 'flat-within-noise')
  if (!t.insufficientData) assert.equal(t.delta, 0.2)
})

test('the structural early-outs carry the gate too, so consumers never special-case', () => {
  const tiny = landscapeTrend([
    makeScoreEntry({ date: '2026-01-01', overall: 7 }),
    makeScoreEntry({ date: '2026-02-01', overall: 8 }),
  ])
  assert.equal(tiny.insufficientData, true)
  assert.equal(tiny.reportableVerdict, 'insufficient-data')
  assert.equal(tiny.verdictGate.met, false)
  assert.equal(tiny.verdictConfidence, 'insufficient')
  assert.equal(tiny.noiseFloor, OVERALL_NOISE_FLOOR)
})

test('recommendations emit a withheld marker instead of a gated direction', () => {
  const rows = windows(9, 5, 8)
  const recs = trendRecommendations(listingTrajectories(rows), landscapeTrend(rows))
  const corpus = recs.filter(r => r.action.startsWith('Landscape trend'))
  assert.equal(corpus.length, 1)
  assert.equal(corpus[0].insufficientData, true)
  assert.equal(corpus[0].confidence, 'insufficient')
  assert.equal(corpus[0].sampleSize, 9)
  assert.equal(corpus[0].gate, GATES.trendMinPerWindowForVerdict)
  // No direction anywhere in the withheld copy.
  assert.ok(!recs.some(r => /sharpening|sliding/.test(r.action)))
})

test('recommendations state flat-within-noise as a finding, with its n', () => {
  const rows = windows(12, 7.0, 7.2)
  const recs = trendRecommendations(listingTrajectories(rows), landscapeTrend(rows))
  const flat = recs.find(r => r.action.includes('flat within noise'))
  assert.ok(flat)
  assert.equal(flat.confidence, 'low')
  assert.equal(flat.sampleSize, 12)
  assert.match(flat.reasoning, /12 vs 12 evals/)
  assert.ok(!/[↑↓]/.test(flat.action))
})

test('an ungated corpus direction states its sample and tier', () => {
  const rows = windows(10, 5, 8)
  const recs = trendRecommendations(listingTrajectories(rows), landscapeTrend(rows))
  const sharpening = recs.find(r => r.action.includes('Targeting is sharpening'))
  assert.ok(sharpening)
  assert.equal(sharpening.confidence, 'low')
  assert.equal(sharpening.sampleSize, 10)
  assert.match(sharpening.reasoning, /10 earlier vs 10 recent evals; low confidence/)
})

test('a sub-floor listing move never becomes a re-check recommendation', () => {
  // Δ 0.29 with a deliberately loose minDelta: the floor still blocks it.
  const rows = traj('Jitter', [['2026-01-01', 7.0], ['2026-02-01', 7.29]])
  const recs = trendRecommendations(listingTrajectories(rows), landscapeTrend(rows), { minDelta: 0.1 })
  assert.ok(!recs.some(r => r.action.includes('Jitter')))
})

test('analyzeScoreTrend stamps the contract it was produced under', () => {
  const a = analyzeScoreTrend(windows(10, 5, 8))
  assert.equal(a.metadata?.contract.doc, 'docs/scoring-statistical-design.md')
  assert.equal(a.metadata?.contract.noiseFloor, OVERALL_NOISE_FLOOR)
  assert.equal(a.metadata?.contract.minEvalsPerTrajectory, GATES.trendMinEvals)
  assert.equal(a.metadata?.contract.minPerWindowForVerdict, GATES.trendMinPerWindowForVerdict)
})
