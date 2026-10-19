// Renderer-side "fixability" engine for the Database and Reports lenses.
//
// The backend's scripts/lib/explain-score.mjs answers, during evaluation,
// "what single change would move this role into a better verdict cell?".
// That insight only lived in the generated report — invisible while scanning
// the Database table. This module brings the same decision-support into the
// cockpit: given a row's already-scored dimensions (the data store holds
// them, no backend round-trip), it finds the SMALLEST single-dimension raise —
// or the single amber eligibility check resolved — that lands the row in a
// strictly better verdict cell.
//
// It MIRRORS docs/scoring-v2.md: §2 Want and §3 Ease (replayed through
// lib/scoreBands, which restates the score-bands.mjs constants by name), §4
// the verdict grid, and §7 the lever search (one dimension at a time, up to
// +4 integer steps; better-cell order blocked < skip < thin < growth < solid
// < stretch < go; an amber resolved is worth +0.5 Ease). It does NOT call the
// backend; tierLevers.test.ts pins the spec's boundary cases so a drift
// between the spec and the cockpit fails CI.
//
// Replay limits (the renderer has no user/profile.yml): Want/Ease are
// replayed at the DEFAULT weights. The dream-company floor is inferred from
// the stored Want (stored ≥ 8.0 while the replay is below it). A lever is only
// reported when the probe beats BOTH the stored verdict and the replayed
// base, so a weights mismatch can hide a lever but never invent one.
//
// Pure: no I/O, no globals, no React.

import type { ScoreEntry, TierKey, Verdict } from '@/types'
import {
  assignVerdict,
  computeEase,
  computeWant,
  eligibilityCheckLabel,
  normalizeTier as normalizeTierCell,
  normalizeVerdict,
  parseEligibilityFlags,
  DIM_LABELS,
  DREAM_WANT_FLOOR,
  EASE_HIGH,
  EASE_MID,
  EXPERIENCE_WALL_AT,
  HYGIENE_DIMS,
  HYGIENE_VETO_AT,
  JUDGED_DIMS,
  ROLE_CONTENT_VETO_AT,
  VERDICT_LABELS,
  VERDICT_RANK,
  VERDICT_TIER,
  WANT_HIGH,
  WANT_MID,
  type JudgedDimKey,
  type V2DimKey,
} from '@/lib/scoreBands'

export { DIM_LABELS }

/** Max integer steps probed per dimension (spec §7). */
export const LEVER_MAX_STEPS = 4

/** A lever this small is a "near-miss": one step on one dimension, or one
 *  amber resolved. Drives the Database "Near upgrade" quick-filter and the
 *  chip's emphasis. */
export const NEAR_MISS_MAX_LIFT = 1

/** The ten v2 dimension values, all required (a blocked/unscored row has
 *  none and gets no lever). */
export type V2Dims = Record<V2DimKey, number>

export interface LeverContext {
  is_intern: boolean
  /** Dream-company floor in force (inferred, see header). */
  dream: boolean
  /** Number of amber eligibility checks (−0.5 Ease each, max −1.0). */
  amber_count: number
}

export interface Lever {
  /** 'dimension' = raise one judged dimension; 'amber' = resolve one amber
   *  eligibility check with the recruiter (+0.5 Ease). */
  kind: 'dimension' | 'amber'
  /** The dimension raised; null for an amber lever. */
  dimension: JudgedDimKey | null
  /** The eligibility check resolved (amber levers only). */
  check?: string
  label: string
  /** Dimension value before/after (dimension) or Ease before/after (amber). */
  from: number
  to: number
  /** Integer steps on the dimension; 1 for an amber resolved. */
  lift: number
  fromVerdict: Verdict
  toVerdict: Verdict
  fromTier: TierKey
  toTier: TierKey
}

export interface LeverResult {
  /** The cheapest verdict-improving lever, or null when none exists (already
   *  `go`, blocked, unscored, or no single change crosses a cell). */
  best: Lever | null
  /** The row's verdict (stored, else replayed); null when unscored. */
  verdict: Verdict | null
  /** The row's storage tier (stored, else the verdict's). */
  tier: string
  /** True when best.lift ≤ NEAR_MISS_MAX_LIFT — a "one nudge away" upgrade. */
  nearMiss: boolean
}

