// Per-company score trajectory + engagement timeline for the dossier
// (CompanyView). Pure over the company's score-history rows + application
// rows so every number is testable in isolation — the view only renders.
//
// Two outputs:
//   • computeScoreTrajectory — is this company trending up or down across
//     its evaluations, by how much, and a normalized sparkline path.
//   • buildEngagementTimeline — one merged, newest-first chronological feed
//     of evaluations and applications for the company.
//
// Companion to lib/companyStats.ts (snapshot aggregates); this module owns
// the *time* axis the snapshot collapses away.
//
// Scoring v2: a trajectory is computed on ONE metric at a time — Want or
// Ease (docs/scoring-v2.md §9: trend claims are stated on each separately).
// Blocked rows carry no scores and never join a trajectory.

import type { ScoreEntry, ApplicationEntry, AppStatus } from '@/types'
import { isBlocked, isScored, parseScoreCell } from './scoreBands'

export type TrajectoryMetric = 'want' | 'ease'

// ─── Score trajectory ─────────────────────────────────────────────────────────

export type TrajectoryDirection = 'improving' | 'declining' | 'steady' | 'flat'

export interface TrajectoryPoint {
  date: string
  /** The trajectory metric's value (Want or Ease) at this evaluation. */
  score: number
  role: string
}

export interface ScoreTrajectory {
  /** Scored evaluations, oldest → newest (the regression / sparkline input). */
  points: TrajectoryPoint[]
  /** improving / declining when the trend clears the noise band; steady when
   *  it's within it; flat when there's nothing to compare (0–1 points). */
  direction: TrajectoryDirection
  /** latest scored − first scored, signed. 0 when < 2 scored points. */
  delta: number
  /** Least-squares slope in score-points per evaluation step. Drives the
   *  direction call so a noisy middle doesn't flip the verdict the way a raw
   *  first-vs-last delta can. 0 when < 2 scored points. */
  slope: number
  /** First and latest scored values (0 when none / one). */
  firstScore: number
  latestScore: number
}

// Below this absolute slope (score-points per step) the trend is "steady" —
// scoring is coarse (one decimal, 0–10) so anything under a tenth-per-eval is
// noise, not signal.
const STEADY_SLOPE_BAND = 0.1

function leastSquaresSlope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  // x = 0,1,2,… (evenly-spaced evaluation index, not calendar gap — we care
  // about order of evaluations, not how long the user waited between them).
  const meanX = (n - 1) / 2
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = i - meanX
    num += dx * (ys[i] - meanY)
    den += dx * dx
  }
  return den === 0 ? 0 : num / den
}

/**
 * Want (default) or Ease trajectory across a company's evaluations. Only
 * scored rows count — blocked / unscored rows carry no trend signal.
 * Ties on date keep input order stable (the store already feeds newest-first;
 * we re-sort ascending here so the regression and sparkline read left→right
 * as oldest→newest).
 */
export function computeScoreTrajectory(history: ScoreEntry[], metric: TrajectoryMetric = 'want'): ScoreTrajectory {
  const points: TrajectoryPoint[] = history
    .filter(isScored)
    .map(e => ({ date: e.date, score: e[metric] as number, role: e.role }))
    // Stable ascending sort by date; equal dates keep relative input order.
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.date.localeCompare(b.p.date) || a.i - b.i)
    .map(({ p }) => p)

  if (points.length === 0) {
    return { points, direction: 'flat', delta: 0, slope: 0, firstScore: 0, latestScore: 0 }
  }

  const firstScore = points[0].score
  const latestScore = points[points.length - 1].score

  if (points.length === 1) {
    return { points, direction: 'flat', delta: 0, slope: 0, firstScore, latestScore }
  }

  const slope = leastSquaresSlope(points.map(p => p.score))
  const delta = latestScore - firstScore

  let direction: TrajectoryDirection
  if (slope > STEADY_SLOPE_BAND) direction = 'improving'
  else if (slope < -STEADY_SLOPE_BAND) direction = 'declining'
  else direction = 'steady'

  return { points, direction, delta, slope, firstScore, latestScore }
}

