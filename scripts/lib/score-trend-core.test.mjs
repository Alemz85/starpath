// Unit tests for scripts/lib/score-trend-core.mjs — the re-evaluation /
// score-trend math on scoring v2. score-trend.mjs only wraps these with file
// I/O, so this suite is where the logic is pinned: the canonical
// (company, role) key reuse, trajectory grouping (same-date collapse +
// spelling-drift merge), Want and Ease classified separately against their
// own floors, the verdict move (including blocked ↔ scored), the landscape
// earlier-vs-later split with its gate, the actionable-share delta, the
// verdict upgrade / downgrade roll-up, and the recommendation gates.
//
// Fixtures go through the shared v2 builder (real engine for verdicts);
// companies are fictional. Plain ESM, zero deps.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listingKey,
  verdictMove,
  listingTrajectories,
  trajectorySummary,
  verdictMoves,
  landscapeTrend,
  trendRecommendations,
  describeTrajectory,
  analyzeTrend,
  parseScoreHistory,
  DIMENSIONS,
  TREND_METRICS,
  WANT_NOISE_FLOOR,
  EASE_NOISE_FLOOR,
} from './score-trend-core.mjs'
import * as core from './score-trend-core.mjs'
import { GATES } from './scoring-stats.mjs'
import { historyTsv } from './testing/score-history-fixture.mjs'

const parse = (...rows) => parseScoreHistory(historyTsv(...rows))

/** One evaluation of a listing. `want` / `ease` override the engine rollup. */
const ev = (company, role, date, want, ease, extra = {}) =>
  ({ company, role, date, want, ease, ...extra })

/** A blocked evaluation (eligibility red: empty score cells). */
const blockedEv = (company, role, date, extra = {}) =>
  ({ company, role, date, eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship', ...extra })

/** n single-eval listings on one date with the given Want / Ease. */
const windowRows = (date, n, want, ease, prefix = date) =>
  Array.from({ length: n }, (_, i) => ev(`Co ${prefix} ${i}`, 'Analyst', date, want, ease))

const EARLY = '2026-05-01'
const LATE = '2026-06-01'

// ─── Exports: v1 surface is gone ──────────────────────────────────────────

test('the v1 exports are gone and the v2 ones exist', () => {
  for (const name of ['classifyDelta', 'overallBand', 'OVERALL_NOISE_FLOOR']) {
    assert.equal(name in core, false, `${name} should no longer be exported`)
  }
  assert.equal(WANT_NOISE_FLOOR, 0.30)
  assert.equal(EASE_NOISE_FLOOR, 0.35)
  assert.deepEqual([...TREND_METRICS], ['want', 'ease'])
  assert.equal(DIMENSIONS.length, 10)
})

// ─── listingKey ───────────────────────────────────────────────────────────

test('listingKey collapses company-spelling + role-spacing drift to one key', () => {
  assert.equal(
    listingKey('Northwind Analytics', 'Strategy Analyst Internship'),
    listingKey('northwind analytics ', 'Strategy  Analyst   Internship'),
  )
  assert.equal(listingKey('Contoso Retail', 'Data Analyst'), listingKey('contosoretail', 'data analyst'))
})

test('listingKey tolerates missing company/role without throwing', () => {
  assert.equal(typeof listingKey(undefined, undefined), 'string')
  assert.equal(listingKey('', ''), '\t')
})

// ─── verdictMove ──────────────────────────────────────────────────────────

test('verdictMove orders verdicts by score-bands.verdictRank', () => {
  assert.equal(verdictMove('solid', 'go'), 'upgrade')
  assert.equal(verdictMove('blocked', 'skip'), 'upgrade')
  assert.equal(verdictMove('stretch', 'thin'), 'downgrade')
  assert.equal(verdictMove('go', 'blocked'), 'downgrade')
  assert.equal(verdictMove('growth', 'growth'), 'same')
  assert.equal(verdictMove('', 'go'), 'unknown')
  assert.equal(verdictMove('stellar', 'go'), 'unknown')
})

// ─── Per-listing trajectories ─────────────────────────────────────────────

test('listingTrajectories ignores single-eval listings (no movement)', () => {
  assert.deepEqual(listingTrajectories(parse(ev('Northwind', 'Analyst', EARLY, 7, 7))), [])
})

test('Want and Ease are classified separately, each on its own floor', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 7.0, 6.0),
    ev('Northwind', 'Analyst', LATE, 7.6, 6.1),
  ))
  assert.equal(t.want.first, 7)
  assert.equal(t.want.latest, 7.6)
  assert.equal(t.want.delta, 0.6)
  assert.equal(t.want.movementClass, 'improving')
  assert.equal(t.want.detectable, true)
  assert.equal(t.want.noiseFloor, WANT_NOISE_FLOOR)
  assert.equal(t.ease.delta, 0.1)
  assert.equal(t.ease.movementClass, 'within-noise')
  assert.equal(t.ease.detectable, false)
  assert.equal(t.ease.noiseFloor, EASE_NOISE_FLOOR)
  assert.equal('delta' in t, false, 'no combined delta')
  assert.equal('firstOverall' in t, false)
})

