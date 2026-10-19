import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCompany, normalizeRole, listingKey,
  listingTrajectories, trajectorySummary, landscapeTrend, trendRecommendations,
  analyzeScoreTrend, scoredRows, DIMENSIONS,
} from '@/lib/scoreTrend'
import { NOISE_FLOORS, GATES } from '@/lib/scoringStats'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'
import type { ScoreEntry } from '@/types'

// One scored eval of a listing. Want / Ease drive every v2 trend; the verdict
// is replayed from the grid unless given.
const ev = (company: string, role: string, date: string, want: number, ease: number, over: Partial<ScoreEntry> = {}) =>
  makeScoreEntry({ company, role, date, want, ease, ...over })

// ─── keys ────────────────────────────────────────────────────────────────────

test('normalizeCompany / normalizeRole / listingKey collapse spelling drift', () => {
  assert.equal(normalizeCompany('Acme, Inc.'), 'acmeinc')
  assert.equal(normalizeRole('  Data   Analyst '), 'data analyst')
  assert.equal(listingKey('Acme Inc', 'Data  Analyst'), listingKey('acme, inc', 'data analyst'))
})

test('DIMENSIONS are the nine judged v2 dims, all real ScoreEntry fields', () => {
  assert.equal(DIMENSIONS.length, 9)
  const sample = makeScoreEntry()
  for (const d of DIMENSIONS) assert.ok(d.key in sample, d.key)
  assert.ok(!DIMENSIONS.some(d => (d.key as string) === 'salary_adj_city'))
})

// ─── scored rows only ────────────────────────────────────────────────────────

test('blocked and unscored rows never enter a score trend', () => {
  const rows = [
    ev('A', 'x', '2026-10-01', 8, 7),
    makeBlockedEntry('x', { company: 'A', role: 'x', date: '2026-10-02' }),
    makeScoreEntry({ company: 'A', role: 'x', date: '2026-10-03' }), // want/ease null
  ]
  assert.equal(scoredRows(rows).length, 1)
  assert.equal(listingTrajectories(rows).length, 0)
})

// ─── trajectories ────────────────────────────────────────────────────────────

test('a single evaluation is not a trajectory', () => {
  assert.equal(listingTrajectories([ev('A', 'x', '2026-10-01', 8, 7)]).length, 0)
})

test('Want and Ease move independently, each against its own floor', () => {
  const [t] = listingTrajectories([
    ev('Acme', 'Analyst', '2026-09-01', 7.0, 5.0),
    ev('Acme', 'Analyst', '2026-10-01', 7.2, 6.0),
  ])
  assert.equal(t.evals, 2)
  assert.equal(t.want.delta, 0.2)
  assert.equal(t.want.movementClass, 'within-noise')   // 0.2 < 0.30
  assert.equal(t.ease.delta, 1)
  assert.equal(t.ease.movementClass, 'improving')
  assert.equal(t.ease.noiseFloor, NOISE_FLOORS.ease)
  assert.equal(t.detectable, true)
  assert.equal(t.verdictFrom, 'thin')
  assert.equal(t.verdictTo, 'thin')
  assert.equal(t.verdictChanged, false)
})

test('the Ease floor is 0.35: Δ 0.34 is flat, Δ 0.35 is movement', () => {
  const flat = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 7, 6.34)])[0]
  assert.equal(flat.ease.movementClass, 'within-noise')
  const moved = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 7, 6.35)])[0]
  assert.equal(moved.ease.movementClass, 'improving')
})

test('the Want floor is 0.30: one motivator step (0.25) is flat, 0.30 is movement', () => {
  const flat = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 6.75, 6)])[0]
  assert.equal(flat.want.movementClass, 'within-noise')
  const moved = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 6.7, 6)])[0]
  assert.equal(moved.want.movementClass, 'declining')
})

test('same-date duplicate writes collapse to the last row', () => {
  const rows = [ev('A', 'x', '2026-10-01', 7, 6), ev('A', 'x', '2026-10-01', 9, 9)]
  assert.equal(listingTrajectories(rows).length, 0)
})

test('a verdict change is reported as an upgrade or downgrade', () => {
  const ts = listingTrajectories([
    ev('Up', 'x', '2026-09-01', 8.2, 5.5), ev('Up', 'x', '2026-10-01', 8.2, 7.2),       // stretch → go
    ev('Down', 'x', '2026-09-01', 7.5, 7.5), ev('Down', 'x', '2026-10-01', 6.0, 7.5),   // solid → skip
  ])
  const up = ts.find(t => t.company === 'Up')!
  assert.equal(up.verdictFrom, 'stretch')
  assert.equal(up.verdictTo, 'go')
  const s = trajectorySummary(ts)
  assert.equal(s.verdictUpgrades, 1)
  assert.equal(s.verdictDowngrades, 1)
  assert.equal(s.reevaluated, 2)
  assert.equal(s.want.movement.declining, 1)
  assert.equal(s.ease.movement.improving, 1)
  assert.equal(s.detectable, 2)
})

test('topMover identifies the judged dimension that moved most; peak/trough per metric', () => {
  const [t] = listingTrajectories([
    ev('A', 'x', '2026-08-01', 7, 5, { skills_match: 5, experience_bar: 4 }),
    ev('A', 'x', '2026-09-01', 7, 8),
    ev('A', 'x', '2026-10-01', 7, 6, { skills_match: 6, experience_bar: 7 }),
  ])
  assert.equal(t.topMover?.key, 'experience_bar')
  assert.equal(t.topMover?.delta, 3)
  assert.equal(t.ease.peak, 8)
  assert.equal(t.ease.trough, 5)
  assert.equal(t.confidence, 'low') // 3 evals, gate 2 → low
})

