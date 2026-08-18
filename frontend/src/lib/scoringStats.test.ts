// scoringStats.test.ts — the anti-drift pin between the two runtimes.
//
// CONTRACT: docs/scoring-statistical-design.md
//
// scripts/lib/scoring-stats.mjs is the canonical statement of the contract's
// numbers for the Node CLIs; src/lib/scoringStats.ts restates them for the
// renderer. This suite imports BOTH — the .mjs directly, by relative path out
// of frontend/, which works because the node:test runner executes in Node (the
// alias loader passes explicit `.mjs` specifiers straight through to the
// default resolver) — and asserts every mirrored number, gate, tier boundary
// and classification agrees. Change one side without the other and this fails.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as ts from '@/lib/scoringStats'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM .mjs with no type declarations; this import exists to
// compare VALUES against the canonical module, so the shape is deliberately
// untyped here. (tsconfig excludes *.test.ts from the app build.)
import * as mjs from '../../../scripts/lib/scoring-stats.mjs'

/* ───── The module actually loaded ───────────────────────────────────────── */

test('the canonical scripts/lib/scoring-stats.mjs is importable from the renderer suite', () => {
  assert.equal(typeof mjs.confidenceTier, 'function')
  assert.equal(typeof mjs.classifyMovement, 'function')
  assert.ok(mjs.GATES, 'canonical GATES table must be present')
})

/* ───── Rubric geometry ──────────────────────────────────────────────────── */

test('rollup weights and dimension steps are identical across runtimes', () => {
  assert.equal(ts.CF_WEIGHT, mjs.CF_WEIGHT)
  assert.equal(ts.AF_WEIGHT, mjs.AF_WEIGHT)
  assert.equal(ts.CF_DIM_STEP, mjs.CF_DIM_STEP)
  assert.equal(ts.AF_DIM_STEP, mjs.AF_DIM_STEP)
  // …and match the documented values, so a matched pair of wrong numbers still fails.
  assert.equal(ts.CF_WEIGHT, 0.70)
  assert.equal(ts.AF_WEIGHT, 0.30)
  assert.ok(Math.abs(ts.CF_DIM_STEP - 0.2333) < 0.0001)
  assert.equal(Number(ts.AF_DIM_STEP.toFixed(4)), 0.1)
})

test('the noise floor is 0.30 in both runtimes and in the doc', () => {
  assert.equal(ts.OVERALL_NOISE_FLOOR, mjs.OVERALL_NOISE_FLOOR)
  assert.equal(ts.OVERALL_NOISE_FLOOR, 0.30)
})

test('the floor clears every single-dimension wobble and admits the cheapest two-dim move', () => {
  assert.ok(ts.OVERALL_NOISE_FLOOR > ts.CF_DIM_STEP)
  assert.ok(ts.OVERALL_NOISE_FLOOR > ts.AF_DIM_STEP)
  assert.ok(ts.OVERALL_NOISE_FLOOR > 2 * ts.AF_DIM_STEP)
  assert.ok(ts.OVERALL_NOISE_FLOOR <= ts.CF_DIM_STEP + ts.AF_DIM_STEP)
  assert.ok(ts.OVERALL_NOISE_FLOOR <= 2 * ts.CF_DIM_STEP)
})

/* ───── Gate table ───────────────────────────────────────────────────────── */

test('the gate table matches the canonical module key-for-key', () => {
  assert.deepEqual({ ...ts.GATES }, { ...mjs.GATES })
})

test('the gate table matches the values documented in the contract', () => {
  assert.deepEqual({ ...ts.GATES }, {
    peerMinPeers: 5,
    trendMinEvals: 2,
    trendMinPerWindowForVerdict: 10,
    calibrationMinCompanyRoles: 4,
    calibrationMinDimRows: 20,
    calibrationMinCompRows: 20,
    calibrationMinApplied: 8,
  })
})

/* ───── Dimension classes ────────────────────────────────────────────────── */

test('dimension class lists are identical across runtimes', () => {
  assert.deepEqual([...ts.MECHANICAL_DIMS], [...mjs.MECHANICAL_DIMS])
  assert.deepEqual([...ts.JUDGMENT_DIMS], [...mjs.JUDGMENT_DIMS])
})