// ─── Adapters from a ScoreEntry ─────────────────────────────────────────────

const ALL_DIMS: readonly V2DimKey[] = [
  'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
  'best_cities', 'salary_adj_city', 'work_life_balance',
  'skills_match', 'experience_bar', 'competition',
]

/** The row's ten dimensions, or null when any is missing (blocked rows,
 *  malformed rows). */
export function v2DimsOf(e: ScoreEntry): V2Dims | null {
  const out = {} as V2Dims
  for (const k of ALL_DIMS) {
    const v = e[k]
    if (v == null || !Number.isFinite(v)) return null
    out[k] = v
  }
  return out
}

// Intern detection mirrors the data: employment_type carries "internship" /
// "intern" (any case). Interns skip the salary hygiene term and its veto
// (spec §2.2 — stipends are not salaries).
export function isInternRow(e: ScoreEntry): boolean {
  return /\bintern/i.test(e.employment_type ?? '')
}

export function amberFlagsOf(e: ScoreEntry) {
  return parseEligibilityFlags(e.eligibility_flags).filter(f => f.status === 'amber')
}

export function leverContextOf(e: ScoreEntry, dims: V2Dims | null = v2DimsOf(e)): LeverContext {
  const is_intern = isInternRow(e)
  let dream = false
  if (dims && e.want != null && e.want >= DREAM_WANT_FLOOR) {
    dream = computeWant(dims, { is_intern }).score < DREAM_WANT_FLOOR
  }
  return { is_intern, dream, amber_count: amberFlagsOf(e).length }
}

/** Replay Want / Ease / verdict for a dimension set (spec §2–§4). */
export function replay(dims: V2Dims, ctx: LeverContext): { want: number; ease: number; verdict: Verdict } {
  const want = computeWant(dims, { is_intern: ctx.is_intern, dream: ctx.dream }).score
  const ease = computeEase(dims, { amber_count: ctx.amber_count }).score
  const verdict = assignVerdict({ want, ease })?.verdict ?? 'skip'
  return { want, ease, verdict }
}

// True iff a ScoreEntry carries every v2 dimension and is not blocked — i.e.
// the engine replay can run on it.
export function hasScoredDims(e: ScoreEntry | null | undefined): e is ScoreEntry {
  if (!e || e.eligibility === 'red' || e.verdict === 'blocked') return false
  return v2DimsOf(e) != null
}

// Every row entering the renderer passes through here so the T1..T4
// vocabulary is the only one the UI sees. v2 history writes T1–T4 directly
// (docs/scoring-v2.md §8.1); an empty cell falls back to the verdict's tier
// (stored, else replayed from Want/Ease), then T4.
export function normalizeTier(raw: string | null | undefined, entry?: Partial<ScoreEntry>): TierKey {
  const t = normalizeTierCell(raw)
  if (t) return t
  if (entry) {
    const v = normalizeVerdict(entry.verdict ?? '')
      ?? assignVerdict({ want: entry.want, ease: entry.ease, eligibility: entry.eligibility ?? null })?.verdict
    if (v) return VERDICT_TIER[v]
  }
  return 'T4'
}

// ─── Lever search (spec §7) ─────────────────────────────────────────────────

/** All verdict-improving single-change levers for a dimension set, cheapest
 *  first. `floorVerdict` is the rank a probe must beat (the stored verdict
 *  when known); the replayed base is always a floor too. */
