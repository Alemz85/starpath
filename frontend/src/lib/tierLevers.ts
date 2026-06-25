// Renderer-side "fixability" engine for the Database lens.
//
// The backend's scripts/lib/explain-score.mjs answers, during evaluation,
// "what single dimension bump would move this role into a better tier?". That
// insight only lived in the generated report — invisible while scanning the
// Database table. This module brings the same decision-support into the
// cockpit: given a row's already-scored dimensions (which the data store
// already holds, no backend round-trip), it computes the SMALLEST single-
// dimension raise that crosses into a strictly better tier.
//
// It deliberately MIRRORS the canonical math in scripts/lib/score-bands.mjs
// (rollupCurrentFit / rollupAspirationalFit / rollupOverall / assignTier) and
// the lever search in scripts/lib/explain-score.mjs § tierLevers. It does NOT
// call the backend. The two implementations are kept in lockstep by a shared
// fixture set (tierLevers.test.ts pins the same example rows the .mjs tests
// pin), so a drift between engine and cockpit is caught by CI.
//
// Pure: no I/O, no globals, no React. The view passes a ScoreEntry in and
// renders the LeverResult out.

import type { ScoreEntry } from '@/types'

// ─── Canonical scoring constants (mirror score-bands.mjs) ───────────────────

const BOTTOM_RANGE_PENALTY = 0.3 // per dim scoring 1 or 2 — mirrors score-bands

// The 6 scoring dims, split by rollup. Order matches explain-score.mjs so the
// lever tie-break (cheaper-to-reach first) resolves identically.
const CF_DIMS = ['skills_match', 'ease_of_entry', 'strategic_fit'] as const
const AF_DIMS = ['growth_mobility', 'optionality_exit', 'brand_value'] as const
type SixDimKey = (typeof CF_DIMS)[number] | (typeof AF_DIMS)[number]

// Higher index = better band. Used to decide whether a hypothetical bump
// produced an *improvement* (not just a change). Mirrors explain-score's
// TIER_RANK. 'T2-high' is a frontend-only display refinement of T2; the
// engine never emits it, so it isn't in the rank table — we normalize it to
// 'T2' before ranking.
const TIER_RANK: Record<string, number> = { T4: 0, T3: 1, T2: 2, T1: 3 }

// Display labels for the 6 rollup dims — the frontend's own copy (the backend
// keeps its own in explain-score.mjs; neither imports the other so each stays
// dependency-free on its own side).
export const DIM_LABELS: Record<SixDimKey, string> = {
  skills_match: 'Skills Match',
  ease_of_entry: 'Ease of Entry',
  strategic_fit: 'Strategic Fit',
  growth_mobility: 'Growth / Mobility',
  optionality_exit: 'Optionality',
  brand_value: 'Brand Value',
}

export type SixDims = Record<SixDimKey, number>

export interface LeverContext {
  salary_adj_for_city: number
  work_life_balance: number
  is_intern: boolean
}

export interface Lever {
  dimension: SixDimKey
  label: string
  from: number
  to: number
  lift: number
  fromTier: string
  toTier: string
}

export interface LeverResult {
  /** The cheapest band-crossing lever, or null when none exists (already T1,
   *  or no single-dim raise can cross a band — e.g. a zero-score / unevaluated
   *  row, or one gated by a constraint a single dim can't lift). */
  best: Lever | null
  /** Current engine tier for this dim set (normalized: 'T2-high' → 'T2'). */
  tier: string
  /** True when best.lift ≤ NEAR_MISS_MAX_LIFT — a "one nudge away" upgrade. */
  nearMiss: boolean
}

// A lever this small is a "near-miss": the role is one modest bump from a
// better band. Drives the Database "Near upgrade" quick-filter and the chip's
// emphasis. 1.0 = a single point on one dimension.
export const NEAR_MISS_MAX_LIFT = 1.0

// ─── Canonical rollups (mirror score-bands.mjs) ─────────────────────────────

function bottomRangePenalty(scores: number[]): number {
  return scores.filter(s => s >= 1 && s <= 2).length * BOTTOM_RANGE_PENALTY
}

function round2(n: number): number {
  return Number(n.toFixed(2))
}

