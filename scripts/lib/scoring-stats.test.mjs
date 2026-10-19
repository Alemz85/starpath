// scoring-stats.test.mjs — pins the statistical-honesty contract.
//
// These tests are deliberately literal about the NUMBERS. The whole point of
// scoring-stats.mjs is that docs/scoring-statistical-design.md and the code
// state the same values; if someone changes a constant, this suite fails and
// forces them to update the doc in the same change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WANT_DIM_STEP, EASE_DIM_STEP,
  WANT_NOISE_FLOOR, EASE_NOISE_FLOOR, PRIORITY_NOISE_FLOOR,
  NOISE_FLOORS, noiseFloorFor,
  GATES,
  CONFIDENCE_TIERS,
  MECHANICAL_DIMS, JUDGMENT_DIMS, dimensionClass,
  confidenceTier, describeSample,
  classifyMovement, isWithinNoise,
  formatSample, formatWithinNoise,
} from './scoring-stats.mjs'
import {
  rollupWant, rollupEase, computePriority, WANT_DIMS, EASE_DIMS,
} from './score-bands.mjs'

/* ───── Rubric geometry + the noise-floor derivation (spec §9) ───────────── */

test('the v2 noise floors are exactly the spec values', () => {
  assert.equal(WANT_NOISE_FLOOR, 0.30)
  assert.equal(EASE_NOISE_FLOOR, 0.35)
  assert.equal(PRIORITY_NOISE_FLOOR, 0.30)
  assert.deepEqual({ ...NOISE_FLOORS }, { want: 0.30, ease: 0.35, priority: 0.30 })
  assert.equal(noiseFloorFor('want'), 0.30)
  assert.equal(noiseFloorFor('ease'), 0.35)
  assert.equal(noiseFloorFor('priority'), 0.30)
  assert.equal(noiseFloorFor(undefined), PRIORITY_NOISE_FLOOR)
})

const MID = {
  growth_mobility: 6, optionality_exit: 6, brand_value: 6, role_content: 6,
  best_cities: 6, salary_adj_city: 6, work_life_balance: 6,
  skills_match: 6, experience_bar: 6, competition: 6,
}

test('one motivator step moves Want by WANT_DIM_STEP, below the Want floor', () => {
  const base = rollupWant(MID).score
  const moved = rollupWant({ ...MID, brand_value: 7 }).score
  assert.equal(Number((moved - base).toFixed(2)), WANT_DIM_STEP)
  assert.ok(WANT_DIM_STEP < WANT_NOISE_FLOOR)
  // two motivators agreeing clear it
  assert.ok(2 * WANT_DIM_STEP >= WANT_NOISE_FLOOR)
})

test('one step on a 0.35-weight Ease stage near 6 stays under the Ease floor', () => {
  const base = rollupEase(MID).score
  const up = rollupEase({ ...MID, skills_match: 7 }).score
  const down = rollupEase({ ...MID, skills_match: 5 }).score
  assert.ok(up - base < EASE_NOISE_FLOOR, `+1 moved Ease by ${up - base}`)
  assert.ok(base - down < EASE_NOISE_FLOOR + 0.05, `−1 moved Ease by ${base - down}`)
  assert.ok(Math.abs(EASE_DIM_STEP - (up - base)) < 0.05)
})

test('a single-dimension step stays under the Priority floor at mid-scale', () => {
  const p0 = computePriority(rollupWant(MID).score, rollupEase(MID).score)
  for (const dim of [...WANT_DIMS.filter(d => d !== 'salary_adj_city' && d !== 'best_cities' && d !== 'work_life_balance'), ...EASE_DIMS]) {
    const d = { ...MID, [dim]: 7 }
    const p1 = computePriority(rollupWant(d).score, rollupEase(d).score)
    assert.ok(Math.abs(p1 - p0) < PRIORITY_NOISE_FLOOR, `${dim} moved Priority by ${p1 - p0}`)
  }
})

/* ───── Dimension classes ────────────────────────────────────────────────── */

test('dimension classes split mechanical from judgment over the v2 dims', () => {
  assert.equal(dimensionClass('brand_value'), 'mechanical')
  assert.equal(dimensionClass('salary_adj_city'), 'mechanical')
  assert.equal(dimensionClass('best_cities'), 'mechanical')
  assert.equal(dimensionClass('skills_match'), 'judgment')
  assert.equal(dimensionClass('role_content'), 'judgment')
  assert.equal(dimensionClass('experience_bar'), 'judgment')
  assert.equal(dimensionClass('strategic_fit'), 'unknown')
  assert.equal(dimensionClass('not_a_dimension'), 'unknown')
})

test('no dimension is in both classes, and together they cover every v2 dim', () => {
  for (const d of MECHANICAL_DIMS) assert.ok(!JUDGMENT_DIMS.includes(d), `${d} is in both classes`)
  const all = new Set([...MECHANICAL_DIMS, ...JUDGMENT_DIMS])
  for (const d of [...WANT_DIMS, ...EASE_DIMS]) assert.ok(all.has(d), `${d} is unclassified`)
  assert.equal(all.size, WANT_DIMS.length + EASE_DIMS.length)
})

/* ───── Confidence tiers — boundaries at exactly g, 2g, 4g ───────────────── */

test('confidenceTier: n exactly at the gate is low, one below is insufficient', () => {
  assert.equal(confidenceTier(4, 5), 'insufficient')
  assert.equal(confidenceTier(5, 5), 'low')       // ← boundary
})

test('confidenceTier: n exactly at 2× the gate is moderate', () => {
  assert.equal(confidenceTier(9, 5), 'low')
  assert.equal(confidenceTier(10, 5), 'moderate') // ← boundary
})

