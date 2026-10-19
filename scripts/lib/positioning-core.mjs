// positioning-core.mjs — corpus-level positioning synthesis over
// data/score-history.tsv (scoring v2: eligibility gate, Want, Ease, verdict).
//
// Two pure libs operate at different altitudes:
//
//   • targeting-core.mjs   — corpus aggregates: which archetypes land in
//                            actionable verdicts, which dimension drags the WHOLE
//                            corpus down, where actionable matches cluster.
//   • explain-score.mjs    — per-ROLE explainability: the binding constraint
//                            keeping one role out of a better verdict cell, and
//                            the cheapest single-dim raise that reaches one.
//
// The `positioning` mode needs the bridge between them, **per archetype**:
// given the archetype's AVERAGE fingerprint (mean of each of the ten v2
// dimensions over its scored roles), which verdict does the typical role land
// in, what binds it, and what's the cheapest single-dimension lift that would
// move it to a better cell? Plus, across the archetype's individual listings,
// which binding-constraint kinds and lever dimensions recur.
//
// That "average-fingerprint lever" is the synthesis. If three archetypes all
// have their typical role held back by the Experience bar, the report can say
// "Experience bar binds most of your landscape; the cheapest move is the lever
// that re-cells the typical role in the most archetypes" — a finding anchored
// to real math that neither lib produces alone.
//
// Ease is point-in-time: it moves as the candidate's profile grows, so the
// per-archetype Ease trajectory (earlier vs later half of the archetype's
// scored evals, classified against the Ease noise floor and the trend gate) is
// the key positioning canary (docs/scoring-v2.md §3.2). It is exposed per
// archetype (`fingerprints[].easeTrajectory`) and summarized in `easeCanary`.
//
// Blocked rows (eligibility red) carry no scores: they are counted per
// archetype (`blocked`) and in the eligibility breakdown, never averaged.
//
// All functions are pure (no I/O, no mutation, no globals). The thin file/CLI
// wrapper lives in positioning-intel.mjs. Verdict / constraint / lever logic is
// NEVER reimplemented here — it is replayed through score-bands.mjs and
// explain-score.mjs, so this module can never drift from the scoring engine.

import {
  DIMENSIONS,
  archetypePerformance,
  dimensionDrag,
  cityExposure,
  landscapeSummary,
  eligibilityBreakdown,
  scoredRows,
  isScored,
  isBlocked,
} from './targeting-core.mjs'
import {
  rollupWant,
  rollupEase,
  assignVerdict,
  computePriority,
  VERDICT_LABELS,
} from './score-bands.mjs'
import { explainScore, DIM_LABELS, CHECK_LABELS } from './explain-score.mjs'
import { isDreamCompany } from './calibration.mjs'
import {
  GATES,
  EASE_NOISE_FLOOR,
  classifyMovement,
  confidenceTier,
  formatWithinNoise,
} from './scoring-stats.mjs'
import { rowIsIntern } from './calibration-advisor.mjs'

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN)
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)

// The ten v2 dimension keys, in canonical order. Sourced from targeting-core
// so the two stay in lockstep if a dimension is ever added/renamed.
const DIM_KEYS = DIMENSIONS.map(d => d.key)

// Neutral midpoint for a dimension no row of the archetype scored (shouldn't
// happen for scored rows; guards the replay against NaN).
const NEUTRAL_DIM = 5

/** Display labels for explain-score's binding-constraint kinds. */
export const CONSTRAINT_KIND_LABELS = Object.freeze({
  eligibility_red:   'Eligibility red',
  experience_wall:   'Experience wall',
  hygiene_veto:      'Hygiene veto',
  role_content_veto: 'Role-content veto',
  low_want:          'Want below the next verdict row',
  low_ease:          'Ease below the next verdict column',
  amber:             'Amber eligibility check',
})

const kindLabel = (k) => CONSTRAINT_KIND_LABELS[k] ?? k

// Weights come from user/profile.yml `scoring:` (want_weights / ease_weights),
// passed as { want, ease } — the shape explain-score's context takes.
function normWeights(weights) {
  if (!weights) return undefined
  return { want: weights.want ?? weights.want_weights, ease: weights.ease ?? weights.ease_weights }
}

