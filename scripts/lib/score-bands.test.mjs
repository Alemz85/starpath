// Unit tests for the scoring engine — scripts/lib/score-bands.mjs is the
// canonical math that executes during every evaluation (modes/_shared.md only
// describes it in prose). test-all.mjs pins a handful of end-to-end fixtures
// through score-listing.mjs; this suite tests each pure function directly:
// the salary helpers, the v2 Match rollup (hygiene steps, intern carve-out,
// motivator penalty, dream floor vs. vetoes), the Ease geometric mean
// (experience wall, amber cap), and every cell of the verdict grid at its
// exact boundaries, so a rule change can't drift silently.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  savingsToBaseScore,
  applyBenefitsModifier,
  buildTotalComp,
  grossToNet,
  hygieneTerm,
  rollupMatch,
  rollupEase,
  assignVerdict,
  verdictRank,
  promotionHint,
  computePriority,
  HYGIENE_STEPS,
  MOTIVATOR_BOTTOM_PENALTY,
  HYGIENE_VETO_CAP,
  ROLE_CONTENT_VETO_AT,
  ROLE_CONTENT_VETO_CAP,
  DREAM_MATCH_FLOOR,
  DEFAULT_MATCH_WEIGHTS,
  DEFAULT_EASE_WEIGHTS,
  EXPERIENCE_WALL_AT,
  EXPERIENCE_WALL_CAP,
  AMBER_EASE_PENALTY,
  AMBER_EASE_PENALTY_MAX,
  REFERRAL_BONUS,
  MATCH_HIGH,
  MATCH_MID,
  EASE_HIGH,
  EASE_MID,
  VERDICT_ORDER,
  VERDICT_LABELS,
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

// ─── v2: hygiene steps ────────────────────────────────────────────────────────

test('hygieneTerm hits every step at its threshold and just below', () => {
  assert.equal(hygieneTerm(10), 0.25)
  assert.equal(hygieneTerm(8), 0.25)
  assert.equal(hygieneTerm(7.99), 0)
  assert.equal(hygieneTerm(5), 0)
  assert.equal(hygieneTerm(4.99), -0.40)
  assert.equal(hygieneTerm(4), -0.40)
  assert.equal(hygieneTerm(3.99), -0.80)
  assert.equal(hygieneTerm(3), -0.80)
  assert.equal(hygieneTerm(2.99), -1.20)
  assert.equal(hygieneTerm(1), -1.20)
  assert.equal(HYGIENE_STEPS.length, 5)
})

test('named constants match the spec', () => {
  assert.equal(MOTIVATOR_BOTTOM_PENALTY, 0.30)
  assert.equal(HYGIENE_VETO_CAP, 5.0)
  assert.equal(ROLE_CONTENT_VETO_AT, 3)
  assert.equal(ROLE_CONTENT_VETO_CAP, 6.0)
  assert.equal(DREAM_MATCH_FLOOR, 8.0)
  assert.deepEqual({ ...DEFAULT_MATCH_WEIGHTS }, { growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1 })
  assert.deepEqual({ ...DEFAULT_EASE_WEIGHTS }, { skills_match: 0.35, experience_bar: 0.35, competition: 0.30 })
  assert.equal(EXPERIENCE_WALL_AT, 3)
  assert.equal(EXPERIENCE_WALL_CAP, 4.5)
  assert.equal(AMBER_EASE_PENALTY, 0.5)
  assert.equal(AMBER_EASE_PENALTY_MAX, 1.0)
  assert.deepEqual({ ...REFERRAL_BONUS }, { 'warm-direct': 1.0, 'warm-intro': 0.5 })
  assert.deepEqual([MATCH_HIGH, MATCH_MID, EASE_HIGH, EASE_MID], [8.0, 6.5, 7.0, 5.0])
  assert.deepEqual([...VERDICT_ORDER], ['blocked', 'skip', 'thin', 'growth', 'solid', 'stretch', 'go'])
  assert.deepEqual({ ...VERDICT_LABELS }, {
    go: 'Go', stretch: 'Stretch', growth: 'Growth target', solid: 'Solid',
    thin: 'If pipeline thin', skip: 'Skip', blocked: 'Blocked',
  })
})

// ─── v2: rollupMatch ───────────────────────────────────────────────────────────

