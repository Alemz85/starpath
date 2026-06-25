// scoreTrend.ts — renderer-side mirror of scripts/lib/score-trend-core.mjs.
//
// The backend `score-trend` capability answers two questions the flat Trends
// view can't: (1) how did a *given* company+role's Overall MOVE across its own
// re-evaluations, and (2) is the user's evaluated quality trending up over
// calendar time. This module reproduces that math against the ScoreEntry[]
// already in the data store — no shelling out to the .mjs CLI — so the cockpit
// can render the same insights live.
//
// It is a faithful port: the canonical (company, role) key scheme, the
// stable-band verdicts, the same-date collapse, the balanced landscape split,
// and the recommendation thresholds all match the core module so the GUI and
// the CLI never disagree. Kept pure (no React, no store import) so it's unit-
// testable in isolation — mirroring how the backend keeps the math in lib/ and
// the CLI owns only I/O.
//
// Source of truth for the algorithm: scripts/lib/score-trend-core.mjs.

import type { ScoreEntry } from '@/types'

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

// ─── Score band — recomputed from Overall, never trusted from a stored column.
// Mirrors targeting-core.mjs overallBand. */
export type Band = 'strong' | 'solid' | 'pass' | 'weak' | 'unknown'
export function overallBand(overall: number): Band {
  if (!Number.isFinite(overall)) return 'unknown'
  if (overall >= 7.5) return 'strong'
  if (overall >= 7.0) return 'solid'
  if (overall >= 6.0) return 'pass'
  return 'weak'
}

// The six Current/Aspirational Fit dimensions whose movement we attribute the
// Overall delta to. Keys match the numeric fields on ScoreEntry. Mirrors
// targeting-core.mjs DIMENSIONS.
export const DIMENSIONS = [
  { key: 'skills_match',     label: 'Skills Match'       },
  { key: 'ease_of_entry',    label: 'Ease of Entry'      },
  { key: 'strategic_fit',    label: 'Strategic Fit'      },
  { key: 'growth_mobility',  label: 'Growth / Mobility'  },
  { key: 'optionality_exit', label: 'Optionality / Exit' },
  { key: 'brand_value',      label: 'Brand Value'        },
] as const

type DimKey = (typeof DIMENSIONS)[number]['key']

const round2 = (n: number) => Math.round(n * 100) / 100
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr: number[]) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export type Verdict = 'improving' | 'declining' | 'stable' | 'unknown'

/** A move verdict from a signed Overall delta. The dead-band keeps tiny scoring
 *  jitter from being labelled a real trend. Mirrors core classifyDelta. */
