// Unit tests for the scoring engine — scripts/lib/score-bands.mjs is the
// canonical math that executes during every evaluation (modes/_shared.md only
// describes it in prose). test-all.mjs pins a handful of end-to-end fixtures
// through score-listing.mjs; this suite tests each pure function directly,
// nailing the band boundaries, the bottom-range penalty, the intern carve-out,
// and every tier branch so a rule change can't drift silently.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  savingsToBaseScore,
  applyBenefitsModifier,
  buildTotalComp,
  rollupCurrentFit,
  rollupAspirationalFit,
  rollupOverall,
  assignTier,
  grossToNet,
} from './score-bands.mjs'

// ─── savingsToBaseScore: the 10-tier savings band ─────────────────────────────

test('savingsToBaseScore hits every band at its threshold and just below', () => {
  // [threshold, scoreAtThreshold, scoreJustBelow]
  const cases = [
    [2000, 10, 9],
    [1500,  9, 8],
    [1100,  8, 7],
    [ 800,  7, 6],
    [ 500,  6, 5],
    [ 250,  5, 4],
    [  50,  4, 3],
    [-150,  3, 2],
    [-400,  2, 1],
  ]
  for (const [threshold, at, below] of cases) {
    assert.equal(savingsToBaseScore(threshold), at, `at ${threshold}`)
    assert.equal(savingsToBaseScore(threshold - 1), below, `below ${threshold}`)
  }
  assert.equal(savingsToBaseScore(99999), 10)   // saturates high
  assert.equal(savingsToBaseScore(-99999), 1)   // floors low
})

// ─── applyBenefitsModifier ────────────────────────────────────────────────────

test('applyBenefitsModifier adds the modifier and clamps to [1,10]', () => {
  assert.equal(applyBenefitsModifier(7, 0.5), 7.5)
  assert.equal(applyBenefitsModifier(7, -0.3), 6.7)
  assert.equal(applyBenefitsModifier(7, undefined), 7)   // missing modifier → +0
  assert.equal(applyBenefitsModifier(10, 1.0), 10)        // clamp high
  assert.equal(applyBenefitsModifier(1, -0.5), 1)         // clamp low
})

// ─── buildTotalComp ───────────────────────────────────────────────────────────

test('buildTotalComp sums only the disclosed components', () => {
  const { total, breakdown } = buildTotalComp({ base: 50000 })
  assert.equal(total, 50000)
  assert.deepEqual(breakdown, { base: 50000 })   // no phantom bonus/equity keys
})

test('buildTotalComp builds up every component', () => {
  const { total, breakdown } = buildTotalComp({
    base: 60000,
    bonusPct: 0.10,            // → 6000
    equityAnnualEur: 10000,
    thirteenthMonthMonths: 2,  // → (60000/12)*2 = 10000
    benefitsMonthlyEur: 100,   // → 1200
    signOnEur: 9000,           // → 9000/3 = 3000 (default tenure 3)
  })
  assert.equal(breakdown.bonus, 6000)
  assert.equal(breakdown.equity, 10000)
  assert.equal(breakdown.thirteenth_etc, 10000)
  assert.equal(breakdown.cash_benefits, 1200)
  assert.equal(breakdown.sign_on, 3000)
  assert.equal(total, 60000 + 6000 + 10000 + 10000 + 1200 + 3000)
})

test('buildTotalComp amortizes the sign-on over the stated tenure', () => {
  const { breakdown } = buildTotalComp({ base: 60000, signOnEur: 9000, tenureYears: 2 })
  assert.equal(breakdown.sign_on, 4500)
})

// ─── rollups + bottom-range penalty ───────────────────────────────────────────

test('rollupCurrentFit averages the three CF dims', () => {
  assert.equal(rollupCurrentFit({ skills_match: 8, ease_of_entry: 6, strategic_fit: 7 }), 7)
  assert.equal(rollupCurrentFit({ skills_match: 7, ease_of_entry: 7, strategic_fit: 8 }), 7.33) // 22/3
})

test('rollupCurrentFit subtracts 0.30 per bottom-range (1-2) dim, compounding', () => {
  // avg(5,6,7)=6.0, no low dims
  assert.equal(rollupCurrentFit({ skills_match: 5, ease_of_entry: 6, strategic_fit: 7 }), 6)
  // avg(2,6,7)=5.0, one dim ∈[1,2] → −0.30
  assert.equal(rollupCurrentFit({ skills_match: 2, ease_of_entry: 6, strategic_fit: 7 }), 4.7)
  // avg(1,2,7)=3.33, two low dims → −0.60
  assert.equal(rollupCurrentFit({ skills_match: 1, ease_of_entry: 2, strategic_fit: 7 }), 2.73)
  // a 3 is NOT bottom-range — no penalty
  assert.equal(rollupCurrentFit({ skills_match: 3, ease_of_entry: 6, strategic_fit: 6 }), 5)
})

test('rollupAspirationalFit averages G/O/B (Sales-Trap Risk excluded)', () => {
  assert.equal(rollupAspirationalFit({ growth_mobility: 8, optionality_exit: 8, brand_value: 8 }), 8)
  assert.equal(rollupAspirationalFit({ growth_mobility: 4, optionality_exit: 7, brand_value: 7 }), 6)
})