const MATCH = (o = {}) => ({
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7,
  best_cities: 6, salary_adj_city: 6, work_life_balance: 6, ...o,
})

test('rollupMatch: motivator mean with neutral hygiene', () => {
  const w = rollupMatch(MATCH())
  assert.equal(w.score, 7)
  assert.equal(w.motivators_mean, 7)
  assert.equal(w.motivator_penalty, 0)
  assert.deepEqual(w.hygiene, { best_cities: 0, salary_adj_city: 0, work_life_balance: 0 })
  assert.equal(w.floor, null)
  assert.deepEqual(w.vetoes, [])
})

test('rollupMatch: good hygiene adds +0.25 each; bad hygiene subtracts per step', () => {
  assert.equal(rollupMatch(MATCH({ best_cities: 8, salary_adj_city: 9, work_life_balance: 10 })).score, 7.75)
  assert.equal(rollupMatch(MATCH({ best_cities: 4 })).score, 6.6)
  assert.equal(rollupMatch(MATCH({ best_cities: 3 })).score, 6.2)
  // 3 is not < 3: no veto, just the −0.80 term
  assert.deepEqual(rollupMatch(MATCH({ work_life_balance: 3 })).vetoes, [])
})

test('rollupMatch: intern salary carve-out — salary term is 0 and salary cannot veto', () => {
  const full = rollupMatch(MATCH({ salary_adj_city: 2 }))
  assert.equal(full.raw, 5.8)                          // 7 − 1.20
  assert.equal(full.score, 5)                          // hygiene veto
  assert.equal(full.vetoes[0].dimension, 'salary_adj_city')
  const intern = rollupMatch(MATCH({ salary_adj_city: 2 }), { is_intern: true })
  assert.equal(intern.score, 7)
  assert.equal(intern.hygiene.salary_adj_city, 0)
  assert.deepEqual(intern.vetoes, [])
  // a high stipend doesn't add the +0.25 either
  assert.equal(rollupMatch(MATCH({ salary_adj_city: 9 }), { is_intern: true }).score, 7)
  // other hygiene factors still bite interns
  assert.equal(rollupMatch(MATCH({ work_life_balance: 2 }), { is_intern: true }).score, 5)
})

test('rollupMatch: −0.30 per motivator ≤ 2, compounding; a 3 is not bottom-range', () => {
  const two = rollupMatch(MATCH({ growth_mobility: 2, optionality_exit: 2, brand_value: 8, role_content: 8 }))
  assert.equal(two.motivators_mean, 5)
  assert.equal(two.motivator_penalty, 0.6)
  assert.equal(two.score, 4.4)
  assert.equal(rollupMatch(MATCH({ growth_mobility: 3, optionality_exit: 7, brand_value: 7, role_content: 7 })).score, 6)
  // hygiene dims never take the motivator penalty
  assert.equal(rollupMatch(MATCH({ best_cities: 2 })).motivator_penalty, 0)
})

test('rollupMatch: role_content ≤ 3 caps Match at 6.0; 4 does not', () => {
  const w = rollupMatch(MATCH({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 3 }))
  assert.equal(w.raw, 7.5)
  assert.equal(w.score, 6)
  assert.deepEqual(w.vetoes.map(v => v.kind), ['role_content_veto'])
  assert.equal(w.vetoes[0].applied, true)
  assert.equal(rollupMatch(MATCH({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 4 })).score, 7.75)
})

test('rollupMatch: vetoes record applied=false when Match is already under the cap', () => {
  const w = rollupMatch(MATCH({ growth_mobility: 3, optionality_exit: 3, brand_value: 3, role_content: 3, work_life_balance: 2 }))
  assert.equal(w.score, 1.8)
  assert.equal(w.vetoes.length, 2)
  assert.ok(w.vetoes.every(v => v.applied === false))
})

test('rollupMatch: dream floor lifts to 8.0 only when below it', () => {
  const lifted = rollupMatch(MATCH({ best_cities: 4 }), { dream: true })
  assert.equal(lifted.raw, 6.6)
  assert.equal(lifted.score, 8)
  assert.deepEqual(lifted.floor, { source: 'dream-company Match floor', from: 6.6, to: 8 })
  const high = rollupMatch(MATCH({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9 }), { dream: true })
  assert.equal(high.score, 9)
  assert.equal(high.floor, null)
  assert.equal(rollupMatch(MATCH({ best_cities: 4 })).score, 6.6)   // not a dream company → no floor
})

