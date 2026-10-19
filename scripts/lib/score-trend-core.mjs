// score-trend-core.mjs — pure re-evaluation / score-trend math over
// data/score-history.tsv (scoring v2, docs/scoring-v2.md).
//
// Roles get re-evaluated over time: a posting is re-scanned and re-scored, the
// user's CV improves, the role is re-posted, or the evaluator's calibration
// shifts. targeting-core.mjs aggregates the landscape as a flat pool — it never
// asks how a *given* company+role MOVED across its own re-evaluations, nor
// whether the user's evaluated landscape is trending over calendar time.
//
// This module answers exactly those two questions, and nothing else:
//
//   1. Per-listing trajectory  — group every evaluation by a canonical
//      (company, role) key; for listings evaluated on 2+ distinct dates,
//      classify the first→latest Want move and the first→latest Ease move
//      SEPARATELY (each against its own noise floor), plus the verdict move
//      between the first and the latest evaluation (upgrade / downgrade /
//      same, ordered by score-bands.verdictRank).
//
//   2. Landscape trend         — split all scored evaluations into an earlier
//      and a later calendar window (the boundary closest to 50/50) and compare
//      window-mean Want, window-mean Ease and the actionable share
//      (go + stretch + solid), each gated and floored per the contract.
//
// BLOCKED EVALUATIONS (eligibility red — no Want, no Ease; docs/scoring-v2.md
// §8.1). The reading this module takes:
//   - They never enter a Want / Ease number: not a trajectory delta, not a
//     window mean, not a window count toward the ≥10 gate.
//   - They DO count as evaluations for the verdict axis. A listing whose
//     evaluations span distinct dates is a trajectory even if some (or all but
//     one) of them are blocked, so a listing that went blocked → scored (an
//     eligibility fact changed, e.g. the JD now offers sponsorship) or
//     scored → blocked shows up as a verdict upgrade / downgrade. Its Want /
//     Ease blocks then report `n` < 2 and `movementClass: 'unknown'` — there is
//     no score movement to classify, only the verdict move.
//   - A verdict move that touches `blocked` is always `verdictMoveDetectable`
//     (the eligibility gate is mechanical, not judge wobble). A verdict move
//     between two scored cells is detectable only when the Want or Ease move
//     behind it cleared its floor — otherwise it is a sub-floor wobble across
//     a grid line and is flagged as such.
//
// Read-only. All functions are pure (no I/O, no mutation, no globals) so the
// thin CLI wrapper (score-trend.mjs) is the only thing that touches the disk.
//
// Shared helpers are imported, never re-implemented:
//   - normalizeCompany / normalizeRole  ← dedup-index.mjs (the SAME canonical
//     (company, role) key scheme merge-staging + the dedup index use).
//   - parseScoreHistory / DIMENSIONS / isScored / isBlocked / isActionable
//     ← targeting-core.mjs.
//   - verdictRank / VERDICT_LABELS  ← score-bands.mjs.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.3.
//   - per trajectory, per metric: `movementClass` ('within-noise' |
//     'improving' | 'declining' | 'unknown') against that metric's floor
//     (Want 0.30, Ease 0.35), `n` (scored evals) and `confidence` (g = 2);
//   - per corpus trend: `verdictGate` (≥10 scored evals per calendar window),
//     and per metric `reportableVerdict` — 'insufficient-data' under the gate,
//     'flat-within-noise' under the floor, else 'improving' / 'declining'.
//
// The contract numbers live in scoring-stats.mjs — never re-declare them here.

import { normalizeCompany, normalizeRole } from './dedup-index.mjs'
import {
  parseScoreHistory, DIMENSIONS, isScored, isBlocked, isActionable,
} from './targeting-core.mjs'
import { verdictRank, VERDICT_LABELS } from './score-bands.mjs'
import {
  WANT_NOISE_FLOOR,
  EASE_NOISE_FLOOR,
  GATES,
  classifyMovement,
  confidenceTier,
} from './scoring-stats.mjs'

