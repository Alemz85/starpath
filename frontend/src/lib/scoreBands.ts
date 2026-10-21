// scoreBands.ts — the renderer-side mirror of the v2 scoring engine.
//
// CONTRACT: docs/scoring-v2.md (§2 Match, §3 Ease, §4 verdict grid, §5
// Priority, §8 storage formats). The executable source of truth is
// scripts/lib/score-bands.mjs + scripts/lib/eligibility.mjs; this module
// restates the same constants BY THE SAME NAMES and the same formulas so the
// cockpit can replay a row's verdict (tierLevers.ts) and parse every v2
// storage cell without a backend round-trip.
//
// Pure: no I/O, no React, and only RELATIVE value imports — the Electron sync
// layer (electron/db/sync.ts, compiled to CJS without the `@/` alias) imports
// this file at runtime.
//
// Do not invent thresholds on a number here. Display/sort bands come from the
// verdict (spec §9), never from new cut-offs on Match, Ease or Priority.

import type {
  Eligibility,
  EligibilityFlag,
  ScoreEntry,
  TierKey,
  Verdict,
} from '../types'

/* ───── §4 Verdict grid ───────────────────────────────────────────────────── */

export const MATCH_HIGH = 8.0
export const MATCH_MID = 6.5
export const EASE_HIGH = 7.0
export const EASE_MID = 5.0

export const VERDICTS: readonly Verdict[] = ['go', 'stretch', 'growth', 'solid', 'thin', 'skip', 'blocked']

/** Short labels (spec §4 `VERDICT_LABELS`). */
export const VERDICT_LABELS: Record<Verdict, string> = {
  go: 'Go',
  stretch: 'Stretch',
  growth: 'Growth target',
  solid: 'Solid',
  thin: 'If pipeline thin',
  skip: 'Skip',
  blocked: 'Blocked',
}

/** The one-line action that goes with each verdict cell (spec §4 grid). */
export const VERDICT_ACTIONS: Record<Verdict, string> = {
  go: 'apply now',
  stretch: 'apply with prep',
  growth: 'close the gap first',
  solid: 'apply',
  thin: 'only if your pipeline is thin',
  skip: "don't apply",
  blocked: 'not eligible',
}

/** Verdict → legacy storage tier (spec §4). Verdict chips take their colour
 *  from this tier — a verdict never gets a palette of its own. */
export const VERDICT_TIER: Record<Verdict, TierKey> = {
  go: 'T1',
  stretch: 'T2',
  solid: 'T2',
  thin: 'T2',
  growth: 'T3',
  skip: 'T4',
  blocked: 'T4',
}

/** Better-cell order (spec §7): blocked < skip < thin < growth < solid <
 *  stretch < go. Higher = better. Used for lever search and verdict sorts. */
export const VERDICT_RANK: Record<Verdict, number> = {
  blocked: 0,
  skip: 1,
  thin: 2,
  growth: 3,
  solid: 4,
  stretch: 5,
  go: 6,
}

/** Ethical-use rule (spec §4): recommend against applying on skip / blocked. */
export function recommendsAgainst(v: Verdict | null | undefined): boolean {
  return v === 'skip' || v === 'blocked'
}

export interface VerdictResult {
  verdict: Verdict
  tier: TierKey
  reason: string
}

function fmt(n: number): string {
  return String(round2(n))
}

/**
 * assignVerdict — spec §4. A red eligibility always wins (Blocked, T4). With
 * no red and either score missing the row is unscored → null.
 */