export function classifyDelta(delta: number, stableBand = 0.25): Verdict {
  if (!Number.isFinite(delta)) return 'unknown'
  if (delta > stableBand) return 'improving'
  if (delta < -stableBand) return 'declining'
  return 'stable'
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DimDelta {
  key: DimKey
  label: string
  from: number
  to: number
  delta: number
}

export interface Trajectory {
  key: string
  company: string
  role: string
  evals: number
  firstDate: string
  latestDate: string
  firstOverall: number
  latestOverall: number
  delta: number
  bandFrom: Band
  bandTo: Band
  bandChanged: boolean
  peakOverall: number
  troughOverall: number
  verdict: Verdict
  dimDeltas: DimDelta[]
  topMover: DimDelta | null
  sequence: Array<{ date: string; overall: number }>
}

export interface TrajectorySummary {
  reevaluated: number
  verdicts: { improving: number; declining: number; stable: number }
  avgDelta: number
  medianDelta: number
  bandUpgrades: number
  bandDowngrades: number
}

interface WindowStats {
  count: number
  avgOverall: number
  medianOverall: number
  strongSolidShare: number
  dateRange: { from: string; to: string }
}

export type LandscapeTrend =
  | {
      insufficientData: true
      reason: string
      evaluated: number
      distinctDates: number
    }
  | {
      insufficientData: false
      splitDate: string
      older: WindowStats
      recent: WindowStats
      delta: number
      strongSolidShareDelta: number
      verdict: Verdict
    }

export interface TrendRecommendation {
  action: string
  reasoning: string
  impact: 'high' | 'medium' | 'low'
}

export interface ScoreTrendAnalysis {
  error?: string
  metadata?: {
    evaluated: number
    reevaluatedListings: number
    dateRange: { from: string; to: string }
  }
  trajectorySummary?: TrajectorySummary
  listingTrajectories?: Trajectory[]
  landscapeTrend?: LandscapeTrend
  recommendations?: TrendRecommendation[]
}

export interface ScoreTrendOpts {
  stableBand?: number
  minPerWindow?: number
  minDelta?: number
}

// ─── Per-listing trajectories ──────────────────────────────────────────────────
// Group evaluations by canonical key; a listing is a "trajectory" only with 2+
// scored evals on DISTINCT dates (same-date duplicate writes collapse to the
// last one). Mirrors core listingTrajectories.
export function listingTrajectories(rows: ScoreEntry[], { stableBand = 0.25 }: ScoreTrendOpts = {}): Trajectory[] {
  const groups = new Map<string, { key: string; company: string; role: string; evals: ScoreEntry[] }>()
  for (const r of rows) {
    if (!Number.isFinite(r.overall)) continue
    if (!r.date) continue
    const key = listingKey(r.company, r.role)
    if (!groups.has(key)) {
      groups.set(key, { key, company: r.company, role: r.role, evals: [] })
    }
    groups.get(key)!.evals.push(r)
  }

  const trajectories: Trajectory[] = []
  for (const g of groups.values()) {
    // Collapse same-date duplicate writes: keep the last row per date, then
    // order chronologically.
    const byDate = new Map<string, ScoreEntry>()
    for (const e of g.evals) byDate.set(e.date, e)
    const seq = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (seq.length < 2) continue

    const first = seq[0]
    const latest = seq[seq.length - 1]
    const delta = round2(latest.overall - first.overall)

    const dimDeltas: DimDelta[] = []
    for (const { key, label } of DIMENSIONS) {
      const a = first[key]
      const b = latest[key]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      dimDeltas.push({ key, label, from: a, to: b, delta: round2(b - a) })
    }
    const topMover = dimDeltas
      .filter(d => d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null

    const overalls = seq.map(e => e.overall)

    trajectories.push({
      key: g.key,
      company: g.company,
      role: g.role,
      evals: seq.length,
      firstDate: first.date,
      latestDate: latest.date,
      firstOverall: round2(first.overall),
      latestOverall: round2(latest.overall),
      delta,
      bandFrom: overallBand(first.overall),
      bandTo: overallBand(latest.overall),
      bandChanged: overallBand(first.overall) !== overallBand(latest.overall),
      peakOverall: round2(Math.max(...overalls)),
      troughOverall: round2(Math.min(...overalls)),
      verdict: classifyDelta(delta, stableBand),
      dimDeltas,
      topMover,
      sequence: seq.map(e => ({ date: e.date, overall: round2(e.overall) })),
    })
  }

  return trajectories.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) ||
      (a.latestDate < b.latestDate ? 1 : -1),
  )
}

// Roll trajectories into a one-line summary. Mirrors core trajectorySummary.
export function trajectorySummary(trajectories: Trajectory[]): TrajectorySummary {
  const verdicts = { improving: 0, declining: 0, stable: 0 }
  let bandUp = 0
  let bandDown = 0
  const bandRank: Record<Band, number> = { weak: 0, pass: 1, solid: 2, strong: 3, unknown: -1 }
  for (const t of trajectories) {
    if (t.verdict === 'improving' || t.verdict === 'declining' || t.verdict === 'stable') {
      verdicts[t.verdict] += 1
    }
    if (t.bandChanged) {
      const from = bandRank[t.bandFrom] ?? -1
      const to = bandRank[t.bandTo] ?? -1
      if (to > from) bandUp++
      else if (to < from) bandDown++
    }
  }
  const deltas = trajectories.map(t => t.delta).filter(Number.isFinite)
  return {
    reevaluated: trajectories.length,
    verdicts,
    avgDelta: round2(mean(deltas)),
    medianDelta: round2(median(deltas)),
    bandUpgrades: bandUp,
    bandDowngrades: bandDown,
  }
}

// ─── Landscape trend over calendar time ─────────────────────────────────────────
// Split scored evals into an older vs recent window at the boundary that
// balances the two windows closest to 50/50. Mirrors core landscapeTrend.
export function landscapeTrend(rows: ScoreEntry[], { minPerWindow = 3 }: ScoreTrendOpts = {}): LandscapeTrend {
  const scored = rows.filter(r => Number.isFinite(r.overall) && r.date)
  const dates = [...new Set(scored.map(r => r.date))].sort()

  if (scored.length < minPerWindow * 2 || dates.length < 2) {
    return {
      insufficientData: true,
      reason: `Need ≥${minPerWindow * 2} scored evals across ≥2 distinct dates to trend (have ${scored.length} across ${dates.length}).`,
      evaluated: scored.length,
      distinctDates: dates.length,
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
    }
  }

  const splitDate = best.boundary
  const older = scored.filter(r => r.date < splitDate)
  const recent = scored.filter(r => r.date >= splitDate)

  const olderOveralls = older.map(r => r.overall)
  const recentOveralls = recent.map(r => r.overall)
  const olderAvg = round2(mean(olderOveralls))
  const recentAvg = round2(mean(recentOveralls))
  const delta = round2(recentAvg - olderAvg)

  const bandShare = (arr: number[]) => {
    const strong = arr.filter(o => overallBand(o) === 'strong' || overallBand(o) === 'solid').length
    return Math.round((strong / arr.length) * 100)
  }
  const dateRangeOf = (arr: ScoreEntry[]) => {
    const sorted = arr.map(r => r.date).sort()
    return { from: sorted[0], to: sorted[sorted.length - 1] }
  }

  return {
    insufficientData: false,
    splitDate,
    older: {
      count: older.length,
      avgOverall: olderAvg,
      medianOverall: round2(median(olderOveralls)),
      strongSolidShare: bandShare(olderOveralls),
      dateRange: dateRangeOf(older),
    },
    recent: {
      count: recent.length,
      avgOverall: recentAvg,
      medianOverall: round2(median(recentOveralls)),
      strongSolidShare: bandShare(recentOveralls),
      dateRange: dateRangeOf(recent),
    },
    delta,
    strongSolidShareDelta: bandShare(recentOveralls) - bandShare(olderOveralls),
    verdict: classifyDelta(delta, 0.15),
  }
}

