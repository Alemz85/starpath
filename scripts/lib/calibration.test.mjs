// Unit tests for the scoring calibration — scripts/lib/calibration.mjs applies
// the user's data-driven Brand / Growth / Aspirational-Fit adjustments before
// the rollups (dream-company override, affinity & lower-tier-dream bonuses,
// onboarding ±1, AF floor). test-all.mjs pins a few of these end-to-end through
// score-listing.mjs; this suite tests each function directly so the
// precedence (override wins, stacking, clamps, the cems alias) can't drift.
//
// Plain ESM, zero deps: picked up by `node --test "scripts/**/*.test.mjs"`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBrandCalibration,
  applyGrowthCalibration,
  applyAspirationalFitFloor,
} from './calibration.mjs'

// ─── Brand calibration ────────────────────────────────────────────────────────

test('applyBrandCalibration is a no-op with no/empty calibration', () => {
  assert.deepEqual(applyBrandCalibration(6, 'Acme', {}), { value: 6, adjustments: [] })
  assert.deepEqual(applyBrandCalibration(6, 'Acme', undefined), { value: 6, adjustments: [] })
})

test('applyBrandCalibration: dream-company overrides Brand to 10 and wins over everything', () => {
  const r = applyBrandCalibration(5, 'google', { dream_companies: ['Google'], brand_affinity_companies: ['Google'] })
  assert.equal(r.value, 10)                          // case-insensitive match
  assert.equal(r.adjustments.length, 1)              // override returns early — affinity never fires
  assert.equal(r.adjustments[0].type, 'override')
  assert.equal(r.adjustments[0].value, 5)            // 10 − rawBrand
})

test('applyBrandCalibration: affinity (+0.6) via either the canonical key or the cems alias', () => {
  assert.equal(applyBrandCalibration(6, 'McKinsey', { brand_affinity_companies: ['McKinsey'] }).value, 6.6)
  assert.equal(applyBrandCalibration(6, 'McKinsey', { cems_adjacent_companies: ['McKinsey'] }).value, 6.6)
})

test('applyBrandCalibration: lower-tier dream adds +1.0 (no override, no early return)', () => {
  const r = applyBrandCalibration(7, 'Glovo', { lower_tier_dream_companies: ['Glovo'] })
  assert.equal(r.value, 8)
  assert.equal(r.adjustments[0].source, 'lower-tier dream company')
})

test('applyBrandCalibration: extra_brand_bonuses add by entry, labelled with the reason', () => {
  const withReason = applyBrandCalibration(6, 'Google', { extra_brand_bonuses: [{ company: 'Google', bonus: 1.0, reason: 'priority target' }] })
  assert.equal(withReason.value, 7)
  assert.equal(withReason.adjustments[0].source, 'Google bonus (priority target)')
  // non-finite bonus is ignored, not NaN-propagated
  assert.equal(applyBrandCalibration(6, 'Google', { extra_brand_bonuses: [{ company: 'Google', bonus: 'oops' }] }).value, 6)
})

test('applyBrandCalibration: non-override bonuses stack and clamp at 10', () => {
  const stacked = applyBrandCalibration(6, 'Glovo', {
    brand_affinity_companies: ['Glovo'],
    lower_tier_dream_companies: ['Glovo'],
    extra_brand_bonuses: [{ company: 'Glovo', bonus: 0.5 }],
  })
  assert.equal(stacked.value, 8.1)                   // 6 + 0.6 + 1.0 + 0.5
  assert.equal(stacked.adjustments.length, 3)
  assert.equal(applyBrandCalibration(9.5, 'Glovo', { lower_tier_dream_companies: ['Glovo'] }).value, 10) // clamp
})

// ─── Growth calibration ───────────────────────────────────────────────────────

test('applyGrowthCalibration: structured onboarding +1, sink-or-swim −1, both cancel', () => {
  assert.equal(applyGrowthCalibration(7, { has_structured_onboarding: true }).value, 8)
  assert.equal(applyGrowthCalibration(7, { has_sink_or_swim_signal: true }).value, 6)
  const both = applyGrowthCalibration(7, { has_structured_onboarding: true, has_sink_or_swim_signal: true })
  assert.equal(both.value, 7)
  assert.equal(both.adjustments.length, 2)
})

test('applyGrowthCalibration: no-op when neither signal is set; clamps to [1,10]', () => {
  assert.deepEqual(applyGrowthCalibration(7, {}), { value: 7, adjustments: [] })
  assert.equal(applyGrowthCalibration(10, { has_structured_onboarding: true }).value, 10) // clamp high
  assert.equal(applyGrowthCalibration(1, { has_sink_or_swim_signal: true }).value, 1)     // clamp low
})

// ─── Aspirational Fit floor ───────────────────────────────────────────────────

test('applyAspirationalFitFloor: dream company floors AF to 8.0 only when below it', () => {
  const floored = applyAspirationalFitFloor(6.5, 'Google', { dream_companies: ['Google'] })
  assert.equal(floored.value, 8)
  assert.equal(floored.adjustments[0].value, 1.5)                 // 8.0 − 6.5
  // already ≥ 8 → untouched
  assert.deepEqual(applyAspirationalFitFloor(8.5, 'Google', { dream_companies: ['Google'] }), { value: 8.5, adjustments: [] })
  // exactly 8.0 is not "below" → no floor entry
  assert.deepEqual(applyAspirationalFitFloor(8.0, 'Google', { dream_companies: ['Google'] }), { value: 8, adjustments: [] })
})

test('applyAspirationalFitFloor: no effect for non-dream companies or no calibration', () => {
  assert.deepEqual(applyAspirationalFitFloor(6.5, 'Acme', { dream_companies: ['Google'] }), { value: 6.5, adjustments: [] })
  assert.deepEqual(applyAspirationalFitFloor(6.5, 'Acme', {}), { value: 6.5, adjustments: [] })
})
