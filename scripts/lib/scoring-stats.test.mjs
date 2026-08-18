// scoring-stats.test.mjs — pins the statistical-honesty contract.
//
// These tests are deliberately literal about the NUMBERS. The whole point of
// scoring-stats.mjs is that docs/scoring-statistical-design.md and the code
// state the same values; if someone changes a constant, this suite fails and
// forces them to update the doc in the same change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CF_WEIGHT, AF_WEIGHT, CF_DIM_STEP, AF_DIM_STEP,
  OVERALL_NOISE_FLOOR,
  GATES,
  CONFIDENCE_TIERS,
  MECHANICAL_DIMS, JUDGMENT_DIMS, dimensionClass,
  confidenceTier, describeSample,
  classifyMovement, isWithinNoise,
  formatSample, formatWithinNoise,
} from './scoring-stats.mjs'

/* ───── Rubric geometry + the noise-floor derivation ─────────────────────── */

test('rollup weights match modes/_shared.md (CF 0.70 / AF 0.30)', () => {
  assert.equal(CF_WEIGHT, 0.70)
  assert.equal(AF_WEIGHT, 0.30)
  assert.equal(CF_WEIGHT + AF_WEIGHT, 1)
})

test('one-step dimension moves land where the derivation says', () => {
  assert.ok(Math.abs(CF_DIM_STEP - 0.2333) < 0.0001)
  assert.equal(Number(AF_DIM_STEP.toFixed(4)), 0.1)
})

test('the noise floor is exactly 0.30, as documented', () => {
  assert.equal(OVERALL_NOISE_FLOOR, 0.30)
})

test('the noise floor sits strictly above any SINGLE-dimension wobble', () => {
  // This is the derivation: no one dimension re-judging itself may clear it.
  assert.ok(OVERALL_NOISE_FLOOR > CF_DIM_STEP, 'one CF dim step must not clear the floor')
  assert.ok(OVERALL_NOISE_FLOOR > AF_DIM_STEP, 'one AF dim step must not clear the floor')
  assert.ok(OVERALL_NOISE_FLOOR > 2 * AF_DIM_STEP, 'two AF dim steps must not clear the floor')
})

test('the noise floor sits at or below the cheapest two-dimension move', () => {
  // ...so a genuine move that needs two dimensions to agree is still detectable.
  assert.ok(OVERALL_NOISE_FLOOR <= CF_DIM_STEP + AF_DIM_STEP)
  assert.ok(OVERALL_NOISE_FLOOR <= 2 * CF_DIM_STEP)
})

/* ───── Dimension classes ────────────────────────────────────────────────── */

test('dimension classes split mechanical from judgment', () => {
  assert.equal(dimensionClass('brand_value'), 'mechanical')
  assert.equal(dimensionClass('salary_adj_city'), 'mechanical')
  assert.equal(dimensionClass('skills_match'), 'judgment')
  assert.equal(dimensionClass('strategic_fit'), 'judgment')
  assert.equal(dimensionClass('not_a_dimension'), 'unknown')
})

test('no dimension is in both classes', () => {
  for (const d of MECHANICAL_DIMS) assert.ok(!JUDGMENT_DIMS.includes(d), `${d} is in both classes`)
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

test('classifyMovement: one CF dim step alone never reads as movement', () => {
  assert.equal(classifyMovement(CF_DIM_STEP), 'within-noise')
  assert.equal(classifyMovement(-CF_DIM_STEP), 'within-noise')
})

test('classifyMovement: a CF+AF dim pair moving together does read as movement', () => {
  assert.equal(classifyMovement(CF_DIM_STEP + AF_DIM_STEP), 'improving')
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