test('a delta EXACTLY at its floor is detectable; just under is within-noise', () => {
  const one = (w0, w1, e0, e1) => listingTrajectories(parse(
    ev('Fabrikam Labs', 'Analyst', EARLY, w0, e0),
    ev('Fabrikam Labs', 'Analyst', LATE, w1, e1),
  ))[0]
  const at = one(7.0, 7.3, 6.0, 6.35)
  assert.equal(at.want.movementClass, 'improving')
  assert.equal(at.ease.movementClass, 'improving')
  const under = one(7.0, 7.29, 6.0, 6.34)
  assert.equal(under.want.movementClass, 'within-noise')
  assert.equal(under.ease.movementClass, 'within-noise')
  // The same 0.34 delta clears the Want floor but not the Ease floor.
  const split = one(7.0, 7.34, 6.0, 6.34)
  assert.equal(split.want.movementClass, 'improving')
  assert.equal(split.ease.movementClass, 'within-noise')
})

test('a declining move past the floor classifies as declining', () => {
  const [t] = listingTrajectories(parse(
    ev('Contoso Retail', 'Analyst', EARLY, 8.0, 7.0),
    ev('Contoso Retail', 'Analyst', LATE, 7.2, 6.0),
  ))
  assert.equal(t.want.movementClass, 'declining')
  assert.equal(t.ease.movementClass, 'declining')
})

test('per-dimension deltas cover the v2 dims; the driver is per metric and only on a detectable move', () => {
  const [t] = listingTrajectories(parse(
    { company: 'Tailspin Toys', role: 'Analyst', date: EARLY, growth_mobility: 6, brand_value: 6, competition: 6 },
    { company: 'Tailspin Toys', role: 'Analyst', date: LATE, growth_mobility: 8, brand_value: 9, competition: 6 },
  ))
  assert.equal(t.dimDeltas.length, 10)
  assert.ok(t.dimDeltas.every(d => DIMENSIONS.some(x => x.key === d.key)))
  assert.equal(t.want.movementClass, 'improving')
  assert.equal(t.want.topMover.key, 'brand_value')
  assert.equal(t.want.topMover.rollup, 'want')
  assert.equal(t.want.topMover.delta, 3)
  assert.equal(t.ease.movementClass, 'within-noise')
  assert.equal(t.ease.topMover, null)
})

test('a within-noise move has no driver even if a dimension moved', () => {
  const [t] = listingTrajectories(parse(
    { company: 'Tailspin Toys', role: 'Analyst', date: EARLY, growth_mobility: 7 },
    { company: 'Tailspin Toys', role: 'Analyst', date: LATE, growth_mobility: 8 },
  ))
  assert.equal(t.want.delta, 0.25) // one motivator step at equal weights
  assert.equal(t.want.movementClass, 'within-noise')
  assert.equal(t.want.topMover, null)
})

