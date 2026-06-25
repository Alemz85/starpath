import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCompany, normalizeRole, listingKey,
  overallBand, classifyDelta,
  listingTrajectories, trajectorySummary,
  landscapeTrend, trendRecommendations, analyzeScoreTrend,
  DIMENSIONS,
} from '@/lib/scoreTrend'
import { makeScoreEntry } from '@/test-utils/fixtures'

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
