// offer-compare.mjs — pure multi-offer comparison math.
//
// This is the decision engine at the END of the funnel: the candidate has
// 2+ live offers and needs a structured, weighted comparison to decide.
//
// It is PURE (no I/O, no mutation, no globals) and deliberately reuses the
// project's canonical scoring math rather than reinventing it:
//
//   - comp        → savingsToBaseScore() on cost-of-living-adjusted monthly
//                   savings (the same savings-power band the scouting report
//                   uses), with the same buildTotalComp() build-up upstream.
//   - fit         → rollupOverall(CF, AF) on the 6 scouting dimensions, i.e.
//                   the exact Overall the scouting evaluation produced.
//
// growth / brand / location / risk are 1-10 factor scores the caller supplies
// (the agent derives them from the scouting report + deep-dive, the same way it
// scores the rollup dims). Nothing about a specific candidate, company, city,
// school, or comp target is hardcoded here — weights and targets flow in as
// arguments, sourced from user/* at call time. See modes/ofertas.md.
//
// Plain ESM, zero deps. Tested in offer-compare.test.mjs.

import {
  savingsToBaseScore,
  rollupCurrentFit,
  rollupAspirationalFit,
  rollupOverall,
} from './score-bands.mjs'

/* ───── Factors & default weights ───────────────────────────────── */

// The six comparison factors, in canonical display order. Every offer is
// scored 1-10 on each; the weighted sum ranks them.
export const FACTORS = ['comp', 'fit', 'growth', 'brand', 'location', 'risk']

export const FACTOR_LABELS = {
  comp:     'Compensation (savings-power adj.)',
  fit:      'Fit (scouting Overall)',
  growth:   'Growth / Mobility',
  brand:    'Brand Value',
  location: 'Location',
  risk:     'Risk (higher = safer)',
}

// Neutral default weights — equal across all six factors. This is a FALLBACK,
// not a recommendation: a real comparison passes a weight object sourced from
// the candidate's priorities in user/* (e.g. comp-heavy for someone optimizing
// savings, brand/growth-heavy for someone optimizing the next move). Weights
// are relative — they're normalized to sum to 1 before use, so callers can pass
// raw 1-5 importance ratings and not worry about them adding up.
export const DEFAULT_WEIGHTS = Object.freeze({
  comp: 1, fit: 1, growth: 1, brand: 1, location: 1, risk: 1,
})

/* ───── Per-factor derivation from project primitives ───────────── */

/**
 * Derive the `comp` factor (1-10) from cost-of-living-adjusted monthly savings,
 * reusing the canonical savings-power band so an offer's comp factor here is on
 * the exact same scale as the Salary Adj dimension in its scouting report.
 *
 *   monthlyNetEur   take-home per month after tax (grossToNet upstream)
 *   colBaselineEur  monthly comfortable-life baseline for the offer's city
 *                   (from data/col-cache.tsv via col-cache.mjs)
 *
 * savings = net − baseline, then mapped through savingsToBaseScore.
 */
export function compFactorFromSavings(monthlyNetEur, colBaselineEur) {
  if (!Number.isFinite(monthlyNetEur) || !Number.isFinite(colBaselineEur)) {
    throw new TypeError('compFactorFromSavings needs finite monthlyNetEur and colBaselineEur')
  }
  const monthlySavings = monthlyNetEur - colBaselineEur
  return { score: savingsToBaseScore(monthlySavings), monthlySavings }
}

/**
 * Derive the `fit` factor (1-10) from the six scouting dimensions, by replaying
 * the canonical CF/AF rollup → Overall. The Overall an offer carried out of the
 * scouting evaluation IS its fit factor — no re-derivation, no drift.
 *
 *   sixDims  { skills_match, ease_of_entry, strategic_fit,
 *              growth_mobility, optionality_exit, brand_value }
 *   context  { salary_adj_for_city, work_life_balance, is_intern } (optional)
 */
