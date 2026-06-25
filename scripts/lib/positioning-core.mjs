// positioning-core.mjs — corpus-level positioning synthesis over
// data/score-history.tsv.
//
// Round 1 shipped two pure libs that operate at different altitudes:
//
//   • targeting-core.mjs   — corpus aggregates: which archetypes the landscape
//                            scores well, which dimension drags the WHOLE corpus
//                            down, where strong matches cluster geographically.
//   • explain-score.mjs    — per-ROLE explainability: the binding constraint
//                            gating one role's tier, and the cheapest single-dim
//                            raise that crosses it into a better band.
//
// The `positioning` mode needs the bridge between them: not "what's the average
// Ease-of-Entry across everything" (targeting-core) and not "what's the lever
// for THIS role" (explain-score), but **per-archetype**: given the archetype's
// AVERAGE fingerprint, what tier does the average role land in, what's the
// binding constraint holding that archetype back, and what's the cheapest
// single-dimension lift that would re-band the archetype's typical role?
//
// That "average-fingerprint lever" is the synthesis. If three archetypes all
// have their average role gated by Ease of Entry, the report can say "EoE is the
// binding constraint across most of your landscape; the highest-leverage move is
// the one reframe that lifts it everywhere" — a finding, anchored to real math,
// that neither round-1 lib could produce alone.
//
// All functions are pure (no I/O, no mutation, no globals). The thin file/CLI
// wrapper lives in positioning-intel.mjs. Band/tier logic is NEVER reimplemented
// here — it is replayed through explain-score.mjs / score-bands.mjs, so this
// module can never drift from the scoring engine.

import {
  DIMENSIONS,
  archetypePerformance,
  dimensionDrag,
  cityExposure,
  landscapeSummary,
} from './targeting-core.mjs'
import {
  rollupCurrentFit,
  rollupAspirationalFit,
  assignTier,
} from './score-bands.mjs'
import { explainScore, DIM_LABELS } from './explain-score.mjs'

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN)

// The six rollup dimension keys, in canonical order. Sourced from targeting-core
// so the two stay in lockstep if a dimension is ever added/renamed.
const DIM_KEYS = DIMENSIONS.map(d => d.key)

// Context dims that inform the lever engine's Overall modifier but are NOT part
// of the 6-dim fingerprint. We average them per archetype so the replayed
// Overall reflects the archetype's typical comp/WLB profile, not a default.
const CTX_KEYS = ['salary_adj_city', 'work_life_balance']

/* ───── Per-archetype dimensional fingerprint ──────────────────────────────
 *
 * For each archetype with ≥ minRoles evaluations, the average of each of the 6
 * scoring dimensions plus the two context dims. This is the "typical role" in
 * that archetype — the input we feed to the lever engine below.
 *
 * targeting-core.archetypePerformance gives Overall aggregates; it deliberately
 * does NOT break down by dimension. This fills that gap (it's the Step-1B
 * "dimensional fingerprint" the positioning mode asks for) without duplicating
 * the Overall/band math — that's read straight from archetypePerformance.
 */
export function archetypeFingerprints(rows, { minRoles = 3 } = {}) {
  const perf = new Map(archetypePerformance(rows).map(a => [a.archetype, a]))
  const groups = new Map()
  for (const r of rows) {
    if (!Number.isFinite(r.overall)) continue
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
    const ctx = {}
    for (const key of CTX_KEYS) {
      const vals = group.map(r => r[key]).filter(Number.isFinite)
      ctx[key] = vals.length ? round2(mean(vals)) : NaN
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
      ctx,
      // Pull the engine's Overall/band aggregates rather than recomputing.
      avgOverall: p ? p.avgOverall : NaN,
      strongRate: p ? p.strongRate : 0,
      share: p ? p.share : 0,
      bottleneck: bottleneckKey
        ? { key: bottleneckKey, label: DIM_LABELS[bottleneckKey] || bottleneckKey, avg: dims[bottleneckKey] }
        : null,
    })
  }
  // Strongest archetype first, matching archetypePerformance's ordering intent.
  return out.sort((a, b) => b.avgOverall - a.avgOverall || b.count - a.count)
}

/* ───── Replay the lever engine on an archetype's average fingerprint ───────
 *
 * The averaged dims are fractional (e.g. EoE 5.7). The scoring engine accepts
 * fractional dims fine — rollups are just weighted means — so we feed the raw
 * averages through the canonical CF/AF/tier math, then ask explain-score for
 * the binding constraint and the cheapest band-crossing lever.
 *
 * The result answers, for the archetype's TYPICAL role: "what tier does it land
 * in, why isn't it higher, and what's the smallest single-dimension lift that
 * would re-band it". That lever is what the positioning report prescribes.
 */
