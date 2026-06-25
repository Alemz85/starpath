// Unit tests for scripts/lib/offer-compare.mjs — the end-of-funnel multi-offer
// comparison engine. Covers: per-factor derivation reusing the canonical scoring
// math, weight normalization edge cases, single-offer weighted scoring + input
// validation, ranking determinism, tradeoff/decisive-factor analysis, and the
// close-call vs clear-pick recommendation branches.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FACTORS,
  DEFAULT_WEIGHTS,
  compFactorFromSavings,
  fitFactorFromDims,
  normalizeWeights,
  scoreOffer,
  tradeoffs,
  compareOffers,
  buildRecommendation,
} from './offer-compare.mjs'
import { savingsToBaseScore, rollupOverall, rollupCurrentFit, rollupAspirationalFit } from './score-bands.mjs'

// Convenience: a full, valid factor-score set we can tweak per test.
const baseScores = () => ({ comp: 5, fit: 5, growth: 5, brand: 5, location: 5, risk: 5 })

// ─── compFactorFromSavings: reuses the canonical savings band ────────────────

test('compFactorFromSavings maps net−baseline through savingsToBaseScore', () => {
  // net 3000, baseline 1500 → savings 1500 → band score 9
  const r = compFactorFromSavings(3000, 1500)
  assert.equal(r.monthlySavings, 1500)
  assert.equal(r.score, 9)
  assert.equal(r.score, savingsToBaseScore(1500)) // never drifts from the engine
})

test('compFactorFromSavings handles negative savings (rent eats the salary)', () => {
  const r = compFactorFromSavings(1200, 1500) // −300 → band 2
  assert.equal(r.monthlySavings, -300)
  assert.equal(r.score, savingsToBaseScore(-300))
})

test('compFactorFromSavings rejects non-finite inputs', () => {
  assert.throws(() => compFactorFromSavings(NaN, 1500), TypeError)
  assert.throws(() => compFactorFromSavings(3000, undefined), TypeError)
})

// ─── fitFactorFromDims: replays the canonical CF/AF rollup → Overall ─────────

test('fitFactorFromDims equals the canonical Overall, never re-derived', () => {
  const sixDims = {
    skills_match: 8, ease_of_entry: 7, strategic_fit: 8,
    growth_mobility: 7, optionality_exit: 8, brand_value: 9,
  }
  const cf = rollupCurrentFit(sixDims)
  const af = rollupAspirationalFit(sixDims)
  const { overall } = rollupOverall(cf, af, { salary_adj_for_city: 6, work_life_balance: 6, is_intern: false })

  const r = fitFactorFromDims(sixDims)
  assert.equal(r.cf, cf)
  assert.equal(r.af, af)
  assert.equal(r.score, overall)
})

test('fitFactorFromDims threads context modifiers (low salary adj drags Overall)', () => {
  const sixDims = {
    skills_match: 8, ease_of_entry: 7, strategic_fit: 8,
    growth_mobility: 7, optionality_exit: 8, brand_value: 9,
  }
  const neutral = fitFactorFromDims(sixDims, { salary_adj_for_city: 6 })
  const lowComp = fitFactorFromDims(sixDims, { salary_adj_for_city: 3 }) // ≤4 → −0.4
  assert.ok(lowComp.score < neutral.score)
  assert.ok(lowComp.modifiersApplied.some(m => m.value === -0.4))
})

// ─── normalizeWeights ────────────────────────────────────────────────────────

test('normalizeWeights turns equal raw weights into a uniform simplex', () => {
  const w = normalizeWeights(DEFAULT_WEIGHTS)
  for (const f of FACTORS) assert.ok(Math.abs(w[f] - 1 / FACTORS.length) < 1e-9)
  assert.ok(Math.abs(FACTORS.reduce((a, f) => a + w[f], 0) - 1) < 1e-9)
})

test('normalizeWeights normalizes arbitrary raw importance ratings to sum 1', () => {
  const w = normalizeWeights({ comp: 5, fit: 5, growth: 0, brand: 0, location: 0, risk: 0 })
  assert.ok(Math.abs(w.comp - 0.5) < 1e-9)
  assert.ok(Math.abs(w.fit - 0.5) < 1e-9)
  assert.equal(w.growth, 0)
  assert.ok(Math.abs(FACTORS.reduce((a, f) => a + w[f], 0) - 1) < 1e-9)
})