// Re-export so the CLI and tests can pull the TSV parser from one import site.
export { parseScoreHistory, DIMENSIONS }
export { WANT_NOISE_FLOOR, EASE_NOISE_FLOOR }

/** The two score metrics this module classifies, each on its own floor. */
export const TREND_METRICS = Object.freeze(['want', 'ease'])

const METRIC_LABEL = { want: 'Want', ease: 'Ease' }
const SCORED_VERDICTS = ['go', 'stretch', 'solid', 'thin', 'growth', 'skip']

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)
const signed = (n) => (n > 0 ? `+${n}` : `${n}`)
const byDateAsc = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)

/** Resolve the per-metric floors from options (overridable for inspection only). */
function floorsFrom(opts = {}) {
  return {
    want: Number.isFinite(opts.wantFloor) ? opts.wantFloor : WANT_NOISE_FLOOR,
    ease: Number.isFinite(opts.easeFloor) ? opts.easeFloor : EASE_NOISE_FLOOR,
  }
}

/** A row that carries a verdict this module can place: scored or blocked. */
function hasVerdict(row) {
  return isBlocked(row) || isScored(row)
}

/** The verdict of a row, normalized ('blocked' for any blocked row). */
function verdictOf(row) {
  return isBlocked(row) ? 'blocked' : row.verdict
}

/* ───── Canonical listing key ──────────────────────────────────────────────
 *
 * Reuse the exact (company, role) normalization the dedup index / merge layer
 * use, so a re-evaluation that drifted in spelling ("Northwind" vs
 * "northwind ", "Strategy Analyst Internship" vs "Strategy  Analyst
 * Internship") still collapses onto one trajectory.
 */
export function listingKey(company, role) {
  return `${normalizeCompany(company || '')}\t${normalizeRole(role || '')}`
}

/**
 * The verdict move between two verdict keys, by score-bands.verdictRank
 * (blocked < skip < thin < growth < solid < stretch < go).
 * @returns {'upgrade'|'downgrade'|'same'|'unknown'}
 */
export function verdictMove(from, to) {
  const a = verdictRank(from)
  const b = verdictRank(to)
  if (a < 0 || b < 0) return 'unknown'
  if (b > a) return 'upgrade'
  if (b < a) return 'downgrade'
  return 'same'
}

/* ───── Per-listing trajectories ───────────────────────────────────────────
 *
 * Group evaluations by canonical key. A listing is a trajectory when it has
 * evaluations on 2+ DISTINCT dates — a single eval has no movement, and two
 * evals logged the same day are a duplicate write, not a re-evaluation over
 * time, so same-date rows collapse to the last one seen.
 *
 * Want and Ease are tracked over the SCORED evaluations of the sequence
 * (blocked ones have no numbers); the verdict move is read off the first and
 * the latest evaluation of the full sequence, blocked included.
 */

/** One metric's first→latest track over the scored evaluations of a sequence. */
function metricTrack(scoredSeq, metric, floor, dimDeltas) {
  const values = scoredSeq.map(e => e[metric])
  const n = values.length
  const base = {
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
  // A per-dimension delta may only be shown as the DRIVER of a rollup move
  // that cleared its floor (docs § 2) — never as a headline on its own — so
  // the driver is null for a within-noise move.
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
    // Two points is `low` by construction (docs § 3.3, g = 2).
    confidence: confidenceTier(n, GATES.trendMinEvals),
    topMover,
  }
}

/** How far past its floor a trajectory's biggest score move went (sort key). */
function salience(t) {
  const w = Number.isFinite(t.want.delta) ? Math.abs(t.want.delta) / t.want.noiseFloor : 0
  const e = Number.isFinite(t.ease.delta) ? Math.abs(t.ease.delta) / t.ease.noiseFloor : 0
  return Math.max(w, e)
}