test('rollupMatch: vetoes win over the dream floor', () => {
  const hyg = rollupMatch(MATCH({ work_life_balance: 2 }), { dream: true })
  assert.equal(hyg.uncapped, 8)       // floored first…
  assert.equal(hyg.score, 5)          // …then vetoed
  assert.equal(hyg.vetoes[0].applied, true)
  const rc = rollupMatch(MATCH({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 3 }), { dream: true })
  assert.equal(rc.score, 6)
})

test('rollupMatch: custom weights merge over defaults; 0 drops a dim; all-zero falls back', () => {
  const dims = MATCH({ growth_mobility: 10, optionality_exit: 4, brand_value: 4, role_content: 4 })
  assert.equal(rollupMatch(dims).score, 5.5)
  assert.equal(rollupMatch(dims, { weights: { growth_mobility: 3 } }).score, 7)   // (30+12)/6
  const zero = rollupMatch(MATCH({ brand_value: 1 }), { weights: { brand_value: 0 } })
  assert.equal(zero.score, 7)
  assert.equal(zero.motivator_penalty, 0)   // a weight-0 motivator isn't penalised
  const allZero = { growth_mobility: 0, optionality_exit: 0, brand_value: 0, role_content: 0 }
  assert.equal(rollupMatch(dims, { weights: allZero }).score, 5.5)
  assert.equal(rollupMatch(dims, { weights: { growth_mobility: -2 } }).score, 5.5)  // invalid → default
})

test('rollupMatch clamps to [1, 10]', () => {
  const top = rollupMatch(MATCH({ growth_mobility: 10, optionality_exit: 10, brand_value: 10, role_content: 10, best_cities: 10, salary_adj_city: 10, work_life_balance: 10 }))
  assert.equal(top.score, 10)
  const bottom = rollupMatch(MATCH({ growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1, best_cities: 1, salary_adj_city: 1, work_life_balance: 1 }))
  assert.equal(bottom.raw, 1)
  assert.equal(bottom.score, 1)
})

// ─── v2: rollupEase ───────────────────────────────────────────────────────────

const EASE = (s, x, c) => ({ skills_match: s, experience_bar: x, competition: c })

test('rollupEase: weighted geometric mean, below the arithmetic mean when uneven', () => {
  assert.equal(rollupEase(EASE(7, 7, 7)).score, 7)
  const e = rollupEase(EASE(8, 6, 5))
  assert.equal(e.geometric, 6.28)
  assert.equal(e.score, 6.28)
  assert.equal(e.wall, false)
  // one weak stage drags more than strong ones lift: arithmetic would be 7.4
  assert.equal(rollupEase(EASE(10, 10, 2)).score, 6.17)
})

test('rollupEase: experience wall caps at 4.5 when experience_bar ≤ 3; 4 does not', () => {
  const wall = rollupEase(EASE(8, 3, 8))
  assert.equal(wall.geometric, 5.68)
  assert.equal(wall.wall, true)
  assert.equal(wall.unwalled, 5.68)
  assert.equal(wall.score, 4.5)
  assert.equal(rollupEase(EASE(8, 4, 8)).wall, false)
  // wall fires but doesn't bind when the mean is already lower
  const low = rollupEase(EASE(2, 3, 2))
  assert.equal(low.wall, true)
  assert.equal(low.score, 2.3)
})

test('rollupEase: amber penalty −0.5 each, capped at −1.0', () => {
  assert.equal(rollupEase(EASE(7, 7, 7), { amber_count: 1 }).score, 6.5)
  assert.equal(rollupEase(EASE(7, 7, 7), { amber_count: 2 }).score, 6)
  const three = rollupEase(EASE(7, 7, 7), { amber_count: 3 })
  assert.equal(three.score, 6)
  assert.equal(three.amber_penalty, 1)
  // wall first, then amber
  assert.equal(rollupEase(EASE(8, 3, 8), { amber_count: 1 }).score, 4)
  // clamp at 1
  assert.equal(rollupEase(EASE(1, 1, 1), { amber_count: 2 }).score, 1)
})