test('normalizeWeights defaults missing factors to neutral, clamps negatives to 0', () => {
  const w = normalizeWeights({ comp: 3, fit: -2 }) // fit→0; others missing→1
  assert.equal(w.fit, 0)
  // comp=3, growth/brand/location/risk=1 each (4), total=7
  assert.ok(Math.abs(w.comp - 3 / 7) < 1e-9)
  assert.ok(Math.abs(w.growth - 1 / 7) < 1e-9)
})

test('normalizeWeights falls back to uniform when total is non-positive', () => {
  const w = normalizeWeights({ comp: 0, fit: 0, growth: 0, brand: 0, location: 0, risk: 0 })
  for (const f of FACTORS) assert.ok(Math.abs(w[f] - 1 / FACTORS.length) < 1e-9)
})

// ─── scoreOffer + validation ─────────────────────────────────────────────────

test('scoreOffer weighted total of an all-5 offer under uniform weights is 5', () => {
  const w = normalizeWeights(DEFAULT_WEIGHTS)
  const r = scoreOffer({ label: 'X', scores: baseScores() }, w)
  assert.equal(r.total, 5)
  // contributions are each rounded to 4 decimals, so they sum to total within
  // accumulated rounding tolerance (not exactly — that's expected).
  const sum = FACTORS.reduce((a, f) => a + r.contributions[f], 0)
  assert.ok(Math.abs(sum - 5) < 1e-3)
})

test('scoreOffer respects weights — a comp-heavy weight rewards a comp-strong offer', () => {
  const w = normalizeWeights({ comp: 5, fit: 1, growth: 1, brand: 1, location: 1, risk: 1 })
  const strongComp = scoreOffer({ label: 'A', scores: { ...baseScores(), comp: 10 } }, w)
  const strongBrand = scoreOffer({ label: 'B', scores: { ...baseScores(), brand: 10 } }, w)
  assert.ok(strongComp.total > strongBrand.total)
})

test('scoreOffer rejects out-of-range and missing factor scores', () => {
  const w = normalizeWeights(DEFAULT_WEIGHTS)
  assert.throws(() => scoreOffer({ label: 'bad', scores: { ...baseScores(), comp: 0 } }, w), RangeError)
  assert.throws(() => scoreOffer({ label: 'bad', scores: { ...baseScores(), fit: 11 } }, w), RangeError)
  const { comp, ...missing } = baseScores()
  assert.throws(() => scoreOffer({ label: 'bad', scores: missing }, w), RangeError)
})

// ─── tradeoffs ───────────────────────────────────────────────────────────────

test('tradeoffs surfaces material per-factor wins on each side + decisive factor', () => {
  const w = normalizeWeights(DEFAULT_WEIGHTS)
  const winner = scoreOffer({ label: 'W', scores: { ...baseScores(), comp: 9, brand: 9, growth: 4 } }, w)
  const runnerUp = scoreOffer({ label: 'R', scores: { ...baseScores(), comp: 5, brand: 5, growth: 8 } }, w)
  const t = tradeoffs(winner, runnerUp, w)
  const winFactors = t.winnerWins.map(x => x.factor)
  const loseFactors = t.runnerUpWins.map(x => x.factor)
  assert.ok(winFactors.includes('comp') && winFactors.includes('brand'))
  assert.ok(loseFactors.includes('growth'))
  assert.ok(t.decisiveFactor !== null)
  // winnerWins sorted by gap desc
  assert.ok(t.winnerWins[0].gap >= t.winnerWins[t.winnerWins.length - 1].gap)
})

test('tradeoffs ignores sub-material (<2pt) gaps', () => {
  const w = normalizeWeights(DEFAULT_WEIGHTS)
  const a = scoreOffer({ label: 'A', scores: { ...baseScores(), comp: 6 } }, w) // 1pt edge
  const b = scoreOffer({ label: 'B', scores: baseScores() }, w)
  const t = tradeoffs(a, b, w)
  assert.equal(t.winnerWins.length, 0)
  assert.equal(t.runnerUpWins.length, 0)
})

