// scoringStats.ts — the renderer-side mirror of scripts/lib/scoring-stats.mjs.
//
// CONTRACT: docs/scoring-statistical-design.md
//
// Every analytic the app derives from data/score-history.tsv (peer rank in
// lib/peerRank.ts, re-evaluation movement in lib/scoreTrend.ts, and the
// components that render them) is bound by that document. The numbers live in
// exactly ONE place per runtime: scripts/lib/scoring-stats.mjs for the Node
// CLIs, this module for the renderer — and scoringStats.test.ts imports BOTH
// and asserts they are identical, so a change on either side that isn't made
// on the other fails the suite.
//
// Do not re-derive a threshold inline in a component or a lib. Import it here.
// If a number needs to change, change the doc, scripts/lib/scoring-stats.mjs,
// and this file in the same commit.

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
 * Derivation (docs § 1 "The noise floor"): strictly greater than the largest
 * Overall move a SINGLE dimension can produce by wobbling one integer step
 * (0.2333, one Current Fit dim — a re-evaluation does that for free), and no
 * greater than the smallest move that needs TWO dimensions to agree (0.3333).
 * 0.30 is the round value inside (0.2333, 0.3333].
 *
 * A delta below this is NOT a small change — it is the resolution limit of the
 * instrument. Surfaces render it as "flat within noise": no arrow, no sign, no
 * directional colour.
 */
export const OVERALL_NOISE_FLOOR = 0.30

/* ───── 2. Dimension classes (docs § 2) ───────────────────────────────────── */

/** Dimensions that resolve against a table, a document, or a stated fact —
 *  they reproduce exactly given the same inputs, so a change across
 *  re-evaluations means an INPUT changed and may be reported as such. */
export const MECHANICAL_DIMS = [
  'brand_value',      // brand-tier table + user calibration lists
  'salary_adj_city',  // computed by score-listing.mjs from comp inputs
  'best_cities',      // lookup against the user's preferred-cities list
] as const

/** An agent's reading of prose against a CV. Ordinal/comparative claims only —
 *  NEVER read as precise to a decimal across re-evaluations. */
export const JUDGMENT_DIMS = [
  'skills_match',
  'ease_of_entry',
  'strategic_fit',
  'growth_mobility',
  'optionality_exit',
  'work_life_balance',
  'sales_trap_risk',
] as const

export type DimensionClass = 'mechanical' | 'judgment' | 'unknown'

export function dimensionClass(key: string): DimensionClass {
  if ((MECHANICAL_DIMS as readonly string[]).includes(key)) return 'mechanical'
  if ((JUDGMENT_DIMS as readonly string[]).includes(key)) return 'judgment'
  return 'unknown'
}

/* ───── 3. Sample gates (docs § 3) ────────────────────────────────────────── */

/**
 * Every gate in the system, in one object — same keys and values as the
 * canonical module's GATES. Each is derived in the doc; the one-line reason is
 * repeated here so a reader of the code sees why.
 */
export const GATES = {
  /** peer-rank: below 5 same-archetype peers the block is OMITTED entirely
   *  (returns null) — never a placeholder. */
  peerMinPeers: 5,

  /** score-trend per-listing: a trajectory needs 2+ evals on distinct dates.
   *  Two points is `low` confidence by construction. */
  trendMinEvals: 2,

  /** score-trend corpus verdict: ≥10 scored evals in EACH calendar window —
   *  a single extreme role deviates by up to ≈3.0 Overall, and 3.0/k ≤ 0.30
   *  gives k ≥ 10. */
  trendMinPerWindowForVerdict: 10,

  /** calibration: a per-company brand verdict places a company mean on one
   *  side of a band boundary — SE = 1.0/√n against a ~0.5-wide band → n ≥ 4. */
  calibrationMinCompanyRoles: 4,

  /** calibration: "this dimension is pinned" is a share claim; 20 observations
   *  narrow the interval to roughly ±20 points. */
  calibrationMinDimRows: 20,

  /** calibration: same share-plus-mean claim shape over salary_adj_city. */
  calibrationMinCompRows: 20,

  /** calibration: "0 of n converted" — at a 20% true rate P(0) = 0.8^n only
   *  drops below ~1-in-6 at n = 8. */
  calibrationMinApplied: 8,
} as const

export type GateKey = keyof typeof GATES

/* ───── 4. Confidence tiers (docs § 3.1) ──────────────────────────────────── */

export const CONFIDENCE_TIERS = ['insufficient', 'low', 'moderate', 'high'] as const
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number]

