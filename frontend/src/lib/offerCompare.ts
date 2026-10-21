// offerCompare.ts — pure multi-offer comparison math for the cockpit.
//
// This is a faithful TypeScript port of `scripts/lib/offer-compare.mjs` (the
// backend `compare-offers` engine) PLUS the savings band from
// `scripts/lib/score-bands.mjs` it depends on. Scoring v2: the `fit` factor
// is the role's MATCH (lib/scoreBands mirrors the §2 formula) — an offer has
// already cleared the Ease funnel, so the open question is how well it
// matches. The v1 CF/AF rollup copies are retired. The lane requires the GUI
// mirror the backend logic in a tested
// `frontend/src/lib/` module rather than shelling out — so the Offer-comparison
// view computes the exact same weighted ranking, tradeoffs, and recommendation
// the CLI would, with no IPC round-trip and no drift.
//
// Everything here is PURE (no I/O, no mutation, no globals). If the backend
// math changes, both files must change together — the parity is asserted in
// offerCompare.test.ts against the documented bands, and the backend keeps its
// own suite (scripts/lib/*.test.mjs). Nothing about a specific candidate,
// company, city, school, or comp target is hardcoded here; weights and factor
// scores flow in from the caller, sourced from the user's data at use time.

import { computeMatch, type MatchDims, type MatchOptions } from './scoreBands'

/* ───── Canonical savings band (ported from score-bands.mjs) ────── */

/**
 * Map monthly cost-of-living-adjusted savings (EUR) to a base 1-10 score on the
 * savings-power band. Monotonic across all 10 tiers — identical to
 * `savingsToBaseScore` in scripts/lib/score-bands.mjs so the comp factor here
 * sits on the exact same scale as the Salary Adj dimension in a scouting report.
 */
export function savingsToBaseScore(monthlySavingsEur: number): number {
  const s = monthlySavingsEur
  if (s >= 2000) return 10
  if (s >= 1500) return 9
  if (s >= 1100) return 8
  if (s >= 800) return 7
  if (s >= 500) return 6
  if (s >= 250) return 5
  if (s >= 50) return 4
  if (s >= -150) return 3
  if (s >= -400) return 2
  return 1
}

/* ───── Factors & default weights ───────────────────────────────── */

export type Factor = 'comp' | 'fit' | 'growth' | 'brand' | 'location' | 'risk'

// The six comparison factors, in canonical display order. Every offer is
// scored 1-10 on each; the weighted sum ranks them.
export const FACTORS: readonly Factor[] = ['comp', 'fit', 'growth', 'brand', 'location', 'risk']

export const FACTOR_LABELS: Record<Factor, string> = {
  comp: 'Compensation',
  fit: 'Fit (Match)',
  growth: 'Growth / Mobility',
  brand: 'Brand Value',
  location: 'Location',
  risk: 'Risk (higher = safer)',
}

// One-line description of what each 1-10 factor score means — surfaced as
// tooltips/help text in the editor so the user scores on the same definition
// the backend mode (modes/ofertas.md) uses.
export const FACTOR_HELP: Record<Factor, string> = {
  comp: 'Cost-of-living-adjusted savings power — what the take-home leaves after a comfortable life in that city.',
  fit: 'How well this role matches you — its scouting Match score. Prefills from the evaluation if the role was scored.',
  growth: 'Does it lead somewhere — promotion velocity, skill compounding, internal mobility.',
  brand: 'Signalling value on your CV for the next move.',
  location: 'How well the location fits your preferences — top-preference city + no visa friction scores high.',
  risk: 'Stability / downside. Higher = safer: a late-stage profitable employer scores high, a runway-constrained startup low.',
}

export type FactorScores = Record<Factor, number>

// Neutral default weights — equal across all six factors. A FALLBACK, not a
// recommendation: a real comparison passes a weight object sourced from the
// candidate's priorities. Weights are relative — normalized to sum to 1 before
// use, so callers can pass raw 1-5 importance ratings.
export const DEFAULT_WEIGHTS: FactorScores = Object.freeze({
  comp: 1,
  fit: 1,
  growth: 1,
  brand: 1,
  location: 1,
  risk: 1,
})

