// Unit tests for scripts/lib/positioning-core.mjs — the corpus-level positioning
// synthesis (scoring v2) that bridges targeting-core (corpus aggregates) and
// explain-score (per-role levers) into per-archetype average-fingerprint levers,
// per-listing constraint/lever tallies, the systemic binding constraint and the
// per-archetype Ease trajectory (the canary).
//
// Rows are built with the shared v2 fixture builder (Match / Ease / verdict come
// from the real engine) and parsed by targeting-core. Companies are fictional.
//
// Plain ESM, zero deps: `node --test scripts/lib/positioning-core.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from './targeting-core.mjs'
import { historyTsv } from './testing/score-history-fixture.mjs'
import { rollupMatch, rollupEase, assignVerdict } from './score-bands.mjs'
import { classifyMovement, EASE_NOISE_FLOOR, GATES } from './scoring-stats.mjs'
import {
  archetypeFingerprints,
  archetypeLever,
  listingConstraints,
  systemicConstraint,
  easeTrajectory,
  easeCanary,
  positioningIntel,
  CONSTRAINT_KIND_LABELS,
} from './positioning-core.mjs'

const parse = (...overs) => parseScoreHistory(historyTsv(...overs))
const repeat = (n, over = {}) => Array.from({ length: n }, () => ({ ...over }))
// n rows on consecutive days starting at `start` (YYYY-MM-DD in Jan–Mar 2026).
const dated = (n, over = {}, offset = 0) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + offset + i)).toISOString().slice(0, 10)
  return { ...over, date: d, company: `Wingtip ${offset + i}` }
})

const TOP_MATCH = { growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9 }
const EASY = { skills_match: 8, experience_bar: 8, competition: 8 }

const fullDims = (over = {}) => ({
  skills_match: 7, experience_bar: 7, competition: 6,
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7,
  best_cities: 7, salary_adj_city: 6, work_life_balance: 7,
  ...over,
})

// ─── archetypeFingerprints ────────────────────────────────────────────────────

test('archetypeFingerprints averages each of the ten v2 dimensions', () => {
  const rows = parse(
    { skills_match: 6, experience_bar: 4, role_content: 8 },
    { skills_match: 8, experience_bar: 6, role_content: 8 },
    { skills_match: 7, experience_bar: 5, role_content: 8 },
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps.length, 1)
  const fp = fps[0]
  assert.equal(fp.archetype, 'Data Analyst')
  assert.equal(fp.count, 3)
  assert.equal(Object.keys(fp.dims).length, 10)
  assert.equal(fp.dims.skills_match, 7)    // (6+8+7)/3
  assert.equal(fp.dims.experience_bar, 5)  // (4+6+5)/3
  assert.equal(fp.dims.role_content, 8)
})

test('archetypeFingerprints carries Match / Ease, verdict mix, actionable share and blocked count', () => {
  const rows = parse(
    ...repeat(3, { ...TOP_MATCH, ...EASY }),                              // go
    { growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7 }, // thin
    { eligibility: 'red', eligibility_flags: 'language:red:German C1 required' },
  )
  const fp = archetypeFingerprints(rows)[0]
  assert.equal(fp.count, 4)          // the blocked row is not a scored role
  assert.equal(fp.blocked, 1)
  assert.equal(fp.verdicts.go, 3)
  assert.equal(fp.verdicts.thin, 1)
  assert.equal(fp.actionableShare, 75)
  const matchScores = rows.filter(r => !r.blocked).map(r => r.match)
  assert.equal(fp.avgMatch, Math.round((matchScores.reduce((a, b) => a + b, 0) / matchScores.length) * 100) / 100)
  assert.ok(Number.isFinite(fp.avgEase))
})

test('archetypeFingerprints flags the lowest-averaging dim as the bottleneck', () => {
  const rows = parse(...repeat(3, { experience_bar: 3 }))
  const fp = archetypeFingerprints(rows)[0]
  assert.equal(fp.bottleneck.key, 'experience_bar')
  assert.equal(fp.bottleneck.label, 'Experience bar')
  assert.equal(fp.bottleneck.avg, 3)
})

