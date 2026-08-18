// scoring-stats.mjs — the single source of truth for the statistical-honesty
// numbers used by every analytic derived from data/score-history.tsv.
//
// CONTRACT: docs/scoring-statistical-design.md
//
// That document and this module must state the SAME numbers. If you change a
// constant here without changing the doc (or vice-versa) that is a defect —
// scoring-stats.test.mjs pins the values so the drift is caught.
//
// Why this file exists: a score is an LLM judgment on a coarse ordinal rubric.
// Peer rank, score trend, and calibration advice all read that log and can
// easily overclaim — a 0.1 wobble rendered as a trend arrow, a percentile
// computed from five peers, a "your rubric is broken" advisory built on three
// applications. The constants below are the resolution limit and the sample
// gates that keep those surfaces honest. All functions are pure.

/* ───── 1. Rubric geometry (docs § 1) ─────────────────────────────────────── */

/** Overall = CF × 0.70 + AF × 0.30 (modes/_shared.md § Overall). */
export const CF_WEIGHT = 0.70
export const AF_WEIGHT = 0.30

/** Each rollup is the mean of three integer dimensions, so one dimension
 *  moving one integer step moves Overall by a fixed amount. */
export const CF_DIM_STEP = CF_WEIGHT / 3   // 0.2333… — one Current Fit dim, one step
export const AF_DIM_STEP = AF_WEIGHT / 3   // 0.1000  — one Aspirational Fit dim, one step

/**
 * OVERALL_NOISE_FLOOR — the minimum detectable difference in Overall.
 *
 * Derivation (docs § 1 "The noise floor"): the floor must be strictly greater
 * than the largest Overall move a SINGLE dimension can produce by wobbling one
 * integer step (0.2333, one Current Fit dim — a re-evaluation does that for
 * free), and no greater than the smallest move that needs TWO dimensions to
 * agree (0.3333, one CF + one AF dim in the same direction). 0.30 is the round
 * value inside (0.2333, 0.3333].
 *
 * A delta below this is NOT a small change — it is the resolution limit of the
 * instrument. Surfaces report it as "flat within noise", never with a sign,
 * arrow, or directional verb.
 */
export const OVERALL_NOISE_FLOOR = 0.30

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
 *  NEVER read as precise to a decimal across re-evaluations. Ease of Entry is
 *  listed here because its discretionary share dominates its table-driven
 *  share; its table adjustments are still mechanical facts. */
export const JUDGMENT_DIMS = Object.freeze([
  'skills_match',
  'ease_of_entry',
  'strategic_fit',
  'growth_mobility',
  'optionality_exit',
  'work_life_balance',
  'sales_trap_risk',
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
   *  No single evaluation may move a window mean by more than the noise floor:
   *  a single extreme role deviates by up to ≈3.0 Overall, and 3.0/k ≤ 0.30
   *  gives k ≥ 10. */
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
 * Classify a signed Overall delta against the noise floor.
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
export function classifyMovement(delta, { floor = OVERALL_NOISE_FLOOR } = {}) {
  const d = Number(delta)
  if (!Number.isFinite(d)) return 'unknown'
  if (Math.abs(d) < floor) return 'within-noise'
  return d > 0 ? 'improving' : 'declining'
}

/** True when |Δ| is under the resolution limit — i.e. not evidence of change. */
export function isWithinNoise(delta, { floor = OVERALL_NOISE_FLOOR } = {}) {
  return classifyMovement(delta, { floor }) === 'within-noise'
}

/* ───── 6. Rendering helpers (docs § 4) ───────────────────────────────────── */

/** "of 12 peers" / "of 1 peer" — the always-show-n fragment. */
export function formatSample(n, noun = 'observation') {
  const count = Number(n) || 0
  return `of ${count} ${count === 1 ? noun : pluralize(noun)}`
}

/** "flat within noise (|Δ| 0.10 < 0.30 floor)" — the first-class flat result. */
export function formatWithinNoise(delta, { floor = OVERALL_NOISE_FLOOR } = {}) {
  const d = Math.abs(Number(delta) || 0)
  return `flat within noise (|Δ| ${d.toFixed(2)} < ${floor.toFixed(2)} floor)`
}

function pluralize(noun) {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}
