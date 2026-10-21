// scoring-stats.mjs — the single source of truth for the statistical-honesty
// numbers used by every analytic derived from data/score-history.tsv.
//
// CONTRACT: docs/scoring-statistical-design.md
//
// That document and this module must state the SAME numbers. If you change a
// constant here without changing the doc (or vice-versa) that is a defect —
// scoring-stats.test.mjs pins the values so the drift is caught.
//
// Scoring model: v2 (docs/scoring-v2.md §9): Match and Ease each have their own
// floor; Priority has one too, for the surfaces that sort on it.
//
// Why this file exists: a score is an LLM judgment on a coarse ordinal rubric.
// Peer rank, score trend, and calibration advice all read that log and can
// easily overclaim — a 0.1 wobble rendered as a trend arrow, a percentile
// computed from five peers, a "your rubric is broken" advisory built on three
// applications. The constants below are the resolution limit and the sample
// gates that keep those surfaces honest. All functions are pure.

/* ───── 1. Rubric geometry (docs § 1) ─────────────────────────────────────── */
//
// Scoring v2 (docs/scoring-v2.md) has no Overall. A listing carries two
// independent numbers, Match and Ease, plus Priority = √(Match·Ease) as a sort
// key. Each gets its own noise floor, derived from the smallest move one
// integer re-judgment of one dimension produces in that rollup.

/** Match: one motivator moving one integer step at the default equal weights
 *  (4 motivators) moves the motivator mean, and so Match, by 1/4. */
export const MATCH_DIM_STEP = 0.25

/** Ease: one step on a 0.35-weight stage of the weighted geometric mean, near
 *  the middle of the scale (stage ≈ 6, Ease ≈ 6): 6 × ((7/6)^0.35 − 1) ≈ 0.33,
 *  6 × (1 − (5/6)^0.35) ≈ 0.37; the spec rounds the typical move to ≈ 0.32. */
export const EASE_DIM_STEP = 0.32

/**
 * MATCH_NOISE_FLOOR — the minimum detectable Match difference (spec §9).
 * One motivator re-judged one step moves Match by 0.25; the floor is that,
 * rounded up, so no single motivator wobble can clear it.
 */
export const MATCH_NOISE_FLOOR = 0.30

/**
 * EASE_NOISE_FLOOR — the minimum detectable Ease difference (spec §9).
 * One step on a 0.35-weight stage near 6 moves Ease by ≈ 0.32; 0.35 is the
 * round value above it.
 */
export const EASE_NOISE_FLOOR = 0.35

/**
 * PRIORITY_NOISE_FLOOR — Priority = √(Match·Ease). A one-step Match wobble moves
 * it by ≈ ½·√(E/W)·0.25 ≈ 0.13, a one-step Ease wobble by ≈ 0.16; 0.30 is
 * conservatively above both and below most two-dimension moves.
 */
export const PRIORITY_NOISE_FLOOR = 0.30

/** Floor per metric, for surfaces that classify Match, Ease and Priority. */
export const NOISE_FLOORS = Object.freeze({
  match: MATCH_NOISE_FLOOR,
  ease: EASE_NOISE_FLOOR,
  priority: PRIORITY_NOISE_FLOOR,
})

/** @returns {number} the noise floor for 'match' | 'ease' | 'priority' (Priority's floor for anything else). */
export function noiseFloorFor(metric) {
  return NOISE_FLOORS[metric] ?? PRIORITY_NOISE_FLOOR
}

/* ───── 2. Dimension classes (docs § 2) ───────────────────────────────────── */

/** Dimensions that resolve against a table, a document, or a stated fact —
 *  they reproduce exactly given the same inputs, so a change across
 *  re-evaluations means an INPUT changed and may be reported as such. */
export const MECHANICAL_DIMS = Object.freeze([
  'brand_value',      // brand-tier table + user calibration lists
  'salary_adj_city',  // computed by score-listing.mjs from comp inputs
  'best_cities',      // lookup against the user's preferred-cities list
])

/** An agent's reading of prose against a CV. Ordinal/comparative claims only —
 *  NEVER read as precise to a decimal across re-evaluations. Experience bar
 *  and Competition are listed here because their discretionary share (how far
 *  the candidate "partly meets" a bar; how much signalling the pool has)
 *  dominates their anchor-table share; their table adjustments are still
 *  mechanical facts. */
