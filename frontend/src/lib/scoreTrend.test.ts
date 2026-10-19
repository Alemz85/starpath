import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCompany, normalizeRole, listingKey, verdictMove,
  listingTrajectories, trajectorySummary, landscapeTrend, trendRecommendations,
  analyzeScoreTrend, scoredRows, describeTrajectory, DIMENSIONS,
} from '@/lib/scoreTrend'
import { NOISE_FLOORS, GATES } from '@/lib/scoringStats'
import { verdictOf } from '@/lib/scoreBands'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'
import type { ScoreEntry } from '@/types'
// @ts-ignore — plain ESM .mjs with no type declarations; imported so the
// parity test below runs the SAME rows through the canonical backend core.
import * as core from '../../../scripts/lib/score-trend-core.mjs'

// One scored eval of a listing. Want / Ease drive every v2 trend; the verdict
// is replayed from the grid unless given. Company names are fictional.
const ev = (company: string, role: string, date: string, want: number, ease: number, over: Partial<ScoreEntry> = {}) =>
  makeScoreEntry({ company, role, date, want, ease, ...over })
const blocked = (company: string, role: string, date: string) =>
  makeBlockedEntry('Work authorisation required', { company, role, date })

// ─── keys + dims ─────────────────────────────────────────────────────────────

test('normalizeCompany / normalizeRole / listingKey collapse spelling drift', () => {
  assert.equal(normalizeCompany('Acme, Inc.'), 'acmeinc')
  assert.equal(normalizeRole('  Data   Analyst '), 'data analyst')
  assert.equal(listingKey('Acme Inc', 'Data  Analyst'), listingKey('acme, inc', 'data analyst'))
})

test('DIMENSIONS are the ten v2 dims with group and rollup, all real ScoreEntry fields', () => {
  assert.equal(DIMENSIONS.length, 10)
  const sample = makeScoreEntry()
  for (const d of DIMENSIONS) assert.ok(d.key in sample, d.key)
  assert.deepEqual(
    DIMENSIONS.map(d => [d.key, d.group, d.rollup]),
    (core.DIMENSIONS as Array<{ key: string; group: string; rollup: string }>).map(d => [d.key, d.group, d.rollup]),
  )
})

test('verdictMove orders blocked < skip < thin < growth < solid < stretch < go', () => {
  assert.equal(verdictMove('blocked', 'skip'), 'upgrade')
  assert.equal(verdictMove('growth', 'solid'), 'upgrade')
  assert.equal(verdictMove('go', 'stretch'), 'downgrade')
  assert.equal(verdictMove('thin', 'thin'), 'same')
  assert.equal(verdictMove(null, 'go'), 'unknown')
  const order = ['blocked', 'skip', 'thin', 'growth', 'solid', 'stretch', 'go'] as const
  for (let i = 1; i < order.length; i++) {
    assert.equal(verdictMove(order[i - 1], order[i]), core.verdictMove(order[i - 1], order[i]))
  }
})

// ─── scored rows ─────────────────────────────────────────────────────────────