/* ───── Ease trajectory (the canary) ────────────────────────────────────────
 *
 * Earlier vs later half of an archetype's scored evaluations, in date order
 * (stable sort; on an odd count the later half gets the extra row). Each half
 * must hold ≥ GATES.trendMinPerWindowForVerdict (10) scored evals — the same
 * window gate as the corpus trend (docs/scoring-statistical-design.md § 3.3):
 * below it the trajectory is withheld (`insufficient-data`, no delta, no
 * direction). Above it the half-mean Ease delta is classified against
 * EASE_NOISE_FLOOR (0.35): under the floor it is `flat-within-noise`, a
 * first-class result. Confidence is the § 3.1 tier on the smaller half.
 *
 * Not causal: a rising Ease is compatible with the scan having pulled easier
 * roles, not only with the profile growing.
 */
export function easeTrajectory(rows) {
  const gate = GATES.trendMinPerWindowForVerdict
  const scored = (rows || []).filter(isScored)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => String(a.r.date || '').localeCompare(String(b.r.date || '')) || a.i - b.i)
    .map(x => x.r)
  const cut = Math.floor(scored.length / 2)
  const half = (part) => {
    const dates = part.map(r => r.date).filter(Boolean)
    return {
      count: part.length,
      avgEase: part.length ? round2(mean(part.map(r => r.ease))) : null,
      dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    }
  }
  const earlier = half(scored.slice(0, cut))
  const later = half(scored.slice(cut))
  const smaller = Math.min(earlier.count, later.count)
  const base = { metric: 'ease', floor: EASE_NOISE_FLOOR, gate, earlier, later }

  if (smaller < gate) {
    const short = earlier.count <= later.count ? ['earlier', earlier.count] : ['later', later.count]
    return {
      ...base,
      delta: null,
      movementClass: null,
      reportableVerdict: 'insufficient-data',
      confidence: 'insufficient',
      insufficientData: true,
      reason: `Ease trajectory withheld: ${short[1]} scored evaluation${short[1] === 1 ? '' : 's'} in the ${short[0]} half, ${gate} required in each.`,
    }
  }
  const delta = round2(later.avgEase - earlier.avgEase)
  const movementClass = classifyMovement(delta, { metric: 'ease' })
  return {
    ...base,
    delta,
    movementClass,
    reportableVerdict: movementClass === 'within-noise' ? 'flat-within-noise' : movementClass,
    confidence: confidenceTier(smaller, gate),
    insufficientData: false,
    reason: movementClass === 'within-noise' ? `Ease ${formatWithinNoise(delta, { metric: 'ease' })}` : null,
  }
}

/* ───── Per-archetype dimensional fingerprint ──────────────────────────────
 *
 * For each archetype with ≥ minRoles SCORED (non-blocked) evaluations, the mean
 * of each of the ten v2 dimensions — the "typical role" in that archetype, the
 * input we replay through the engine below. The Want / Ease / verdict
 * aggregates are read from targeting-core.archetypePerformance (means of the
 * STORED Want / Ease, the verdict mix, the actionable share, the blocked count)
 * rather than recomputed.
 *
 * Sort: actionable share (go + stretch + solid) first, then mean Priority (a
 * sort key only), then count.
 */
export function archetypeFingerprints(rows, { minRoles = 3 } = {}) {
  const perf = new Map(archetypePerformance(rows || []).map(a => [a.archetype, a]))
  const groups = new Map()
  for (const r of rows || []) {
    if (!isScored(r)) continue
    if (!groups.has(r.archetype)) groups.set(r.archetype, [])
    groups.get(r.archetype).push(r)
  }

  const out = []
  for (const [archetype, group] of groups) {
    if (group.length < minRoles) continue
    const dims = {}
    for (const key of DIM_KEYS) {
      const vals = group.map(r => r[key]).filter(Number.isFinite)
      dims[key] = vals.length ? round2(mean(vals)) : NaN
    }
    // The single lowest-averaging dimension — the archetype's own bottleneck.
    const present = DIM_KEYS.filter(k => Number.isFinite(dims[k]))
    const bottleneckKey = present.length
      ? present.reduce((lo, k) => (dims[k] < dims[lo] ? k : lo), present[0])
      : null
    const p = perf.get(archetype)
    out.push({
      archetype,
      count: group.length,
      dims,
      avgWant: p ? p.avgWant : NaN,
      medianWant: p ? p.medianWant : NaN,
      avgEase: p ? p.avgEase : NaN,
      medianEase: p ? p.medianEase : NaN,
      avgPriority: p ? p.avgPriority : NaN,
      verdicts: p ? p.verdicts : {},
      actionableShare: p ? p.actionableRate : 0,
      share: p ? p.share : 0,
      blocked: p ? p.blocked : 0,
      internShare: pct(group.filter(rowIsIntern).length, group.length),
      bottleneck: bottleneckKey
        ? { key: bottleneckKey, label: DIM_LABELS[bottleneckKey] || bottleneckKey, avg: dims[bottleneckKey] }
        : null,
      easeTrajectory: easeTrajectory(group),
    })
  }
  return out.sort((a, b) =>
    b.actionableShare - a.actionableShare ||
    (b.avgPriority || 0) - (a.avgPriority || 0) ||
    b.count - a.count)
}