export function assignVerdict(input: {
  match: number | null | undefined
  ease: number | null | undefined
  eligibility?: Eligibility | null
}): VerdictResult | null {
  if (input.eligibility === 'red') {
    return { verdict: 'blocked', tier: 'T4', reason: 'Eligibility red' }
  }
  const match = input.match
  const ease = input.ease
  if (match == null || ease == null || !Number.isFinite(match) || !Number.isFinite(ease)) return null

  const row: 'high' | 'mid' | 'low' = match >= MATCH_HIGH ? 'high' : match >= MATCH_MID ? 'mid' : 'low'
  const col: 'high' | 'mid' | 'low' = ease >= EASE_HIGH ? 'high' : ease >= EASE_MID ? 'mid' : 'low'

  let verdict: Verdict
  if (row === 'high') verdict = col === 'high' ? 'go' : col === 'mid' ? 'stretch' : 'growth'
  else if (row === 'mid') verdict = col === 'high' ? 'solid' : col === 'mid' ? 'thin' : 'skip'
  else verdict = 'skip'

  const matchPart = row === 'high'
    ? `Match ${fmt(match)} ≥ ${MATCH_HIGH.toFixed(1)}`
    : row === 'mid'
      ? `Match ${fmt(match)} in ${MATCH_MID.toFixed(1)}–${MATCH_HIGH.toFixed(1)}`
      : `Match ${fmt(match)} < ${MATCH_MID.toFixed(1)}`
  const easePart = col === 'high'
    ? `Ease ${fmt(ease)} ≥ ${EASE_HIGH.toFixed(1)}`
    : col === 'mid'
      ? `Ease ${fmt(ease)} in ${EASE_MID.toFixed(1)}–${EASE_HIGH.toFixed(1)}`
      : `Ease ${fmt(ease)} < ${EASE_MID.toFixed(1)}`

  return { verdict, tier: VERDICT_TIER[verdict], reason: `${matchPart}, ${easePart}` }
}

/* ───── §5 Priority (sort key only) ───────────────────────────────────────── */

export function computePriority(match: number | null | undefined, ease: number | null | undefined): number | null {
  if (match == null || ease == null || !Number.isFinite(match) || !Number.isFinite(ease)) return null
  if (match <= 0 || ease <= 0) return null
  return round2(Math.sqrt(match * ease))
}

/** Priority for an entry — the stored cell, else recomputed from Match/Ease.
 *  Blocked rows have none. Never render this as a headline score. */
export function priorityOf(e: Pick<ScoreEntry, 'priority' | 'match' | 'ease' | 'eligibility'>): number | null {
  if (e.eligibility === 'red') return null
  if (e.priority != null && Number.isFinite(e.priority)) return e.priority
  return computePriority(e.match, e.ease)
}

/* ───── §2 Match ───────────────────────────────────────────────────────────── */

export const MOTIVATOR_DIMS = ['growth_mobility', 'optionality_exit', 'brand_value', 'role_content'] as const
export const HYGIENE_DIMS = ['best_cities', 'salary_adj_city', 'work_life_balance'] as const
export const EASE_DIMS = ['skills_match', 'experience_bar', 'competition'] as const
export const MATCH_DIMS = [...MOTIVATOR_DIMS, ...HYGIENE_DIMS] as const
/** All ten v2 dimensions, in the report's row order (spec §8.5). */
export const V2_DIMS = [...MATCH_DIMS, ...EASE_DIMS] as const
/** The nine agent-judged dimensions (spec §6 `judgment_scores`) —
 *  salary_adj_city is computed by the script, so it is not a lever. */
export const JUDGED_DIMS = [
  'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
  'best_cities', 'work_life_balance',
  'skills_match', 'experience_bar', 'competition',
] as const

export type MotivatorKey = (typeof MOTIVATOR_DIMS)[number]
export type HygieneKey = (typeof HYGIENE_DIMS)[number]
export type EaseDimKey = (typeof EASE_DIMS)[number]
export type V2DimKey = (typeof V2_DIMS)[number]
export type JudgedDimKey = (typeof JUDGED_DIMS)[number]

export const DIM_LABELS: Record<V2DimKey, string> = {
  growth_mobility: 'Growth / Mobility',
  optionality_exit: 'Optionality / Exit',
  brand_value: 'Brand Value',
  role_content: 'Role content',
  best_cities: 'City',
  salary_adj_city: 'Salary Adj for City',
  work_life_balance: 'Work-Life Balance',
  skills_match: 'Skills Match',
  experience_bar: 'Experience bar',
  competition: 'Competition',
}