export function fitFactorFromDims(sixDims, context = {}) {
  const cf = rollupCurrentFit(sixDims)
  const af = rollupAspirationalFit(sixDims)
  const { overall, modifiersApplied } = rollupOverall(cf, af, {
    salary_adj_for_city: context.salary_adj_for_city ?? 6,
    work_life_balance:   context.work_life_balance ?? 6,
    is_intern:           context.is_intern === true,
  })
  return { score: overall, cf, af, modifiersApplied }
}

/* ───── Weight normalization ────────────────────────────────────── */

/**
 * Normalize a raw weight object to non-negative weights summing to 1, keyed by
 * FACTORS (missing factors default to the neutral weight, negatives clamp to 0).
 * Returns DEFAULT (uniform) if the total is non-positive, so a degenerate input
 * can never produce NaN scores downstream.
 */
export function normalizeWeights(raw = {}) {
  const cleaned = {}
  for (const f of FACTORS) {
    const v = Number(raw[f])
    cleaned[f] = Number.isFinite(v) && v > 0 ? v : (raw[f] === undefined ? 1 : 0)
  }
  const total = FACTORS.reduce((a, f) => a + cleaned[f], 0)
  if (total <= 0) {
    const eq = 1 / FACTORS.length
    return Object.fromEntries(FACTORS.map(f => [f, eq]))
  }
  return Object.fromEntries(FACTORS.map(f => [f, cleaned[f] / total]))
}

/* ───── Single-offer weighted score ─────────────────────────────── */

function validateScores(scores, label) {
  for (const f of FACTORS) {
    const v = scores?.[f]
    if (!Number.isFinite(v) || v < 1 || v > 10) {
      throw new RangeError(`offer "${label}" factor "${f}" must be a number in [1,10], got ${v}`)
    }
  }
}

/**
 * Weighted total for one offer's factor scores.
 *
 *   offer.label    human-readable identifier (e.g. "Stripe — Analyst")
 *   offer.scores   { comp, fit, growth, brand, location, risk } each in [1,10]
 *
 * Returns { label, total, contributions } where contributions[f] = score*weight,
 * so a caller can show exactly how each factor pushed the total.
 */
export function scoreOffer(offer, normalizedWeights) {
  validateScores(offer.scores, offer.label)
  const contributions = {}
  let total = 0
  for (const f of FACTORS) {
    const c = offer.scores[f] * normalizedWeights[f]
    contributions[f] = Number(c.toFixed(4))
    total += c
  }
  return {
    label: offer.label,
    total: Number(total.toFixed(2)),
    scores: { ...offer.scores },
    contributions,
  }
}

/* ───── Tradeoff analysis ───────────────────────────────────────── */

// A per-factor gap this size or larger between two offers is "decisive enough"
// to call out as a real tradeoff rather than noise. Two points on a 1-10 factor
// scale is a full band of difference.
const MATERIAL_FACTOR_GAP = 2

/**
 * For the top-ranked offer vs the runner-up, list the factors where each one
 * wins by a material margin — the explicit tradeoffs the recommendation rests on.
 *
 * @returns { winnerWins: [...], runnerUpWins: [...], decisiveFactor }
 *   each entry: { factor, label, winnerScore, runnerUpScore, gap }
 *   decisiveFactor — the single weighted-contribution gap that most explains the
 *   ranking (what the winner won ON), or null if the offers tie on contributions.
 */
export function tradeoffs(winner, runnerUp, normalizedWeights) {
  const winnerWins = []
  const runnerUpWins = []
  let decisiveFactor = null
  let maxWeightedGap = 0

  for (const f of FACTORS) {
    const w = winner.scores[f]
    const r = runnerUp.scores[f]
    const gap = Math.abs(w - r)
    if (gap >= MATERIAL_FACTOR_GAP) {
      const entry = {
        factor: f, label: FACTOR_LABELS[f],
        winnerScore: w, runnerUpScore: r, gap,
      }
      ;(w > r ? winnerWins : runnerUpWins).push(entry)
    }
    // Decisive factor = the largest *weighted* swing in the winner's favor.
    const weightedSwing = (w - r) * normalizedWeights[f]
    if (weightedSwing > maxWeightedGap) {
      maxWeightedGap = weightedSwing
      decisiveFactor = { factor: f, label: FACTOR_LABELS[f], weightedSwing: Number(weightedSwing.toFixed(3)) }
    }
  }
  // Sort each side by raw gap, biggest first.
  winnerWins.sort((a, b) => b.gap - a.gap)
  runnerUpWins.sort((a, b) => b.gap - a.gap)
  return { winnerWins, runnerUpWins, decisiveFactor }
}