/* ───── Per-factor derivation from project primitives ───────────── */

/**
 * Derive the `comp` factor (1-10) from cost-of-living-adjusted monthly savings,
 * reusing the canonical savings-power band. `savings = net − baseline`.
 */
export function compFactorFromSavings(
  monthlyNetEur: number,
  colBaselineEur: number,
): { score: number; monthlySavings: number } {
  if (!Number.isFinite(monthlyNetEur) || !Number.isFinite(colBaselineEur)) {
    throw new TypeError('compFactorFromSavings needs finite monthlyNetEur and colBaselineEur')
  }
  const monthlySavings = monthlyNetEur - colBaselineEur
  return { score: savingsToBaseScore(monthlySavings), monthlySavings }
}

/**
 * Derive the `fit` factor (1-10) from a scouting evaluation. v2: fit = Match
 * (spec §2) — no re-derivation when the evaluation already carries it; when
 * only the dimensions are known, the Match formula is replayed at the default
 * weights. Ease is deliberately not part of fit: an offer in hand has already
 * cleared the hiring funnel Ease measures.
 */
export function fitFactorFromScores(
  scores: { match?: number | null; dims?: MatchDims | null },
  context: MatchOptions = {},
): { score: number; source: 'match' | 'replay' | 'neutral' } {
  if (scores.match != null && Number.isFinite(scores.match)) return { score: clampFit(scores.match), source: 'match' }
  if (scores.dims) return { score: clampFit(computeMatch(scores.dims, context).score), source: 'replay' }
  return { score: 5, source: 'neutral' }
}

function clampFit(n: number): number {
  return Math.min(10, Math.max(1, Math.round(n * 100) / 100))
}

/* ───── Weight normalization ────────────────────────────────────── */

/**
 * Normalize a raw weight object to non-negative weights summing to 1, keyed by
 * FACTORS (missing factors default to the neutral weight, negatives clamp to 0).
 * Returns uniform if the total is non-positive, so a degenerate input can never
 * produce NaN scores downstream.
 */
export function normalizeWeights(raw: Partial<FactorScores> = {}): FactorScores {
  const cleaned = {} as FactorScores
  for (const f of FACTORS) {
    const v = Number(raw[f])
    cleaned[f] = Number.isFinite(v) && v > 0 ? v : raw[f] === undefined ? 1 : 0
  }
  const total = FACTORS.reduce((a, f) => a + cleaned[f], 0)
  if (total <= 0) {
    const eq = 1 / FACTORS.length
    return Object.fromEntries(FACTORS.map((f) => [f, eq])) as FactorScores
  }
  return Object.fromEntries(FACTORS.map((f) => [f, cleaned[f] / total])) as FactorScores
}

/* ───── Single-offer weighted score ─────────────────────────────── */

export interface Offer {
  label: string
  scores: FactorScores
}

export interface ScoredOffer {
  label: string
  total: number
  scores: FactorScores
  contributions: FactorScores
}

function validateScores(scores: FactorScores | undefined, label: string): void {
  for (const f of FACTORS) {
    const v = scores?.[f]
    if (!Number.isFinite(v) || (v as number) < 1 || (v as number) > 10) {
      throw new RangeError(`offer "${label}" factor "${f}" must be a number in [1,10], got ${v}`)
    }
  }
}

/**
 * Weighted total for one offer's factor scores. Returns the total plus per-factor
 * contributions (score × weight) so a caller can show exactly how each factor
 * pushed the total.
 */