test('blocked and unscored rows never enter a score number', () => {
  const rows = [
    ev('A', 'x', '2026-10-01', 8, 7),
    blocked('A', 'x', '2026-10-02'),
    makeScoreEntry({ company: 'A', role: 'x', date: '2026-10-03' }), // want/ease null
  ]
  assert.equal(scoredRows(rows).length, 1)
  // The blocked eval still counts on the verdict axis: A is a trajectory.
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 2)
  assert.equal(t.scoredEvals, 1)
  assert.equal(t.blockedEvals, 1)
  assert.equal(t.want.n, 1)
  assert.equal(t.want.delta, null)
  assert.equal(t.want.movementClass, 'unknown')
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
  assert.equal(t.want.detectable, false)
  assert.equal(t.ease.delta, 1)
  assert.equal(t.ease.movementClass, 'improving')
  assert.equal(t.ease.noiseFloor, NOISE_FLOORS.ease)
  assert.equal(t.ease.n, 2)
  assert.equal(t.ease.confidence, 'low')
  assert.equal(t.verdictFrom, 'thin')
  assert.equal(t.verdictTo, 'thin')
  assert.equal(t.verdictMove, 'same')
  assert.equal(t.verdictChanged, false)
  assert.equal(t.verdictMoveDetectable, false)
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

test('a verdict change is reported as an upgrade or downgrade, and summarized', () => {
  const ts = listingTrajectories([
    ev('Up', 'x', '2026-09-01', 8.2, 5.5), ev('Up', 'x', '2026-10-01', 8.2, 7.2),       // stretch → go
    ev('Down', 'x', '2026-09-01', 7.5, 7.5), ev('Down', 'x', '2026-10-01', 6.0, 7.5),   // solid → skip
  ])
  const up = ts.find(t => t.company === 'Up')!
  assert.equal(up.verdictFrom, 'stretch')
  assert.equal(up.verdictTo, 'go')
  assert.equal(up.verdictMove, 'upgrade')
  assert.equal(up.verdictMoveDetectable, true)
  const s = trajectorySummary(ts)
  assert.equal(s.reevaluated, 2)
  assert.deepEqual(s.verdictMoves, { upgrade: 1, downgrade: 1, same: 0, unknown: 0 })
  assert.equal(s.want.declining, 1)
  assert.equal(s.want.withinNoise, 1)
  assert.equal(s.ease.improving, 1)
  assert.equal(s.want.n, 2)
  assert.equal(s.want.detectable, 1)
})

test('a verdict move across a grid line on a sub-floor wobble is not detectable', () => {
  // Want 8.1 → 7.9 crosses the 8.0 line (go → solid) but |Δ| 0.2 < 0.30.
  const [t] = listingTrajectories([ev('A', 'x', '2026-09-01', 8.1, 7.5), ev('A', 'x', '2026-10-01', 7.9, 7.5)])
  assert.equal(t.verdictMove, 'downgrade')
  assert.equal(t.verdictChanged, true)
  assert.equal(t.verdictMoveDetectable, false)
})

test('blocked → scored is an always-detectable verdict upgrade', () => {
  const [t] = listingTrajectories([blocked('A', 'x', '2026-09-01'), ev('A', 'x', '2026-10-01', 7, 7.5)])
  assert.equal(t.verdictFrom, 'blocked')
  assert.equal(t.verdictTo, 'solid')
  assert.equal(t.blockedFrom, true)
  assert.equal(t.blockedTo, false)
  assert.equal(t.verdictMove, 'upgrade')
  assert.equal(t.verdictMoveDetectable, true)
  assert.deepEqual(t.sequence.map(p => p.want), [null, 7])
})

test('topMover is the rollup dim that drove a move past the floor; peak/trough per metric', () => {
  const [t] = listingTrajectories([
    ev('A', 'x', '2026-08-01', 7, 5, { skills_match: 5, experience_bar: 4, brand_value: 6 }),
    ev('A', 'x', '2026-09-01', 7, 8),
    ev('A', 'x', '2026-10-01', 7, 6, { skills_match: 6, experience_bar: 7, brand_value: 9 }),
  ])
  // brand_value moved most in absolute terms, but it rolls up into Want (flat) — the
  // Ease driver is experience_bar.
  assert.equal(t.ease.topMover?.key, 'experience_bar')
  assert.equal(t.ease.topMover?.delta, 3)
  assert.equal(t.want.topMover, null)
  assert.equal(t.ease.peak, 8)
  assert.equal(t.ease.trough, 5)
  assert.equal(t.confidence, 'low') // 3 evals, gate 2 → low
})

test('describeTrajectory states the verdict move and each metric, flat below its floor', () => {
  const [t] = listingTrajectories([ev('A', 'x', '2026-09-01', 7.5, 7.5), ev('A', 'x', '2026-10-01', 6.0, 7.6)])
  assert.equal(describeTrajectory(t), 'verdict Solid → Skip · Want 7.5 → 6 (-1.5) · Ease flat within noise')
})

// ─── landscape trend ─────────────────────────────────────────────────────────

function isoDay(offset: number): string {
  const d = new Date(Date.UTC(2026, 0, 1 + offset))
  return d.toISOString().slice(0, 10)
}
function windows(perWindow: number, earlier: [number, number], later: [number, number]): ScoreEntry[] {
  const rows: ScoreEntry[] = []
  for (let i = 0; i < perWindow; i++) rows.push(ev(`E${i}`, 'x', isoDay(i), earlier[0], earlier[1]))
  for (let i = 0; i < perWindow; i++) rows.push(ev(`L${i}`, 'x', isoDay(100 + i), later[0], later[1]))
  return rows
}

test('landscapeTrend reports insufficientData below the row floor, with the gate attached', () => {
  const t = landscapeTrend([ev('A', 'x', '2026-10-01', 7, 7)])
  assert.equal(t.insufficientData, true)
  assert.equal(t.splitDate, null)
  assert.equal(t.earlier, null)
  assert.equal(t.later, null)
  assert.equal(t.actionableShareDelta, null)
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.want.reportableVerdict, 'insufficient-data')
  assert.equal(t.ease.reportableVerdict, 'insufficient-data')
  assert.equal(t.verdictUpgrades.count, 0)
})

