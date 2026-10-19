// scoreTrend.ts — renderer-side mirror of scripts/lib/score-trend-core.mjs.
//
// The `score-trend` capability answers two questions the flat Trends view
// can't: (1) how did a *given* company+role MOVE across its own
// re-evaluations, and (2) is the evaluated landscape trending over calendar
// time. This module reproduces that math against the ScoreEntry[] already in
// the data store — no shelling out to the CLI.
//
// SOURCE OF TRUTH: scripts/lib/score-trend-core.mjs (`analyzeTrend`). This is
// a typed port of it: the SAME field names, the SAME semantics, the SAME sort
// order and recommendation copy. The renderer bundle cannot import scripts/,
// so the port lives here; scoreTrend.test.ts runs one fixture through both
// and compares the outputs, so a drift fails the suite.
//
// SCORING v2 (docs/scoring-v2.md §9): there is no Overall. Every claim is
// stated on WANT and EASE SEPARATELY, each against its own noise floor; the
// band of a row is its VERDICT, never a cut-off on a number.
//
// BLOCKED EVALUATIONS (eligibility red — no Want, no Ease): they never enter a
// Want / Ease number, but they DO count as evaluations for the verdict axis,
// so a listing that went blocked → scored (or back) shows up as a verdict
// upgrade / downgrade. A verdict move that touches `blocked` is always
// detectable; one between two scored cells is detectable only when the Want
// or Ease move behind it cleared its floor.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.3 — the gates
// (≥2 evals per trajectory, ≥10 scored evals per calendar window), the floors
// and the confidence tiers live in lib/scoringStats.ts. Never re-declare them.

import type { ScoreEntry, Verdict } from '@/types'
import {
  GATES, NOISE_FLOORS, classifyMovement, confidenceTier,
  type ConfidenceTier, type MovementClass,
} from '@/lib/scoringStats'
import {
  DIM_LABELS, EASE_DIMS, HYGIENE_DIMS, MOTIVATOR_DIMS, VERDICT_LABELS, VERDICT_RANK,
  isBlocked, isScored as hasBothScores, verdictOf as storedOrReplayedVerdict,
  type V2DimKey,
} from '@/lib/scoreBands'

export type { ConfidenceTier, MovementClass }

/** The two score metrics this module classifies, each on its own floor. */
export type TrendMetric = 'want' | 'ease'
export const TREND_METRICS: readonly TrendMetric[] = ['want', 'ease'] as const

const METRIC_LABEL: Record<TrendMetric, string> = { want: 'Want', ease: 'Ease' }

/** Scored verdicts tallied per calendar window (blocked is counted apart). */
export type ScoredVerdict = Exclude<Verdict, 'blocked'>
const SCORED_VERDICTS: readonly ScoredVerdict[] = ['go', 'stretch', 'solid', 'thin', 'growth', 'skip']

/** Verdicts that count as "worth applying to" (targeting-core ACTIONABLE_VERDICTS). */
const ACTIONABLE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['go', 'stretch', 'solid'])

