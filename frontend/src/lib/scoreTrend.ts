// scoreTrend.ts — renderer-side mirror of scripts/lib/score-trend-core.mjs.
//
// The `score-trend` capability answers two questions the flat Trends view
// can't: (1) how did a *given* company+role MOVE across its own
// re-evaluations, and (2) is the evaluated landscape trending over calendar
// time. This module reproduces that math against the ScoreEntry[] already in
// the data store — no shelling out to the CLI.
//
// SCORING v2 (docs/scoring-v2.md §9): there is no Overall. Every claim is
// stated on WANT and EASE SEPARATELY, each against its own noise floor
// (WANT_NOISE_FLOOR 0.30, EASE_NOISE_FLOOR 0.35); the band of a row is its
// VERDICT, never a cut-off on a number. Blocked rows carry no scores and are
// excluded from every score trend. Ease is point-in-time, so its trajectory
// is the positioning canary.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md — the gates
// (≥2 evals per trajectory, ≥10 scored evals per calendar window) and the
// confidence tiers live in lib/scoringStats.ts. Never re-declare them here.
//
// NOTE for the analytics round: scripts/lib/score-trend-core.mjs is being
// re-derived for v2 separately; this mirror is the frontend's reading of the
// spec and may need reconciling with the core's final shape.

import type { ScoreEntry, Verdict } from '@/types'
import {
  GATES, NOISE_FLOORS, classifyMovement, confidenceTier,
  type ConfidenceTier, type MovementClass,
} from '@/lib/scoringStats'
import { DIM_LABELS, JUDGED_DIMS, VERDICT_RANK, isScored, verdictOf, type JudgedDimKey } from '@/lib/scoreBands'

export type { ConfidenceTier, MovementClass }

/** The two axes every trend is stated on. */
export type TrendMetric = 'want' | 'ease'
export const TREND_METRICS: readonly TrendMetric[] = ['want', 'ease'] as const

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

/** The nine judged v2 dimensions whose movement we attribute a delta to. */
export const DIMENSIONS: ReadonlyArray<{ key: JudgedDimKey; label: string }> =
  JUDGED_DIMS.map(key => ({ key, label: DIM_LABELS[key] }))

/** Verdicts the ethical-use rule allows applying to (spec §4): the
 *  "apply-worthy share" replaces v1's strong/solid share. */
const APPLY_WORTHY: ReadonlySet<Verdict> = new Set<Verdict>(['go', 'stretch', 'solid'])

const round2 = (n: number) => Math.round(n * 100) / 100
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr: number[]) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The contract read of a corpus-level claim (docs § 3.3): withheld under the
 *  per-window gate, flat when the window-mean delta is under the metric's
 *  noise floor, a direction only when both gates pass. */
export type ReportableVerdict = 'insufficient-data' | 'flat-within-noise' | 'improving' | 'declining' | 'unknown'