/** h(x) steps (spec §2.2), highest floor first. */
export const HYGIENE_STEPS: ReadonlyArray<{ min: number; delta: number }> = [
  { min: 8, delta: 0.25 },
  { min: 5, delta: 0 },
  { min: 4, delta: -0.40 },
  { min: 3, delta: -0.80 },
  { min: -Infinity, delta: -1.20 },
]
export const MOTIVATOR_BOTTOM_PENALTY = 0.30
export const HYGIENE_VETO_AT = 3          // "any hygiene factor < 3"
export const HYGIENE_VETO_CAP = 5.0
export const ROLE_CONTENT_VETO_AT = 3
export const ROLE_CONTENT_VETO_CAP = 6.0
export const DREAM_MATCH_FLOOR = 8.0
export const DEFAULT_MATCH_WEIGHTS: Record<MotivatorKey, number> = {
  growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1,
}

export function hygieneDelta(x: number): number {
  for (const step of HYGIENE_STEPS) if (x >= step.min) return step.delta
  return HYGIENE_STEPS[HYGIENE_STEPS.length - 1].delta
}

export type MatchDims = Record<MotivatorKey, number> & Partial<Record<HygieneKey, number | null>>

export interface MatchOptions {
  is_intern?: boolean
  /** company ∈ calibration.dream_companies → Match floored at 8.0. */
  dream?: boolean
  weights?: Partial<Record<MotivatorKey, number>>
}

export interface MatchBreakdown {
  score: number
  motivators_mean: number
  motivator_penalty: number
  hygiene: Record<HygieneKey, number>
  floor: number | null
  vetoes: Array<'hygiene' | 'role_content'>
}

export function computeMatch(d: MatchDims, opts: MatchOptions = {}): MatchBreakdown {
  const w = { ...DEFAULT_MATCH_WEIGHTS, ...(opts.weights ?? {}) }
  let num = 0
  let den = 0
  let bottom = 0
  for (const k of MOTIVATOR_DIMS) {
    num += w[k] * d[k]
    den += w[k]
    if (d[k] <= 2) bottom++
  }
  const M = den > 0 ? num / den : 0
  const penalty = MOTIVATOR_BOTTOM_PENALTY * bottom

  const hyg: Record<HygieneKey, number> = { best_cities: 0, salary_adj_city: 0, work_life_balance: 0 }
  for (const k of HYGIENE_DIMS) {
    const x = d[k]
    if (x == null || !Number.isFinite(x)) continue
    if (k === 'salary_adj_city' && opts.is_intern) continue // stipends are not salaries
    hyg[k] = hygieneDelta(x)
  }
  const H = hyg.best_cities + hyg.salary_adj_city + hyg.work_life_balance

  let match = clamp(M - penalty + H, 1, 10)
  let floor: number | null = null
  if (opts.dream && match < DREAM_MATCH_FLOOR) {
    match = DREAM_MATCH_FLOOR
    floor = DREAM_MATCH_FLOOR
  }
  const vetoes: MatchBreakdown['vetoes'] = []
  const hygieneVeto = HYGIENE_DIMS.some(k => {
    if (k === 'salary_adj_city' && opts.is_intern) return false
    const x = d[k]
    return x != null && Number.isFinite(x) && x < HYGIENE_VETO_AT
  })
  if (hygieneVeto && match > HYGIENE_VETO_CAP) { match = HYGIENE_VETO_CAP; vetoes.push('hygiene') }
  else if (hygieneVeto) vetoes.push('hygiene')
  if (d.role_content <= ROLE_CONTENT_VETO_AT) {
    vetoes.push('role_content')
    if (match > ROLE_CONTENT_VETO_CAP) match = ROLE_CONTENT_VETO_CAP
  }

  return {
    score: round2(match),
    motivators_mean: round2(M),
    motivator_penalty: round2(penalty),
    hygiene: hyg,
    floor,
    vetoes,
  }
}