// ─── compareOffers: ranking, margin, recommendation ──────────────────────────

test('compareOffers ranks best-first and computes the margin', () => {
  const res = compareOffers([
    { label: 'Low',  scores: { ...baseScores(), comp: 3, fit: 4 } },
    { label: 'High', scores: { ...baseScores(), comp: 9, fit: 8 } },
  ])
  assert.equal(res.ranking[0].label, 'High')
  assert.equal(res.ranking[0].rank, 1)
  assert.equal(res.winner.label, 'High')
  assert.equal(res.runnerUp.label, 'Low')
  assert.ok(res.margin > 0)
  assert.equal(res.margin, Number((res.winner.total - res.runnerUp.total).toFixed(2)))
})

test('compareOffers flags a clear pick and names the tradeoff conceded', () => {
  const res = compareOffers([
    { label: 'BrandCo', scores: { ...baseScores(), brand: 10, comp: 9, growth: 4 } },
    { label: 'GrowthCo', scores: { ...baseScores(), brand: 5, comp: 5, growth: 9 } },
  ])
  assert.equal(res.isCloseCall, false)
  assert.equal(res.winner.label, 'BrandCo')
  // It concedes Growth to the runner-up — recommendation should say so.
  assert.match(res.recommendation, /GrowthCo is stronger on/)
  assert.match(res.recommendation, /Growth/)
})

test('compareOffers flags a close call when the margin is within threshold', () => {
  const res = compareOffers([
    { label: 'A', scores: { ...baseScores(), comp: 7 } },
    { label: 'B', scores: { ...baseScores(), brand: 7 } },
  ])
  assert.ok(res.margin < 0.5)
  assert.equal(res.isCloseCall, true)
  assert.match(res.recommendation, /Close call/)
  assert.match(res.recommendation, /near-tie/)
})

test('compareOffers tie-breaks deterministically by label', () => {
  const identical = { ...baseScores() }
  const res = compareOffers([
    { label: 'Bravo', scores: { ...identical } },
    { label: 'Alpha', scores: { ...identical } },
  ])
  assert.equal(res.margin, 0)
  assert.equal(res.ranking[0].label, 'Alpha') // localeCompare tie-break
  // Re-running yields the same order — no Array.sort instability leaking through.
  const res2 = compareOffers([
    { label: 'Alpha', scores: { ...identical } },
    { label: 'Bravo', scores: { ...identical } },
  ])
  assert.equal(res2.ranking[0].label, 'Alpha')
})

test('compareOffers handles 3+ offers, full ranking', () => {
  const res = compareOffers([
    { label: 'Mid',  scores: { ...baseScores(), comp: 6 } },
    { label: 'Top',  scores: { ...baseScores(), comp: 10, fit: 9 } },
    { label: 'Bot',  scores: { ...baseScores(), comp: 2, fit: 3 } },
  ])
  assert.deepEqual(res.ranking.map(r => r.label), ['Top', 'Mid', 'Bot'])
  assert.deepEqual(res.ranking.map(r => r.rank), [1, 2, 3])
})

test('compareOffers rejects <2 offers and duplicate labels', () => {
  assert.throws(() => compareOffers([{ label: 'solo', scores: baseScores() }]), RangeError)
  assert.throws(() => compareOffers([
    { label: 'dup', scores: baseScores() },
    { label: 'dup', scores: baseScores() },
  ]), RangeError)
})

// ─── buildRecommendation: pure, drives both report + CLI ─────────────────────

test('buildRecommendation says "no materially concede" when winner dominates', () => {
  const winner = { label: 'W', total: 8, scores: { comp: 9, fit: 9, growth: 9, brand: 9, location: 9, risk: 9 } }
  const runnerUp = { label: 'R', total: 5, scores: baseScores() }
  const trade = { winnerWins: [], runnerUpWins: [], decisiveFactor: null }
  const rec = buildRecommendation({ winner, runnerUp, margin: 3, isCloseCall: false, trade })
  assert.match(rec, /doesn't materially concede any factor/)
})