/** Whether a corpus verdict may be spoken at all, and the shortfall if not. */
export interface VerdictGate {
  minPerWindow: number
  olderCount: number
  recentCount: number
  met: boolean
  /** Null when met; otherwise the exact shortfall, for verbatim rendering. */
  reason: string | null
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DimDelta {
  key: JudgedDimKey
  label: string
  from: number
  to: number
  delta: number
}

/** One metric's first → latest move on one listing. */
export interface MetricMove {
  first: number
  latest: number
  delta: number
  peak: number
  trough: number
  /** The honest read against THIS metric's noise floor. 'within-noise' is a
   *  RESULT: no arrow, no sign colour, no directional verb. */
  movementClass: MovementClass
  /** |delta| ≥ noiseFloor. */
  detectable: boolean
  noiseFloor: number
}

export interface Trajectory {
  key: string
  company: string
  role: string
  evals: number
  firstDate: string
  latestDate: string
  want: MetricMove
  ease: MetricMove
  verdictFrom: Verdict | null
  verdictTo: Verdict | null
  verdictChanged: boolean
  /** True when either metric's move cleared its floor. */
  detectable: boolean
  /** docs § 3.1, gate = 2 evals — a two-point trajectory is `low`. */
  confidence: ConfidenceTier
  dimDeltas: DimDelta[]
  topMover: DimDelta | null
  sequence: Array<{ date: string; want: number; ease: number; verdict: Verdict | null }>
}

export interface MetricSummary {
  movement: Record<MovementClass, number>
  avgDelta: number
  medianDelta: number
  withinNoise: number
  detectable: number
  noiseFloor: number
}

export interface TrajectorySummary {
  reevaluated: number
  want: MetricSummary
  ease: MetricSummary
  /** Trajectories that moved into a better / worse verdict cell. */
  verdictUpgrades: number
  verdictDowngrades: number
  /** Trajectories where at least one metric cleared its floor. */
  detectable: number
}

export interface WindowStats {
  count: number
  avgWant: number
  avgEase: number
  medianWant: number
  medianEase: number
  /** % of the window's verdicts that are go / stretch / solid. */
  applyWorthyShare: number
  dateRange: { from: string; to: string }
}

export interface MetricTrend {
  delta: number
  movement: MovementClass
  reportableVerdict: ReportableVerdict
  noiseFloor: number
}

/** Fields every landscape-trend result carries, on BOTH branches. */
interface TrendContract {
  verdictGate: VerdictGate
  verdictConfidence: ConfidenceTier
  want: MetricTrend
  ease: MetricTrend
}

export type LandscapeTrend =
  | ({
      insufficientData: true
      reason: string
      evaluated: number
      distinctDates: number
    } & TrendContract)
  | ({
      insufficientData: false
      splitDate: string
      older: WindowStats
      recent: WindowStats
      applyWorthyShareDelta: number
    } & TrendContract)

export interface TrendRecommendation {
  action: string
  reasoning: string
  impact: 'high' | 'medium' | 'low'
  /** The sample and tier behind a corpus claim (docs § 4 rule 1). */
  confidence?: ConfidenceTier
  sampleSize?: number
  gate?: number
  /** True when this rec IS the withheld-verdict marker. */
  insufficientData?: boolean
}

export interface ScoreTrendAnalysis {
  error?: string
  metadata?: {
    evaluated: number
    /** Blocked rows in the history — excluded from every score trend. */
    blocked: number
    reevaluatedListings: number
    dateRange: { from: string; to: string }
    contract: TrendContractMeta
  }
  trajectorySummary?: TrajectorySummary
  listingTrajectories?: Trajectory[]
  landscapeTrend?: LandscapeTrend
  recommendations?: TrendRecommendation[]
}

export interface TrendContractMeta {
  doc: string
  noiseFloors: Record<TrendMetric, number>
  minEvalsPerTrajectory: number
  minPerWindowForVerdict: number
}

export interface ScoreTrendOpts {
  minPerWindow?: number
  minDelta?: number
  /** Contract gate for the corpus verdict (docs § 3.3). Defaults to 10. */
  minPerWindowForVerdict?: number
  /** Per-metric floor overrides (tests). */
  noiseFloors?: Partial<Record<TrendMetric, number>>
}

const floorsOf = (opts: ScoreTrendOpts): Record<TrendMetric, number> => ({
  want: opts.noiseFloors?.want ?? NOISE_FLOORS.want,
  ease: opts.noiseFloors?.ease ?? NOISE_FLOORS.ease,
})

/** Rows a score trend may use: scored (Want and Ease present), not blocked,
 *  dated. */
export function scoredRows(rows: ScoreEntry[]): ScoreEntry[] {
  return rows.filter(r => isScored(r) && !!r.date)
}

function metricMove(values: number[], floor: number): MetricMove {
  const first = values[0]
  const latest = values[values.length - 1]
  const delta = round2(latest - first)
  return {
    first: round2(first),
    latest: round2(latest),
    delta,
    peak: round2(Math.max(...values)),
    trough: round2(Math.min(...values)),
    movementClass: classifyMovement(delta, { floor }),
    detectable: Math.abs(delta) >= floor,
    noiseFloor: floor,
  }
}

// ─── Per-listing trajectories ──────────────────────────────────────────────────
// Group SCORED evaluations by canonical key; a listing is a "trajectory" only
// with 2+ evals on DISTINCT dates (same-date duplicate writes collapse to the
// last one).
export function listingTrajectories(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): Trajectory[] {
  const floors = floorsOf(opts)
  const groups = new Map<string, { key: string; company: string; role: string; evals: ScoreEntry[] }>()
  for (const r of scoredRows(rows)) {
    const key = listingKey(r.company, r.role)
    if (!groups.has(key)) groups.set(key, { key, company: r.company, role: r.role, evals: [] })
    groups.get(key)!.evals.push(r)
  }

  const trajectories: Trajectory[] = []
  for (const g of groups.values()) {
    const byDate = new Map<string, ScoreEntry>()
    for (const e of g.evals) byDate.set(e.date, e)
    const seq = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (seq.length < 2) continue

    const first = seq[0]
    const latest = seq[seq.length - 1]
    const want = metricMove(seq.map(e => e.want as number), floors.want)
    const ease = metricMove(seq.map(e => e.ease as number), floors.ease)

    const dimDeltas: DimDelta[] = []
    for (const { key, label } of DIMENSIONS) {
      const a = first[key]
      const b = latest[key]
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue
      dimDeltas.push({ key, label, from: a, to: b, delta: round2(b - a) })
    }
    const topMover = dimDeltas
      .filter(d => d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null

    const verdictFrom = verdictOf(first)
    const verdictTo = verdictOf(latest)

    trajectories.push({
      key: g.key,
      company: g.company,
      role: g.role,
      evals: seq.length,
      firstDate: first.date,
      latestDate: latest.date,
      want,
      ease,
      verdictFrom,
      verdictTo,
      verdictChanged: verdictFrom !== verdictTo,
      detectable: want.detectable || ease.detectable,
      confidence: confidenceTier(seq.length, GATES.trendMinEvals),
      dimDeltas,
      topMover,
      sequence: seq.map(e => ({ date: e.date, want: round2(e.want as number), ease: round2(e.ease as number), verdict: verdictOf(e) })),
    })
  }

  // Largest move on either axis (scaled to its floor) first, then most recent.
  const size = (t: Trajectory) => Math.max(Math.abs(t.want.delta) / t.want.noiseFloor, Math.abs(t.ease.delta) / t.ease.noiseFloor)
  return trajectories.sort((a, b) => size(b) - size(a) || (a.latestDate < b.latestDate ? 1 : -1))
}

function metricSummary(trajectories: Trajectory[], metric: TrendMetric, floor: number): MetricSummary {
  const movement: Record<MovementClass, number> = { improving: 0, declining: 0, 'within-noise': 0, unknown: 0 }
  for (const t of trajectories) movement[t[metric].movementClass] += 1
  const deltas = trajectories.map(t => t[metric].delta).filter(Number.isFinite)
  return {
    movement,
    avgDelta: round2(mean(deltas)),
    medianDelta: round2(median(deltas)),
    withinNoise: movement['within-noise'],
    detectable: movement.improving + movement.declining,
    noiseFloor: floor,
  }
}

export function trajectorySummary(trajectories: Trajectory[], opts: ScoreTrendOpts = {}): TrajectorySummary {
  const floors = floorsOf(opts)
  let up = 0
  let down = 0
  for (const t of trajectories) {
    if (!t.verdictChanged || !t.verdictFrom || !t.verdictTo) continue
    if (VERDICT_RANK[t.verdictTo] > VERDICT_RANK[t.verdictFrom]) up++
    else down++
  }
  return {
    reevaluated: trajectories.length,
    want: metricSummary(trajectories, 'want', floors.want),
    ease: metricSummary(trajectories, 'ease', floors.ease),
    verdictUpgrades: up,
    verdictDowngrades: down,
    detectable: trajectories.filter(t => t.detectable).length,
  }
}

// ─── Landscape trend over calendar time ─────────────────────────────────────────
// Split scored evals into an older vs recent window at the boundary that
// balances the two windows closest to 50/50.
export function landscapeTrend(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): LandscapeTrend {
  const minPerWindow = opts.minPerWindow ?? 3
  const minPerWindowForVerdict = opts.minPerWindowForVerdict ?? GATES.trendMinPerWindowForVerdict
  const floors = floorsOf(opts)
  const scored = scoredRows(rows)
  const dates = [...new Set(scored.map(r => r.date))].sort()

  const withheldMetric = (metric: TrendMetric): MetricTrend =>
    ({ delta: 0, movement: 'unknown', reportableVerdict: 'insufficient-data', noiseFloor: floors[metric] })
  const withheld = (why: string): TrendContract => ({
    verdictGate: { minPerWindow: minPerWindowForVerdict, olderCount: 0, recentCount: 0, met: false, reason: why },
    verdictConfidence: 'insufficient',
    want: withheldMetric('want'),
    ease: withheldMetric('ease'),
  })

  if (scored.length < minPerWindow * 2 || dates.length < 2) {
    return {
      insufficientData: true,
      reason: `Need ≥${minPerWindow * 2} scored evals across ≥2 distinct dates to trend (have ${scored.length} across ${dates.length}).`,
      evaluated: scored.length,
      distinctDates: dates.length,
      ...withheld(`No usable time axis: ${scored.length} scored evals across ${dates.length} distinct date(s).`),
    }
  }

  let best: { boundary: string; imbalance: number } | null = null
  for (let i = 1; i < dates.length; i++) {
    const boundary = dates[i]
    const olderCount = scored.filter(r => r.date < boundary).length
    const recentCount = scored.length - olderCount
    if (olderCount < minPerWindow || recentCount < minPerWindow) continue
    const imbalance = Math.abs(olderCount - recentCount)
    if (!best || imbalance < best.imbalance) best = { boundary, imbalance }
  }

  if (!best) {
    return {
      insufficientData: true,
      reason: `Evaluation dates too concentrated to split into two ≥${minPerWindow}-row windows.`,
      evaluated: scored.length,
      distinctDates: dates.length,
      ...withheld(`No calendar boundary yields two windows of ≥${minPerWindow} rows.`),
    }
  }

  const splitDate = best.boundary
  const older = scored.filter(r => r.date < splitDate)
  const recent = scored.filter(r => r.date >= splitDate)

  const windowStats = (arr: ScoreEntry[]): WindowStats => {
    const wants = arr.map(r => r.want as number)
    const eases = arr.map(r => r.ease as number)
    const worthy = arr.filter(r => { const v = verdictOf(r); return v != null && APPLY_WORTHY.has(v) }).length
    const sortedDates = arr.map(r => r.date).sort()
    return {
      count: arr.length,
      avgWant: round2(mean(wants)),
      avgEase: round2(mean(eases)),
      medianWant: round2(median(wants)),
      medianEase: round2(median(eases)),
      applyWorthyShare: Math.round((worthy / arr.length) * 100),
      dateRange: { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] },
    }
  }
  const o = windowStats(older)
  const r = windowStats(recent)

  const gateMet = older.length >= minPerWindowForVerdict && recent.length >= minPerWindowForVerdict
  const verdictGate: VerdictGate = {
    minPerWindow: minPerWindowForVerdict,
    olderCount: older.length,
    recentCount: recent.length,
    met: gateMet,
    reason: gateMet
      ? null
      : `Corpus verdict withheld: ${older.length} eval(s) in the earlier window and ${recent.length} in the recent window; ${minPerWindowForVerdict} required in each.`,
  }
  const metricTrend = (metric: TrendMetric, delta: number): MetricTrend => {
    const movement = classifyMovement(delta, { floor: floors[metric] })
    return {
      delta,
      movement,
      reportableVerdict: !gateMet ? 'insufficient-data' : (movement === 'within-noise' ? 'flat-within-noise' : movement),
      noiseFloor: floors[metric],
    }
  }

  return {
    insufficientData: false,
    splitDate,
    older: o,
    recent: r,
    applyWorthyShareDelta: r.applyWorthyShare - o.applyWorthyShare,
    verdictGate,
    verdictConfidence: gateMet ? confidenceTier(Math.min(older.length, recent.length), minPerWindowForVerdict) : 'insufficient',
    want: metricTrend('want', round2(r.avgWant - o.avgWant)),
    ease: metricTrend('ease', round2(r.avgEase - o.avgEase)),
  }
}

// ─── Recommendations ────────────────────────────────────────────────────────────
// Conservative: only fire on real movement (≥ minDelta AND past the floor).
const METRIC_LABEL: Record<TrendMetric, string> = { want: 'Want', ease: 'Ease' }

export function trendRecommendations(
  trajectories: Trajectory[],
  trend: LandscapeTrend,
  { minDelta = 0.5 }: ScoreTrendOpts = {},
): TrendRecommendation[] {
  const recs: TrendRecommendation[] = []

  // Worst single-axis slide, then best single-axis climb.
  const moves = trajectories.flatMap(t => TREND_METRICS.map(m => ({ t, m, mv: t[m] })))
  const worst = moves
    .filter(x => x.mv.movementClass === 'declining' && Math.abs(x.mv.delta) >= minDelta)
    .sort((a, b) => a.mv.delta - b.mv.delta)[0]
  if (worst) {
    const { t, m, mv } = worst
    recs.push({
      action: `Re-check "${t.company} — ${t.role}": ${METRIC_LABEL[m]} slid ${mv.first} → ${mv.latest} (${mv.delta}) across ${t.evals} evals`,
      reasoning: t.topMover
        ? `${t.topMover.label} moved ${t.topMover.delta} between first and latest evaluation — the main driver.`
        : `The role scored materially lower on re-evaluation.`,
      impact: t.verdictChanged ? 'high' : 'medium',
    })
  }
  const bestMove = moves
    .filter(x => x.mv.movementClass === 'improving' && x.mv.delta >= minDelta)
    .sort((a, b) => b.mv.delta - a.mv.delta)[0]
  if (bestMove) {
    const { t, m, mv } = bestMove
    recs.push({
      action: `Prioritize "${t.company} — ${t.role}": ${METRIC_LABEL[m]} climbed ${mv.first} → ${mv.latest} (+${mv.delta}) across ${t.evals} evals`,
      reasoning: t.verdictChanged && t.verdictFrom && t.verdictTo
        ? `Its verdict moved ${t.verdictFrom} → ${t.verdictTo} — it now sits in a different cell than on first look.`
        : m === 'ease'
          ? `Getting in looks more realistic than it did — act before the posting closes.`
          : `Improving on re-evaluation; act before the posting closes.`,
      impact: t.verdictChanged ? 'high' : 'medium',
    })
  }

  // Landscape-level verdicts — gated (docs § 3.3), one per metric.
  if (trend.insufficientData) return recs
  if (!trend.verdictGate.met) {
    recs.push({
      action: `Landscape trend: insufficient data — corpus verdict withheld`,
      reasoning: `${trend.verdictGate.reason} A window mean built on fewer evaluations can be moved past the noise floor by a single role, so the direction would be a report about one listing. Keep evaluating; the verdict unlocks itself.`,
      impact: 'low',
      insufficientData: true,
      confidence: 'insufficient',
      sampleSize: Math.min(trend.verdictGate.olderCount, trend.verdictGate.recentCount),
      gate: trend.verdictGate.minPerWindow,
    })
    return recs
  }
  const n = Math.min(trend.verdictGate.olderCount, trend.verdictGate.recentCount)
  const note = ` (${trend.verdictGate.olderCount} earlier vs ${trend.verdictGate.recentCount} recent evals; ${trend.verdictConfidence} confidence)`
  for (const m of TREND_METRICS) {
    const mt = trend[m]
    const avgOld = m === 'want' ? trend.older.avgWant : trend.older.avgEase
    const avgNew = m === 'want' ? trend.recent.avgWant : trend.recent.avgEase
    const base = { confidence: trend.verdictConfidence, sampleSize: n, gate: trend.verdictGate.minPerWindow }
    if (mt.reportableVerdict === 'flat-within-noise') {
      recs.push({
        action: `${METRIC_LABEL[m]} trend: flat within noise — recent evals avg ${avgNew} vs ${avgOld} earlier (Δ ${Math.abs(mt.delta).toFixed(2)})`,
        reasoning: `The gap between the two calendar windows is under the ${mt.noiseFloor} ${METRIC_LABEL[m]} noise floor — one dimension re-judging itself produces that much.${note}`,
        impact: 'low',
        ...base,
      })
    } else if (mt.reportableVerdict === 'improving') {
      recs.push({
        action: m === 'want'
          ? `Targeting is sharpening — recent evals avg Want ${avgNew} vs ${avgOld} earlier (+${mt.delta})`
          : `Roles are getting more reachable — recent evals avg Ease ${avgNew} vs ${avgOld} earlier (+${mt.delta})`,
        reasoning: m === 'want'
          ? `The roles you've evaluated lately are ones you want more${trend.applyWorthyShareDelta > 0 ? `, and the apply-worthy share rose ${trend.applyWorthyShareDelta} pts` : ''}.${note}`
          : `Ease is point-in-time — a rising Ease means your profile is closing the gaps these roles test.${note}`,
        impact: 'medium',
        ...base,
      })
    } else if (mt.reportableVerdict === 'declining') {
      recs.push({
        action: m === 'want'
          ? `Evaluated roles are less wanted — recent evals avg Want ${avgNew} vs ${avgOld} earlier (${mt.delta})`
          : `Roles are getting harder to reach — recent evals avg Ease ${avgNew} vs ${avgOld} earlier (${mt.delta})`,
        reasoning: m === 'want'
          ? `Re-tighten scan keywords or raise the pre-evaluation bar before scoring more.${note}`
          : `The scanner may be pulling more senior or more selective roles; check the experience bar on recent evaluations.${note}`,
        impact: 'high',
        ...base,
      })
    }
  }
  return recs
}

// ─── Top-level analysis ─────────────────────────────────────────────────────────
export function analyzeScoreTrend(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): ScoreTrendAnalysis {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score history.' }
  }
  const scored = scoredRows(rows)
  if (scored.length === 0) {
    return { error: 'No scored rows in score history (every row is blocked or unscored).' }
  }
  const blocked = rows.filter(r => r.eligibility === 'red' || r.verdict === 'blocked').length

  const trajectories = listingTrajectories(scored, opts)
  const trend = landscapeTrend(scored, opts)
  const dates = scored.map(r => r.date).sort()

  return {
    metadata: {
      evaluated: scored.length,
      blocked,
      reevaluatedListings: trajectories.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      contract: {
        doc: 'docs/scoring-statistical-design.md',
        noiseFloors: floorsOf(opts),
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