/* ───── Replay the engine on an archetype's average fingerprint ─────────────
 *
 * The averaged dims are fractional (e.g. Experience bar 5.7). rollupWant /
 * rollupEase accept fractional dims, so we feed the raw averages through the
 * canonical Want / Ease / verdict math, then ask explain-score for the binding
 * constraint and the cheapest cell-crossing lever.
 *
 * Replay reading (documented, not engine rules):
 *   • eligibility green — the typical role is the scored landscape, and ambers
 *     are per-listing facts that don't average (they show up in `listings`).
 *   • dream false — a blend of companies is not a dream company.
 *   • is_intern when ≥ 50% of the archetype's scored rows are internships /
 *     working-student roles (the engine then ignores the salary term).
 *   • weights = the caller's scoring.want_weights / ease_weights.
 *
 * The replayed `want` / `ease` are the typical role's, so they can differ from
 * the fingerprint's `avgWant` / `avgEase` (the means of the stored scores):
 * a mean of rollups is not the rollup of means once a veto or the
 * experience wall fires on some rows.
 */
export function archetypeLever(fingerprint, { weights } = {}) {
  const dims = {}
  const imputed = []
  for (const key of DIM_KEYS) {
    const v = fingerprint.dims?.[key]
    if (Number.isFinite(v)) dims[key] = v
    else { dims[key] = NEUTRAL_DIM; imputed.push(key) }
  }
  const w = normWeights(weights)
  const isIntern = (fingerprint.internShare ?? 0) >= 50
  const want = rollupWant(dims, { weights: w?.want, is_intern: isIntern }).score
  const ease = rollupEase(dims, { weights: w?.ease }).score
  const { verdict, tier } = assignVerdict({ want, ease, eligibility: 'green' })
  const explanation = explainScore({
    dims,
    eligibility: { status: 'green', amber_count: 0, checks: [] },
    context: { weights: w, is_intern: isIntern, dream: false },
  })
  return {
    archetype: fingerprint.archetype,
    count: fingerprint.count,
    want,
    ease,
    priority: computePriority(want, ease),
    verdict,
    verdictLabel: VERDICT_LABELS[verdict] ?? verdict,
    tier,
    // explain-score orders binding constraints first; a non-binding first
    // entry (binding: false) means no single constraint lifted alone re-cells it.
    bindingConstraint: explanation.bindingConstraints[0] || null,
    // The single cheapest cell-crossing lever, or null when already `go` / no
    // single-dim raise of up to +4 reaches a better cell.
    cheapestLever: explanation.levers[0] || null,
    headline: explanation.headline,
    imputed,
  }
}

/* ───── Per-listing constraint / lever tally ────────────────────────────────
 *
 * Replays each scored row's own dims (and its eligibility flags, so ambers
 * count) through explainScore and tallies, across the listings:
 *   constraintKinds  — the first BINDING constraint's kind per listing, with the
 *                      dimensions (or eligibility checks) it named
 *   leverDimensions  — the cheapest lever's dimension per listing ('amber' for
 *                      a resolve-the-amber lever), with the mean lift
 *   alreadyGo / noBindingConstraint / noLever — the listings that fall outside
 *   replayMismatches — listings whose replayed verdict differs from the stored
 *                      one (weights / the dream floor changed since, or a
 *                      context fact the log doesn't keep); counted, not hidden
 *
 * Context per row: weights from the caller; dream from calibration.dream_companies
 * (isDreamCompany); is_intern from employment_type.
 */
function rowEligibility(row) {
  const checks = (row.eligibilityFlags || [])
    .filter(f => f.status === 'amber' || f.status === 'red')
    .map(f => ({ check: f.check, status: f.status, reason: f.reason, question: f.reason || f.check }))
  return {
    status: ['green', 'amber', 'red'].includes(row.eligibility) ? row.eligibility : 'green',
    amber_count: checks.filter(c => c.status === 'amber').length,
    checks,
  }
}