const round2 = (n: number) => Math.round(n * 100) / 100
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr: number[]) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`)
const byDateAsc = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

// ─── Canonical key normalization ──────────────────────────────────────────────
// Same scheme as scripts/lib/dedup-index.mjs (normalizeCompany / normalizeRole)
// so a re-eval that drifted in spelling collapses onto one trajectory.
export function normalizeCompany(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
export function normalizeRole(role: string): string {
  return (role || '').toLowerCase().replace(/\s+/g, ' ').trim()
}
export function listingKey(company: string, role: string): string {
  return `${normalizeCompany(company)}\t${normalizeRole(role)}`
}

// ─── Dimensions (targeting-core DIMENSIONS) ───────────────────────────────────

export type DimGroup = 'motivator' | 'hygiene' | 'ease'
export interface DimensionDef {
  key: V2DimKey
  label: string
  group: DimGroup
  rollup: TrendMetric
}

/** The ten v2 dimensions, in report order, with the rollup each feeds. */
export const DIMENSIONS: ReadonlyArray<DimensionDef> = [
  ...MOTIVATOR_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'motivator' as const, rollup: 'want' as const })),
  ...HYGIENE_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'hygiene' as const, rollup: 'want' as const })),
  ...EASE_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'ease' as const, rollup: 'ease' as const })),
]

// ─── Row predicates (targeting-core isScored / isBlocked) ─────────────────────

/** True when the row carries a finite Want and Ease and isn't Blocked. */
export function isScoredRow(r: ScoreEntry): boolean {
  return !isBlocked(r) && hasBothScores(r)
    && Number.isFinite(r.want as number) && Number.isFinite(r.ease as number)
}

/** Rows a score number may use: scored and dated. */
export function scoredRows(rows: ScoreEntry[]): ScoreEntry[] {
  return rows.filter(r => isScoredRow(r) && !!r.date)
}

/** A row this module can place on the verdict axis: scored or blocked. */
function hasVerdict(r: ScoreEntry): boolean {
  return isBlocked(r) || isScoredRow(r)
}

/** The verdict of a row, normalized ('blocked' for any blocked row). */
function verdictOfRow(r: ScoreEntry): Verdict | null {
  return isBlocked(r) ? 'blocked' : storedOrReplayedVerdict(r)
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DimDelta extends DimensionDef {
  from: number
  to: number
  delta: number
}

/** One metric's first → latest track over the SCORED evals of a listing. */
export interface MetricTrack {
  first: number | null
  latest: number | null
  /** Null when fewer than two scored evals (nothing to classify). */
  delta: number | null
  peak: number | null
  trough: number | null
  /** The honest read against THIS metric's noise floor. 'within-noise' is a
   *  RESULT: no arrow, no sign colour, no directional verb. 'unknown' when
   *  there is no score movement to classify (n < 2). */
  movementClass: MovementClass
  /** |delta| ≥ noiseFloor. */
  detectable: boolean
  noiseFloor: number
  /** Scored evaluations behind the track. */
  n: number
  confidence: ConfidenceTier
  /** The dimension that drove a move past the floor — null for a
   *  within-noise move (docs § 2: a dim delta is only ever shown as a driver). */
  topMover: DimDelta | null
}

export type VerdictMove = 'upgrade' | 'downgrade' | 'same' | 'unknown'

export interface TrajectoryPoint {
  date: string
  want: number | null
  ease: number | null
  verdict: Verdict | null
}

export interface Trajectory {
  key: string
  company: string
  role: string
  /** Evaluations on distinct dates (scored + blocked). */
  evals: number
  scoredEvals: number
  blockedEvals: number
  firstDate: string
  latestDate: string
  want: MetricTrack
  ease: MetricTrack
  verdictFrom: Verdict | null
  verdictTo: Verdict | null
  verdictMove: VerdictMove
  verdictChanged: boolean
  verdictMoveDetectable: boolean
  blockedFrom: boolean
  blockedTo: boolean
  /** docs § 3.3, gate = 2 evals — a two-point trajectory is `low`. */
  confidence: ConfidenceTier
  dimDeltas: DimDelta[]
  sequence: TrajectoryPoint[]
}

export interface MetricSummary {
  /** Trajectories with a finite delta on this metric (≥2 scored evals). */
  n: number
  improving: number
  declining: number
  withinNoise: number
  detectable: number
  avgDelta: number
  medianDelta: number
  noiseFloor: number
}

export interface TrajectorySummary {
  reevaluated: number
  want: MetricSummary
  ease: MetricSummary
  verdictMoves: Record<VerdictMove, number>
}

export interface VerdictMoveListing {
  key: string
  company: string
  role: string
  from: Verdict | null
  to: Verdict | null
  firstDate: string
  latestDate: string
  evals: number
  detectable: boolean
}

/** Listings whose verdict moved one way, gated as a corpus claim. */
export interface VerdictMoveBlock {
  count: number
  detectable: number
  /** Listings compared (verdict move known). */
  n: number
  gate: number
  confidence: ConfidenceTier
  /** True when n is under the gate: counts are facts, not a direction. */
  insufficientData: boolean
  listings: VerdictMoveListing[]
}

export interface VerdictMoves {
  verdictUpgrades: VerdictMoveBlock
  verdictDowngrades: VerdictMoveBlock
}

export interface WindowStats {
  /** Scored evaluations in the window. */
  count: number
  /** Blocked evaluations in the window (never in a number). */
  blocked: number
  dateRange: { from: string; to: string }
  actionableCount: number
  /** % of the window's scored verdicts that are go / stretch / solid. */
  actionableShare: number
  verdicts: Record<ScoredVerdict, number>
}

/** The contract read of a corpus-level claim (docs § 3.3): withheld under the
 *  per-window gate, flat when the window-mean delta is under the metric's
 *  noise floor, a direction only when both gates pass. */
export type ReportableVerdict = 'insufficient-data' | 'flat-within-noise' | 'improving' | 'declining' | 'unknown'

/** One metric's earlier → later window trend. Under the gate the numbers stay
 *  auditable but carry no class and no direction. */
export interface MetricTrend {
  earlier: number | null
  later: number | null
  delta: number | null
  medianEarlier: number | null
  medianLater: number | null
  movementClass: MovementClass | 'insufficient-data'
  reportableVerdict: ReportableVerdict
  detectable: boolean
  noiseFloor: number
  n: number
  confidence: ConfidenceTier
}

/** Whether a corpus verdict may be spoken at all, and the shortfall if not. */
export interface VerdictGate {
  minPerWindow: number
  earlierCount: number
  laterCount: number
  met: boolean
  /** Null when met; otherwise the exact shortfall, for verbatim rendering. */
  reason: string | null
}

/** Fields every landscape-trend result carries, on BOTH branches. */
interface TrendCommon extends VerdictMoves {
  evaluated: number
  blocked: number
  distinctDates: number
  want: MetricTrend
  ease: MetricTrend
  verdictGate: VerdictGate
  verdictConfidence: ConfidenceTier
}

export type LandscapeTrend =
  | ({
      insufficientData: true
      reason: string
      splitDate: null
      earlier: null
      later: null
      actionableShareDelta: null
    } & TrendCommon)
  | ({
      insufficientData: false
      splitDate: string
      earlier: WindowStats
      later: WindowStats
      /** Actionable share later − earlier, in percentage points. */
      actionableShareDelta: number
    } & TrendCommon)

export interface TrendRecommendation {
  action: string
  reasoning: string
  impact: 'high' | 'medium' | 'low'
  /** The sample and tier behind the claim (docs § 4 rule 1). */
  confidence?: ConfidenceTier
  sampleSize?: number
  gate?: number
  /** True when this rec IS the withheld-verdict marker. */
  insufficientData?: boolean
}

export interface TrendContractMeta {
  doc: string
  noiseFloors: Record<TrendMetric, number>
  minEvalsPerTrajectory: number
  minPerWindowForVerdict: number
}

export interface ScoreTrendAnalysis {
  error?: string
  metadata?: {
    evaluated: number
    /** Blocked rows in the history — excluded from every score number. */
    blocked: number
    reevaluatedListings: number
    dateRange: { from: string; to: string }
    analysisDate: string
    contract: TrendContractMeta
  }
  trajectorySummary?: TrajectorySummary
  listingTrajectories?: Trajectory[]
  landscapeTrend?: LandscapeTrend
  recommendations?: TrendRecommendation[]
}

export interface ScoreTrendOpts {
  /** Row floor per calendar window before any split is attempted (default 3). */
  minPerWindow?: number
  /** Contract gate for the corpus verdict (docs § 3.3). Defaults to 10. */
  minPerWindowForVerdict?: number
  /** Per-metric floor overrides (inspection / tests only). */
  wantFloor?: number
  easeFloor?: number
  /** Smallest listing move a recommendation fires on (default 0.5). */
  minDelta?: number
}

function floorsFrom(opts: ScoreTrendOpts = {}): Record<TrendMetric, number> {
  return {
    want: Number.isFinite(opts.wantFloor) ? (opts.wantFloor as number) : NOISE_FLOORS.want,
    ease: Number.isFinite(opts.easeFloor) ? (opts.easeFloor as number) : NOISE_FLOORS.ease,
  }
}

/**
 * The verdict move between two verdict keys, by VERDICT_RANK
 * (blocked < skip < thin < growth < solid < stretch < go).
 */
export function verdictMove(from: Verdict | null, to: Verdict | null): VerdictMove {
  const a = from ? VERDICT_RANK[from] ?? -1 : -1
  const b = to ? VERDICT_RANK[to] ?? -1 : -1
  if (a < 0 || b < 0) return 'unknown'
  if (b > a) return 'upgrade'
  if (b < a) return 'downgrade'
  return 'same'
}

// ─── Per-listing trajectories ──────────────────────────────────────────────────
// Group evaluations (scored or blocked) by canonical key; a listing is a
// trajectory with evaluations on 2+ DISTINCT dates (same-date duplicate writes
// collapse to the last one). Want / Ease are tracked over the scored evals;
// the verdict move is read off the first and latest eval, blocked included.

function metricTrack(scoredSeq: ScoreEntry[], metric: TrendMetric, floor: number, dimDeltas: DimDelta[]): MetricTrack {
  const values = scoredSeq.map(e => e[metric] as number)
  const n = values.length
  const base: MetricTrack = {
    first: n ? round2(values[0]) : null,
    latest: n ? round2(values[n - 1]) : null,
    delta: null,
    peak: n ? round2(Math.max(...values)) : null,
    trough: n ? round2(Math.min(...values)) : null,
    movementClass: 'unknown',
    detectable: false,
    noiseFloor: floor,
    n,
    confidence: 'insufficient',
    topMover: null,
  }
  if (n < GATES.trendMinEvals) return base
  const delta = round2(values[n - 1] - values[0])
  const detectable = Math.abs(delta) >= floor
  const topMover = detectable
    ? (dimDeltas
        .filter(d => d.rollup === metric && d.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null)
    : null
  return {
    ...base,
    delta,
    movementClass: classifyMovement(delta, { floor }),
    detectable,
    confidence: confidenceTier(n, GATES.trendMinEvals),
    topMover,
  }
}

/** How far past its floor a trajectory's biggest score move went (sort key). */
function salience(t: Trajectory): number {
  const w = Number.isFinite(t.want.delta) ? Math.abs(t.want.delta as number) / t.want.noiseFloor : 0
  const e = Number.isFinite(t.ease.delta) ? Math.abs(t.ease.delta as number) / t.ease.noiseFloor : 0
  return Math.max(w, e)
}

export function listingTrajectories(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): Trajectory[] {
  const floors = floorsFrom(opts)
  const groups = new Map<string, { key: string; company: string; role: string; evals: ScoreEntry[] }>()
  for (const r of rows || []) {
    if (!r || !r.date) continue
    if (!hasVerdict(r)) continue // neither scored nor blocked: nothing to place
    const key = listingKey(r.company, r.role)
    if (!groups.has(key)) groups.set(key, { key, company: r.company, role: r.role, evals: [] })
    groups.get(key)!.evals.push(r)
  }

  const trajectories: Trajectory[] = []
  for (const g of groups.values()) {
    const byDate = new Map<string, ScoreEntry>()
    for (const e of g.evals) byDate.set(e.date, e)
    const seq = [...byDate.values()].sort(byDateAsc)
    if (seq.length < GATES.trendMinEvals) continue // not re-evaluated over time

    const first = seq[0]
    const latest = seq[seq.length - 1]
    const scoredSeq = seq.filter(isScoredRow)
    const firstScored = scoredSeq[0]
    const latestScored = scoredSeq[scoredSeq.length - 1]

    const dimDeltas: DimDelta[] = []
    if (scoredSeq.length >= 2) {
      for (const d of DIMENSIONS) {
        const a = firstScored[d.key]
        const b = latestScored[d.key]
        if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue
        dimDeltas.push({ ...d, from: a, to: b, delta: round2(b - a) })
      }
    }

    const want = metricTrack(scoredSeq, 'want', floors.want, dimDeltas)
    const ease = metricTrack(scoredSeq, 'ease', floors.ease, dimDeltas)

    const verdictFrom = verdictOfRow(first)
    const verdictTo = verdictOfRow(latest)
    const move = verdictMove(verdictFrom, verdictTo)
    const blockedFrom = verdictFrom === 'blocked'
    const blockedTo = verdictTo === 'blocked'
    const verdictChanged = move === 'upgrade' || move === 'downgrade'
    const verdictMoveDetectable = verdictChanged
      && (blockedFrom !== blockedTo || want.detectable || ease.detectable)

    trajectories.push({
      key: g.key,
      company: g.company,
      role: g.role,
      evals: seq.length,
      scoredEvals: scoredSeq.length,
      blockedEvals: seq.length - scoredSeq.length,
      firstDate: first.date,
      latestDate: latest.date,
      want,
      ease,
      verdictFrom,
      verdictTo,
      verdictMove: move,
      verdictChanged,
      verdictMoveDetectable,
      blockedFrom,
      blockedTo,
      confidence: confidenceTier(seq.length, GATES.trendMinEvals),
      dimDeltas,
      sequence: seq.map(e => ({
        date: e.date,
        want: isScoredRow(e) ? round2(e.want as number) : null,
        ease: isScoredRow(e) ? round2(e.ease as number) : null,
        verdict: verdictOfRow(e),
      })),
    })
  }

  // Detectable verdict moves first (the story changed), then the move that
  // cleared its floor by the widest margin, then most-recently-touched.
  const rank = (t: Trajectory) => (t.verdictMoveDetectable ? 1 : 0)
  return trajectories.sort(
    (a, b) => rank(b) - rank(a) ||
      salience(b) - salience(a) ||
      (a.latestDate < b.latestDate ? 1 : a.latestDate > b.latestDate ? -1 : 0),
  )
}

function summarizeMetric(trajectories: Trajectory[], metric: TrendMetric, floor: number): MetricSummary {
  const tracked = trajectories.filter(t => t[metric] && Number.isFinite(t[metric].delta))
  const counts: Record<string, number> = { improving: 0, declining: 0, 'within-noise': 0 }
  for (const t of tracked) counts[t[metric].movementClass] = (counts[t[metric].movementClass] || 0) + 1
  const deltas = tracked.map(t => t[metric].delta as number)
  return {
    n: tracked.length,
    improving: counts.improving,
    declining: counts.declining,
    withinNoise: counts['within-noise'],
    detectable: counts.improving + counts.declining,
    avgDelta: round2(mean(deltas)),
    medianDelta: round2(median(deltas)),
    noiseFloor: floor,
  }
}

export function trajectorySummary(trajectories: Trajectory[], opts: ScoreTrendOpts = {}): TrajectorySummary {
  const floors = floorsFrom(opts)
  const list = trajectories || []
  const verdictMoves: Record<VerdictMove, number> = { upgrade: 0, downgrade: 0, same: 0, unknown: 0 }
  for (const t of list) verdictMoves[t.verdictMove ?? 'unknown'] = (verdictMoves[t.verdictMove ?? 'unknown'] || 0) + 1
  return {
    reevaluated: list.length,
    want: summarizeMetric(list, 'want', floors.want),
    ease: summarizeMetric(list, 'ease', floors.ease),
    verdictMoves,
  }
}

// ─── Verdict moves (per-listing, rolled up for the corpus) ─────────────────────

function verdictMoveBlock(compared: Trajectory[], kind: 'upgrade' | 'downgrade', gate: number): VerdictMoveBlock {
  const hits = compared.filter(t => t.verdictMove === kind)
  return {
    count: hits.length,
    detectable: hits.filter(t => t.verdictMoveDetectable).length,
    n: compared.length,
    gate,
    confidence: confidenceTier(compared.length, gate),
    insufficientData: compared.length < gate,
    listings: hits.map(t => ({
      key: t.key,
      company: t.company,
      role: t.role,
      from: t.verdictFrom,
      to: t.verdictTo,
      firstDate: t.firstDate,
      latestDate: t.latestDate,
      evals: t.evals,
      detectable: t.verdictMoveDetectable,
    })),
  }
}

export function verdictMoves(
  trajectories: Trajectory[],
  { gate = GATES.trendMinPerWindowForVerdict }: { gate?: number } = {},
): VerdictMoves {
  const compared = (trajectories || []).filter(t => t.verdictMove && t.verdictMove !== 'unknown')
  return {
    verdictUpgrades: verdictMoveBlock(compared, 'upgrade', gate),
    verdictDowngrades: verdictMoveBlock(compared, 'downgrade', gate),
  }
}

// ─── Landscape trend over calendar time ─────────────────────────────────────────
// Split scored evals into an earlier vs later window at the calendar boundary
// that balances the two windows closest to 50/50 (later = on/after boundary).

function windowStats(scored: ScoreEntry[], blockedCount: number): WindowStats {
  const verdicts = Object.fromEntries(SCORED_VERDICTS.map(v => [v, 0])) as Record<ScoredVerdict, number>
  for (const r of scored) {
    const v = verdictOfRow(r)
    if (v && v in verdicts) verdicts[v as ScoredVerdict]++
  }
  const actionableCount = scored.filter(r => { const v = verdictOfRow(r); return v != null && ACTIONABLE_VERDICTS.has(v) }).length
  const dates = scored.map(r => r.date).sort()
  return {
    count: scored.length,
    blocked: blockedCount,
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    actionableCount,
    actionableShare: pct(actionableCount, scored.length),
    verdicts,
  }
}

function withheldMetric(floor: number): MetricTrend {
  return {
    earlier: null,
    later: null,
    delta: null,
    medianEarlier: null,
    medianLater: null,
    movementClass: 'insufficient-data',
    reportableVerdict: 'insufficient-data',
    detectable: false,
    noiseFloor: floor,
    n: 0,
    confidence: 'insufficient',
  }
}

function metricTrend(
  earlier: ScoreEntry[], later: ScoreEntry[], metric: TrendMetric,
  floor: number, gateMet: boolean, gate: number,
): MetricTrend {
  const a = earlier.map(r => r[metric] as number)
  const b = later.map(r => r[metric] as number)
  const avgA = round2(mean(a))
  const avgB = round2(mean(b))
  const delta = round2(avgB - avgA)
  const n = Math.min(a.length, b.length)
  if (!gateMet) {
    // Under the gate: the numbers stay auditable, but no class, no direction.
    return {
      ...withheldMetric(floor),
      earlier: avgA, later: avgB, delta,
      medianEarlier: round2(median(a)), medianLater: round2(median(b)),
      n,
    }
  }
  const movementClass = classifyMovement(delta, { floor })
  return {
    earlier: avgA,
    later: avgB,
    delta,
    medianEarlier: round2(median(a)),
    medianLater: round2(median(b)),
    movementClass,
    reportableVerdict: movementClass === 'within-noise' ? 'flat-within-noise' : movementClass,
    detectable: movementClass === 'improving' || movementClass === 'declining',
    noiseFloor: floor,
    n,
    confidence: confidenceTier(n, gate),
  }
}

export function landscapeTrend(
  rows: ScoreEntry[],
  opts: ScoreTrendOpts & { trajectories?: Trajectory[] } = {},
): LandscapeTrend {
  const minPerWindow = opts.minPerWindow ?? 3
  const minPerWindowForVerdict = opts.minPerWindowForVerdict ?? GATES.trendMinPerWindowForVerdict
  const floors = floorsFrom(opts)
  const dated = (rows || []).filter(r => r && r.date)
  const scored = dated.filter(isScoredRow)
  const blocked = dated.filter(isBlocked)
  const dates = [...new Set(scored.map(r => r.date))].sort()

  // Per-listing verdict moves don't depend on the windows, so they ride on
  // every return path.
  const moves = verdictMoves(
    opts.trajectories ?? listingTrajectories(dated, { wantFloor: opts.wantFloor, easeFloor: opts.easeFloor }),
    { gate: minPerWindowForVerdict },
  )

  const withheld = (reason: string, why: string): LandscapeTrend => ({
    insufficientData: true,
    reason,
    evaluated: scored.length,
    blocked: blocked.length,
    distinctDates: dates.length,
    splitDate: null,
    earlier: null,
    later: null,
    want: withheldMetric(floors.want),
    ease: withheldMetric(floors.ease),
    actionableShareDelta: null,
    verdictGate: {
      minPerWindow: minPerWindowForVerdict,
      earlierCount: 0,
      laterCount: 0,
      met: false,
      reason: why,
    },
    verdictConfidence: 'insufficient',
    ...moves,
  })

  if (scored.length < minPerWindow * 2 || dates.length < 2) {
    return withheld(
      `Need ≥${minPerWindow * 2} scored evals across ≥2 distinct dates to trend (have ${scored.length} across ${dates.length}).`,
      `No usable time axis: ${scored.length} scored evals across ${dates.length} distinct date(s).`,
    )
  }

  let best: { boundary: string; imbalance: number } | null = null
  for (let i = 1; i < dates.length; i++) {
    const boundary = dates[i]
    const earlierCount = scored.filter(r => r.date < boundary).length
    const laterCount = scored.length - earlierCount
    if (earlierCount < minPerWindow || laterCount < minPerWindow) continue
    const imbalance = Math.abs(earlierCount - laterCount)
    if (!best || imbalance < best.imbalance) best = { boundary, imbalance }
  }

  if (!best) {
    return withheld(
      `Evaluation dates too concentrated to split into two ≥${minPerWindow}-row windows.`,
      `No calendar boundary yields two windows of ≥${minPerWindow} rows.`,
    )
  }

  const splitDate = best.boundary
  const earlier = scored.filter(r => r.date < splitDate)
  const later = scored.filter(r => r.date >= splitDate)
  const earlierWin = windowStats(earlier, blocked.filter(r => r.date < splitDate).length)
  const laterWin = windowStats(later, blocked.filter(r => r.date >= splitDate).length)

  const gateMet = earlier.length >= minPerWindowForVerdict && later.length >= minPerWindowForVerdict
  const verdictGate: VerdictGate = {
    minPerWindow: minPerWindowForVerdict,
    earlierCount: earlier.length,
    laterCount: later.length,
    met: gateMet,
    reason: gateMet
      ? null
      : `Corpus verdict withheld: ${earlier.length} scored eval(s) in the earlier window and ${later.length} in the later window; ${minPerWindowForVerdict} required in each.`,
  }
  const verdictConfidence: ConfidenceTier = gateMet
    ? confidenceTier(Math.min(earlier.length, later.length), minPerWindowForVerdict)
    : 'insufficient'

  return {
    insufficientData: false,
    evaluated: scored.length,
    blocked: blocked.length,
    distinctDates: dates.length,
    splitDate,
    earlier: earlierWin,
    later: laterWin,
    want: metricTrend(earlier, later, 'want', floors.want, gateMet, minPerWindowForVerdict),
    ease: metricTrend(earlier, later, 'ease', floors.ease, gateMet, minPerWindowForVerdict),
    actionableShareDelta: laterWin.actionableShare - earlierWin.actionableShare,
    verdictGate,
    verdictConfidence,
    ...moves,
  }
}

// ─── Recommendations ────────────────────────────────────────────────────────────
// Conservative: only fire on movement that cleared its floor. Surfaces (a) the
// sharpest decliner worth re-checking, (b) the strongest improver worth
// prioritizing and (c) the gated landscape line.

/** "verdict Solid → Skip · Want 7.2 → 6.1 (−1.1) · Ease flat within noise". */
export function describeTrajectory(t: Trajectory): string {
  const parts: string[] = []
  if (t.verdictChanged) {
    const from = t.verdictFrom ? VERDICT_LABELS[t.verdictFrom] ?? t.verdictFrom : String(t.verdictFrom)
    const to = t.verdictTo ? VERDICT_LABELS[t.verdictTo] ?? t.verdictTo : String(t.verdictTo)
    parts.push(`verdict ${from} → ${to}`)
  }
  for (const m of TREND_METRICS) {
    const track = t[m]
    if (!track || !Number.isFinite(track.delta)) continue
    parts.push(track.detectable
      ? `${METRIC_LABEL[m]} ${track.first} → ${track.latest} (${signed(track.delta as number)})`
      : `${METRIC_LABEL[m]} flat within noise`)
  }
  return parts.join(' · ')
}

/** Normalized size of a trajectory's move in one direction (0 when none). */
function directionalWeight(t: Trajectory, direction: 'improving' | 'declining', minDelta: number): number {
  let w = 0
  const verdictHit = direction === 'declining' ? 'downgrade' : 'upgrade'
  if (t.verdictMove === verdictHit && t.verdictMoveDetectable) w = 100 // verdict moves lead
  for (const m of TREND_METRICS) {
    const track = t[m]
    if (!track || track.movementClass !== direction) continue
    if (Math.abs(track.delta as number) < minDelta) continue
    w += Math.abs(track.delta as number) / track.noiseFloor
  }
  return w
}

function trajectoryRec(t: Trajectory, direction: 'improving' | 'declining'): TrendRecommendation {
  const declining = direction === 'declining'
  const driverTrack = TREND_METRICS.map(m => t[m]).find(tr => tr?.movementClass === direction && tr.topMover)
  const driver = driverTrack?.topMover
  const verb = declining ? 'Re-check' : 'Prioritize'
  let reasoning: string
  if (t.blockedFrom !== t.blockedTo) {
    reasoning = t.blockedTo
      ? 'The latest evaluation is Blocked: an eligibility check turned red. Re-read the JD before spending more on it.'
      : 'It was Blocked on an earlier evaluation and now passes the eligibility gate.'
  } else if (driver) {
    reasoning = `${driver.label} moved ${signed(driver.delta)} between first and latest evaluation, the main driver of the ${declining ? 'decline' : 'climb'}.`
  } else {
    reasoning = declining
      ? 'The role scored materially lower on re-evaluation.'
      : 'Improving on re-evaluation; act before the posting closes.'
  }
  return {
    action: `${verb} "${t.company} — ${t.role}": ${describeTrajectory(t)} across ${t.evals} evals`,
    reasoning,
    impact: t.verdictChanged && t.verdictMoveDetectable ? 'high' : 'medium',
    confidence: t.confidence,
    sampleSize: t.evals,
  }
}

/** "Want improving (7.1 vs 6.4 earlier, +0.7)" or "Want flat within noise (|Δ| 0.10 < 0.30 floor)". */
function describeMetricTrend(m: TrendMetric, block: MetricTrend): string {
  if (block.reportableVerdict === 'flat-within-noise') {
    return `${METRIC_LABEL[m]} flat within noise (|Δ| ${Math.abs(block.delta as number).toFixed(2)} < ${block.noiseFloor.toFixed(2)} floor)`
  }
  return `${METRIC_LABEL[m]} ${block.reportableVerdict} (${block.later} vs ${block.earlier} earlier, ${signed(block.delta as number)})`
}

export function trendRecommendations(
  trajectories: Trajectory[],
  trend: LandscapeTrend | null | undefined,
  { minDelta = 0.5 }: ScoreTrendOpts = {},
): TrendRecommendation[] {
  const recs: TrendRecommendation[] = []
  const list = trajectories || []

  const pick = (direction: 'improving' | 'declining') => list
    .map(t => ({ t, w: directionalWeight(t, direction, minDelta) }))
    .filter(x => x.w > 0)
    .sort((a, b) => b.w - a.w)[0]?.t

  // 1. Sharpest decliner — a role the user was warming to that's now sliding.
  const worst = pick('declining')
  if (worst) recs.push(trajectoryRec(worst, 'declining'))

  // 2. Strongest improver — prioritize before it closes.
  const best = pick('improving')
  if (best && best !== worst) recs.push(trajectoryRec(best, 'improving'))

  // 3. Landscape line — gated (docs § 3.3). Under the ≥10-per-window gate the
  //    corpus claim is NOT rendered in a weaker form; an explicit
  //    insufficient-data marker replaces it.
  if (!trend || trend.insufficientData || !trend.verdictGate) return recs
  const sampleSize = Math.min(trend.verdictGate.earlierCount, trend.verdictGate.laterCount)
  const gate = trend.verdictGate.minPerWindow
  const counts = `${trend.verdictGate.earlierCount} earlier vs ${trend.verdictGate.laterCount} later scored evals`

  if (!trend.verdictGate.met) {
    recs.push({
      action: 'Landscape trend: insufficient data — corpus verdict withheld',
      reasoning: `${trend.verdictGate.reason} A window mean built on fewer evaluations can be moved past the Want (${trend.want.noiseFloor}) or Ease (${trend.ease.noiseFloor}) noise floor by a single role, so the direction would be a report about one listing. Keep evaluating; the verdict unlocks itself.`,
      impact: 'low',
      insufficientData: true,
      confidence: 'insufficient',
      sampleSize,
      gate,
    })
    return recs
  }

  const verdicts = TREND_METRICS.map(m => trend[m].reportableVerdict)
  const shareNote = `actionable share ${trend.earlier.actionableShare}% → ${trend.later.actionableShare}% (${signed(trend.actionableShareDelta)} pts)`
  const metricsLine = TREND_METRICS.map(m => describeMetricTrend(m, trend[m])).join('; ')

  if (verdicts.every(v => v === 'flat-within-noise')) {
    recs.push({
      action: `Landscape trend: flat within noise — ${metricsLine}`,
      reasoning: `Neither window-mean gap clears its floor, which is what one dimension re-judging itself produces. Targeting is neither sharpening nor sliding on this evidence; ${shareNote} (${counts}, ${trend.verdictConfidence} confidence).`,
      impact: 'low',
      confidence: trend.verdictConfidence,
      sampleSize,
      gate,
    })
    return recs
  }

  const anyDeclining = verdicts.includes('declining')
  const anyImproving = verdicts.includes('improving')
  const headline = anyDeclining && anyImproving
    ? 'Landscape trend is mixed'
    : anyDeclining ? 'Evaluated landscape is sliding' : 'Targeting is sharpening'
  const advice = anyDeclining && anyImproving
    ? 'Want and Ease moved in opposite directions: read them separately before changing scan scope.'
    : anyDeclining
      ? "Lately you're evaluating roles you want less, or can reach less easily, than before. Re-tighten scan keywords or raise the pre-evaluation bar before scoring more."
      : 'The roles you have evaluated lately sit higher than your earlier ones. Keep sourcing the way you have been.'
  recs.push({
    action: `${headline} — ${metricsLine}`,
    reasoning: `${advice} ${shareNote[0].toUpperCase()}${shareNote.slice(1)} (${counts}; ${trend.verdictConfidence} confidence). This states what moved, not why: a different segment of the market on either side of ${trend.splitDate} produces the same shape.`,
    impact: anyDeclining ? 'high' : 'medium',
    confidence: trend.verdictConfidence,
    sampleSize,
    gate,
  })
  return recs
}

// ─── Top-level analysis (core `analyzeTrend`) ───────────────────────────────────
export function analyzeScoreTrend(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): ScoreTrendAnalysis {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score history.' }
  }
  const scored = rows.filter(isScoredRow)
  const blocked = rows.filter(isBlocked)
  if (scored.length === 0) {
    return {
      error: `No scored evaluations in score history (${rows.length} row(s), ${blocked.length} blocked).`,
    }
  }

  const floors = floorsFrom(opts)
  const trajectories = listingTrajectories(rows, opts)
  const trend = landscapeTrend(rows, { ...opts, trajectories })
  const dates = rows.filter(hasVerdict).map(r => r.date).filter(Boolean).sort()

  return {
    metadata: {
      evaluated: scored.length,
      blocked: blocked.length,
      reevaluatedListings: trajectories.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      contract: {
        doc: 'docs/scoring-statistical-design.md',
        noiseFloors: { want: floors.want, ease: floors.ease },
        minEvalsPerTrajectory: GATES.trendMinEvals,
        minPerWindowForVerdict: opts.minPerWindowForVerdict ?? GATES.trendMinPerWindowForVerdict,
      },
    },
    trajectorySummary: trajectorySummary(trajectories, opts),
    listingTrajectories: trajectories,
    landscapeTrend: trend,
    recommendations: trendRecommendations(trajectories, trend, opts),
  }
}