/* ───── §3 Ease ───────────────────────────────────────────────────────────── */

export const DEFAULT_EASE_WEIGHTS: Record<EaseDimKey, number> = {
  skills_match: 0.35, experience_bar: 0.35, competition: 0.30,
}
export const EXPERIENCE_WALL_AT = 3
export const EXPERIENCE_WALL_CAP = 4.5
export const AMBER_EASE_PENALTY = 0.5
export const AMBER_EASE_PENALTY_MAX = 1.0
export const REFERRAL_BONUS: Record<'warm-direct' | 'warm-intro', number> = {
  'warm-direct': 1.0,
  'warm-intro': 0.5,
}

export type EaseDims = Record<EaseDimKey, number>

export interface EaseBreakdown {
  score: number
  geometric: number
  wall: boolean
  amber_penalty: number
}

export function computeEase(
  d: EaseDims,
  opts: { amber_count?: number; weights?: Partial<Record<EaseDimKey, number>> } = {},
): EaseBreakdown {
  const w = { ...DEFAULT_EASE_WEIGHTS, ...(opts.weights ?? {}) }
  let num = 0
  let den = 0
  for (const k of EASE_DIMS) {
    const x = Math.max(d[k], 1e-9) // ln(0) guard; dims are 1–10 integers
    num += w[k] * Math.log(x)
    den += w[k]
  }
  let geo = den > 0 ? Math.exp(num / den) : 0
  const rawGeo = geo
  const wall = d.experience_bar <= EXPERIENCE_WALL_AT
  if (wall) geo = Math.min(geo, EXPERIENCE_WALL_CAP)
  const amber = Math.min(AMBER_EASE_PENALTY * Math.max(0, opts.amber_count ?? 0), AMBER_EASE_PENALTY_MAX)
  const ease = clamp(geo - amber, 1, 10)
  return { score: round2(ease), geometric: round2(rawGeo), wall, amber_penalty: amber }
}

/* ───── Eligibility cells ─────────────────────────────────────────────────── */

export function normalizeEligibility(raw: string | null | undefined): Eligibility | null {
  const t = (raw ?? '').trim().toLowerCase()
  if (t.startsWith('green')) return 'green'
  if (t.startsWith('amber')) return 'amber'
  if (t.startsWith('red')) return 'red'
  return null
}

/** Score-history `eligibility_flags` — `check:status:reason;…` (spec §8.1).
 *  The reason may itself contain `:`; only the first two separate fields. */
export function parseEligibilityFlags(raw: string | null | undefined): EligibilityFlag[] {
  const text = (raw ?? '').trim()
  if (!text) return []
  return text.split(';').flatMap(part => {
    const p = part.trim()
    if (!p) return []
    const i = p.indexOf(':')
    if (i < 0) return []
    const check = p.slice(0, i).trim()
    const rest = p.slice(i + 1)
    const j = rest.indexOf(':')
    const statusRaw = j < 0 ? rest : rest.slice(0, j)
    const reason = j < 0 ? '' : rest.slice(j + 1).trim()
    const status = normalizeEligibility(statusRaw)
    if (!check || !status) return []
    return [{ check, status, reason }]
  })
}

export function amberCountOf(e: Pick<ScoreEntry, 'eligibility_flags'>): number {
  return parseEligibilityFlags(e.eligibility_flags).filter(f => f.status === 'amber').length
}

/** Scouting `Eligibility` cell: `green`, `amber: <reasons ;-joined>`,
 *  `red: <reason>` (spec §8.2). */
export function parseEligibilityCell(cell: string | null | undefined): { status: Eligibility | null; reason: string } {
  const text = (cell ?? '').trim()
  const status = normalizeEligibility(text)
  if (!status) return { status: null, reason: '' }
  const i = text.indexOf(':')
  const reason = i < 0 ? '' : text.slice(i + 1).trim()
  return { status, reason }
}