test('listingTrajectories collapses same-date duplicate writes (last wins)', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 6.0, 6.0),
    ev('Northwind', 'Analyst', EARLY, 6.5, 6.0),
    ev('Northwind', 'Analyst', LATE, 7.5, 6.0),
  ))
  assert.equal(t.evals, 2)
  assert.equal(t.want.first, 6.5)
  // Two same-date rows alone are not a trajectory.
  assert.deepEqual(listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 6.0, 6.0),
    ev('Northwind', 'Analyst', EARLY, 7.0, 6.0),
  )), [])
})

test('listingTrajectories merges spelling/spacing drift onto one trajectory', () => {
  const ts = listingTrajectories(parse(
    ev('Northwind Analytics', 'Data  Analyst', EARLY, 6.0, 6.0),
    ev('northwind analytics', 'data analyst', LATE, 7.0, 6.0),
  ))
  assert.equal(ts.length, 1)
  assert.equal(ts[0].evals, 2)
})

test('peak / trough span a non-monotonic path; sequence is chronological', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', '2026-07-01', 7.0, 6.0),
    ev('Northwind', 'Analyst', EARLY, 6.0, 6.0),
    ev('Northwind', 'Analyst', LATE, 8.5, 5.0),
  ))
  assert.deepEqual(t.sequence.map(s => s.date), [EARLY, LATE, '2026-07-01'])
  assert.equal(t.want.peak, 8.5)
  assert.equal(t.want.trough, 6)
  assert.equal(t.ease.trough, 5)
  assert.equal(t.want.delta, 1)
})

test('rows without a date are skipped', () => {
  assert.deepEqual(listingTrajectories(parse(
    ev('Northwind', 'Analyst', '', 6.0, 6.0),
    ev('Northwind', 'Analyst', LATE, 7.0, 6.0),
  )), [])
})

test('trajectory confidence climbs with the evaluation count (g = 2)', () => {
  const traj = (n) => listingTrajectories(parse(
    ...Array.from({ length: n }, (_, i) => ev('Northwind', 'Analyst', `2026-05-${String(i + 1).padStart(2, '0')}`, 6 + i * 0.1, 6)),
  ))[0]
  assert.equal(traj(2).confidence, 'low')
  assert.equal(traj(2).want.confidence, 'low')
  assert.equal(traj(3).confidence, 'low')
  assert.equal(traj(4).confidence, 'moderate')
  assert.equal(traj(8).confidence, 'high')
})

// ─── Verdict moves per listing ────────────────────────────────────────────

test('a verdict upgrade backed by a detectable move is detectable', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 7.0, 7.5), // solid
    ev('Northwind', 'Analyst', LATE, 8.5, 7.5),  // go
  ))
  assert.equal(t.verdictFrom, 'solid')
  assert.equal(t.verdictTo, 'go')
  assert.equal(t.verdictMove, 'upgrade')
  assert.equal(t.verdictChanged, true)
  assert.equal(t.verdictMoveDetectable, true)
})

test('a verdict flip on a sub-floor wobble is flagged as not detectable', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 7.9, 7.5), // solid
    ev('Northwind', 'Analyst', LATE, 8.1, 7.5),  // go
  ))
  assert.equal(t.verdictMove, 'upgrade')
  assert.equal(t.want.movementClass, 'within-noise')
  assert.equal(t.verdictMoveDetectable, false)
  assert.match(describeTrajectory(t), /verdict Solid → Go · Want flat within noise/)
})