test('under the per-window gate the corpus verdict is withheld on both axes, numbers kept', () => {
  const t = landscapeTrend(windows(5, [6, 5], [8, 8]))
  assert.equal(t.insufficientData, false)
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.verdictGate.earlierCount, 5)
  assert.equal(t.verdictGate.laterCount, 5)
  assert.equal(t.want.reportableVerdict, 'insufficient-data')
  assert.equal(t.ease.reportableVerdict, 'insufficient-data')
  assert.equal(t.want.earlier, 6)
  assert.equal(t.want.later, 8)
  assert.equal(t.want.delta, 2)
})

test('at 10 per window each axis gets its own verdict', () => {
  const t = landscapeTrend(windows(GATES.trendMinPerWindowForVerdict, [7, 5], [7.1, 6]))
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.verdictConfidence, 'low')
  assert.equal(t.want.reportableVerdict, 'flat-within-noise')  // Δ 0.1
  assert.equal(t.ease.reportableVerdict, 'improving')          // Δ 1.0
  assert.equal(t.want.earlier, 7)
  assert.equal(t.ease.later, 6)
  assert.equal(t.ease.n, 10)
  if (!t.insufficientData) {
    // (7, 5) is thin; (7.1, 6) is thin — neither is actionable.
    assert.equal(t.earlier.actionableShare, 0)
    assert.equal(t.later.actionableShare, 0)
    assert.equal(t.earlier.verdicts.thin, 10)
  }
})

test('actionable share counts go / stretch / solid verdicts; blocked counted per window', () => {
  const rows = [...windows(10, [6, 6], [8, 7.5]), blocked('Z', 'y', isoDay(101))]
  const t = landscapeTrend(rows)
  assert.ok(!t.insufficientData)
  if (!t.insufficientData) {
    assert.equal(t.earlier.actionableShare, 0)
    assert.equal(t.later.actionableShare, 100)
    assert.equal(t.later.actionableCount, 10)
    assert.equal(t.actionableShareDelta, 100)
    assert.equal(t.later.blocked, 1)
    assert.equal(t.earlier.blocked, 0)
    assert.equal(t.blocked, 1)
  }
})

// ─── recommendations ─────────────────────────────────────────────────────────

test('trendRecommendations names the decliner then the improver', () => {
  const ts = listingTrajectories([
    ev('Slide', 'x', '2026-09-01', 8, 7), ev('Slide', 'x', '2026-10-01', 8, 5.5),
    ev('Climb', 'x', '2026-09-01', 6.5, 6), ev('Climb', 'x', '2026-10-01', 8, 6),
  ])
  const recs = trendRecommendations(ts, landscapeTrend([]))
  assert.match(recs[0].action, /^Re-check "Slide — x": verdict Go → Stretch · Want flat within noise · Ease 7 → 5.5 \(-1.5\)/)
  assert.match(recs[1].action, /^Prioritize "Climb — x": verdict If pipeline thin → Stretch · Want 6.5 → 8 \(\+1.5\)/)
  assert.equal(recs[0].impact, 'high')
})

test('a sub-floor listing move never becomes a recommendation', () => {
  const ts = listingTrajectories([ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 7.2, 6.3)])
  assert.deepEqual(trendRecommendations(ts, landscapeTrend([]), { minDelta: 0.1 }), [])
})

test('recommendations emit a withheld marker instead of a gated direction', () => {
  const recs = trendRecommendations([], landscapeTrend(windows(5, [6, 5], [8, 8])))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].insufficientData, true)
  assert.equal(recs[0].confidence, 'insufficient')
  assert.match(recs[0].reasoning, /Want \(0\.3\) or Ease \(0\.35\) noise floor/)
})

test('an ungated corpus claim is one line covering both axes, with sample and tier', () => {
  const recs = trendRecommendations([], landscapeTrend(windows(10, [7, 5], [7.1, 6])))
  assert.equal(recs.length, 1)
  assert.match(recs[0].action, /^Targeting is sharpening — Want flat within noise .*; Ease improving \(6 vs 5 earlier, \+1\)/)
  assert.equal(recs[0].sampleSize, 10)
  assert.equal(recs[0].gate, 10)
  assert.equal(recs[0].confidence, 'low')
})

// ─── top level ───────────────────────────────────────────────────────────────