export function rollupCurrentFit(d: Pick<SixDims, (typeof CF_DIMS)[number]>): number {
  const dims = [d.skills_match, d.ease_of_entry, d.strategic_fit]
  const avg = (dims[0] + dims[1] + dims[2]) / 3
  return round2(avg - bottomRangePenalty(dims))
}

export function rollupAspirationalFit(d: Pick<SixDims, (typeof AF_DIMS)[number]>): number {
  const dims = [d.growth_mobility, d.optionality_exit, d.brand_value]
  const avg = (dims[0] + dims[1] + dims[2]) / 3
  return round2(avg - bottomRangePenalty(dims))
}

export function rollupOverall(cf: number, af: number, ctx: LeverContext): number {
  let delta = 0
  if (!ctx.is_intern) {
    if (ctx.salary_adj_for_city <= 4) delta -= 0.4
    if (ctx.salary_adj_for_city >= 9) delta += 0.2
  }
  if (ctx.work_life_balance <= 4) delta -= 0.2
  return round2(cf * 0.7 + af * 0.3 + delta)
}

// Mirror score-bands.mjs § assignTier. Returns the legacy tier symbol.
export function assignTier(cf: number, af: number, sixDims: SixDims): string {
  const eoe = sixDims.ease_of_entry
  const allDimsAtLeast = (n: number) =>
    [...CF_DIMS, ...AF_DIMS].every(k => sixDims[k] >= n)

  if (cf >= 9.0) return 'T1'
  if (allDimsAtLeast(8) && cf >= 8.0 && af >= 8.0) return 'T1'
  if (eoe <= 4) return af >= 7.0 ? 'T3' : 'T4'
  if (cf >= 7.0) return 'T2'
  if (af >= 7.0) return 'T3'
  return 'T4'
}

function computeTier(sixDims: SixDims, ctx: LeverContext): string {
  const cf = rollupCurrentFit(sixDims)
  const af = rollupAspirationalFit(sixDims)
  return assignTier(cf, af, sixDims)
}

// ─── Adapters from a ScoreEntry ─────────────────────────────────────────────

export function sixDimsOf(e: ScoreEntry): SixDims {
  return {
    skills_match: e.skills_match,
    ease_of_entry: e.ease_of_entry,
    strategic_fit: e.strategic_fit,
    growth_mobility: e.growth_mobility,
    optionality_exit: e.optionality_exit,
    brand_value: e.brand_value,
  }
}

// Intern detection mirrors the data: employment_type carries "internship" /
// "intern" (any case). Interns skip the Salary-Adj Overall modifier per the
// engine's intern carve-out, so the lever math must know.
export function isInternRow(e: ScoreEntry): boolean {
  return /\bintern/i.test(e.employment_type ?? '')
}

export function leverContextOf(e: ScoreEntry): LeverContext {
  return {
    salary_adj_for_city: e.salary_adj_city,
    work_life_balance: e.work_life_balance,
    is_intern: isInternRow(e),
  }
}

// ─── Lever search (mirror explain-score.mjs § tierLevers) ───────────────────

// All band-crossing single-dim levers, smallest lift first (tie-break: the
// dim already nearest the top, so the cheapest-to-actually-reach wins). Held
// fixed at integer probes — the engine scores in whole points.
export function tierLevers(sixDims: SixDims, ctx: LeverContext): Lever[] {
  const baseTier = computeTier(sixDims, ctx)
  const baseRank = TIER_RANK[baseTier] ?? 0
  const levers: Lever[] = []

  for (const dim of [...CF_DIMS, ...AF_DIMS]) {
    const current = sixDims[dim]
    for (let candidate = current + 1; candidate <= 10; candidate++) {
      const probe: SixDims = { ...sixDims, [dim]: candidate }
      const probeTier = computeTier(probe, ctx)
      if ((TIER_RANK[probeTier] ?? 0) > baseRank) {
        levers.push({
          dimension: dim,
          label: DIM_LABELS[dim],
          from: round2(current),
          to: round2(candidate),
          lift: round2(candidate - current),
          fromTier: baseTier,
          toTier: probeTier,
        })
        break // smallest lift for this dim found; stop climbing
      }
    }
  }

  return levers.sort((a, b) => a.lift - b.lift || b.from - a.from)
}