test('dimensionClass agrees on every known key and on an unknown one', () => {
  for (const key of [...ts.MECHANICAL_DIMS, ...ts.JUDGMENT_DIMS, 'not_a_dimension']) {
    assert.equal(ts.dimensionClass(key), mjs.dimensionClass(key), key)
  }
  assert.equal(ts.dimensionClass('brand_value'), 'mechanical')
  assert.equal(ts.dimensionClass('skills_match'), 'judgment')
  assert.equal(ts.dimensionClass('not_a_dimension'), 'unknown')
})

test('no dimension is in both classes', () => {
  for (const d of ts.MECHANICAL_DIMS) {
    assert.ok(!(ts.JUDGMENT_DIMS as readonly string[]).includes(d), `${d} is in both classes`)
  }
})

/* ───── Confidence tiers — boundaries at exactly g, 2g, 4g ───────────────── */

test('confidenceTier agrees with the canonical module across the boundary sweep', () => {
  const gates = [2, 4, 5, 8, 10, 20]
  for (const g of gates) {
    for (const n of [0, g - 1, g, g + 1, 2 * g - 1, 2 * g, 4 * g - 1, 4 * g, 4 * g + 1]) {
      assert.equal(ts.confidenceTier(n, g), mjs.confidenceTier(n, g), `n=${n} gate=${g}`)
    }
  }
})

test('confidenceTier: n exactly at the gate is low, one below is insufficient', () => {
  assert.equal(ts.confidenceTier(4, 5), 'insufficient')
  assert.equal(ts.confidenceTier(5, 5), 'low')       // ← boundary
})

test('confidenceTier: n exactly at 2× the gate is moderate, 4× is high', () => {
  assert.equal(ts.confidenceTier(9, 5), 'low')
  assert.equal(ts.confidenceTier(10, 5), 'moderate') // ← boundary
  assert.equal(ts.confidenceTier(19, 5), 'moderate')
  assert.equal(ts.confidenceTier(20, 5), 'high')     // ← boundary
})

test('confidenceTier reproduces every surface tier table', () => {
  assert.deepEqual(
    [5, 9, 10, 19, 20].map(n => ts.confidenceTier(n, ts.GATES.peerMinPeers)),
    ['low', 'low', 'moderate', 'moderate', 'high'],
  )
  assert.deepEqual(
    [9, 10, 20, 40].map(n => ts.confidenceTier(n, ts.GATES.trendMinPerWindowForVerdict)),
    ['insufficient', 'low', 'moderate', 'high'],
  )
  assert.deepEqual(
    [1, 2, 3, 4, 8].map(n => ts.confidenceTier(n, ts.GATES.trendMinEvals)),
    ['insufficient', 'low', 'low', 'moderate', 'high'],
  )
})

test('confidenceTier rejects nonsense input as insufficient, same as canonical', () => {
  const bad: Array<[unknown, unknown]> = [[NaN, 5], [undefined, 5], [10, 0], [10, undefined]]
  for (const [n, g] of bad) {
    assert.equal(
      ts.confidenceTier(n as number, g as number),
      mjs.confidenceTier(n, g),
      `n=${String(n)} gate=${String(g)}`,
    )
    assert.equal(ts.confidenceTier(n as number, g as number), 'insufficient')
  }
})

test('the published tier list is identical and covers every result', () => {
  assert.deepEqual([...ts.CONFIDENCE_TIERS], [...mjs.CONFIDENCE_TIERS])
  for (const n of [0, 5, 12, 99]) {
    assert.ok((ts.CONFIDENCE_TIERS as readonly string[]).includes(ts.confidenceTier(n, 5)))
  }
})

/* ───── describeSample ───────────────────────────────────────────────────── */

test('describeSample matches the canonical descriptor', () => {
  for (const [n, g] of [[7, 5], [2, 5], [40, 10], [0, 2]] as Array<[number, number]>) {
    assert.deepEqual(ts.describeSample(n, g), mjs.describeSample(n, g), `n=${n} gate=${g}`)
  }
  assert.deepEqual(ts.describeSample(7, 5), { n: 7, gate: 5, confidence: 'low', sufficient: true })
  assert.deepEqual(ts.describeSample(2, 5), { n: 2, gate: 5, confidence: 'insufficient', sufficient: false })
  assert.equal(ts.describeSample(undefined, 5).n, 0)
})