export function listingConstraints(rows, { weights, calibration } = {}) {
  const w = normWeights(weights)
  const kinds = new Map()
  const levers = new Map()
  let n = 0, alreadyGo = 0, noBinding = 0, noLever = 0, mismatches = 0, skipped = 0

  for (const r of rows || []) {
    if (!isScored(r)) continue
    const dims = {}
    for (const k of DIM_KEYS) dims[k] = r[k]
    if (!DIM_KEYS.every(k => Number.isFinite(dims[k]))) { skipped++; continue }
    n++
    const ex = explainScore({
      dims,
      eligibility: rowEligibility(r),
      context: { weights: w, is_intern: rowIsIntern(r), dream: isDreamCompany(r.company, calibration) },
    })
    if (r.verdict && ex.verdict !== r.verdict) mismatches++
    if (ex.verdict === 'go') { alreadyGo++; continue }

    const binding = ex.bindingConstraints.find(c => c.binding)
    if (binding) {
      if (!kinds.has(binding.kind)) kinds.set(binding.kind, { kind: binding.kind, label: kindLabel(binding.kind), count: 0, on: {} })
      const e = kinds.get(binding.kind)
      e.count++
      const on = binding.dimension ?? binding.check
      if (on) e.on[on] = (e.on[on] || 0) + 1
    } else noBinding++

    const lever = ex.levers[0]
    if (lever) {
      const key = lever.kind === 'amber' ? 'amber' : lever.dimension
      if (!levers.has(key)) {
        levers.set(key, {
          key,
          dimension: lever.kind === 'amber' ? null : lever.dimension,
          label: lever.kind === 'amber' ? 'Resolve an amber check' : (DIM_LABELS[lever.dimension] || lever.dimension),
          count: 0,
          totalLift: 0,
        })
      }
      const e = levers.get(key)
      e.count++
      e.totalLift += lever.lift
    } else noLever++
  }

  const listed = n - alreadyGo
  return {
    n,
    skipped,
    alreadyGo,
    noBindingConstraint: noBinding,
    noLever,
    replayMismatches: mismatches,
    constraintKinds: [...kinds.values()]
      .map(e => ({ ...e, share: pct(e.count, listed) }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    leverDimensions: [...levers.values()]
      .map(({ totalLift, ...e }) => ({ ...e, share: pct(e.count, listed), avgLift: round2(totalLift / e.count) }))
      .sort((a, b) => b.count - a.count || a.avgLift - b.avgLift),
  }
}

/* ───── The corpus-wide binding constraint ─────────────────────────────────
 *
 * Tally the binding constraint of each archetype's AVERAGE role. If the same
 * thing holds back the typical role in most archetypes, THAT is the systemic
 * blocker — the one fix with cross-archetype leverage. This is the headline
 * finding the positioning mode is built around.
 *
 * Keying: `low_want` / `low_ease` say "the rollup is below the next verdict
 * threshold"; the dimension they carry is only the weakest motivator / Ease
 * stage (an arbitrary pick on a tie), so they are keyed by the rollup ('Want' /
 * 'Ease', the engine's own label) and the weakest dimension goes into `on`.
 * Every other kind names its dimension (experience wall, vetoes) or its
 * eligibility check, and is keyed by that.
 *
 * Returns { dominant, tally, lever } where:
 *   dominant — the entry binding the most archetypes (null if none)
 *   tally    — [{ key, label, dimension, check, kinds: {kind: n}, on: {dim|check: n},
 *                 archetypes, count, binding }]
 *              binding = in how many of those archetypes lifting it alone re-cells
 *   lever    — the most common cheapest-lever dimension across archetypes, with
 *              how many archetypes that single lift re-cells and its avg lift
 */
const ROLLUP_KINDS = new Set(['low_want', 'low_ease'])

export function systemicConstraint(levers) {
  const constraintTally = new Map()
  const leverTally = new Map()

  for (const l of levers || []) {
    const c = l.bindingConstraint
    if (c) {
      const rollup = ROLLUP_KINDS.has(c.kind)
      const key = rollup ? c.kind
        : c.dimension ? c.dimension
        : c.check ? `check:${c.check}`
        : `kind:${c.kind}`
      if (!constraintTally.has(key)) {
        const label = rollup ? c.label
          : c.dimension ? (DIM_LABELS[c.dimension] || c.dimension)
          : c.check ? (CHECK_LABELS[c.check] || c.check)
          : kindLabel(c.kind)
        constraintTally.set(key, {
          key,
          label,
          dimension: rollup ? null : (c.dimension ?? null),
          check: c.check ?? null,
          kinds: {}, on: {}, archetypes: [], count: 0, binding: 0,
        })
      }
      const e = constraintTally.get(key)
      e.archetypes.push(l.archetype)
      e.count++
      if (c.binding) e.binding++
      if (c.kind) e.kinds[c.kind] = (e.kinds[c.kind] || 0) + 1
      const on = c.dimension ?? c.check
      if (on) e.on[on] = (e.on[on] || 0) + 1
    }
    const lv = l.cheapestLever
    if (lv?.dimension) {
      const d = lv.dimension
      if (!leverTally.has(d)) {
        leverTally.set(d, { dimension: d, label: DIM_LABELS[d] || d, archetypes: [], count: 0, totalLift: 0 })
      }
      const e = leverTally.get(d)
      e.archetypes.push(l.archetype)
      e.count++
      e.totalLift += lv.lift
    }
  }

  const tally = [...constraintTally.values()].sort((a, b) => b.count - a.count || b.binding - a.binding)
  const leverRanked = [...leverTally.values()]
    .map(({ totalLift, ...e }) => ({ ...e, avgLift: round2(totalLift / e.count) }))
    .sort((a, b) => b.count - a.count || a.avgLift - b.avgLift)

  return {
    dominant: tally[0] || null,
    tally,
    lever: leverRanked[0] || null,
  }
}

/* ───── Ease canary summary ─────────────────────────────────────────────────
 * One place to read every archetype's Ease trajectory call, grouped by its
 * reportable verdict. Archetypes under the gate are listed as insufficient,
 * never given a direction.
 */
export function easeCanary(fingerprints) {
  const out = {
    metric: 'ease',
    floor: EASE_NOISE_FLOOR,
    gate: GATES.trendMinPerWindowForVerdict,
    improving: [],
    declining: [],
    flat: [],
    insufficient: [],
    archetypes: [],
  }
  for (const f of fingerprints || []) {
    const t = f.easeTrajectory
    if (!t) continue
    out.archetypes.push({
      archetype: f.archetype,
      reportableVerdict: t.reportableVerdict,
      delta: t.delta,
      confidence: t.confidence,
      earlier: t.earlier.count,
      later: t.later.count,
    })
    if (t.reportableVerdict === 'improving') out.improving.push(f.archetype)
    else if (t.reportableVerdict === 'declining') out.declining.push(f.archetype)
    else if (t.reportableVerdict === 'flat-within-noise') out.flat.push(f.archetype)
    else out.insufficient.push(f.archetype)
  }
  return out
}

/* ───── Top-level positioning intelligence bundle ───────────────────────────
 *
 * Everything the positioning mode needs in one object: the landscape summary,
 * the eligibility breakdown, per-archetype fingerprints (+ Ease trajectory) and
 * their average-role levers (+ per-listing tallies), the systemic binding
 * constraint, the Ease canary, corpus-wide dimension drag, and city exposure.
 * The mode reads judgments off this rather than re-deriving math from the TSV.
 *
 *   opts.minRoles     archetypes need ≥ this many scored rows (default 3)
 *   opts.weights      { want, ease } from user/profile.yml scoring.*
 *   opts.calibration  user/profile.yml calibration (dream_companies, for the
 *                     per-listing replay)
 */
export function positioningIntel(rows, { minRoles = 3, weights, calibration } = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = scoredRows(rows)
  const blocked = rows.filter(isBlocked).length
  if (scored.length === 0) {
    return {
      error: `No scored (non-blocked) rows with Want and Ease in score-history.tsv${blocked ? ` (${blocked} blocked by eligibility)` : ''}.`,
      eligibility: eligibilityBreakdown(rows),
    }
  }

  const fingerprints = archetypeFingerprints(rows, { minRoles })
  const byArch = new Map()
  for (const r of scored) {
    if (!byArch.has(r.archetype)) byArch.set(r.archetype, [])
    byArch.get(r.archetype).push(r)
  }
  const levers = fingerprints.map(f => ({
    ...archetypeLever(f, { weights }),
    listings: listingConstraints(byArch.get(f.archetype), { weights, calibration }),
  }))
  const constraint = {
    ...systemicConstraint(levers),
    listings: listingConstraints(scored, { weights, calibration }),
  }

  const dates = scored.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      blocked,
      total: rows.length,
      archetypesAnalyzed: fingerprints.length,
      minRoles,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      contract: {
        doc: 'docs/scoring-statistical-design.md',
        easeFloor: EASE_NOISE_FLOOR,
        trendGate: GATES.trendMinPerWindowForVerdict,
      },
    },
    landscape: landscapeSummary(rows),
    eligibility: eligibilityBreakdown(rows),
    fingerprints,
    levers,
    systemicConstraint: constraint,
    easeCanary: easeCanary(fingerprints),
    dimensionDrag: dimensionDrag(scored),
    cityExposure: cityExposure(scored).slice(0, 12),
  }
}