test('archetypeFingerprints applies the minRoles filter on SCORED rows only', () => {
  const rows = parse(
    { archetype: 'Data Analyst' },
    { archetype: 'Data Analyst' },
    { archetype: 'Data Analyst', eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' },
    ...repeat(3, { archetype: 'Strategy & Operations' }),
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps.length, 1)
  assert.equal(fps[0].archetype, 'Strategy & Operations')
  assert.equal(archetypeFingerprints(rows, { minRoles: 2 }).length, 2)
})

test('archetypeFingerprints sorts the most actionable archetype first', () => {
  const rows = parse(
    ...repeat(3, { archetype: 'Field Sales', growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 5 }),
    ...repeat(3, { archetype: 'Product Ops', ...TOP_MATCH, ...EASY }),
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps[0].archetype, 'Product Ops')
  assert.equal(fps[0].actionableShare, 100)
  assert.equal(fps[1].archetype, 'Field Sales')
  assert.equal(fps[1].actionableShare, 0)
})

test('archetypeFingerprints tolerates a blank dimension cell (NaN-safe averaging)', () => {
  const rows = parse(
    { skills_match: 7 },
    { skills_match: '', match: 7, ease: 6.5 }, // blank → NaN, excluded from the mean
    { skills_match: 9 },
  )
  const fp = archetypeFingerprints(rows)[0]
  assert.equal(fp.count, 3)
  assert.equal(fp.dims.skills_match, 8)
})

// ─── archetypeLever: replay must agree with the canonical engine ──────────────

test('hand anchor: motivators 8, neutral hygiene, Ease stages 8 → Match 8.0, Ease 8.0, Go', () => {
  const lever = archetypeLever({
    archetype: 'Anchor', count: 3,
    dims: fullDims({ growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, skills_match: 8, experience_bar: 8, competition: 8 }),
  })
  assert.equal(lever.match, 8)
  assert.equal(lever.ease, 8)
  assert.equal(lever.verdict, 'go')
  assert.equal(lever.verdictLabel, 'Go')
  assert.equal(lever.tier, 'T1')
  assert.equal(lever.cheapestLever, null)
})

test('archetypeLever reproduces Match / Ease / verdict from the average fingerprint', () => {
  const dims = fullDims({ skills_match: 6.67, experience_bar: 5.33, competition: 5.5, role_content: 8.25 })
  const lever = archetypeLever({ archetype: 'X', count: 4, dims })
  const match = rollupMatch(dims).score
  const ease = rollupEase(dims).score
  assert.equal(lever.match, match)
  assert.equal(lever.ease, ease)
  assert.equal(lever.verdict, assignVerdict({ match, ease, eligibility: 'green' }).verdict)
})

test('archetypeLever honors the caller weights', () => {
  const dims = fullDims({ role_content: 10 })
  const plain = archetypeLever({ archetype: 'W', count: 3, dims })
  const weighted = archetypeLever({ archetype: 'W', count: 3, dims }, { weights: { match: { role_content: 3 } } })
  assert.equal(weighted.match, rollupMatch(dims, { weights: { role_content: 3 } }).score)
  assert.ok(weighted.match > plain.match)
})

test('archetypeLever surfaces the experience wall as the binding constraint, with its lever', () => {
  const lever = archetypeLever({
    archetype: 'Walled', count: 4,
    dims: fullDims({ ...TOP_MATCH, skills_match: 8, experience_bar: 3, competition: 7 }),
  })
  assert.equal(lever.ease, 4.5)                 // the wall cap
  assert.equal(lever.verdict, 'growth')
  assert.equal(lever.bindingConstraint.kind, 'experience_wall')
  assert.equal(lever.bindingConstraint.dimension, 'experience_bar')
  assert.equal(lever.cheapestLever.dimension, 'experience_bar')
  assert.equal(lever.cheapestLever.from, 3)
  assert.equal(lever.cheapestLever.to, 4)
  assert.equal(lever.cheapestLever.newVerdict, 'stretch')
})

test('archetypeLever treats a mostly-intern archetype as intern (salary cannot veto)', () => {
  const dims = fullDims({ ...TOP_MATCH, ...EASY, salary_adj_city: 2 })
  const fulltime = archetypeLever({ archetype: 'FT', count: 3, dims, internShare: 0 })
  const interns = archetypeLever({ archetype: 'IN', count: 3, dims, internShare: 100 })
  assert.equal(fulltime.match, 5)                // hygiene veto caps Match
  assert.equal(fulltime.bindingConstraint.kind, 'hygiene_veto')
  assert.equal(interns.match, 9)
  assert.equal(interns.verdict, 'go')
})

test('archetypeLever imputes a neutral midpoint for an all-blank dimension and says so', () => {
  const lever = archetypeLever({ archetype: 'Gap', count: 3, dims: fullDims({ competition: NaN }) })
  assert.deepEqual(lever.imputed, ['competition'])
  assert.ok(Number.isFinite(lever.match))
  assert.ok(Number.isFinite(lever.ease))
})

// ─── listingConstraints: per-listing replay tallies ──────────────────────────

test('listingConstraints tallies binding-constraint kinds and lever dimensions per listing', () => {
  const rows = parse(
    ...repeat(3, { ...TOP_MATCH, skills_match: 8, experience_bar: 3, competition: 7 }), // growth, wall
    ...repeat(2, { ...TOP_MATCH, ...EASY }),                                            // go
  )
  const t = listingConstraints(rows)
  assert.equal(t.n, 5)
  assert.equal(t.alreadyGo, 2)
  assert.equal(t.replayMismatches, 0)
  assert.equal(t.constraintKinds[0].kind, 'experience_wall')
  assert.equal(t.constraintKinds[0].label, CONSTRAINT_KIND_LABELS.experience_wall)
  assert.equal(t.constraintKinds[0].count, 3)
  assert.equal(t.constraintKinds[0].share, 100)
  assert.deepEqual(t.constraintKinds[0].on, { experience_bar: 3 })
  assert.equal(t.leverDimensions[0].key, 'experience_bar')
  assert.equal(t.leverDimensions[0].avgLift, 1)
})

test('listingConstraints replays amber flags: resolving the amber is the cheapest lever', () => {
  // Ease geometric ≈ 7.34, −0.5 amber → 6.84 (Stretch); resolving it → Go.
  const rows = parse(...repeat(3, {
    ...TOP_MATCH, skills_match: 8, experience_bar: 8, competition: 6,
    eligibility: 'amber', eligibility_flags: 'start_date:amber:start not stated',
  }))
  assert.equal(rows[0].verdict, 'stretch')
  const t = listingConstraints(rows)
  assert.equal(t.replayMismatches, 0)
  assert.equal(t.leverDimensions[0].key, 'amber')
  assert.equal(t.leverDimensions[0].dimension, null)
  assert.equal(t.leverDimensions[0].count, 3)
})

test('listingConstraints counts replay mismatches instead of hiding them', () => {
  const rows = parse({ verdict: 'go' }, {}) // stored go, dims say thin
  assert.equal(listingConstraints(rows).replayMismatches, 1)
})

test('listingConstraints applies the dream floor from calibration', () => {
  // Motivators 7/7/10/7 → raw Match 7.75; the dream floor stored 8.0 → Go.
  const rows = parse(...repeat(2, {
    company: 'Northwind Analytics', growth_mobility: 7, optionality_exit: 7, brand_value: 10, role_content: 7,
    ...EASY, match: 8,
  }))
  assert.equal(rows[0].verdict, 'go')
  assert.equal(listingConstraints(rows).replayMismatches, 2)
  const t = listingConstraints(rows, { calibration: { dream_companies: ['Northwind Analytics'] } })
  assert.equal(t.replayMismatches, 0)
  assert.equal(t.alreadyGo, 2)
})

test('listingConstraints skips blocked rows', () => {
  const rows = parse({ eligibility: 'red', eligibility_flags: 'language:red:German C1 required' }, {})
  assert.equal(listingConstraints(rows).n, 1)
})

// ─── systemicConstraint: cross-archetype tally ────────────────────────────────

test('systemicConstraint picks the constraint holding back the most archetypes', () => {
  const levers = [
    { archetype: 'A', bindingConstraint: { kind: 'experience_wall', dimension: 'experience_bar', label: 'Experience bar', binding: true }, cheapestLever: { dimension: 'experience_bar', lift: 1 } },
    { archetype: 'B', bindingConstraint: { kind: 'experience_wall', dimension: 'experience_bar', label: 'Experience bar', binding: true }, cheapestLever: { dimension: 'experience_bar', lift: 2 } },
    { archetype: 'C', bindingConstraint: { kind: 'hygiene_veto', dimension: 'best_cities', label: 'City', binding: true }, cheapestLever: { dimension: 'best_cities', lift: 3 } },
  ]
  const sc = systemicConstraint(levers)
  assert.equal(sc.dominant.key, 'experience_bar')
  assert.equal(sc.dominant.dimension, 'experience_bar')
  assert.equal(sc.dominant.label, 'Experience bar')
  assert.equal(sc.dominant.count, 2)
  assert.equal(sc.dominant.binding, 2)
  assert.deepEqual(sc.dominant.archetypes, ['A', 'B'])
  assert.deepEqual(sc.dominant.kinds, { experience_wall: 2 })
  assert.equal(sc.lever.dimension, 'experience_bar')
  assert.equal(sc.lever.count, 2)
  assert.equal(sc.lever.avgLift, 1.5)
})

test('systemicConstraint keys low_match / low_ease by the rollup, not the weakest dimension', () => {
  const levers = [
    { archetype: 'A', bindingConstraint: { kind: 'low_ease', dimension: 'competition', label: 'Ease', binding: true }, cheapestLever: { dimension: 'competition', lift: 1 } },
    { archetype: 'B', bindingConstraint: { kind: 'low_ease', dimension: 'skills_match', label: 'Ease', binding: true }, cheapestLever: { dimension: 'skills_match', lift: 2 } },
    { archetype: 'C', bindingConstraint: { kind: 'experience_wall', dimension: 'experience_bar', label: 'Experience bar', binding: true }, cheapestLever: null },
  ]
  const sc = systemicConstraint(levers)
  assert.equal(sc.dominant.key, 'low_ease')
  assert.equal(sc.dominant.label, 'Ease')
  assert.equal(sc.dominant.dimension, null)
  assert.deepEqual(sc.dominant.on, { competition: 1, skills_match: 1 })
  assert.equal(sc.dominant.count, 2)
})

test('systemicConstraint handles archetypes with no constraint / lever (already Go)', () => {
  const sc = systemicConstraint([
    { archetype: 'Top', bindingConstraint: null, cheapestLever: null },
    { archetype: 'Gated', bindingConstraint: { kind: 'low_ease', dimension: 'skills_match', label: 'Ease', binding: true }, cheapestLever: { dimension: 'skills_match', lift: 2 } },
  ])
  assert.equal(sc.dominant.key, 'low_ease')
  assert.equal(sc.dominant.count, 1)
  assert.equal(sc.lever.dimension, 'skills_match')
})

test('systemicConstraint returns nulls when nothing binds', () => {
  const sc = systemicConstraint([{ archetype: 'Top', bindingConstraint: null, cheapestLever: null }])
  assert.equal(sc.dominant, null)
  assert.equal(sc.lever, null)
  assert.deepEqual(sc.tally, [])
})

// ─── easeTrajectory: the canary, gated and floored ────────────────────────────

const HARD = { skills_match: 7, experience_bar: 5, competition: 6 }   // lower Ease
const EASIER = { skills_match: 7, experience_bar: 7, competition: 6 } // higher Ease

test('easeTrajectory is withheld below the per-half trend gate', () => {
  const rows = parse(...dated(9, HARD), ...dated(10, EASIER, 9)) // 9 / 10
  const t = easeTrajectory(rows)
  assert.equal(t.earlier.count, 9)
  assert.equal(t.later.count, 10)
  assert.equal(t.reportableVerdict, 'insufficient-data')
  assert.equal(t.insufficientData, true)
  assert.equal(t.delta, null)
  assert.equal(t.movementClass, null)
  assert.equal(t.confidence, 'insufficient')
  assert.match(t.reason, /9 scored evaluations in the earlier half, 10 required/)
})

test('easeTrajectory reports an Ease rise that clears the floor, at exactly the gate', () => {
  const rows = parse(...dated(10, HARD), ...dated(10, EASIER, 10))
  const t = easeTrajectory(rows)
  assert.equal(t.gate, GATES.trendMinPerWindowForVerdict)
  assert.equal(t.floor, EASE_NOISE_FLOOR)
  assert.ok(t.delta >= EASE_NOISE_FLOOR)
  assert.equal(t.movementClass, classifyMovement(t.delta, { metric: 'ease' }))
  assert.equal(t.reportableVerdict, 'improving')
  assert.equal(t.confidence, 'low')
  assert.ok(t.earlier.dateRange.to < t.later.dateRange.from)
})

test('easeTrajectory orders by date, not input order', () => {
  const rows = parse(...dated(10, EASIER, 10), ...dated(10, HARD)) // later rows first in the file
  assert.equal(easeTrajectory(rows).reportableVerdict, 'improving')
})

test('easeTrajectory reports a decline, and flat-within-noise as a first-class result', () => {
  const down = easeTrajectory(parse(...dated(20, EASIER), ...dated(20, HARD, 20)))
  assert.equal(down.reportableVerdict, 'declining')
  assert.equal(down.confidence, 'moderate')   // 20 per half = 2× the gate
  const flat = easeTrajectory(parse(...dated(24, {})))
  assert.equal(flat.reportableVerdict, 'flat-within-noise')
  assert.equal(flat.delta, 0)
  assert.match(flat.reason, /flat within noise/)
})

test('easeTrajectory ignores blocked rows', () => {
  const rows = parse(
    ...dated(10, HARD),
    ...dated(5, { eligibility: 'red', eligibility_flags: 'language:red:German C1 required' }, 10),
    ...dated(10, EASIER, 15),
  )
  const t = easeTrajectory(rows)
  assert.equal(t.earlier.count + t.later.count, 20)
  assert.equal(t.reportableVerdict, 'improving')
})

test('easeCanary groups archetypes by their trajectory call', () => {
  const canary = easeCanary([
    { archetype: 'A', easeTrajectory: { reportableVerdict: 'improving', delta: 0.5, confidence: 'low', earlier: { count: 10 }, later: { count: 10 } } },
    { archetype: 'B', easeTrajectory: { reportableVerdict: 'flat-within-noise', delta: 0.1, confidence: 'low', earlier: { count: 12 }, later: { count: 12 } } },
    { archetype: 'C', easeTrajectory: { reportableVerdict: 'insufficient-data', delta: null, confidence: 'insufficient', earlier: { count: 2 }, later: { count: 3 } } },
  ])
  assert.deepEqual(canary.improving, ['A'])
  assert.deepEqual(canary.flat, ['B'])
  assert.deepEqual(canary.insufficient, ['C'])
  assert.deepEqual(canary.declining, [])
  assert.equal(canary.archetypes.length, 3)
})

// ─── positioningIntel: top-level bundle ───────────────────────────────────────

test('positioningIntel returns an error object on empty input', () => {
  assert.ok(positioningIntel([]).error)
  assert.ok(positioningIntel(null).error)
})

test('positioningIntel errors on an all-blocked history but still reports eligibility', () => {
  const out = positioningIntel(parse(...repeat(2, { eligibility: 'red', eligibility_flags: 'language:red:German C1 required' })))
  assert.ok(out.error)
  assert.equal(out.eligibility.status.red, 2)
})

test('positioningIntel assembles the full bundle and ties levers to fingerprints', () => {
  const rows = parse(
    ...repeat(3, { archetype: 'Data Analyst', ...TOP_MATCH, skills_match: 8, experience_bar: 3, competition: 7 }),
    ...repeat(3, { archetype: 'Strategy & Operations', ...TOP_MATCH, ...EASY }),
    { archetype: 'Strategy & Operations', eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' },
  )
  const intel = positioningIntel(rows)
  assert.equal(intel.metadata.evaluated, 6)
  assert.equal(intel.metadata.blocked, 1)
  assert.equal(intel.metadata.total, 7)
  assert.equal(intel.metadata.archetypesAnalyzed, 2)
  assert.equal(intel.fingerprints.length, 2)
  assert.equal(intel.levers.length, 2)
  const fpNames = new Set(intel.fingerprints.map(f => f.archetype))
  for (const l of intel.levers) assert.ok(fpNames.has(l.archetype))

  const strat = intel.fingerprints.find(f => f.archetype === 'Strategy & Operations')
  for (const k of ['avgMatch', 'avgEase', 'actionableShare', 'verdicts', 'blocked', 'easeTrajectory']) assert.ok(k in strat, k)
  assert.equal(strat.blocked, 1)
  assert.equal(strat.actionableShare, 100)

  const da = intel.levers.find(l => l.archetype === 'Data Analyst')
  assert.equal(da.verdict, 'growth')
  assert.equal(da.listings.n, 3)
  assert.equal(intel.systemicConstraint.dominant.key, 'experience_bar')
  assert.equal(intel.systemicConstraint.lever.dimension, 'experience_bar')
  assert.equal(intel.systemicConstraint.listings.n, 6)

  assert.equal(intel.landscape.evaluated, 6)
  assert.equal(intel.landscape.blocked, 1)
  assert.equal(intel.eligibility.status.red, 1)
  assert.ok(Array.isArray(intel.dimensionDrag))
  assert.ok(Array.isArray(intel.cityExposure))
  assert.equal(intel.easeCanary.insufficient.length, 2)
})

test('positioningIntel output carries no v1 fields', () => {
  const intel = positioningIntel(parse(...repeat(4, {}), ...repeat(3, { archetype: 'Ops', ...TOP_MATCH })))
  const keys = new Set()
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x) }
  }
  walk(intel)
  for (const banned of ['cf', 'af', 'overall', 'avgOverall', 'medianOverall', 'strongRate', 'bands', 'ctx', 'sixDims']) {
    assert.equal(keys.has(banned), false, `unexpected v1 key: ${banned}`)
  }
  const text = JSON.stringify(intel)
  assert.doesNotMatch(text, /ease_of_entry|strategic_fit|sales_trap|current_fit|aspirational_fit/)
})
