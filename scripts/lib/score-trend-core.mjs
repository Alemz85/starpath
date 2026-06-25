// score-trend-core.mjs — pure re-evaluation / score-trend math over
// data/score-history.tsv.
//
// Roles get re-evaluated over time: a posting is re-scanned and re-scored, the
// user's CV improves, the role is re-posted, or the evaluator's calibration
// shifts. targeting-core.mjs aggregates the landscape as a flat pool — it never
// asks how a *given* company+role's score MOVED across its own re-evaluations,
// nor whether the user's evaluated quality is trending up over calendar time.
//
// This module answers exactly those two questions, and nothing else:
//
//   1. Per-listing trajectory  — group every evaluation by a canonical
//      (company, role) key; for listings evaluated 2+ times, surface the
//      first→latest Overall delta, an improving/declining/stable verdict, and
//      which of the six dimensions moved most. This is a *targeting-quality*
//      signal at the listing level: a role that keeps climbing on re-eval is
//      one the user is getting better positioned for; a role that keeps
//      sliding is drifting away from fit.
//
//   2. Landscape trend         — order all evaluations by date and compare an
//      older window against a recent window (default: split at the median
//      evaluation date). If the recent window scores materially higher, the
//      user's *targeting is sharpening* — they're sourcing better roles than
//      they were a month ago. If it's sliding, scope has drifted.
//
// Read-only. All functions are pure (no I/O, no mutation, no globals) so the
// thin CLI wrapper (score-trend.mjs) is the only thing that touches the disk.
//
// Shared helpers are imported, never re-implemented:
//   - normalizeCompany / normalizeRole  ← dedup-index.mjs (the SAME canonical
//     (company, role) key scheme merge-staging + the dedup index use, so a
//     listing that re-eval'd under a slightly different company spelling still
//     collapses to one trajectory).
//   - parseScoreHistory / overallBand / DIMENSIONS  ← targeting-core.mjs.

import { normalizeCompany, normalizeRole } from './dedup-index.mjs'
import { parseScoreHistory, overallBand, DIMENSIONS } from './targeting-core.mjs'

// Re-export so the CLI and tests can pull the TSV parser from one import site.
export { parseScoreHistory, overallBand, DIMENSIONS }

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ───── Canonical listing key ──────────────────────────────────────────────
 *
 * Reuse the exact (company, role) normalization the dedup index / merge layer
 * use, so a re-evaluation that drifted in spelling ("Celonis" vs "celonis ",
 * "Strategy Analyst Internship" vs "Strategy  Analyst  Internship") still
 * collapses onto one trajectory rather than splitting into two singletons.
 */
export function listingKey(company, role) {
  return `${normalizeCompany(company || '')}\t${normalizeRole(role || '')}`
}

/**
 * A move verdict from a signed Overall delta. The dead-band keeps tiny scoring
 * jitter (a 0.1 re-eval wobble) from being labelled a real trend. Default band
 * is ±0.25 Overall — below a quarter-point we call it "stable".
 */
export function classifyDelta(delta, { stableBand = 0.25 } = {}) {
  if (!Number.isFinite(delta)) return 'unknown'
  if (delta > stableBand) return 'improving'
  if (delta < -stableBand) return 'declining'
  return 'stable'
}

/* ───── Per-listing trajectories ───────────────────────────────────────────
 *
 * Group evaluations by canonical key. A listing is only a "trajectory" if it
 * has 2+ scored evaluations on DISTINCT dates — a single eval has no movement,
 * and two evals logged the same day are a duplicate write, not a re-evaluation
 * over time, so we collapse same-date rows to the last one seen.
 *
 * For each trajectory we report:
 *   - first / latest Overall and the signed delta between them
 *   - the band transition (e.g. "pass → solid") so a delta that crosses a
 *     decision boundary (the thing that flips a verdict) stands out
 *   - per-dimension first→latest deltas, and the single dimension that moved
 *     most (the driver of the Overall move)
 *   - the verdict (improving / declining / stable)
 */
export function listingTrajectories(rows, { stableBand = 0.25 } = {}) {
  const groups = new Map()
  for (const r of rows) {
    if (!Number.isFinite(r.overall)) continue
    if (!r.date) continue
    const key = listingKey(r.company, r.role)
    if (!groups.has(key)) {
      groups.set(key, { key, company: r.company, role: r.role, evals: [] })
    }
    groups.get(key).evals.push(r)
  }

  const trajectories = []
  for (const g of groups.values()) {
    // Collapse same-date duplicate writes: keep the last row for each date,
    // then order chronologically. (Stable sort over an ISO date string.)
    const byDate = new Map()
    for (const e of g.evals) byDate.set(e.date, e)
    const seq = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    if (seq.length < 2) continue // not re-evaluated over time

    const first = seq[0]
    const latest = seq[seq.length - 1]
    const delta = round2(latest.overall - first.overall)

    // Per-dimension movement, first→latest. Only dims present (finite) in both
    // endpoints get a delta; the biggest absolute mover is the headline driver.
    const dimDeltas = []
    for (const { key, label } of DIMENSIONS) {
      const a = first[key]
      const b = latest[key]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      dimDeltas.push({ key, label, from: a, to: b, delta: round2(b - a) })
    }
    const topMover = dimDeltas
      .filter(d => d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] || null

    // Peak / trough across the whole sequence — a role can climb then give it
    // back; first→latest alone would hide that volatility.
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
      verdict: classifyDelta(delta, { stableBand }),
      dimDeltas,
      topMover,
      // Full chronological trail so the CLI can print the path if asked.
      sequence: seq.map(e => ({ date: e.date, overall: round2(e.overall) })),
    })
  }

  // Biggest absolute movers first — those are where re-evaluation changed the
  // story most. Ties broken by most-recently-touched.
  return trajectories.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) ||
      (a.latestDate < b.latestDate ? 1 : -1),
  )
}