// Normalize the *stored* tier (which may carry the frontend-only 'T2-high'
// refinement) down to an engine band so rank comparisons are sound. The stored
// tier is what we report as `tier`, but ranking always uses the engine bands.
function normalizeTier(tier: string): string {
  return tier === 'T2-high' ? 'T2' : tier
}

// Is this row a "near upgrade" — one modest single-dim bump from a better
// band? Drives the Database "Near upgrade" quick-filter. Pure wrapper over
// rowLever so the view and any test agree on the predicate.
export function isNearUpgrade(e: ScoreEntry): boolean {
  return rowLever(e).nearMiss
}

// Keep only the near-upgrade rows (used by the quick-filter toggle). A no-op
// when `enabled` is false so the call site can stay declarative.
export function filterNearUpgrades(rows: ScoreEntry[], enabled: boolean): ScoreEntry[] {
  return enabled ? rows.filter(isNearUpgrade) : rows
}

// Top-level convenience for the Database row. Computes the cheapest lever and
// the near-miss flag in one pass. Returns best=null for already-top-band rows
// and rows where no single-dim raise crosses a band (incl. zero-score rows,
// which read as T4 with no reachable lever).
export function rowLever(e: ScoreEntry): LeverResult {
  const sixDims = sixDimsOf(e)
  const ctx = leverContextOf(e)
  const engineTier = computeTier(sixDims, ctx)
  // Prefer the stored tier for display when present & sane; fall back to the
  // recomputed engine tier (covers legacy rows with an empty tier cell).
  const displayTier = e.tier ? normalizeTier(e.tier) : engineTier

  // A zero-overall row is unevaluated (placeholder) — no meaningful lever.
  if (e.overall <= 0) return { best: null, tier: displayTier, nearMiss: false }

  const levers = tierLevers(sixDims, ctx)
  const best = levers[0] ?? null
  return {
    best,
    tier: displayTier,
    nearMiss: best != null && best.lift <= NEAR_MISS_MAX_LIFT,
  }
}

// True iff a ScoreEntry actually carries the six scored dimensions (i.e. the
// engine math can run on it). Orphan / placeholder rows are built with the six
// dims at 0 and overall 0 — those can't yield a meaningful engine lever, so the
// report path must fall back to parsing for them. We treat "any of the six dims
// > 0 AND a positive overall" as "evaluated, engine-runnable".
export function hasScoredDims(e: ScoreEntry | null | undefined): e is ScoreEntry {
  if (!e || e.overall <= 0) return false
  const d = sixDimsOf(e)
  const keys: SixDimKey[] = [...CF_DIMS, ...AF_DIMS]
  return keys.some(k => d[k] > 0)
}

// ─── Unified report-row fixability (the single near-miss authority) ──────────
//
// The Reports lens used to answer "is this a near-miss to upgrade, and what's
// the cheapest lever?" with its OWN engine: an Overall-score band ladder
// (lib/reportsList § distanceToNextBand / isNearMiss / fixabilityScore) plus a
// regex pull of the report's `## Why this score` lever sentence. That is a
// second, independent implementation of the exact question rowLever() answers
// for the Database from the real dimensional scores — so the two could (and
// did) disagree: the Database said "+1 Ease of Entry → T2" while the Reports
// card, knowing only Overall 6.9, said "+0.1 to Decent".
//
// reportFixability() collapses both into ONE verdict, with a clear precedence:
//
//   1. ENGINE (preferred). When the report resolves to a score-history entry
//      that carries real dims, run rowLever() — the same engine-pinned math the
//      Database uses. The near-miss verdict, the lever, and the tier are then
//      IDENTICAL across the two views for the same listing. The lever string,
//      if the report body carries one, is kept for display (it's prose the
//      engine can't reproduce) but the *boolean* verdict comes from the engine.
//
//   2. PARSE FALLBACK. When no dims are available (orphan reports with no
//      score-history match, or unscored placeholders), fall back to the
//      Overall-gap heuristic + the presence of a parsed lever sentence — the
//      pre-unification behavior, now living in one place instead of three.
//
// `bandDistance` is injected (the Overall→band-floor math lives in reportsList,
// which owns the display band ladder) so this module stays free of the band
// vocabulary while still driving the fallback. This keeps tierLevers the lever
// authority and reportsList the band authority, with no circular import.