test('confidenceTier: n exactly at 4× the gate is high', () => {
  assert.equal(confidenceTier(19, 5), 'moderate')
  assert.equal(confidenceTier(20, 5), 'high')     // ← boundary
})

test('confidenceTier: the same rule reproduces every surface tier table', () => {
  // peer rank (gate 5)
  assert.deepEqual(
    [5, 9, 10, 19, 20].map(n => confidenceTier(n, GATES.peerMinPeers)),
    ['low', 'low', 'moderate', 'moderate', 'high'],
  )
  // corpus trend (gate 10)
  assert.deepEqual(
    [9, 10, 20, 40].map(n => confidenceTier(n, GATES.trendMinPerWindowForVerdict)),
    ['insufficient', 'low', 'moderate', 'high'],
  )
  // trajectories (gate 2) — two evaluations can never read as more than low
  assert.deepEqual(
    [1, 2, 3, 4, 8].map(n => confidenceTier(n, GATES.trendMinEvals)),
    ['insufficient', 'low', 'low', 'moderate', 'high'],
  )
})

test('confidenceTier rejects nonsense input as insufficient', () => {
  assert.equal(confidenceTier(NaN, 5), 'insufficient')
  assert.equal(confidenceTier(undefined, 5), 'insufficient')
  assert.equal(confidenceTier(10, 0), 'insufficient')
  assert.equal(confidenceTier(10, undefined), 'insufficient')
})

test('every tier name is in the published list', () => {
  for (const n of [0, 5, 12, 99]) assert.ok(CONFIDENCE_TIERS.includes(confidenceTier(n, 5)))
})

/* ───── describeSample ──────────────────────────────────────────────────── */

test('describeSample carries n, gate, tier and the gate decision', () => {
  assert.deepEqual(describeSample(7, 5), { n: 7, gate: 5, confidence: 'low', sufficient: true })
  assert.deepEqual(describeSample(2, 5), { n: 2, gate: 5, confidence: 'insufficient', sufficient: false })
  assert.equal(describeSample(undefined, 5).n, 0)
})

/* ───── Movement classification — the floor boundary ────────────────────── */

test('classifyMovement: a delta EXACTLY at the floor is detectable', () => {
  assert.equal(classifyMovement(0.30), 'improving')
  assert.equal(classifyMovement(-0.30), 'declining')
})

test('classifyMovement: just under the floor is within-noise, in both directions', () => {
  assert.equal(classifyMovement(0.29), 'within-noise')
  assert.equal(classifyMovement(-0.29), 'within-noise')
  assert.equal(classifyMovement(0), 'within-noise')
})

test('classifyMovement: one Want dim step alone never reads as movement', () => {
  assert.equal(classifyMovement(WANT_DIM_STEP, { metric: 'want' }), 'within-noise')
  assert.equal(classifyMovement(-WANT_DIM_STEP, { metric: 'want' }), 'within-noise')
  assert.equal(classifyMovement(2 * WANT_DIM_STEP, { metric: 'want' }), 'improving')
})

test('classifyMovement: the Ease floor is wider than the Want floor', () => {
  assert.equal(classifyMovement(0.32, { metric: 'ease' }), 'within-noise')
  assert.equal(classifyMovement(0.32, { metric: 'want' }), 'improving')
  assert.equal(classifyMovement(0.35, { metric: 'ease' }), 'improving')
  assert.equal(classifyMovement(-0.35, { metric: 'ease' }), 'declining')
})

test('classifyMovement: non-finite input is unknown, not a direction', () => {
  assert.equal(classifyMovement(NaN), 'unknown')
  assert.equal(classifyMovement(undefined), 'unknown')
  assert.equal(classifyMovement('nope'), 'unknown')
})

test('classifyMovement honors a caller-supplied floor', () => {
  assert.equal(classifyMovement(0.4, { floor: 0.5 }), 'within-noise')
  assert.equal(classifyMovement(0.5, { floor: 0.5 }), 'improving')
})

test('isWithinNoise agrees with classifyMovement at the boundary', () => {
  assert.equal(isWithinNoise(0.29), true)
  assert.equal(isWithinNoise(0.30), false)
})

/* ───── Rendering helpers ───────────────────────────────────────────────── */

test('formatSample always states n and pluralizes correctly', () => {
  assert.equal(formatSample(1, 'peer'), 'of 1 peer')
  assert.equal(formatSample(12, 'peer'), 'of 12 peers')
  assert.equal(formatSample(3, 'match'), 'of 3 matches')
  assert.equal(formatSample(0, 'observation'), 'of 0 observations')
})

test('formatWithinNoise states the delta AND the floor it failed to clear', () => {
  const s = formatWithinNoise(0.1)
  assert.match(formatWithinNoise(0.1, { metric: 'ease' }), /0\.35/)
  assert.match(s, /flat within noise/)
  assert.match(s, /0\.10/)
  assert.match(s, /0\.30/)
  // No sign or arrow may leak into a within-noise rendering (docs § 4 rule 5).
  assert.ok(!/[+↑↓]/.test(s))
})

/* ───── Gate table ──────────────────────────────────────────────────────── */

test('the gate table matches the values documented in the contract', () => {
  assert.deepEqual({ ...GATES }, {
    peerMinPeers: 5,
    trendMinEvals: 2,
    trendMinPerWindowForVerdict: 10,
    calibrationMinCompanyRoles: 4,
    calibrationMinDimRows: 20,
    calibrationMinCompRows: 20,
    calibrationMinApplied: 8,
    momentumMinPerHalf: 5,
  })
})

test('the gate table is frozen — no surface may mutate a shared gate', () => {
  assert.throws(() => { GATES.peerMinPeers = 1 }, TypeError)
})