export function listingTrajectories(rows, opts = {}) {
  const floors = floorsFrom(opts)
  const groups = new Map()
  for (const r of rows || []) {
    if (!r || !r.date) continue
    if (!hasVerdict(r)) continue // neither scored nor blocked: nothing to place
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
    const seq = [...byDate.values()].sort(byDateAsc)
    if (seq.length < GATES.trendMinEvals) continue // not re-evaluated over time

    const first = seq[0]
    const latest = seq[seq.length - 1]
    const scoredSeq = seq.filter(isScored)
    const firstScored = scoredSeq[0]
    const latestScored = scoredSeq[scoredSeq.length - 1]

    // Per-dimension movement over the ten v2 dims, first scored → latest
    // scored eval. Only dims finite at both endpoints get a delta.
    const dimDeltas = []
    if (scoredSeq.length >= 2) {
      for (const { key, label, group, rollup } of DIMENSIONS) {
        const a = firstScored[key]
        const b = latestScored[key]
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue
        dimDeltas.push({ key, label, group, rollup, from: a, to: b, delta: round2(b - a) })
      }
    }

    const want = metricTrack(scoredSeq, 'want', floors.want, dimDeltas)
    const ease = metricTrack(scoredSeq, 'ease', floors.ease, dimDeltas)

    const verdictFrom = verdictOf(first)
    const verdictTo = verdictOf(latest)
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
      // Confidence of the trajectory as a whole, over its evaluation count
      // (docs § 3.3, g = 2): a two-point trajectory never reads above `low`.
      confidence: confidenceTier(seq.length, GATES.trendMinEvals),
      dimDeltas,
      // Full chronological trail so the CLI can print the path if asked.
      sequence: seq.map(e => ({
        date: e.date,
        want: isScored(e) ? round2(e.want) : null,
        ease: isScored(e) ? round2(e.ease) : null,
        verdict: verdictOf(e),
      })),
    })
  }

  // Detectable verdict moves first (the story changed), then the move that
  // cleared its floor by the widest margin, then most-recently-touched.
  const rank = (t) => (t.verdictMoveDetectable ? 1 : 0)
  return trajectories.sort(
    (a, b) => rank(b) - rank(a) ||
      salience(b) - salience(a) ||
      (a.latestDate < b.latestDate ? 1 : a.latestDate > b.latestDate ? -1 : 0),
  )
}