// ─── landscape trend ─────────────────────────────────────────────────────────

function isoDay(offset: number): string {
  const d = new Date(Date.UTC(2026, 0, 1 + offset))
  return d.toISOString().slice(0, 10)
}
function windows(perWindow: number, older: [number, number], recent: [number, number]): ScoreEntry[] {
  const rows: ScoreEntry[] = []
  for (let i = 0; i < perWindow; i++) rows.push(ev(`O${i}`, 'x', isoDay(i), older[0], older[1]))
  for (let i = 0; i < perWindow; i++) rows.push(ev(`R${i}`, 'x', isoDay(100 + i), recent[0], recent[1]))
  return rows
}

test('landscapeTrend reports insufficientData below the row floor, with the gate attached', () => {
  const t = landscapeTrend([ev('A', 'x', '2026-10-01', 7, 7)])
  assert.equal(t.insufficientData, true)
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.want.reportableVerdict, 'insufficient-data')
  assert.equal(t.ease.reportableVerdict, 'insufficient-data')
})

test('under the per-window gate the corpus verdict is withheld on both axes', () => {
  const t = landscapeTrend(windows(5, [6, 5], [8, 8]))
  assert.equal(t.insufficientData, false)
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.want.reportableVerdict, 'insufficient-data')
  assert.equal(t.ease.reportableVerdict, 'insufficient-data')
})

test('at 10 per window each axis gets its own verdict', () => {
  const t = landscapeTrend(windows(GATES.trendMinPerWindowForVerdict, [7, 5], [7.1, 6]))
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.verdictConfidence, 'low')
  assert.equal(t.want.reportableVerdict, 'flat-within-noise')  // Δ 0.1
  assert.equal(t.ease.reportableVerdict, 'improving')          // Δ 1.0
  if (!t.insufficientData) {
    assert.equal(t.older.avgWant, 7)
    assert.equal(t.recent.avgEase, 6)
    // (7, 5) is skip; (7.1, 6) is thin — neither is apply-worthy.
    assert.equal(t.older.applyWorthyShare, 0)
    assert.equal(t.recent.applyWorthyShare, 0)
  }
})

test('apply-worthy share counts go / stretch / solid verdicts', () => {
  const t = landscapeTrend(windows(10, [6, 6], [8, 7.5]))
  assert.ok(!t.insufficientData)
  if (!t.insufficientData) {
    assert.equal(t.older.applyWorthyShare, 0)
    assert.equal(t.recent.applyWorthyShare, 100)
    assert.equal(t.applyWorthyShareDelta, 100)
  }
})

// ─── recommendations ─────────────────────────────────────────────────────────

test('trendRecommendations names the axis that slid / climbed', () => {
  const ts = listingTrajectories([
    ev('Slide', 'x', '2026-09-01', 8, 7), ev('Slide', 'x', '2026-10-01', 8, 5.5),
    ev('Climb', 'x', '2026-09-01', 6.5, 6), ev('Climb', 'x', '2026-10-01', 8, 6),
  ])
  const recs = trendRecommendations(ts, landscapeTrend([]))
  assert.match(recs[0].action, /Re-check "Slide — x": Ease slid 7 → 5.5/)
  assert.match(recs[1].action, /Prioritize "Climb — x": Want climbed 6.5 → 8/)
})

test('a sub-floor listing move never becomes a recommendation', () => {
  const ts = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 7.2, 6.3)])
  assert.deepEqual(trendRecommendations(ts, landscapeTrend([]), { minDelta: 0.1 }), [])
})

test('recommendations emit a withheld marker instead of a gated direction', () => {
  const rows = windows(5, [6, 5], [8, 8])
  const recs = trendRecommendations([], landscapeTrend(rows))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].insufficientData, true)
  assert.equal(recs[0].confidence, 'insufficient')
})

test('ungated corpus claims are stated per axis, with sample and tier', () => {
  const recs = trendRecommendations([], landscapeTrend(windows(10, [7, 5], [7.1, 6])))
  assert.equal(recs.length, 2)
  assert.match(recs[0].action, /^Want trend: flat within noise/)
  assert.match(recs[1].action, /Roles are getting more reachable/)
  for (const r of recs) {
    assert.equal(r.sampleSize, 10)
    assert.equal(r.gate, 10)
    assert.equal(r.confidence, 'low')
  }
})

// ─── top level ───────────────────────────────────────────────────────────────

test('analyzeScoreTrend errors on empty or all-blocked input', () => {
  assert.ok(analyzeScoreTrend([]).error)
  assert.ok(analyzeScoreTrend([makeBlockedEntry()]).error)
})

test('analyzeScoreTrend returns a fully shaped analysis and stamps its contract', () => {
  const rows = [
    ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 8, 7),
    makeBlockedEntry('x', { company: 'B', role: 'y', date: '2026-10-01' }),
  ]
  const a = analyzeScoreTrend(rows)
  assert.equal(a.metadata?.evaluated, 2)
  assert.equal(a.metadata?.blocked, 1)
  assert.equal(a.metadata?.reevaluatedListings, 1)
  assert.deepEqual(a.metadata?.contract.noiseFloors, { want: 0.30, ease: 0.35 })
  assert.equal(a.metadata?.contract.minPerWindowForVerdict, 10)
  assert.ok(a.trajectorySummary)
  assert.ok(a.landscapeTrend)
  assert.ok(Array.isArray(a.recommendations))
})