/**
 * Normalized SVG polyline points string for a trajectory sparkline, mapped
 * into a `width × height` box with `pad` inset on all sides. x is evenly
 * spaced by evaluation index; y is inverted (SVG origin top-left) so a higher
 * score sits higher on screen. A flat series (all equal, or one point) draws
 * along the vertical midline. Returns '' when there's nothing to draw.
 */
export function sparklinePath(
  points: TrajectoryPoint[],
  width: number,
  height: number,
  pad = 2,
): string {
  if (points.length === 0) return ''
  const w = Math.max(0, width - pad * 2)
  const h = Math.max(0, height - pad * 2)

  const scores = points.map(p => p.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const span = max - min

  if (points.length === 1) {
    // Single dot, centered.
    const x = pad + w / 2
    const y = pad + h / 2
    return `${round(x)},${round(y)}`
  }

  return points
    .map((p, i) => {
      const x = pad + (w * i) / (points.length - 1)
      // span === 0 → flat line on the midline.
      const t = span === 0 ? 0.5 : (p.score - min) / span
      const y = pad + h * (1 - t)
      return `${round(x)},${round(y)}`
    })
    .join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

// ─── Engagement timeline ────────────────────────────────────────────────────────

export type TimelineKind = 'evaluation' | 'application'

export interface TimelineEvent {
  /** ISO date string (YYYY-MM-DD as stored). */
  date: string
  kind: TimelineKind
  role: string
  /** Want / Ease for the row; null when blocked / unscored / not parseable. */
  want: number | null
  ease: number | null
  /** A legacy `X.X/10` application Score cell, shown as-is (spec §8.3). */
  legacyScore: number | null
  /** Eligibility red — render the reason instead of scores. */
  blocked: boolean
  /** Application status for application events; null for evaluations. */
  status: AppStatus | null
}

/**
 * Merge a company's evaluations and applications into one newest-first feed.
 *
 * An application that merely mirrors an existing evaluation (same date, same
 * role, status still `Evaluated`) is *not* a distinct engagement — it's the
 * same act recorded in both trackers — so it's suppressed to avoid a doubled
 * row. Any application with a status past `Evaluated` (Applied, Interview, …)
 * is a real engagement and always shown. Role match is case-insensitive.
 */
export function buildEngagementTimeline(
  history: ScoreEntry[],
  applications: ApplicationEntry[],
): TimelineEvent[] {
  const events: TimelineEvent[] = []

  for (const e of history) {
    events.push({
      date: e.date,
      kind: 'evaluation',
      role: e.role,
      want: isScored(e) ? e.want : null,
      ease: isScored(e) ? e.ease : null,
      legacyScore: null,
      blocked: isBlocked(e),
      status: null,
    })
  }

  // Index evaluations by date+role so we can suppress redundant "Evaluated"
  // application mirrors.
  const evalKeys = new Set(history.map(e => `${e.date}::${e.role.trim().toLowerCase()}`))

  for (const a of applications) {
    const key = `${a.date}::${a.role.trim().toLowerCase()}`
    if (a.status === 'Evaluated' && evalKeys.has(key)) continue
    // Application Score cell: `W8.3 E5.6` (v2) or a legacy `X.X/10`; `—` → none.
    const cell = parseScoreCell(a.score)
    events.push({
      date: a.date,
      kind: 'application',
      role: a.role,
      want: cell && 'want' in cell ? cell.want : null,
      ease: cell && 'ease' in cell ? cell.ease : null,
      legacyScore: cell && 'legacy' in cell && cell.legacy > 0 ? cell.legacy : null,
      blocked: false,
      status: a.status,
    })
  }

  // Newest first; ties keep evaluations before applications so a same-day
  // "evaluated then applied" reads in causal order top-to-bottom under a
  // newest-first sort (application above its evaluation).
  return events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => b.ev.date.localeCompare(a.ev.date) || a.i - b.i)
    .map(({ ev }) => ev)
}

// Human-facing verb for a trajectory direction — kept here (not in the view)
// so the wording is unit-pinned alongside the threshold that produces it.
export function trajectoryLabel(direction: TrajectoryDirection): string {
  switch (direction) {
    case 'improving': return 'Trending up'
    case 'declining': return 'Trending down'
    case 'steady':    return 'Holding steady'
    case 'flat':      return 'Single evaluation'
  }
}