export interface ReportLeverInput {
  /** Resolved score-history entry for this report, if one matched. Carries the
   *  six dims when present — that's what lets the engine path run. */
  scoreEntry: ScoreEntry | null | undefined
  /** Overall score shown on the card (report.overall ?? matched entry's). */
  overall: number | null | undefined
  /** Tier string for the report (drives the fallback band ladder). */
  tier: string
  /** Whether the report's `## Why this score` block named a concrete lever.
   *  This is the authoritative "a lever exists" flag on the PARSE path — the
   *  display string below may be absent even when this is true. Defaults to
   *  `!!parsedLever` when omitted. */
  parsedHasLever?: boolean
  /** Lever sentence parsed from the report's `## Why this score` block, when
   *  present. Display-only — never the verdict when the engine path runs. */
  parsedLever?: string | null
  /** Points from `overall` to the next display band's floor (reportsList §
   *  distanceToNextBand). Null when top-band / unscored. Drives the fallback. */
  bandDistance: number | null
}

export interface ReportLeverResult {
  /** The single near-miss verdict both the chip and the filter/sort read. */
  nearMiss: boolean
  /** How the verdict was reached — 'engine' (dims available, rowLever ran) or
   *  'parse' (Overall-gap + parsed lever sentence). Useful for tests + a future
   *  "computed from scores vs. report text" affordance; harmless to ignore. */
  source: 'engine' | 'parse'
  /** Engine lever when the engine path ran and found one — the structured
   *  Database-style lever (dimension/from/to/lift/tiers). Null on the parse
   *  path or when the engine found no single-dim crossing. */
  engineLever: Lever | null
  /** A 0–1 "how worth upgrading is this" rank key. Engine path: a near-miss
   *  lever floors high (cheaper lift ranks higher); parse path: the legacy
   *  proximity+lever blend. Higher = cheaper/more actionable. */
  fixabilityScore: number
}

// Max gap (in Overall points) to the next band that still counts as a near-miss
// on the PARSE fallback path. Mirrors the historical reportsList default.
export const REPORT_NEAR_MISS_MAX_GAP = 0.5

// The single near-miss / fixability computation for a report row. See the block
// comment above for the engine-first / parse-fallback precedence.
export function reportFixability(input: ReportLeverInput): ReportLeverResult {
  const { scoreEntry, parsedLever, bandDistance } = input

  // ── Engine path ── real dims available → reuse the Database engine verbatim.
  if (hasScoredDims(scoreEntry)) {
    const lev = rowLever(scoreEntry)
    // Engine near-miss is the lift-≤-threshold rule. A top-band row (best=null)
    // is never a near-miss regardless of what the report text says.
    const engineLever = lev.best
    const nearMiss = lev.nearMiss
    // Rank key: cheaper lift → higher score. A near-miss lever floors at 0.55
    // (mirrors the parse path's lever floor) and adds proximity by lift; a
    // larger-but-real lever still ranks above any no-lever row; no lever → 0.
    let fix = 0
    if (engineLever) {
      const liftProximity = Math.max(0, 1 - (engineLever.lift - 1) / 9) // lift 1 → 1.0, lift 10 → ~0
      fix = nearMiss ? 0.55 + 0.45 * liftProximity : 0.45 * liftProximity
    }
    return { nearMiss, source: 'engine', engineLever, fixabilityScore: fix }
  }

  // ── Parse fallback ── no dims → Overall-gap + parsed-lever sentence.
  if (bandDistance === null || bandDistance === undefined) {
    // Top-band or unscored — never a near-miss, never in the ranking.
    return { nearMiss: false, source: 'parse', engineLever: null, fixabilityScore: 0 }
  }
  // `parsedHasLever` is the authoritative flag; fall back to the display
  // string's presence when the caller didn't pass it explicitly.
  const hasLever = input.parsedHasLever ?? !!parsedLever
  const nearMiss = hasLever || bandDistance <= REPORT_NEAR_MISS_MAX_GAP
  const proximity = Math.max(0, 1 - bandDistance)
  const fix = hasLever ? 0.55 + 0.45 * proximity : 0.6 * proximity
  return { nearMiss, source: 'parse', engineLever: null, fixabilityScore: fix }
}