export function verdictLevers(
  dims: V2Dims,
  ctx: LeverContext,
  floorVerdict?: Verdict | null,
  amberChecks: string[] = [],
): Lever[] {
  const base = replay(dims, ctx)
  const floorRank = Math.max(VERDICT_RANK[base.verdict], floorVerdict ? VERDICT_RANK[floorVerdict] : -1)
  const fromVerdict = floorVerdict ?? base.verdict
  const levers: Lever[] = []

  // One amber resolved — the cheapest action there is (one question).
  if (ctx.amber_count > 0) {
    const probe = replay(dims, { ...ctx, amber_count: ctx.amber_count - 1 })
    if (VERDICT_RANK[probe.verdict] > floorRank) {
      const check = amberChecks[0]
      levers.push({
        kind: 'amber',
        dimension: null,
        check,
        label: check ? `Resolve ${eligibilityCheckLabel(check).toLowerCase()}` : 'Resolve an amber check',
        from: base.ease,
        to: probe.ease,
        lift: 1,
        fromVerdict,
        toVerdict: probe.verdict,
        fromTier: VERDICT_TIER[fromVerdict],
        toTier: VERDICT_TIER[probe.verdict],
      })
    }
  }

  for (const dim of JUDGED_DIMS) {
    const current = dims[dim]
    const top = Math.min(10, current + LEVER_MAX_STEPS)
    for (let candidate = Math.floor(current) + 1; candidate <= top; candidate++) {
      const probe = replay({ ...dims, [dim]: candidate }, ctx)
      if (VERDICT_RANK[probe.verdict] > floorRank) {
        levers.push({
          kind: 'dimension',
          dimension: dim,
          label: DIM_LABELS[dim],
          from: current,
          to: candidate,
          lift: candidate - current,
          fromVerdict,
          toVerdict: probe.verdict,
          fromTier: VERDICT_TIER[fromVerdict],
          toTier: VERDICT_TIER[probe.verdict],
        })
        break // smallest lift for this dim found; stop climbing
      }
    }
  }

  // Smallest lift first; an amber resolve wins a tie (it costs one question);
  // then the dim already nearest the top (cheapest to actually reach).
  return levers.sort((a, b) =>
    a.lift - b.lift
    || (a.kind === b.kind ? 0 : a.kind === 'amber' ? -1 : 1)
    || b.from - a.from)
}

// Top-level convenience for the Database row. Computes the cheapest lever and
// the near-miss flag in one pass. best=null for `go` rows, blocked rows,
// unscored rows, and rows where no single change crosses a cell.
export function rowLever(e: ScoreEntry): LeverResult {
  const storedVerdict = e.verdict ?? assignVerdict(e)?.verdict ?? null
  const tier = e.tier || (storedVerdict ? VERDICT_TIER[storedVerdict] : '')
  if (!hasScoredDims(e)) {
    return { best: null, verdict: storedVerdict, tier, nearMiss: false }
  }
  const dims = v2DimsOf(e)!
  const ctx = leverContextOf(e, dims)
  const verdict = storedVerdict ?? replay(dims, ctx).verdict
  if (verdict === 'go') return { best: null, verdict, tier, nearMiss: false }
  const levers = verdictLevers(dims, ctx, storedVerdict, amberFlagsOf(e).map(f => f.check))
  const best = levers[0] ?? null
  return {
    best,
    verdict,
    tier,
    nearMiss: best != null && best.lift <= NEAR_MISS_MAX_LIFT,
  }
}

// Is this row a "near upgrade" — one step / one amber from a better cell?
export function isNearUpgrade(e: ScoreEntry): boolean {
  return rowLever(e).nearMiss
}

// Keep only the near-upgrade rows (used by the quick-filter toggle). A no-op
// when `enabled` is false so the call site can stay declarative.
export function filterNearUpgrades(rows: ScoreEntry[], enabled: boolean): ScoreEntry[] {
  return enabled ? rows.filter(isNearUpgrade) : rows
}

/** One-line lever copy shared by the Database chip and the Reports card. */
export function leverSentence(l: Lever): string {
  const to = VERDICT_LABELS[l.toVerdict]
  if (l.kind === 'amber') return `${l.label} → ${to}`
  return `${l.label} ${l.from} → ${l.to} → ${to}`
}

// ─── Binding constraints (spec §7) ──────────────────────────────────────────

export type ConstraintKind =
  | 'eligibility_red' | 'experience_wall' | 'hygiene_veto' | 'role_content_veto'
  | 'amber' | 'low_want' | 'low_ease'