test('blocked → scored is a visible verdict upgrade with no score movement', () => {
  const [t] = listingTrajectories(parse(
    blockedEv('Fabrikam Labs', 'Analyst', EARLY),
    ev('Fabrikam Labs', 'Analyst', LATE, 8.5, 7.5),
  ))
  assert.equal(t.evals, 2)
  assert.equal(t.scoredEvals, 1)
  assert.equal(t.blockedEvals, 1)
  assert.equal(t.verdictFrom, 'blocked')
  assert.equal(t.verdictTo, 'go')
  assert.equal(t.verdictMove, 'upgrade')
  assert.equal(t.verdictMoveDetectable, true)
  assert.equal(t.blockedFrom, true)
  assert.equal(t.blockedTo, false)
  assert.equal(t.want.n, 1)
  assert.equal(t.want.delta, null)
  assert.equal(t.want.movementClass, 'unknown')
  assert.equal(t.want.confidence, 'insufficient')
  assert.deepEqual(t.sequence[0], { date: EARLY, want: null, ease: null, verdict: 'blocked' })
})

test('scored → blocked is a downgrade; blocked → blocked is unchanged', () => {
  const [down] = listingTrajectories(parse(
    ev('Contoso Retail', 'Analyst', EARLY, 7.0, 7.5),
    blockedEv('Contoso Retail', 'Analyst', LATE),
  ))
  assert.equal(down.verdictMove, 'downgrade')
  assert.equal(down.verdictMoveDetectable, true)
  const [same] = listingTrajectories(parse(
    blockedEv('Contoso Retail', 'Analyst', EARLY),
    blockedEv('Contoso Retail', 'Analyst', LATE),
  ))
  assert.equal(same.verdictMove, 'same')
  assert.equal(same.verdictChanged, false)
})

test('blocked evals in the middle are excluded from the Want / Ease track', () => {
  const [t] = listingTrajectories(parse(
    ev('Northwind', 'Analyst', EARLY, 6.0, 6.0),
    blockedEv('Northwind', 'Analyst', LATE),
    ev('Northwind', 'Analyst', '2026-07-01', 7.0, 6.0),
  ))
  assert.equal(t.evals, 3)
  assert.equal(t.want.n, 2)
  assert.equal(t.want.delta, 1)
  assert.equal(t.want.trough, 6)
})

test('detectable verdict moves sort first, then the move furthest past its floor', () => {
  const ts = listingTrajectories(parse(
    ev('Big Mover', 'Analyst', EARLY, 6.6, 3.0), ev('Big Mover', 'Analyst', LATE, 7.9, 4.0), // skip → skip, large Ease move
    ev('Verdict Mover', 'Analyst', EARLY, 7.0, 7.5), ev('Verdict Mover', 'Analyst', LATE, 8.5, 7.5),
    ev('Small Mover', 'Analyst', EARLY, 7.0, 6.0), ev('Small Mover', 'Analyst', LATE, 7.4, 6.0),
  ))
  assert.deepEqual(ts.map(t => t.company), ['Verdict Mover', 'Big Mover', 'Small Mover'])
})

// ─── trajectorySummary ────────────────────────────────────────────────────

test('trajectorySummary tallies Want and Ease separately and counts verdict moves', () => {
  const ts = listingTrajectories(parse(
    ev('A Co', 'Analyst', EARLY, 7.0, 7.5), ev('A Co', 'Analyst', LATE, 8.5, 7.5),   // want ↑, ease flat, upgrade
    ev('B Co', 'Analyst', EARLY, 7.0, 6.0), ev('B Co', 'Analyst', LATE, 7.1, 5.0),   // want flat, ease ↓, thin→thin
    blockedEv('C Co', 'Analyst', EARLY), ev('C Co', 'Analyst', LATE, 7.0, 7.5),      // blocked → solid
  ))
  const s = trajectorySummary(ts)
  assert.equal(s.reevaluated, 3)
  assert.deepEqual(s.want, { n: 2, improving: 1, declining: 0, withinNoise: 1, detectable: 1, avgDelta: 0.8, medianDelta: 0.8, noiseFloor: WANT_NOISE_FLOOR })
  assert.equal(s.ease.n, 2)
  assert.equal(s.ease.declining, 1)
  assert.equal(s.ease.withinNoise, 1)
  assert.deepEqual(s.verdictMoves, { upgrade: 2, downgrade: 0, same: 1, unknown: 0 })
  for (const gone of ['verdicts', 'avgDelta', 'bandUpgrades', 'bandDowngrades', 'movement', 'noiseFloor']) {
    assert.equal(gone in s, false, `${gone} should be gone`)
  }
})