export function scoreOffer(offer: Offer, normalizedWeights: FactorScores): ScoredOffer {
  validateScores(offer.scores, offer.label)
  const contributions = {} as FactorScores
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

export interface TradeoffEntry {
  factor: Factor
  label: string
  winnerScore: number
  runnerUpScore: number
  gap: number
}

export interface DecisiveFactor {
  factor: Factor
  label: string
  weightedSwing: number
}

export interface Tradeoffs {
  winnerWins: TradeoffEntry[]
  runnerUpWins: TradeoffEntry[]
  decisiveFactor: DecisiveFactor | null
}

/**
 * For the top-ranked offer vs the runner-up, list the factors where each one
 * wins by a material margin — the explicit tradeoffs the recommendation rests on.
 * `decisiveFactor` is the single weighted-contribution gap that most explains the
 * ranking (what the winner won ON), or null if the offers tie on contributions.
 */
export function tradeoffs(
  winner: ScoredOffer,
  runnerUp: ScoredOffer,
  normalizedWeights: FactorScores,
): Tradeoffs {
  const winnerWins: TradeoffEntry[] = []
  const runnerUpWins: TradeoffEntry[] = []
  let decisiveFactor: DecisiveFactor | null = null
  let maxWeightedGap = 0

  for (const f of FACTORS) {
    const w = winner.scores[f]
    const r = runnerUp.scores[f]
    const gap = Math.abs(w - r)
    if (gap >= MATERIAL_FACTOR_GAP) {
      const entry: TradeoffEntry = {
        factor: f,
        label: FACTOR_LABELS[f],
        winnerScore: w,
        runnerUpScore: r,
        gap,
      }
      ;(w > r ? winnerWins : runnerUpWins).push(entry)
    }
    const weightedSwing = (w - r) * normalizedWeights[f]
    if (weightedSwing > maxWeightedGap) {
      maxWeightedGap = weightedSwing
      decisiveFactor = { factor: f, label: FACTOR_LABELS[f], weightedSwing: Number(weightedSwing.toFixed(3)) }
    }
  }
  winnerWins.sort((a, b) => b.gap - a.gap)
  runnerUpWins.sort((a, b) => b.gap - a.gap)
  return { winnerWins, runnerUpWins, decisiveFactor }
}

/* ───── Top-level comparison ────────────────────────────────────── */

// Below this weighted-total gap between #1 and #2, the call is "close" — the
// recommendation should flag that secondary considerations (the candidate's gut,
// a deadline, a referral) could legitimately flip it.
export const CLOSE_CALL_THRESHOLD = 0.5

export interface RankedOffer extends ScoredOffer {
  rank: number
}

export interface ComparisonResult {
  ranking: RankedOffer[]
  weights: FactorScores
  winner: RankedOffer
  runnerUp: RankedOffer
  margin: number
  isCloseCall: boolean
  tradeoffs: Tradeoffs
  recommendation: string
}

/**
 * Compare 2+ offers and produce a ranking + recommendation with the tradeoffs
 * made explicit. Mirrors `compareOffers` in scripts/lib/offer-compare.mjs.
 */
export function compareOffers(offers: Offer[], weights: Partial<FactorScores> = DEFAULT_WEIGHTS): ComparisonResult {
  if (!Array.isArray(offers) || offers.length < 2) {
    throw new RangeError('compareOffers needs at least 2 offers')
  }
  const labels = offers.map((o) => o.label)
  if (new Set(labels).size !== labels.length) {
    throw new RangeError('offer labels must be unique')
  }

  const normalizedWeights = normalizeWeights(weights)
  const scored = offers.map((o) => scoreOffer(o, normalizedWeights))

  // Rank by total; deterministic tie-break by label so output is stable.
  scored.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
  const ranking: RankedOffer[] = scored.map((s, i) => ({ ...s, rank: i + 1 }))

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
 * and separate so the same numbers can drive the UI summary or a CLI line.
 * Mirrors `buildRecommendation` in scripts/lib/offer-compare.mjs.
 */
export function buildRecommendation({
  winner,
  runnerUp,
  margin,
  isCloseCall,
  trade,
}: {
  winner: { label: string; total: number }
  runnerUp: { label: string; total: number }
  margin: number
  isCloseCall: boolean
  trade: Tradeoffs
}): string {
  const wonOn = trade.decisiveFactor ? `, won mainly on ${trade.decisiveFactor.label}` : ''
  const concedes = trade.runnerUpWins.length
    ? ` The tradeoff: ${runnerUp.label} is stronger on ${trade.runnerUpWins.map((t) => t.label).join(', ')}.`
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