test('analyzeScoreTrend errors on empty or all-blocked input', () => {
  assert.ok(analyzeScoreTrend([]).error)
  assert.ok(analyzeScoreTrend([makeBlockedEntry()]).error)
})

test('analyzeScoreTrend returns a fully shaped analysis and stamps its contract', () => {
  const rows = [
    ev('A', 'x', '2026-09-01', 7, 6), ev('A', 'x', '2026-10-01', 8, 7),
    blocked('B', 'y', '2026-10-01'),
  ]
  const a = analyzeScoreTrend(rows)
  assert.equal(a.metadata?.evaluated, 2)
  assert.equal(a.metadata?.blocked, 1)
  assert.equal(a.metadata?.reevaluatedListings, 1)
  assert.deepEqual(a.metadata?.contract, {
    doc: 'docs/scoring-statistical-design.md',
    noiseFloors: { want: 0.30, ease: 0.35 },
    minEvalsPerTrajectory: 2,
    minPerWindowForVerdict: 10,
  })
  assert.ok(a.trajectorySummary)
  assert.ok(a.landscapeTrend)
  assert.ok(Array.isArray(a.recommendations))
})

// ─── parity with scripts/lib/score-trend-core.mjs ────────────────────────────
// The core consumes parseScoreHistory rows: numeric cells as numbers (NaN when
// empty), a non-empty verdict for every scored row (replayed from the grid
// when the cell is empty), and `blocked` for eligibility red. Adapt the same
// ScoreEntry fixtures to that shape and compare every field but the clock.

function toCoreRow(r: ScoreEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  for (const [k, v] of Object.entries(r)) if (v === null) out[k] = NaN
  const isBlockedRow = r.eligibility === 'red' || r.verdict === 'blocked'
  out.blocked = isBlockedRow
  out.verdict = isBlockedRow ? 'blocked' : (verdictOf(r) ?? '')
  if (isBlockedRow) { out.want = NaN; out.ease = NaN }
  return out
}

function parityFixture(perWindow: number): ScoreEntry[] {
  const rows: ScoreEntry[] = []
  // Landscape filler across two calendar windows.
  for (let i = 0; i < perWindow; i++) {
    rows.push(ev(`Northwind ${i}`, 'Analyst', isoDay(i), 6 + (i % 4) * 0.5, 5 + (i % 3) * 0.7))
    rows.push(ev(`Contoso ${i}`, 'Associate', isoDay(60 + i), 7 + (i % 3) * 0.6, 6 + (i % 4) * 0.5))
  }
  // Re-evaluated listings with every kind of move.
  rows.push(
    ev('Fabrikam', 'Strategy Analyst', isoDay(2), 7.5, 7.5, { skills_match: 6, experience_bar: 6, competition: 5, role_content: 7 }),
    ev('fabrikam ', 'Strategy  Analyst', isoDay(70), 6.0, 7.6, { skills_match: 6, experience_bar: 7, competition: 5, role_content: 4 }),
    ev('Tailspin', 'Ops Associate', isoDay(3), 8.2, 5.5),
    ev('Tailspin', 'Ops Associate', isoDay(40), 8.3, 6.4),
    ev('Tailspin', 'Ops Associate', isoDay(80), 8.2, 7.2),
    blocked('Litware', 'Data Intern', isoDay(5)),
    ev('Litware', 'Data Intern', isoDay(75), 7, 7.5),
    ev('Proseware', 'Consultant', isoDay(6), 8.1, 7.5),
    ev('Proseware', 'Consultant', isoDay(76), 7.9, 7.5),
    ev('Adatum', 'Analyst', isoDay(7), 7, 6),
    blocked('Adatum', 'Analyst', isoDay(77)),
    ev('Wingtip', 'Analyst', isoDay(8), 7, 6),
    ev('Wingtip', 'Analyst', isoDay(8), 9, 9), // same-date duplicate write
  )
  return rows
}

for (const perWindow of [4, GATES.trendMinPerWindowForVerdict + 2]) {
  test(`parity with score-trend-core analyzeTrend (${perWindow} filler rows per window)`, () => {
    const rows = parityFixture(perWindow)
    const mirror = JSON.parse(JSON.stringify(analyzeScoreTrend(rows)))
    const canonical = JSON.parse(JSON.stringify(core.analyzeTrend(rows.map(toCoreRow))))
    delete mirror.metadata.analysisDate
    delete canonical.metadata.analysisDate
    assert.deepEqual(mirror, canonical)
    assert.ok(mirror.listingTrajectories.length >= 5)
  })
}