test('trajectorySummary on empty trajectories returns zero-state', () => {
  const s = trajectorySummary([])
  assert.equal(s.reevaluated, 0)
  assert.equal(s.want.n, 0)
  assert.equal(s.want.avgDelta, 0)
  assert.deepEqual(s.verdictMoves, { upgrade: 0, downgrade: 0, same: 0, unknown: 0 })
})

// ─── verdictMoves (corpus roll-up) ────────────────────────────────────────

test('verdictMoves lists the listings and gates the count as a corpus claim', () => {
  const ts = listingTrajectories(parse(
    ev('A Co', 'Analyst', EARLY, 7.0, 7.5), ev('A Co', 'Analyst', LATE, 8.5, 7.5),
    ev('B Co', 'Analyst', EARLY, 7.9, 7.5), ev('B Co', 'Analyst', LATE, 8.1, 7.5),
    ev('C Co', 'Analyst', EARLY, 8.5, 7.5), blockedEv('C Co', 'Analyst', LATE),
  ))
  const { verdictUpgrades: up, verdictDowngrades: down } = verdictMoves(ts)
  assert.equal(up.count, 2)
  assert.equal(up.detectable, 1)
  assert.equal(up.n, 3)
  assert.equal(up.gate, GATES.trendMinPerWindowForVerdict)
  assert.equal(up.insufficientData, true)
  assert.equal(up.confidence, 'insufficient')
  assert.deepEqual(up.listings.map(l => l.company).sort(), ['A Co', 'B Co'])
  assert.equal(down.count, 1)
  assert.deepEqual(down.listings[0], {
    key: listingKey('C Co', 'Analyst'), company: 'C Co', role: 'Analyst',
    from: 'go', to: 'blocked', firstDate: EARLY, latestDate: LATE, evals: 2, detectable: true,
  })
  const ten = verdictMoves(ts, { gate: 3 })
  assert.equal(ten.verdictUpgrades.insufficientData, false)
  assert.equal(ten.verdictUpgrades.confidence, 'low')
})

// ─── landscapeTrend ───────────────────────────────────────────────────────

test('landscapeTrend early-outs carry withheld Want / Ease blocks and the gate', () => {
  const few = landscapeTrend(parse(...windowRows(EARLY, 2, 7, 7), ...windowRows(LATE, 2, 7, 7)))
  const oneDate = landscapeTrend(parse(...windowRows(EARLY, 12, 7, 7)))
  for (const t of [few, oneDate]) {
    assert.equal(t.insufficientData, true)
    assert.ok(t.reason)
    assert.equal(t.verdictGate.met, false)
    assert.equal(t.verdictConfidence, 'insufficient')
    for (const m of ['want', 'ease']) {
      assert.equal(t[m].movementClass, 'insufficient-data')
      assert.equal(t[m].reportableVerdict, 'insufficient-data')
      assert.equal(t[m].delta, null)
    }
    assert.equal(t.actionableShareDelta, null)
    assert.ok(t.verdictUpgrades && t.verdictDowngrades)
  }
  assert.equal(oneDate.distinctDates, 1)
})

test('landscapeTrend picks a balanced split, not the lopsided median-date cut', () => {
  const t = landscapeTrend(parse(
    ...windowRows('2026-05-01', 4, 7, 7),
    ...windowRows('2026-05-02', 4, 7, 7),
    ...windowRows('2026-05-03', 12, 7, 7),
  ))
  assert.equal(t.splitDate, '2026-05-03')
  assert.equal(t.earlier.count, 8)
  assert.equal(t.later.count, 12)
})