/** Per-metric tally over trajectories with ≥2 scored evals. */
function summarizeMetric(trajectories, metric, floor) {
  const tracked = trajectories.filter(t => t[metric] && Number.isFinite(t[metric].delta))
  const counts = { improving: 0, declining: 0, 'within-noise': 0 }
  for (const t of tracked) counts[t[metric].movementClass] = (counts[t[metric].movementClass] || 0) + 1
  const deltas = tracked.map(t => t[metric].delta)
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

/**
 * Roll the trajectories into a summary: how many re-evaluated listings, how
 * the Want moves and the Ease moves split against their own floors, and how
 * the verdict moved. "Flat within noise" is reported as a result, not as an
 * absent row.
 */
export function trajectorySummary(trajectories, opts = {}) {
  const floors = floorsFrom(opts)
  const list = trajectories || []
  const verdictMoves = { upgrade: 0, downgrade: 0, same: 0, unknown: 0 }
  for (const t of list) verdictMoves[t.verdictMove ?? 'unknown'] = (verdictMoves[t.verdictMove ?? 'unknown'] || 0) + 1
  return {
    reevaluated: list.length,
    want: summarizeMetric(list, 'want', floors.want),
    ease: summarizeMetric(list, 'ease', floors.ease),
    verdictMoves,
  }
}

/* ───── Verdict moves (per-listing, rolled up for the corpus) ──────────────
 *
 * `verdictUpgrades` / `verdictDowngrades`: the listings whose verdict moved
 * between their first and latest evaluation. The contract defines no gate for
 * this count; the reading taken here treats "re-evaluation is upgrading my
 * listings" as a corpus claim, so the n (listings compared) gets the corpus
 * gate (GATES.trendMinPerWindowForVerdict) and its tier. The counts and the
 * listings are always reported (they are facts); `insufficientData` tells a
 * renderer it may not turn them into a direction.
 */
function verdictMoveBlock(compared, kind, gate) {
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

export function verdictMoves(trajectories, { gate = GATES.trendMinPerWindowForVerdict } = {}) {
  const compared = (trajectories || []).filter(t => t.verdictMove && t.verdictMove !== 'unknown')
  return {
    verdictUpgrades: verdictMoveBlock(compared, 'upgrade', gate),
    verdictDowngrades: verdictMoveBlock(compared, 'downgrade', gate),
  }
}

/* ───── Landscape trend over calendar time ─────────────────────────────────
 *
 * "Is my targeting sharpening?" — split ALL scored evaluations into an earlier
 * window and a later window and compare window-mean Want, window-mean Ease and
 * the actionable share. We split on the date axis (not a row count) so the two
 * windows are genuinely "before" vs "after" in calendar time; and we pick the
 * boundary that splits the rows as close to 50/50 as the calendar allows, so a
 * bursty cadence (one date holding a big batch) can't shove almost everything
 * onto one side.
 *
 * The split is INCLUSIVE-later: rows strictly before the boundary date are
 * "earlier", rows on/after are "later". When every scored row shares one date,
 * or no boundary leaves ≥minPerWindow scored rows on each side, there's no
 * usable time axis — we report insufficientData rather than fabricate a
 * lopsided or zero delta.
 */

function windowStats(scored, blockedCount) {
  const verdicts = Object.fromEntries(SCORED_VERDICTS.map(v => [v, 0]))
  for (const r of scored) if (r.verdict in verdicts) verdicts[r.verdict]++
  const actionableCount = scored.filter(r => isActionable(r.verdict)).length
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

function withheldMetric(floor) {
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

function metricTrend(earlier, later, metric, floor, gateMet, gate) {
  const a = earlier.map(r => r[metric])
  const b = later.map(r => r[metric])
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

export function landscapeTrend(rows, {
  minPerWindow = 3,
  minPerWindowForVerdict = GATES.trendMinPerWindowForVerdict,
  wantFloor,
  easeFloor,
  trajectories,
} = {}) {
  const floors = floorsFrom({ wantFloor, easeFloor })
  const dated = (rows || []).filter(r => r && r.date)
  const scored = dated.filter(isScored)
  const blocked = dated.filter(isBlocked)
  const dates = [...new Set(scored.map(r => r.date))].sort()

  // Per-listing verdict moves don't depend on the windows, so they ride on
  // every return path.
  const moves = verdictMoves(
    trajectories ?? listingTrajectories(dated, { wantFloor, easeFloor }),
    { gate: minPerWindowForVerdict },
  )

  // The gate a corpus verdict must clear before it may be spoken at all
  // (docs § 3.3), attached to every return path so a consumer can always ask
  // "may I render a verdict?" without special-casing.
  const withheld = (reason, why) => ({
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

  // Choose the split boundary (the first date of the "later" window) that
  // best balances the two windows: scan every candidate boundary, keep the
  // ones where BOTH windows clear minPerWindow, pick the closest to 50/50.
  let best = null
  for (let i = 1; i < dates.length; i++) {
    const boundary = dates[i] // later = on/after boundary
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

  // The corpus verdict must clear BOTH gates independently, per metric:
  // enough scored evaluations per window (so one role can't drive the mean)
  // AND a window-mean delta at or above that metric's floor.
  const gateMet = earlier.length >= minPerWindowForVerdict && later.length >= minPerWindowForVerdict
  const verdictGate = {
    minPerWindow: minPerWindowForVerdict,
    earlierCount: earlier.length,
    laterCount: later.length,
    met: gateMet,
    reason: gateMet
      ? null
      : `Corpus verdict withheld: ${earlier.length} scored eval(s) in the earlier window and ${later.length} in the later window; ${minPerWindowForVerdict} required in each.`,
  }
  const verdictConfidence = gateMet
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
    // Actionable share (go + stretch + solid) later − earlier, in percentage
    // points. A band count, not a measurement: stated with both window counts
    // (verdictGate) and never given a direction below the gate.
    actionableShareDelta: laterWin.actionableShare - earlierWin.actionableShare,
    verdictGate,
    verdictConfidence,
    ...moves,
  }
}

/* ───── Recommendations ─────────────────────────────────────────────────────
 *
 * Conservative: only fire on movement that cleared its floor. Surfaces (a) the
 * sharpest decliner worth re-checking, (b) the strongest improver worth
 * prioritizing and (c) the gated landscape line.
 */

/** "verdict Solid → Skip · Want 7.2 → 6.1 (−1.1) · Ease flat within noise". */
export function describeTrajectory(t) {
  const parts = []
  if (t.verdictChanged) {
    parts.push(`verdict ${VERDICT_LABELS[t.verdictFrom] ?? t.verdictFrom} → ${VERDICT_LABELS[t.verdictTo] ?? t.verdictTo}`)
  }
  for (const m of TREND_METRICS) {
    const track = t[m]
    if (!track || !Number.isFinite(track.delta)) continue
    parts.push(track.detectable
      ? `${METRIC_LABEL[m]} ${track.first} → ${track.latest} (${signed(track.delta)})`
      : `${METRIC_LABEL[m]} flat within noise`)
  }
  return parts.join(' · ')
}

/** Normalized size of a trajectory's move in one direction (0 when none). */
function directionalWeight(t, direction, minDelta) {
  let w = 0
  const verdictHit = direction === 'declining' ? 'downgrade' : 'upgrade'
  if (t.verdictMove === verdictHit && t.verdictMoveDetectable) w = 100 // verdict moves lead
  for (const m of TREND_METRICS) {
    const track = t[m]
    if (!track || track.movementClass !== direction) continue
    if (Math.abs(track.delta) < minDelta) continue
    w += Math.abs(track.delta) / track.noiseFloor
  }
  return w
}

function trajectoryRec(t, direction) {
  const declining = direction === 'declining'
  const driverTrack = TREND_METRICS.map(m => t[m]).find(tr => tr?.movementClass === direction && tr.topMover)
  const driver = driverTrack?.topMover
  const verb = declining ? 'Re-check' : 'Prioritize'
  let reasoning
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

/** "Want 7.10 vs 6.40 earlier (+0.7)" or "Want flat within noise (|Δ| 0.10 < 0.30 floor)". */
function describeMetricTrend(m, block) {
  if (block.reportableVerdict === 'flat-within-noise') {
    return `${METRIC_LABEL[m]} flat within noise (|Δ| ${Math.abs(block.delta).toFixed(2)} < ${block.noiseFloor.toFixed(2)} floor)`
  }
  return `${METRIC_LABEL[m]} ${block.reportableVerdict} (${block.later} vs ${block.earlier} earlier, ${signed(block.delta)})`
}

export function trendRecommendations(trajectories, trend, { minDelta = 0.5 } = {}) {
  const recs = []
  const list = trajectories || []

  const pick = (direction) => list
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

/* ───── Top-level analysis object (consumed by the CLI/mode) ──────────────── */
export function analyzeTrend(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = rows.filter(isScored)
  const blocked = rows.filter(isBlocked)
  if (scored.length === 0) {
    return {
      error: `No scored evaluations in score-history.tsv (${rows.length} row(s), ${blocked.length} blocked).`,
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
      // The contract this analysis was produced under, so any renderer can
      // print the floors and the gates it is bound by without re-deriving them.
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