export const JUDGMENT_DIMS = Object.freeze([
  'skills_match',
  'experience_bar',
  'competition',
  'growth_mobility',
  'optionality_exit',
  'role_content',
  'work_life_balance',
])

/** @returns {'mechanical'|'judgment'|'unknown'} */
export function dimensionClass(key) {
  if (MECHANICAL_DIMS.includes(key)) return 'mechanical'
  if (JUDGMENT_DIMS.includes(key)) return 'judgment'
  return 'unknown'
}

/* ───── 3. Sample gates (docs § 3) ────────────────────────────────────────── */

/**
 * Every gate in the system, in one object. Each is derived in the doc; the
 * one-line reason is repeated here so a reader of the code sees why.
 */
export const GATES = Object.freeze({
  /** peer-rank: below 5 same-archetype peers the block is OMITTED entirely
   *  (returns null) — never a placeholder. Pre-existing rule, unchanged. */
  peerMinPeers: 5,

  /** score-trend per-listing: a trajectory needs 2+ evals on distinct dates.
   *  Two points is `low` confidence by construction — one difference cannot
   *  separate a trend from a single noisy evaluation. */
  trendMinEvals: 2,

  /** score-trend corpus verdict: ≥10 scored evals in EACH calendar window.
   *  No single evaluation may move a window mean by more than its noise floor:
   *  a single extreme role deviates by up to ≈3.0 Match (3.0/k ≤ 0.30) or
   *  ≈3.5 Ease (3.5/k ≤ 0.35), and both give k ≥ 10. */
  trendMinPerWindowForVerdict: 10,

  /** calibration: a per-company brand verdict places a company mean on one
   *  side of a band boundary. Within-company spread ≈1.0, so SE = 1.0/√n, and
   *  the narrowest band to resolve is ~0.5 wide → n ≥ 4. */
  calibrationMinCompanyRoles: 4,

  /** calibration: "this dimension is pinned" is a share claim. A share from 5
   *  observations has a CI wide enough to contain 50% (i.e. no pinning at
   *  all); 20 narrows it to roughly ±20 points. Dispersion estimates below 20
   *  are unstable the same way. */
  calibrationMinDimRows: 20,

  /** calibration: same share-plus-mean claim shape over salary_adj_city. */
  calibrationMinCompRows: 20,

  /** calibration: "0 of n converted" is only remarkable if 0 is unlikely under
   *  a healthy rate. At a 20% true rate P(0 successes) = 0.8^n, which only
   *  drops below ~1-in-6 at n = 8. */
  calibrationMinApplied: 8,

  /** Trends momentum (frontend targeting-momentum card): ≥5 scored evals in
   *  EACH chronological half. The card compares per-half MEDIANS, so the
   *  mean-based k ≥ 10 window derivation doesn't transfer: a median's
   *  breakdown is bounded by adjacent real observations, not by an outlier's
   *  magnitude. At n = 5 the median is the 3rd order statistic — one aberrant
   *  listing can shift it only to a neighbouring observed value, and flipping
   *  the verdict needs ≥2 listings moving together past the floor. 5 per half
   *  also makes the 10-eval total match the corpus-trend evidence minimum. */
  momentumMinPerHalf: 5,
})

/**
 * Application-outcome gates (docs § 3.7, outcome-stats.mjs). Kept apart from
 * GATES because they count applications, not evaluations, and the app's
 * scoringStats.ts mirror does not read them.
 */
export const OUTCOME_GATES = Object.freeze({
  /** A rate in a slice (reply / progress / interview): same zero-conversion
   *  shape as calibrationMinApplied — 0.8^n < ~1-in-6 at n = 8. Counted over
   *  RESOLVED applications (progressed + rejected + no-response). */
  minResolved: 8,

  /** Timing ("most rejections are fast", median days): under a coin flip,
   *  ≥6 of 8 fast has P ≈ 0.14, the same ~1-in-6 bar. Counted over rejections
   *  whose sent and rejection dates are both exact (no backfill). */
  minTimedRejections: 8,

  /** Ease-band gap persistence: each band compared carries at least this many
   *  resolved applications in EACH chronological half (half the rate gate). */
  minPerHalfBand: 4,
})