/**
 * Roll the trajectories into a one-line summary: how many re-evaluated
 * listings, and how the verdicts split. Answers "of the roles I looked at
 * twice, are they mostly getting better or worse on second look?".
 */
export function trajectorySummary(trajectories) {
  const verdicts = { improving: 0, declining: 0, stable: 0 }
  let bandUp = 0
  let bandDown = 0
  const bandRank = { weak: 0, pass: 1, solid: 2, strong: 3, unknown: -1 }
  for (const t of trajectories) {
    verdicts[t.verdict] = (verdicts[t.verdict] || 0) + 1
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
    // Net average movement across all re-evaluated listings.
    avgDelta: round2(mean(deltas)),
    medianDelta: round2(median(deltas)),
    // Listings that crossed a band boundary on re-eval (a verdict actually flipped).
    bandUpgrades: bandUp,
    bandDowngrades: bandDown,
  }
}

/* ───── Landscape trend over calendar time ─────────────────────────────────
 *
 * "Is my targeting sharpening?" — split ALL scored evaluations into an older
 * window and a recent window and compare their average Overall. We split on the
 * date axis (not a row count) so the two windows are genuinely "before" vs
 * "after" in calendar time; and we pick the boundary that splits the rows as
 * close to 50/50 as the calendar allows, so a bursty cadence (one date holding
 * a big batch) can't shove almost everything onto one side. A fixed day-count
 * window would instead be empty in a slow month and overflowing in a busy one.
 *
 * The split is INCLUSIVE-recent: rows strictly before the boundary date are
 * "older", rows on/after are "recent". When every row shares one date, or the
 * dates are so concentrated that no boundary leaves ≥minPerWindow rows on each
 * side, there's no usable time axis — we report insufficientData rather than
 * fabricate a lopsided or zero delta.
 */
export function landscapeTrend(rows, { minPerWindow = 3 } = {}) {
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

  // Choose the split boundary (the first date of the "recent" window) that best
  // balances the two windows. We don't blindly cut at the median DATE: when the
  // calendar is bursty (one date holds a big batch), the median date can shove
  // most rows onto one side. Instead we scan every candidate boundary, keep the
  // ones where BOTH windows clear minPerWindow, and pick the boundary whose
  // split is closest to 50/50. If no boundary qualifies the rows are too
  // concentrated to trend, so we say so rather than fabricate a lopsided delta.
  let best = null
  for (let i = 1; i < dates.length; i++) {
    const boundary = dates[i] // recent = on/after boundary
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

  const bandShare = (arr) => {
    const strong = arr.filter(o => overallBand(o) === 'strong' || overallBand(o) === 'solid').length
    return Math.round((strong / arr.length) * 100)
  }

  return {
    insufficientData: false,
    splitDate,
    older: {
      count: older.length,
      avgOverall: olderAvg,
      medianOverall: round2(median(olderOveralls)),
      strongSolidShare: bandShare(olderOveralls),
      dateRange: { from: older.map(r => r.date).sort()[0], to: older.map(r => r.date).sort().slice(-1)[0] },
    },
    recent: {
      count: recent.length,
      avgOverall: recentAvg,
      medianOverall: round2(median(recentOveralls)),
      strongSolidShare: bandShare(recentOveralls),
      dateRange: { from: recent.map(r => r.date).sort()[0], to: recent.map(r => r.date).sort().slice(-1)[0] },
    },
    delta,
    // Net change in the share of strong/solid evals — the cleanest "am I
    // sourcing better roles?" number.
    strongSolidShareDelta: bandShare(recentOveralls) - bandShare(olderOveralls),
    verdict: classifyDelta(delta, { stableBand: 0.15 }),
  }
}

/* ───── Recommendations ─────────────────────────────────────────────────────
 *
 * Conservative, like targeting-core's: only fire when there's real movement.
 * Surfaces (a) the sharpest individual decliner/improver worth re-checking and
 * (b) a one-liner on whether the landscape is trending up.
 */
export function trendRecommendations(trajectories, trend, { minDelta = 0.5 } = {}) {
  const recs = []

  // 1. Sharpest decliner that crossed (or sits near) the apply bar — a role the
  //    user was warming to that's now sliding is the one most worth a fresh look.
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

  // 2. Strongest improver — a role getting more attractive on re-eval is one to
  //    prioritize before it closes.
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

  // 3. Landscape-level verdict.
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

/* ───── Top-level analysis object (consumed by the CLI/mode) ──────────────── */
export function analyzeTrend(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = rows.filter(r => Number.isFinite(r.overall))
  if (scored.length === 0) {
    return { error: 'No rows with a valid Overall score in score-history.tsv.' }
  }

  const trajectories = listingTrajectories(scored, opts)
  const trend = landscapeTrend(scored, opts)
  const dates = scored.map(r => r.date).filter(Boolean).sort()

  return {
    metadata: {
      evaluated: scored.length,
      reevaluatedListings: trajectories.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
    },
    trajectorySummary: trajectorySummary(trajectories),
    listingTrajectories: trajectories,
    landscapeTrend: trend,
    recommendations: trendRecommendations(trajectories, trend, opts),
  }
}