test('landscapeTrend reports insufficientData when no boundary yields two viable windows', () => {
  const t = landscapeTrend(parse(...windowRows(EARLY, 2, 7, 7), ...windowRows(LATE, 10, 7, 7)))
  assert.equal(t.insufficientData, true)
  assert.match(t.reason, /too concentrated/)
})

test('corpus verdict is WITHHELD with 9 scored evals per window (numbers stay auditable)', () => {
  const t = landscapeTrend(parse(...windowRows(EARLY, 9, 7.0, 6.0), ...windowRows(LATE, 9, 8.0, 6.0)))
  assert.equal(t.insufficientData, false)
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.verdictGate.earlierCount, 9)
  assert.equal(t.verdictGate.laterCount, 9)
  assert.match(t.verdictGate.reason, /withheld/)
  assert.equal(t.want.delta, 1)
  assert.equal(t.want.movementClass, 'insufficient-data')
  assert.equal(t.want.reportableVerdict, 'insufficient-data')
  assert.equal(t.want.detectable, false)
  assert.equal(t.want.confidence, 'insufficient')
  assert.equal(t.verdictConfidence, 'insufficient')
})

test('corpus verdict UNLOCKS at exactly 10 per window; Want and Ease read separately', () => {
  const t = landscapeTrend(parse(...windowRows(EARLY, 10, 7.0, 6.0), ...windowRows(LATE, 10, 7.5, 6.2)))
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.verdictConfidence, 'low')
  assert.deepEqual(
    { earlier: t.want.earlier, later: t.want.later, delta: t.want.delta },
    { earlier: 7, later: 7.5, delta: 0.5 },
  )
  assert.equal(t.want.movementClass, 'improving')
  assert.equal(t.want.reportableVerdict, 'improving')
  assert.equal(t.want.noiseFloor, WANT_NOISE_FLOOR)
  assert.equal(t.want.n, 10)
  assert.equal(t.want.confidence, 'low')
  assert.equal(t.ease.delta, 0.2)
  assert.equal(t.ease.movementClass, 'within-noise')
  assert.equal(t.ease.reportableVerdict, 'flat-within-noise')
  assert.equal(t.ease.noiseFloor, EASE_NOISE_FLOOR)
  for (const gone of ['older', 'recent', 'delta', 'verdict', 'reportableVerdict', 'strongSolidShareDelta', 'noiseFloor']) {
    assert.equal(gone in t, false, `${gone} should be gone`)
  }
})

test('corpus verdict confidence rises with window size (g = 10)', () => {
  const tier = (n) => landscapeTrend(parse(...windowRows(EARLY, n, 7, 6), ...windowRows(LATE, n, 7, 6))).verdictConfidence
  assert.equal(tier(10), 'low')
  assert.equal(tier(20), 'moderate')
  assert.equal(tier(40), 'high')
})

test('actionableShareDelta is the go+stretch+solid share later − earlier, in points', () => {
  const t = landscapeTrend(parse(
    ...windowRows(EARLY, 2, 8.5, 7.5, 'e-go'), ...windowRows(EARLY, 8, 6.0, 6.0, 'e-skip'),   // 20%
    ...windowRows(LATE, 5, 7.0, 7.5, 'l-solid'), ...windowRows(LATE, 5, 6.0, 6.0, 'l-skip'), // 50%
  ))
  assert.equal(t.earlier.actionableShare, 20)
  assert.equal(t.earlier.actionableCount, 2)
  assert.equal(t.earlier.verdicts.go, 2)
  assert.equal(t.earlier.verdicts.skip, 8)
  assert.equal(t.later.actionableShare, 50)
  assert.equal(t.later.verdicts.solid, 5)
  assert.equal(t.actionableShareDelta, 30)
})