/* ───── Top-level comparison ────────────────────────────────────── */

// Below this weighted-total gap between #1 and #2, the call is "close" — the
// recommendation should flag that secondary considerations (the candidate's gut,
// a deadline, a referral) could legitimately flip it.
const CLOSE_CALL_THRESHOLD = 0.5

/**
 * Compare 2+ offers and produce a ranking + recommendation with the tradeoffs
 * made explicit.
 *
 *   offers   Array<{ label, scores: {comp,fit,growth,brand,location,risk} }>
 *   weights  raw weight object (normalized internally); omit for uniform.
 *
 * @returns {
 *   ranking: [{ label, total, scores, contributions, rank }],   // best first
 *   weights: normalized weights used,
 *   winner, runnerUp,                                            // convenience refs
 *   margin,                                                      // #1.total − #2.total
 *   isCloseCall: boolean,
 *   tradeoffs: { winnerWins, runnerUpWins, decisiveFactor },
 *   recommendation: string                                       // plain-language verdict
 * }
 */
export function compareOffers(offers, weights = DEFAULT_WEIGHTS) {
  if (!Array.isArray(offers) || offers.length < 2) {
    throw new RangeError('compareOffers needs at least 2 offers')
  }
  const labels = offers.map(o => o.label)
  if (new Set(labels).size !== labels.length) {
    throw new RangeError('offer labels must be unique')
  }

  const normalizedWeights = normalizeWeights(weights)
  const scored = offers.map(o => scoreOffer(o, normalizedWeights))

  // Rank by total; deterministic tie-break by label so output is stable.
  scored.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
  const ranking = scored.map((s, i) => ({ ...s, rank: i + 1 }))

  const winner = ranking[0]
  const runnerUp = ranking[1]
  const margin = Number((winner.total - runnerUp.total).toFixed(2))
  const isCloseCall = margin < CLOSE_CALL_THRESHOLD
  const trade = tradeoffs(winner, runnerUp, normalizedWeights)

  return {
    ranking,
    weights: normalizedWeights,
    winner,
    runnerUp,
    margin,
    isCloseCall,
    tradeoffs: trade,
    recommendation: buildRecommendation({ winner, runnerUp, margin, isCloseCall, trade }),
  }
}

/**
 * Compose a plain-language recommendation from the structured result. Kept pure
 * and separate so the same numbers can drive a report line or a CLI summary.
 */
export function buildRecommendation({ winner, runnerUp, margin, isCloseCall, trade }) {
  const wonOn = trade.decisiveFactor
    ? `, won mainly on ${trade.decisiveFactor.label}`
    : ''
  const concedes = trade.runnerUpWins.length
    ? ` The tradeoff: ${runnerUp.label} is stronger on ${trade.runnerUpWins.map(t => t.label).join(', ')}.`
    : ` It doesn't materially concede any factor to ${runnerUp.label}.`

  if (isCloseCall) {
    return (
      `Close call: ${winner.label} (${winner.total}) edges ${runnerUp.label} ` +
      `(${runnerUp.total}) by just ${margin}${wonOn}.${concedes} ` +
      `Because the margin is within ${CLOSE_CALL_THRESHOLD}, treat this as a near-tie — ` +
      `a deadline, a referral, or your own gut on the tradeoff above can legitimately flip it.`
    )
  }
  return (
    `${winner.label} (${winner.total}) is the clear pick over ${runnerUp.label} ` +
    `(${runnerUp.total}), a ${margin} margin${wonOn}.${concedes}`
  )
}