/* ───── Movement classification — the floor boundary ─────────────────────── */

test('classifyMovement agrees with the canonical module around the floor', () => {
  const deltas = [0, 0.01, 0.1, 0.2333, 0.29, 0.2999, 0.3, 0.30001, 0.5, -0.29, -0.3, -1.2]
  for (const d of deltas) {
    assert.equal(ts.classifyMovement(d), mjs.classifyMovement(d), `Δ=${d}`)
  }
})

test('classifyMovement: a delta EXACTLY at the floor is detectable', () => {
  assert.equal(ts.classifyMovement(0.30), 'improving')
  assert.equal(ts.classifyMovement(-0.30), 'declining')
})

test('classifyMovement: just under the floor is within-noise, in both directions', () => {
  assert.equal(ts.classifyMovement(0.29), 'within-noise')
  assert.equal(ts.classifyMovement(-0.29), 'within-noise')
  assert.equal(ts.classifyMovement(0), 'within-noise')
})

test('classifyMovement: one CF dim step alone never reads as movement; CF+AF does', () => {
  assert.equal(ts.classifyMovement(ts.CF_DIM_STEP), 'within-noise')
  assert.equal(ts.classifyMovement(-ts.CF_DIM_STEP), 'within-noise')
  assert.equal(ts.classifyMovement(ts.CF_DIM_STEP + ts.AF_DIM_STEP), 'improving')
})

test('classifyMovement: non-finite input is unknown, not a direction', () => {
  assert.equal(ts.classifyMovement(NaN), 'unknown')
  assert.equal(ts.classifyMovement(undefined), 'unknown')
  assert.equal(ts.classifyMovement('nope' as unknown as number), 'unknown')
})

test('classifyMovement honors a caller-supplied floor, same as canonical', () => {
  assert.equal(ts.classifyMovement(0.4, { floor: 0.5 }), mjs.classifyMovement(0.4, { floor: 0.5 }))
  assert.equal(ts.classifyMovement(0.4, { floor: 0.5 }), 'within-noise')
  assert.equal(ts.classifyMovement(0.5, { floor: 0.5 }), 'improving')
})

test('isWithinNoise agrees with classifyMovement at the boundary', () => {
  assert.equal(ts.isWithinNoise(0.29), true)
  assert.equal(ts.isWithinNoise(0.30), false)
  assert.equal(ts.isWithinNoise(0.29), mjs.isWithinNoise(0.29))
})

/* ───── Rendering helpers ────────────────────────────────────────────────── */

test('formatSample renders the same string as the canonical helper', () => {
  const cases: Array<[number, string]> = [[1, 'peer'], [12, 'peer'], [3, 'match'], [0, 'observation'], [2, 'entry']]
  for (const [n, noun] of cases) {
    assert.equal(ts.formatSample(n, noun), mjs.formatSample(n, noun), `${n} ${noun}`)
  }
  assert.equal(ts.formatSample(1, 'peer'), 'of 1 peer')
  assert.equal(ts.formatSample(12, 'peer'), 'of 12 peers')
  assert.equal(ts.formatSample(3, 'match'), 'of 3 matches')
})

test('formatWithinNoise states the delta AND the floor, with no sign or arrow', () => {
  assert.equal(ts.formatWithinNoise(0.1), mjs.formatWithinNoise(0.1))
  const s = ts.formatWithinNoise(0.1)
  assert.match(s, /flat within noise/)
  assert.match(s, /0\.10/)
  assert.match(s, /0\.30/)
  assert.ok(!/[+↑↓]/.test(s))
})

/* ───── Renderer-only copy helpers (no .mjs counterpart) ─────────────────── */

test('confidenceNote always states the tier and n', () => {
  assert.equal(ts.confidenceNote('low', 7), 'low confidence · n=7')
  assert.equal(ts.confidenceNote('high', 40), 'high confidence · n=40')
})

test('rankReadingCaveat fires only at low confidence (docs § 3.2)', () => {
  assert.match(ts.rankReadingCaveat('low'), /read the half/)
  assert.equal(ts.rankReadingCaveat('moderate'), '')
  assert.equal(ts.rankReadingCaveat('high'), '')
  assert.equal(ts.rankReadingCaveat('insufficient'), '')
})