export const ELIGIBILITY_CHECK_LABELS: Record<string, string> = {
  start_date: 'Start date',
  duration: 'Duration',
  graduation: 'Graduation',
  language: 'Language',
  work_auth: 'Work authorisation',
  other: 'Other requirement',
}

/** Label for a check key, with a humanised fallback for keys a newer engine
 *  may add (spec §1.2 lists six; readers never hard-fail on a seventh). */
export function eligibilityCheckLabel(check: string): string {
  const known = ELIGIBILITY_CHECK_LABELS[check]
  if (known) return known
  const words = check.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Check'
}

/* ───── Applications Score cell (spec §8.3) ───────────────────────────────── */

export type ScoreCell = { match: number; ease: number } | { legacy: number }

/** Mirror of tracker-core.mjs `parseScoreCell`: `M8.3 E5.6` (or the pre-rename
 *  `W8.3 E5.6`) → {match, ease};
 *  a legacy `7.4/10` (or bare `7.4`) → {legacy}; anything else → null. */
export function parseScoreCell(cell: string | null | undefined): ScoreCell | null {
  const text = (cell ?? '').replace(/\*\*/g, '').trim()
  if (!text) return null
  const v2 = text.match(/^[MW]\s*(\d+(?:\.\d+)?)\s*[·,/ ]?\s*E\s*(\d+(?:\.\d+)?)$/i)
  if (v2) {
    const match = parseFloat(v2[1])
    const ease = parseFloat(v2[2])
    if (Number.isFinite(match) && Number.isFinite(ease)) return { match, ease }
  }
  const legacy = text.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*10)?$/)
  if (legacy) {
    const n = parseFloat(legacy[1])
    if (Number.isFinite(n)) return { legacy: n }
  }
  return null
}

/** The v2 Score cell written to applications.md (`M8.3 E5.6`). */
export function formatScoreCell(match: number, ease: number): string {
  return `M${match.toFixed(1)} E${ease.toFixed(1)}`
}

/* ───── Tier / verdict normalisation ──────────────────────────────────────── */

export function normalizeTier(raw: string | null | undefined): TierKey | null {
  const t = (raw ?? '').trim().toUpperCase().replace(/^TIER-/, 'T')
  if (t === 'T1' || t === 'T2' || t === 'T3' || t === 'T4') return t
  return null
}

export function normalizeVerdict(raw: string | null | undefined): Verdict | null {
  const t = (raw ?? '').trim().toLowerCase()
  return (VERDICTS as readonly string[]).includes(t) ? (t as Verdict) : null
}

/** A row's verdict: the stored key, else replayed from the grid. */
export function verdictOf(e: Pick<ScoreEntry, 'verdict' | 'match' | 'ease' | 'eligibility'>): Verdict | null {
  if (e.verdict) return e.verdict
  return assignVerdict(e)?.verdict ?? null
}

/** Blocked = eligibility red (or a stored `blocked` verdict). */
export function isBlocked(e: Pick<ScoreEntry, 'eligibility' | 'verdict'>): boolean {
  return e.eligibility === 'red' || e.verdict === 'blocked'
}

/** True when the row carries both scores (i.e. it is not blocked/unscored). */
export function isScored(e: Pick<ScoreEntry, 'match' | 'ease' | 'eligibility'>): boolean {
  return e.eligibility !== 'red' && e.match != null && e.ease != null
}

/** "8.3 · 5.6" — the compact Match · Ease display (DESIGN-meta § Match · Ease). */
export function formatMatchEase(match: number | null | undefined, ease: number | null | undefined): string {
  if (match == null || ease == null) return '—'
  return `${match.toFixed(1)} · ${ease.toFixed(1)}`
}

/** The red reason to show in place of the scores on a blocked row. */
export function blockedReason(e: Pick<ScoreEntry, 'eligibility_flags'>): string {
  const red = parseEligibilityFlags(e.eligibility_flags).find(f => f.status === 'red')
  if (!red) return 'Not eligible'
  return red.reason || eligibilityCheckLabel(red.check)
}

/* ───── helpers ───────────────────────────────────────────────────────────── */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