export function archetypeLever(fingerprint) {
  const sixDims = {}
  for (const key of DIM_KEYS) {
    // Guard against an all-blank dimension (shouldn't happen post-filter, but
    // a NaN would poison the rollup). Fall back to the neutral midpoint.
    sixDims[key] = Number.isFinite(fingerprint.dims[key]) ? fingerprint.dims[key] : 5
  }
  const cf = rollupCurrentFit(sixDims)
  const af = rollupAspirationalFit(sixDims)
  const { tier } = assignTier({ cf, af, sixDims })
  const context = {
    salary_adj_for_city: Number.isFinite(fingerprint.ctx.salary_adj_city)
      ? fingerprint.ctx.salary_adj_city : 6,
    work_life_balance: Number.isFinite(fingerprint.ctx.work_life_balance)
      ? fingerprint.ctx.work_life_balance : 6,
    // Average fingerprint is a blend; treat as non-intern so comp modifiers
    // apply the same way the corpus-wide aggregates do.
    is_intern: false,
  }
  const explanation = explainScore({ sixDims, cf, af, tier, context })
  return {
    archetype: fingerprint.archetype,
    count: fingerprint.count,
    cf: round2(cf),
    af: round2(af),
    tier,
    bindingConstraint: explanation.bindingConstraints[0] || null,
    // The single cheapest band-crossing lever, or null if already top-band /
    // no single-dim raise crosses a band.
    cheapestLever: explanation.levers[0] || null,
    headline: explanation.headline,
  }
}

/* ───── The corpus-wide binding constraint ─────────────────────────────────
 *
 * Tally which dimension is the binding constraint across all archetype-average
 * fingerprints. If the same dimension gates the typical role in most archetypes,
 * THAT is the systemic blocker — the one fix with cross-archetype leverage. This
 * is the headline finding the positioning mode is built around.
 *
 * Returns { dominant, tally, lever } where:
 *   dominant — the dimension binding the most archetypes (or null if none bind)
 *   tally    — per-dimension { dimension, label, archetypes:[names], count }
 *   lever    — the most common cheapest-lever dimension across archetypes, with
 *              how many archetypes that single lift would re-band.
 */
export function systemicConstraint(levers) {
  const constraintTally = new Map()
  const leverTally = new Map()

  for (const l of levers) {
    if (l.bindingConstraint?.dimension) {
      const d = l.bindingConstraint.dimension
      if (!constraintTally.has(d)) {
        constraintTally.set(d, { dimension: d, label: DIM_LABELS[d] || d, archetypes: [], count: 0 })
      }
      const e = constraintTally.get(d)
      e.archetypes.push(l.archetype)
      e.count++
    }
    if (l.cheapestLever?.dimension) {
      const d = l.cheapestLever.dimension
      if (!leverTally.has(d)) {
        leverTally.set(d, {
          dimension: d, label: DIM_LABELS[d] || d, archetypes: [], count: 0, totalLift: 0,
        })
      }
      const e = leverTally.get(d)
      e.archetypes.push(l.archetype)
      e.count++
      e.totalLift += l.cheapestLever.lift
    }
  }

  const tally = [...constraintTally.values()].sort((a, b) => b.count - a.count)
  const leverRanked = [...leverTally.values()]
    .map(e => ({ ...e, avgLift: round2(e.totalLift / e.count) }))
    .sort((a, b) => b.count - a.count || a.avgLift - b.avgLift)

  return {
    dominant: tally[0] || null,
    tally,
    lever: leverRanked[0] || null,
  }
}

/* ───── Top-level positioning intelligence bundle ───────────────────────────
 *
 * Everything the positioning mode needs in one object: the landscape summary,
 * per-archetype fingerprints + their average-role levers, the systemic binding
 * constraint, corpus-wide dimension drag, and city exposure. The mode reads
 * judgments off this rather than re-deriving math from the raw TSV.
 */
export function positioningIntel(rows, { minRoles = 3 } = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = rows.filter(r => Number.isFinite(r.overall))
  if (scored.length === 0) {
    return { error: 'No rows with a valid Overall score in score-history.tsv.' }
  }

  const fingerprints = archetypeFingerprints(scored, { minRoles })
  const levers = fingerprints.map(archetypeLever)
  const constraint = systemicConstraint(levers)

  const dates = scored.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      archetypesAnalyzed: fingerprints.length,
      minRoles,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
    },
    landscape: landscapeSummary(scored),
    fingerprints,
    levers,
    systemicConstraint: constraint,
    dimensionDrag: dimensionDrag(scored),
    cityExposure: cityExposure(scored).slice(0, 12),
  }
}
