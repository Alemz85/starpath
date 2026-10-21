// scoringStats.ts — the renderer-side mirror of scripts/lib/scoring-stats.mjs.
//
// CONTRACT: docs/scoring-statistical-design.md, re-derived for v2 in
// docs/scoring-v2.md § 9 (MATCH / EASE / PRIORITY noise floors by exact name).
//
// Every analytic the app derives from data/score-history.tsv (peer rank in
// lib/peerRank.ts, the Trends analytics in lib/trendsAnalytics.ts, and the
// components that render them) is bound by that document. The numbers live in
// exactly ONE place per runtime: scripts/lib/scoring-stats.mjs for the Node
// CLIs, this module for the renderer — and scoringStats.test.ts imports BOTH
// and asserts they are identical, so a change on either side that isn't made
// on the other fails the suite.
//
// Do not re-derive a threshold inline in a component or a lib. Import it here.
// If a number needs to change, change the doc, scripts/lib/scoring-stats.mjs,
// and this file in the same commit.

/* ───── 1. Rubric geometry (docs/scoring-v2.md § 9) ─────────────────────── */
//
// v2 has no Overall. Match and Ease move on different scales, so each carries
// its own noise floor, and Priority (the sort key) a third. A delta below the
// floor of ITS metric is "flat within noise" — never a direction.

/** Match: one motivator moving one integer step at the default equal weights
 *  (4 motivators) moves the motivator mean, and so Match, by 1/4. */
export const MATCH_DIM_STEP = 0.25

/** Ease: one step on a 0.35-weight stage of the weighted geometric mean near
 *  the middle of the scale moves Ease by ≈ 0.32. */
export const EASE_DIM_STEP = 0.32

/** One integer step on one motivator at equal weights moves Match by 0.25;
 *  the floor is that, rounded up. */
export const MATCH_NOISE_FLOOR = 0.30

/** One step on a 0.35-weight Ease dimension near 6 moves the geometric mean
 *  by ≈ 0.32; the floor is that, rounded up. */
export const EASE_NOISE_FLOOR = 0.35

/** Priority = sqrt(Match × Ease) — floor for sort-key movement. */
export const PRIORITY_NOISE_FLOOR = 0.30

export type ScoreMetric = 'match' | 'ease' | 'priority'

export const NOISE_FLOORS: Record<ScoreMetric, number> = {
  match: MATCH_NOISE_FLOOR,
  ease: EASE_NOISE_FLOOR,
  priority: PRIORITY_NOISE_FLOOR,
}

/** The noise floor for 'match' | 'ease' | 'priority' (Priority's for anything else). */
export function noiseFloorFor(metric: string | null | undefined): number {
  return (metric != null && metric in NOISE_FLOORS) ? NOISE_FLOORS[metric as ScoreMetric] : PRIORITY_NOISE_FLOOR
}

/** Options shared by the movement helpers: name the metric, or pass its floor. */
export interface FloorOptions { metric?: ScoreMetric; floor?: number }

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
  'experience_bar',
  'competition',
  'growth_mobility',
  'optionality_exit',
  'role_content',
  'work_life_balance',
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
   *  a single extreme role deviates by up to ≈3.0 points, and 3.0/k ≤ 0.30
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

  /** Trends momentum card: ≥5 scored evals in EACH chronological half. The
   *  card compares per-half MEDIANS, whose breakdown is bounded by adjacent
   *  real observations — at n = 5 one aberrant listing can shift the median
   *  only to a neighbouring value, and a verdict flip needs ≥2 listings
   *  moving together past the floor (docs § 3.5). */
  momentumMinPerHalf: 5,
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
 * Classify a signed delta against the noise floor of ITS metric — pass
 * `{ floor: NOISE_FLOORS.ease }` for an Ease delta. Defaults to the Priority
 * floor (the sort-key comparison most callers make).
 *
 * 'within-noise' for |Δ| < floor is a first-class reported outcome, NOT the
 * absence of a result and NOT a hedged direction. A delta EXACTLY at the floor
 * is detectable (|Δ| ≥ floor) — the floor was chosen as a value no
 * single-dimension wobble can reach.
 */
export function classifyMovement(
  delta: number | null | undefined,
  { metric, floor = noiseFloorFor(metric) }: FloorOptions = {},
): MovementClass {
  const d = Number(delta)
  if (!Number.isFinite(d)) return 'unknown'
  if (Math.abs(d) < floor) return 'within-noise'
  return d > 0 ? 'improving' : 'declining'
}

/** True when |Δ| is under the resolution limit — i.e. not evidence of change. */
export function isWithinNoise(
  delta: number | null | undefined,
  { metric, floor = noiseFloorFor(metric) }: FloorOptions = {},
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
  { metric, floor = noiseFloorFor(metric) }: FloorOptions = {},
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