/** Classification constants for outcomes (docs § 3.7). Not gates: they decide
 *  what an application's outcome is, not whether a claim may be made.
 *  noResponseDays is the default; user/profile.yml `outcomes.no_response_days`
 *  may change it. */
export const OUTCOME_RULES = Object.freeze({
  /** Still Applied this many days after sending → no-response (else pending). */
  noResponseDays: 30,
  /** Rejected within this many days of sending → fast (consistent with an ATS filter). */
  fastRejectionDays: 2,
  /** Rejected more than this many days after sending → late. */
  lateRejectionDays: 30,
})

/* ───── 4. Confidence tiers (docs § 3.1) ──────────────────────────────────── */

export const CONFIDENCE_TIERS = Object.freeze(['insufficient', 'low', 'moderate', 'high'])

/**
 * One rule for every surface. Given a sample size `n` and that surface's gate
 * `g`: below g the claim is not rendered at all; [g, 2g) is `low`; [2g, 4g) is
 * `moderate`; ≥4g is `high`.
 *
 * The doubling is not decoration: a pool of n observations resolves a share or
 * a rank to about 100/n points. At the gate one observation flips the coarsest
 * bucket; at 2g the claim survives one observation moving; at 4g the resolution
 * matches what the surface actually prints.
 *
 * @returns {'insufficient'|'low'|'moderate'|'high'}
 */
export function confidenceTier(n, gate) {
  const count = Number(n)
  const g = Number(gate)
  if (!Number.isFinite(count) || !Number.isFinite(g) || g <= 0) return 'insufficient'
  if (count < g) return 'insufficient'
  if (count < g * 2) return 'low'
  if (count < g * 4) return 'moderate'
  return 'high'
}

/**
 * The full sample descriptor a surface attaches to a claim. `sufficient` is the
 * gate decision; `confidence` is the tier; `n` and `gate` are what the renderer
 * must print (docs § 4 rule 1: always show n).
 */
export function describeSample(n, gate) {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0
  const confidence = confidenceTier(count, gate)
  return {
    n: count,
    gate,
    confidence,
    sufficient: confidence !== 'insufficient',
  }
}

/* ───── 5. Movement classification (docs § 1 + § 4) ───────────────────────── */

/**
 * Classify a signed Match / Ease / Priority delta against a noise floor. Pass
 * `metric` ('match' | 'ease' | 'priority') to use that metric's floor, or an
 * explicit `floor`; the default is the Priority floor.
 *
 * Returns 'within-noise' for |Δ| < floor — a first-class reported outcome, NOT
 * the absence of a result and NOT a hedged direction. Otherwise 'improving' /
 * 'declining'. Non-finite input is 'unknown'.
 *
 * NOTE the boundary: a delta EXACTLY at the floor is detectable (|Δ| ≥ floor),
 * because the floor was chosen as a value no single-dimension wobble can reach.
 *
 * @returns {'within-noise'|'improving'|'declining'|'unknown'}
 */
export function classifyMovement(delta, { metric, floor = noiseFloorFor(metric) } = {}) {
  const d = Number(delta)
  if (!Number.isFinite(d)) return 'unknown'
  if (Math.abs(d) < floor) return 'within-noise'
  return d > 0 ? 'improving' : 'declining'
}

/** True when |Δ| is under the resolution limit — i.e. not evidence of change. */
export function isWithinNoise(delta, { metric, floor = noiseFloorFor(metric) } = {}) {
  return classifyMovement(delta, { floor }) === 'within-noise'
}

/* ───── 6. Rendering helpers (docs § 4) ───────────────────────────────────── */

/** "of 12 peers" / "of 1 peer" — the always-show-n fragment. */
export function formatSample(n, noun = 'observation') {
  const count = Number(n) || 0
  return `of ${count} ${count === 1 ? noun : pluralize(noun)}`
}

/** "flat within noise (|Δ| 0.10 < 0.30 floor)" — the first-class flat result.
 *  With `metric`, the floor is that metric's ("… < 0.35 Ease floor" is not
 *  added: the caller names the metric in the surrounding sentence). */
export function formatWithinNoise(delta, { metric, floor = noiseFloorFor(metric) } = {}) {
  const d = Math.abs(Number(delta) || 0)
  return `flat within noise (|Δ| ${d.toFixed(2)} < ${floor.toFixed(2)} floor)`
}

function pluralize(noun) {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}
