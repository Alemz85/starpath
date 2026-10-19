// Unit tests for the scoring calibration — scripts/lib/calibration.mjs applies
// the user's data-driven Brand / Growth / Competition adjustments before
// the rollups (dream-company override, affinity & lower-tier-dream bonuses,
// onboarding ±1, referral bonus) and answers the dream / revisit lookups
// that drive the Want floor and the Blocked note. Company names are fictional. test-all.mjs pins a few of these end-to-end through
// score-listing.mjs; this suite tests each function directly so the
// precedence (override wins, stacking, clamps, the cems alias) can't drift.
//
// Plain ESM, zero deps: picked up by `node --test "scripts/**/*.test.mjs"`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBrandCalibration,
  applyGrowthCalibration,
  applyReferralAdjustment,
  isDreamCompany,
  isRevisitCompany,
} from './calibration.mjs'

// ─── Brand calibration ────────────────────────────────────────────────────────

test('applyBrandCalibration is a no-op with no/empty calibration', () => {
  assert.deepEqual(applyBrandCalibration(6, 'Acme', {}), { value: 6, adjustments: [] })
  assert.deepEqual(applyBrandCalibration(6, 'Acme', undefined), { value: 6, adjustments: [] })
})

test('applyBrandCalibration: dream-company overrides Brand to 10 and wins over everything', () => {
  const r = applyBrandCalibration(5, 'northwind', { dream_companies: ['Northwind'], brand_affinity_companies: ['Northwind'] })
  assert.equal(r.value, 10)                          // case-insensitive match
  assert.equal(r.adjustments.length, 1)              // override returns early — affinity never fires
  assert.equal(r.adjustments[0].type, 'override')
  assert.equal(r.adjustments[0].value, 5)            // 10 − rawBrand
})

test('applyBrandCalibration: affinity (+0.6) via either the canonical key or the cems alias', () => {
  assert.equal(applyBrandCalibration(6, 'Fabrikam', { brand_affinity_companies: ['Fabrikam'] }).value, 6.6)
  assert.equal(applyBrandCalibration(6, 'Fabrikam', { cems_adjacent_companies: ['Fabrikam'] }).value, 6.6)
})

test('applyBrandCalibration: lower-tier dream adds +1.0 (no override, no early return)', () => {
  const r = applyBrandCalibration(7, 'Contoso', { lower_tier_dream_companies: ['Contoso'] })
  assert.equal(r.value, 8)
  assert.equal(r.adjustments[0].source, 'lower-tier dream company')
})

test('applyBrandCalibration: extra_brand_bonuses add by entry, labelled with the reason', () => {
  const withReason = applyBrandCalibration(6, 'Northwind', { extra_brand_bonuses: [{ company: 'Northwind', bonus: 1.0, reason: 'priority target' }] })
  assert.equal(withReason.value, 7)
  assert.equal(withReason.adjustments[0].source, 'Northwind bonus (priority target)')
  // non-finite bonus is ignored, not NaN-propagated
  assert.equal(applyBrandCalibration(6, 'Northwind', { extra_brand_bonuses: [{ company: 'Northwind', bonus: 'oops' }] }).value, 6)
})

test('applyBrandCalibration: non-override bonuses stack and clamp at 10', () => {
  const stacked = applyBrandCalibration(6, 'Contoso', {
    brand_affinity_companies: ['Contoso'],
    lower_tier_dream_companies: ['Contoso'],
    extra_brand_bonuses: [{ company: 'Contoso', bonus: 0.5 }],
  })
  assert.equal(stacked.value, 8.1)                   // 6 + 0.6 + 1.0 + 0.5
  assert.equal(stacked.adjustments.length, 3)
  assert.equal(applyBrandCalibration(9.5, 'Contoso', { lower_tier_dream_companies: ['Contoso'] }).value, 10) // clamp
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

// ─── Referral adjustment (Competition) ────────────────────────────────────────

test('applyReferralAdjustment: warm-direct +1.0, warm-intro +0.5, anything else 0', () => {
  assert.deepEqual(applyReferralAdjustment(5, 'warm-direct'), { value: 6, adjustments: [{ source: 'warm-direct referral', value: 1 }] })
  assert.deepEqual(applyReferralAdjustment(5, 'warm-intro'), { value: 5.5, adjustments: [{ source: 'warm-intro referral', value: 0.5 }] })
  assert.deepEqual(applyReferralAdjustment(5, null), { value: 5, adjustments: [] })
  assert.deepEqual(applyReferralAdjustment(5, undefined), { value: 5, adjustments: [] })
  assert.deepEqual(applyReferralAdjustment(5, 'cold'), { value: 5, adjustments: [] })
  assert.deepEqual(applyReferralAdjustment(5, 'toString'), { value: 5, adjustments: [] }) // no prototype leaks
})

test('applyReferralAdjustment clamps to 10', () => {
  assert.equal(applyReferralAdjustment(9.5, 'warm-direct').value, 10)
  assert.equal(applyReferralAdjustment(10, 'warm-intro').value, 10)
})

// ─── Dream / revisit lookups ──────────────────────────────────────────────────

test('isDreamCompany: case-insensitive match on dream_companies only', () => {
  const cal = { dream_companies: ['Northwind'], lower_tier_dream_companies: ['Contoso'] }
  assert.equal(isDreamCompany(' northwind ', cal), true)
  assert.equal(isDreamCompany('Contoso', cal), false)          // lower tier doesn't get the Want floor
  assert.equal(isDreamCompany('Northwind', {}), false)
  assert.equal(isDreamCompany('Northwind', undefined), false)
})

test('isRevisitCompany: dream, lower-tier dream or brand-affinity (incl. the cems alias)', () => {
  assert.equal(isRevisitCompany('Northwind', { dream_companies: ['Northwind'] }), true)
  assert.equal(isRevisitCompany('Contoso', { lower_tier_dream_companies: ['Contoso'] }), true)
  assert.equal(isRevisitCompany('Fabrikam', { brand_affinity_companies: ['Fabrikam'] }), true)
  assert.equal(isRevisitCompany('Fabrikam', { cems_adjacent_companies: ['Fabrikam'] }), true)
  assert.equal(isRevisitCompany('Litware', { dream_companies: ['Northwind'] }), false)
  assert.equal(isRevisitCompany('Litware', {}), false)
})