// ─── rollupOverall + context modifiers + intern carve-out ─────────────────────

test('rollupOverall is CF×0.70 + AF×0.30 with no modifiers in the neutral band', () => {
  const { overall, modifiersApplied } = rollupOverall(7.0, 6.0, {
    salary_adj_for_city: 6, work_life_balance: 6, is_intern: false,
  })
  assert.equal(overall, 6.7)
  assert.deepEqual(modifiersApplied, [])
})

test('rollupOverall applies Salary≤4 (−0.4) and WLB≤4 (−0.2) for non-interns', () => {
  const { overall, modifiersApplied } = rollupOverall(6.67, 8.0, {
    salary_adj_for_city: 3, work_life_balance: 4, is_intern: false,
  })
  // 6.67×0.7 + 8.0×0.3 = 7.069 − 0.4 − 0.2 = 6.469 → 6.47
  assert.equal(overall, 6.47)
  assert.equal(modifiersApplied.length, 2)
  assert.equal(modifiersApplied[0].value, -0.4)
  assert.equal(modifiersApplied[1].value, -0.2)
})

test('rollupOverall gives +0.2 for a strong Salary Adj (≥9)', () => {
  const { overall } = rollupOverall(7.0, 6.0, {
    salary_adj_for_city: 9, work_life_balance: 6, is_intern: false,
  })
  assert.equal(overall, 6.9)
})

test('rollupOverall skips the Salary modifier for interns but keeps WLB', () => {
  // Intern, salary would trigger −0.4 but is suppressed; surfaced as a 0 modifier.
  const skip = rollupOverall(7.0, 6.0, { salary_adj_for_city: 3, work_life_balance: 6, is_intern: true })
  assert.equal(skip.overall, 6.7)   // no salary penalty
  assert.ok(skip.modifiersApplied.some(m => m.value === 0 && /intern/i.test(m.source)))

  // WLB ≤ 4 still bites interns (sweatshop signal).
  const wlb = rollupOverall(7.0, 6.0, { salary_adj_for_city: 3, work_life_balance: 4, is_intern: true })
  assert.equal(wlb.overall, 6.5)    // 6.7 − 0.2
})

// ─── assignTier: every branch + ordering ──────────────────────────────────────

const SIX = (o = {}) => ({
  skills_match: 7, ease_of_entry: 6, strategic_fit: 7,
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, ...o,
})

test('assignTier: Stellar (T1) on CF ≥ 9.0, ahead of the EoE gate', () => {
  assert.equal(assignTier({ cf: 9.0, af: 5, sixDims: SIX() }).tier, 'T1')
  // CF≥9 wins even when EoE ≤ 4 would otherwise gate to T3/T4.
  assert.equal(assignTier({ cf: 9.2, af: 5, sixDims: SIX({ ease_of_entry: 3 }) }).tier, 'T1')
})

test('assignTier: uniform-fingerprint override → T1 (all 6 dims ≥ 8 AND CF/AF ≥ 8)', () => {
  const allEight = SIX({ skills_match: 8, ease_of_entry: 8, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 })
  assert.equal(assignTier({ cf: 8.0, af: 8.0, sixDims: allEight }).tier, 'T1')
  // One dim below 8 breaks the override → falls through to T2 (CF ≥ 7, EoE > 4).
  const oneSeven = SIX({ skills_match: 7, ease_of_entry: 8, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 })
  assert.equal(assignTier({ cf: 8.0, af: 8.0, sixDims: oneSeven }).tier, 'T2')
})

test('assignTier: Ease-of-Entry ≤ 4 gate → T3 if AF ≥ 7, else T4', () => {
  assert.equal(assignTier({ cf: 8, af: 7, sixDims: SIX({ ease_of_entry: 4 }) }).tier, 'T3')
  assert.equal(assignTier({ cf: 8, af: 6, sixDims: SIX({ ease_of_entry: 4 }) }).tier, 'T4')
})

test('assignTier: Strong/Decent (T2) when CF ≥ 7 and EoE > 4', () => {
  assert.equal(assignTier({ cf: 7.0, af: 5, sixDims: SIX({ ease_of_entry: 6 }) }).tier, 'T2')
  assert.equal(assignTier({ cf: 8.9, af: 5, sixDims: SIX({ ease_of_entry: 6 }) }).tier, 'T2')
})

test('assignTier: Growth target (T3) on low CF but AF ≥ 7; Skip (T4) otherwise', () => {
  assert.equal(assignTier({ cf: 6.5, af: 7.5, sixDims: SIX({ ease_of_entry: 6 }) }).tier, 'T3')
  assert.equal(assignTier({ cf: 6.0, af: 6.0, sixDims: SIX({ ease_of_entry: 6 }) }).tier, 'T4')
})

// ─── grossToNet ───────────────────────────────────────────────────────────────

test('grossToNet applies the effective rate and derives monthly', () => {
  assert.deepEqual(grossToNet(100000, 0.27), { annualNet: 73000, monthlyNet: 6083.33 })
  assert.deepEqual(grossToNet(60000, 0.30), { annualNet: 42000, monthlyNet: 3500 })
})