test('rollupEase: custom weights', () => {
  assert.equal(rollupEase(EASE(9, 5, 5), { weights: { skills_match: 1, experience_bar: 0, competition: 0 } }).score, 9)
  assert.equal(rollupEase(EASE(9, 5, 5)).score, 6.14)
})

// ─── v2: verdict grid ─────────────────────────────────────────────────────────

test('assignVerdict: every cell of the grid, with exact boundaries', () => {
  const cases = [
    // [match, ease, verdict, tier]
    [8.0,  7.0,  'go',      'T1'],
    [9.5,  9.0,  'go',      'T1'],
    [8.0,  6.99, 'stretch', 'T2'],
    [8.0,  5.0,  'stretch', 'T2'],
    [8.0,  4.99, 'growth',  'T3'],
    [7.99, 7.0,  'solid',   'T2'],
    [6.5,  7.0,  'solid',   'T2'],
    [6.5,  5.0,  'thin',    'T2'],
    [7.99, 6.99, 'thin',    'T2'],
    [6.5,  4.99, 'skip',    'T4'],
    [6.49, 7.0,  'skip',    'T4'],
    [6.49, 5.0,  'skip',    'T4'],
    [6.49, 4.99, 'skip',    'T4'],
  ]
  for (const [match, ease, verdict, tier] of cases) {
    const r = assignVerdict({ match, ease, eligibility: 'green' })
    assert.equal(r.verdict, verdict, `match ${match} ease ${ease}`)
    assert.equal(r.tier, tier, `match ${match} ease ${ease}`)
  }
})

test('assignVerdict: red eligibility is blocked whatever the numbers', () => {
  const elig = { status: 'red', checks: [{ check: 'language', status: 'red', reason: 'German C1 required' }] }
  const r = assignVerdict({ match: 9, ease: 9, eligibility: elig })
  assert.deepEqual(r, { verdict: 'blocked', tier: 'T4', reason: 'Eligibility red (language): German C1 required' })
  assert.equal(assignVerdict({ match: null, ease: null, eligibility: 'red' }).verdict, 'blocked')
  // amber is scored normally
  assert.equal(assignVerdict({ match: 9, ease: 9, eligibility: { status: 'amber', checks: [] } }).verdict, 'go')
})

test('assignVerdict: reason names both axes', () => {
  assert.equal(assignVerdict({ match: 8.25, ease: 5.6, eligibility: 'amber' }).reason, 'Match 8.25 ≥ 8.0, Ease 5.6 in 5.0–7.0')
  assert.equal(assignVerdict({ match: 6, ease: 4.2, eligibility: 'green' }).reason, 'Match 6 < 6.5, Ease 4.2 < 5.0')
  assert.equal(assignVerdict({ match: 7, ease: 7, eligibility: 'green' }).reason, 'Match 7 in 6.5–8.0, Ease 7 ≥ 7.0')
})

test('verdictRank / promotionHint', () => {
  assert.ok(verdictRank('go') > verdictRank('stretch'))
  assert.ok(verdictRank('solid') > verdictRank('growth'))
  assert.ok(verdictRank('thin') > verdictRank('skip'))
  assert.ok(verdictRank('skip') > verdictRank('blocked'))
  assert.equal(verdictRank('nope'), -1)
  assert.equal(promotionHint('go'), 'READY')
  assert.equal(promotionHint('stretch'), 'MONITOR')
  assert.equal(promotionHint('solid'), 'MONITOR')
  for (const v of ['thin', 'growth', 'skip', 'blocked']) assert.equal(promotionHint(v), '')
})

// ─── v2: Priority ─────────────────────────────────────────────────────────────

test('computePriority is √(Match·Ease) to 2 decimals; null when blocked', () => {
  assert.equal(computePriority(8.25, 5.6), 6.8)
  assert.equal(computePriority(9, 4), 6)
  assert.equal(computePriority({ score: 9 }, { score: 4 }), 6)
  assert.equal(computePriority(null, null), null)
  assert.equal(computePriority(8, null), null)
  assert.equal(computePriority(NaN, 5), null)
})

// ─── grossToNet ───────────────────────────────────────────────────────────────

test('grossToNet applies the effective rate and derives monthly', () => {
  assert.deepEqual(grossToNet(100000, 0.27), { annualNet: 73000, monthlyNet: 6083.33 })
  assert.deepEqual(grossToNet(60000, 0.30), { annualNet: 42000, monthlyNet: 3500 })
})