export interface BindingConstraint {
  kind: ConstraintKind
  detail: string
}

/** What holds the row where it is, worst first. Blocked rows return only the
 *  red check. Thresholds come from the spec grid, never invented here. */
export function bindingConstraints(e: ScoreEntry): BindingConstraint[] {
  const flags = parseEligibilityFlags(e.eligibility_flags)
  if (e.eligibility === 'red' || e.verdict === 'blocked') {
    const red = flags.find(f => f.status === 'red')
    return [{ kind: 'eligibility_red', detail: red ? (red.reason || eligibilityCheckLabel(red.check)) : 'Not eligible' }]
  }
  const out: BindingConstraint[] = []
  if (e.experience_bar != null && e.experience_bar <= EXPERIENCE_WALL_AT) {
    out.push({ kind: 'experience_wall', detail: `Experience bar ${e.experience_bar} ≤ ${EXPERIENCE_WALL_AT} caps Ease at 4.5` })
  }
  const intern = isInternRow(e)
  for (const k of HYGIENE_DIMS) {
    if (k === 'salary_adj_city' && intern) continue
    const v = e[k]
    if (v != null && v < HYGIENE_VETO_AT) {
      out.push({ kind: 'hygiene_veto', detail: `${DIM_LABELS[k]} ${v} < ${HYGIENE_VETO_AT} caps Want at 5.0` })
    }
  }
  if (e.role_content != null && e.role_content <= ROLE_CONTENT_VETO_AT) {
    out.push({ kind: 'role_content_veto', detail: `Role content ${e.role_content} ≤ ${ROLE_CONTENT_VETO_AT} caps Want at 6.0` })
  }
  for (const f of flags) {
    if (f.status === 'amber') out.push({ kind: 'amber', detail: `${eligibilityCheckLabel(f.check)}: ${f.reason}` })
  }
  if (e.want != null && e.want < WANT_HIGH) {
    const target = e.want < WANT_MID ? WANT_MID : WANT_HIGH
    out.push({ kind: 'low_want', detail: `Want ${e.want} < ${target.toFixed(1)}` })
  }
  if (e.ease != null && e.ease < EASE_HIGH) {
    const target = e.ease < EASE_MID ? EASE_MID : EASE_HIGH
    out.push({ kind: 'low_ease', detail: `Ease ${e.ease} < ${target.toFixed(1)}` })
  }
  return out
}

// ─── Unified report-row fixability (the single near-miss authority) ──────────
//
// reportFixability() answers "is this report a near-miss, and what's the
// cheapest lever?" for the Reports lens. It runs the SAME rowLever() the
// Database uses whenever the report resolves to a score-history entry with
// every v2 dim, so the near-miss verdict and lever are IDENTICAL across
// views. Reports no longer carry a `## Why this score` block, so there is no
// parse fallback: without dims (orphan / blocked) a report is not a near-miss.

export interface ReportLeverInput {
  /** Resolved score-history entry for this report, if one matched. */
  scoreEntry: ScoreEntry | null | undefined
}

export interface ReportLeverResult {
  nearMiss: boolean
  engineLever: Lever | null
  /** A 0–1 "how worth upgrading is this" rank key. Higher = cheaper. */
  fixabilityScore: number
}

export function reportFixability(input: ReportLeverInput): ReportLeverResult {
  const { scoreEntry } = input
  if (!hasScoredDims(scoreEntry)) {
    return { nearMiss: false, engineLever: null, fixabilityScore: 0 }
  }
  const lev = rowLever(scoreEntry)
  const engineLever = lev.best
  const nearMiss = lev.nearMiss
  let fix = 0
  if (engineLever) {
    // lift 1 → 1.0, lift 4 → 0.25: cheaper lever ranks higher; a near-miss
    // floors at 0.55 so it always outranks any larger lever.
    const liftProximity = Math.max(0, 1 - (engineLever.lift - 1) / LEVER_MAX_STEPS)
    fix = nearMiss ? 0.55 + 0.45 * liftProximity : 0.45 * liftProximity
  }
  return { nearMiss, engineLever, fixabilityScore: fix }
}