// ─── Recommendations ────────────────────────────────────────────────────────────
// Conservative: only fire on real movement. Mirrors core trendRecommendations.
export function trendRecommendations(
  trajectories: Trajectory[],
  trend: LandscapeTrend,
  { minDelta = 0.5 }: ScoreTrendOpts = {},
): TrendRecommendation[] {
  const recs: TrendRecommendation[] = []

  const decliners = trajectories
    .filter(t => t.verdict === 'declining' && Math.abs(t.delta) >= minDelta)
    .sort((a, b) => a.delta - b.delta)
  const worst = decliners[0]
  if (worst) {
    recs.push({
      action: `Re-check "${worst.company} — ${worst.role}": Overall slid ${worst.firstOverall} → ${worst.latestOverall} (${worst.delta}) across ${worst.evals} evals`,
      reasoning: worst.topMover
        ? `${worst.topMover.label} moved ${worst.topMover.delta} between first and latest evaluation — the main driver of the decline.`
        : `The role scored materially lower on re-evaluation.`,
      impact: worst.bandChanged ? 'high' : 'medium',
    })
  }

  const improvers = trajectories
    .filter(t => t.verdict === 'improving' && t.delta >= minDelta)
    .sort((a, b) => b.delta - a.delta)
  const best = improvers[0]
  if (best) {
    recs.push({
      action: `Prioritize "${best.company} — ${best.role}": Overall climbed ${best.firstOverall} → ${best.latestOverall} (+${best.delta}) across ${best.evals} evals`,
      reasoning: best.bandChanged
        ? `It crossed from the ${best.bandFrom} into the ${best.bandTo} band — it now clears a higher bar than on first look.`
        : `Improving on re-evaluation; act before the posting closes.`,
      impact: best.bandChanged ? 'high' : 'medium',
    })
  }

  if (trend && !trend.insufficientData) {
    if (trend.verdict === 'improving') {
      recs.push({
        action: `Targeting is sharpening — recent evals avg ${trend.recent.avgOverall} vs ${trend.older.avgOverall} earlier (+${trend.delta})`,
        reasoning: `The roles you've evaluated lately score higher than your earlier ones${trend.strongSolidShareDelta > 0 ? `, and the strong/solid share rose ${trend.strongSolidShareDelta} pts` : ''}. Keep sourcing the way you have been.`,
        impact: 'medium',
      })
    } else if (trend.verdict === 'declining') {
      recs.push({
        action: `Evaluated quality is sliding — recent evals avg ${trend.recent.avgOverall} vs ${trend.older.avgOverall} earlier (${trend.delta})`,
        reasoning: `Lately you're evaluating weaker roles than before. Re-tighten scan keywords or raise the pre-evaluation bar before scoring more.`,
        impact: 'high',
      })
    }
  }

  return recs
}

// ─── Top-level analysis ─────────────────────────────────────────────────────────
// Mirrors core analyzeTrend. Drops the analysisDate field (the renderer doesn't
// stamp a generation date — the data store's freshness owns that).
export function analyzeScoreTrend(rows: ScoreEntry[], opts: ScoreTrendOpts = {}): ScoreTrendAnalysis {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score history.' }
  }
  const scored = rows.filter(r => Number.isFinite(r.overall))
  if (scored.length === 0) {
    return { error: 'No rows with a valid Overall score in score history.' }
  }

  const trajectories = listingTrajectories(scored, opts)
  const trend = landscapeTrend(scored, opts)
  const dates = scored.map(r => r.date).filter(Boolean).sort()

  return {
    metadata: {
      evaluated: scored.length,
      reevaluatedListings: trajectories.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
    },
    trajectorySummary: trajectorySummary(trajectories),
    listingTrajectories: trajectories,
    landscapeTrend: trend,
    recommendations: trendRecommendations(trajectories, trend, opts),
  }
}