test('blocked rows never count toward a window, but are counted beside it', () => {
  const t = landscapeTrend(parse(
    ...windowRows(EARLY, 10, 7, 6),
    ...Array.from({ length: 5 }, (_, i) => blockedEv(`Blocked ${i}`, 'Analyst', EARLY)),
    ...windowRows(LATE, 10, 7, 6),
  ))
  assert.equal(t.evaluated, 20)
  assert.equal(t.blocked, 5)
  assert.equal(t.earlier.count, 10)
  assert.equal(t.earlier.blocked, 5)
  assert.equal(t.later.blocked, 0)
  assert.equal(t.verdictGate.earlierCount, 10)
  assert.equal(t.want.earlier, 7, 'blocked rows are not read as 0')
})

test('landscapeTrend accepts a caller-supplied verdict gate and floors', () => {
  const rows = parse(...windowRows(EARLY, 6, 7.0, 6.0), ...windowRows(LATE, 6, 7.2, 6.0))
  const t = landscapeTrend(rows, { minPerWindowForVerdict: 6, wantFloor: 0.1 })
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.want.noiseFloor, 0.1)
  assert.equal(t.want.movementClass, 'improving')
})

test('landscapeTrend carries the verdict upgrades / downgrades of re-evaluated listings', () => {
  const t = landscapeTrend(parse(
    ...windowRows(EARLY, 10, 7, 6), ...windowRows(LATE, 10, 7, 6),
    ev('Re Co', 'Analyst', EARLY, 7.0, 7.5), ev('Re Co', 'Analyst', LATE, 8.5, 7.5),
  ))
  assert.equal(t.verdictUpgrades.count, 1)
  assert.equal(t.verdictUpgrades.listings[0].company, 'Re Co')
  assert.equal(t.verdictDowngrades.count, 0)
})

// ─── trendRecommendations ─────────────────────────────────────────────────

test('trendRecommendations flags the sharpest decliner and strongest improver', () => {
  const ts = listingTrajectories(parse(
    ev('Down Co', 'Analyst', EARLY, 8.5, 7.5), ev('Down Co', 'Analyst', LATE, 7.0, 7.5),
    ev('Up Co', 'Analyst', EARLY, 6.0, 6.0), ev('Up Co', 'Analyst', LATE, 6.0, 7.2),
  ))
  const recs = trendRecommendations(ts, null)
  assert.equal(recs.length, 2)
  assert.match(recs[0].action, /^Re-check "Down Co — Analyst": verdict Go → Solid · Want 8\.5 → 7 \(-1\.5\)/)
  assert.equal(recs[0].impact, 'high')
  assert.equal(recs[0].confidence, 'low')
  assert.equal(recs[0].sampleSize, 2)
  assert.match(recs[1].action, /^Prioritize "Up Co — Analyst": .*Ease 6 → 7\.2 \(\+1\.2\)/)
  for (const r of recs) assert.doesNotMatch(r.action, /Overall|\/10/)
})

test('trendRecommendations stays silent on sub-floor and sub-minDelta moves', () => {
  const ts = listingTrajectories(parse(
    ev('Flat Co', 'Analyst', EARLY, 7.0, 6.0), ev('Flat Co', 'Analyst', LATE, 7.2, 6.2),
    ev('Small Co', 'Analyst', EARLY, 7.0, 6.0), ev('Small Co', 'Analyst', LATE, 7.4, 6.0),
  ))
  assert.deepEqual(trendRecommendations(ts, null), [])
})

test('a blocked → scored move is recommended with the eligibility reason', () => {
  const ts = listingTrajectories(parse(blockedEv('Gate Co', 'Analyst', EARLY), ev('Gate Co', 'Analyst', LATE, 8.5, 7.5)))
  const [rec] = trendRecommendations(ts, null)
  assert.match(rec.action, /Prioritize "Gate Co — Analyst": verdict Blocked → Go/)
  assert.match(rec.reasoning, /eligibility gate/)
})

test('trendRecommendations emits an insufficient-data marker under the gate', () => {
  const rows = parse(...windowRows(EARLY, 6, 7, 6), ...windowRows(LATE, 6, 8, 6))
  const recs = trendRecommendations([], landscapeTrend(rows))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].insufficientData, true)
  assert.equal(recs[0].confidence, 'insufficient')
  assert.equal(recs[0].sampleSize, 6)
  assert.equal(recs[0].gate, GATES.trendMinPerWindowForVerdict)
  assert.doesNotMatch(recs[0].action, /sharpening|sliding/)
})