/**
 * One rule for every surface. Given a sample size `n` and that surface's gate
 * `g`: below g the claim is not rendered at all; [g, 2g) is `low`; [2g, 4g) is
 * `moderate`; ≥4g is `high`.
 *
 * The doubling is not decoration: a pool of n observations resolves a share or
 * a rank to about 100/n points. At the gate one observation flips the coarsest
 * bucket; at 2g the claim survives one observation moving; at 4g the
 * resolution matches what the surface actually prints.
 */
export function confidenceTier(n: number | null | undefined, gate: number | null | undefined): ConfidenceTier {
  const count = Number(n)
  const g = Number(gate)
  if (!Number.isFinite(count) || !Number.isFinite(g) || g <= 0) return 'insufficient'
  if (count < g) return 'insufficient'
  if (count < g * 2) return 'low'
  if (count < g * 4) return 'moderate'
  return 'high'
}

export interface SampleDescriptor {
  n: number
  gate: number
  confidence: ConfidenceTier
  sufficient: boolean
}

/**
 * The full sample descriptor a surface attaches to a claim. `sufficient` is the
 * gate decision; `confidence` is the tier; `n` and `gate` are what the renderer
 * must print (docs § 4 rule 1: always show n).
 */
export function describeSample(n: number | null | undefined, gate: number): SampleDescriptor {
  const count = Number.isFinite(Number(n)) ? Number(n) : 0
  const confidence = confidenceTier(count, gate)
  return { n: count, gate, confidence, sufficient: confidence !== 'insufficient' }
}

/* ───── 5. Movement classification (docs § 1 + § 4) ───────────────────────── */

export type MovementClass = 'within-noise' | 'improving' | 'declining' | 'unknown'

/**
 * Classify a signed Overall delta against the noise floor.
 *
 * 'within-noise' for |Δ| < floor is a first-class reported outcome, NOT the
 * absence of a result and NOT a hedged direction. A delta EXACTLY at the floor
 * is detectable (|Δ| ≥ floor) — the floor was chosen as a value no
 * single-dimension wobble can reach.
 */
export function classifyMovement(
  delta: number | null | undefined,
  { floor = OVERALL_NOISE_FLOOR }: { floor?: number } = {},
): MovementClass {
  const d = Number(delta)
  if (!Number.isFinite(d)) return 'unknown'
  if (Math.abs(d) < floor) return 'within-noise'
  return d > 0 ? 'improving' : 'declining'
}

/** True when |Δ| is under the resolution limit — i.e. not evidence of change. */
export function isWithinNoise(
  delta: number | null | undefined,
  { floor = OVERALL_NOISE_FLOOR }: { floor?: number } = {},
): boolean {
  return classifyMovement(delta, { floor }) === 'within-noise'
}

/* ───── 6. Rendering helpers (docs § 4) ───────────────────────────────────── */

/** "of 12 peers" / "of 1 peer" — the always-show-n fragment. */
export function formatSample(n: number | null | undefined, noun = 'observation'): string {
  const count = Number(n) || 0
  return `of ${count} ${count === 1 ? noun : pluralize(noun)}`
}

/** "flat within noise (|Δ| 0.10 < 0.30 floor)" — the first-class flat result. */
export function formatWithinNoise(
  delta: number | null | undefined,
  { floor = OVERALL_NOISE_FLOOR }: { floor?: number } = {},
): string {
  const d = Math.abs(Number(delta) || 0)
  return `flat within noise (|Δ| ${d.toFixed(2)} < ${floor.toFixed(2)} floor)`
}

function pluralize(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

/* ───── 7. Renderer-only copy helpers ─────────────────────────────────────── */
//
// These have no counterpart in the .mjs module (the CLIs write their own
// prose). They exist so the five score-derived components phrase the SAME
// claim the same way — docs § 4 rules 1 and 2: always show n, tiers over point
// precision.

/** "low confidence · n=7" — the suffix every rendered claim carries. */
export function confidenceNote(confidence: ConfidenceTier, n: number): string {
  return `${confidence} confidence · n=${n}`
}

/**
 * Docs § 3.2: at `low` confidence a rank label is a bucket NAME, and the only
 * supported reading is which half the role sits in. Returns the caveat to
 * append, or '' when the sample carries the finer reading.
 */
export function rankReadingCaveat(confidence: ConfidenceTier): string {
  return confidence === 'low' ? 'at this sample read the half, not the quartile' : ''
}