test('trendRecommendations reports a gate-passing flat corpus as flat', () => {
  const rows = parse(...windowRows(EARLY, 10, 7.0, 6.0), ...windowRows(LATE, 10, 7.1, 6.1))
  const [rec] = trendRecommendations([], landscapeTrend(rows))
  assert.match(rec.action, /^Landscape trend: flat within noise — Want flat within noise .*; Ease flat within noise/)
  assert.equal(rec.confidence, 'low')
  assert.equal(rec.sampleSize, 10)
})

test('trendRecommendations: sharpening, sliding and mixed landscape lines', () => {
  const line = (wLate, eLate) => trendRecommendations([], landscapeTrend(parse(
    ...windowRows(EARLY, 10, 7.0, 6.0), ...windowRows(LATE, 10, wLate, eLate),
  )))[0]
  const up = line(7.6, 6.0)
  assert.match(up.action, /^Targeting is sharpening — Want improving \(7\.6 vs 7 earlier, \+0\.6\); Ease flat within noise/)
  assert.equal(up.impact, 'medium')
  assert.match(up.reasoning, /10 earlier vs 10 later scored evals; low confidence/)
  const down = line(7.0, 5.0)
  assert.match(down.action, /^Evaluated landscape is sliding — Want flat within noise .*; Ease declining/)
  assert.equal(down.impact, 'high')
  const mixed = line(7.6, 5.0)
  assert.match(mixed.action, /^Landscape trend is mixed/)
})

test('trendRecommendations is silent on the landscape when the trend has no time axis', () => {
  const t = landscapeTrend(parse(...windowRows(EARLY, 12, 7, 7)))
  assert.deepEqual(trendRecommendations([], t), [])
})

// ─── analyzeTrend ─────────────────────────────────────────────────────────

test('analyzeTrend returns a structured analysis object and publishes its contract', () => {
  const rows = parse(
    ...windowRows(EARLY, 10, 7, 6), ...windowRows(LATE, 10, 7, 6),
    blockedEv('Blocked Co', 'Analyst', LATE),
    ev('Re Co', 'Analyst', EARLY, 7.0, 7.5), ev('Re Co', 'Analyst', LATE, 8.5, 7.5),
  )
  const r = analyzeTrend(rows)
  assert.equal(r.metadata.evaluated, 22)
  assert.equal(r.metadata.blocked, 1)
  assert.equal(r.metadata.reevaluatedListings, 1)
  assert.deepEqual(r.metadata.dateRange, { from: EARLY, to: LATE })
  assert.deepEqual(r.metadata.contract, {
    doc: 'docs/scoring-statistical-design.md',
    noiseFloors: { want: WANT_NOISE_FLOOR, ease: EASE_NOISE_FLOOR },
    minEvalsPerTrajectory: GATES.trendMinEvals,
    minPerWindowForVerdict: GATES.trendMinPerWindowForVerdict,
  })
  assert.equal(r.trajectorySummary.reevaluated, 1)
  assert.equal(r.listingTrajectories.length, 1)
  assert.equal(r.landscapeTrend.verdictGate.met, true)
  assert.equal(r.landscapeTrend.verdictUpgrades.count, 1)
  assert.ok(Array.isArray(r.recommendations))
  assert.doesNotMatch(JSON.stringify(r), /overall|Overall|strongSolid|band(From|To|Up|Down)/)
})

test('analyzeTrend errors on empty or all-blocked input', () => {
  assert.ok(analyzeTrend([]).error)
  assert.ok(analyzeTrend(null).error)
  const allBlocked = analyzeTrend(parse(blockedEv('A Co', 'Analyst', EARLY), blockedEv('B Co', 'Analyst', LATE)))
  assert.match(allBlocked.error, /No scored evaluations .*2 blocked/)
})
