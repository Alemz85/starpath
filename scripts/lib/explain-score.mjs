// explain-score.mjs — pure scoring EXPLAINABILITY.
//
// score-bands.mjs answers "what is the score / tier". This module answers
// the question the user actually has when they read a report:
//
//   "Why did it land here, and what single thing would move it up?"
//
// It is pure (no I/O, no mutation, no globals) and — critically — it does
// NOT re-implement any band logic. The lever search re-runs the canonical
// `rollupCurrentFit` / `rollupAspirationalFit` / `rollupOverall` /
// `assignTier` from score-bands.mjs, so explainability can never drift from
// the engine it describes. If a band rule changes in score-bands.mjs, the
// levers recompute correctly with zero edits here.
//
// Three outputs, each independently useful:
//   1. bindingConstraints — the dim(s) actually gating the tier right now.
//   2. drivers            — per-dim contribution to each rollup (top lift,
//                           biggest drag), so "why is CF only 7?" is concrete.
//   3. levers             — the smallest single-dimension raise that crosses
//                           into a better tier, found by replaying real math.

import {
  rollupCurrentFit,
  rollupAspirationalFit,
  rollupOverall,
  assignTier,
} from './score-bands.mjs'

// Human-readable tier ranking — higher index = better band. Used to decide
// whether a hypothetical dim bump produced an *improvement* (not just a change).
const TIER_RANK = { T4: 0, T3: 1, T2: 2, T1: 3 }

// Display labels for the 6 rollup scoring dimensions. Kept here (not imported
// from a frontend module) so this script stays dependency-free and runnable
// under plain `node`. The frontend has its own label map for its own surface.
export const DIM_LABELS = {
  skills_match:     'Skills Match',
  ease_of_entry:    'Ease of Entry',
  strategic_fit:    'Strategic/Analytical Fit',
  growth_mobility:  'Growth/Mobility',
  optionality_exit: 'Optionality/Exit',
  brand_value:      'Brand Value',
}

const CF_DIMS = ['skills_match', 'ease_of_entry', 'strategic_fit']
const AF_DIMS = ['growth_mobility', 'optionality_exit', 'brand_value']

// A dimension at/below this is treated as a "weak" driver worth surfacing as
// a drag even when it isn't the single lowest dim. 5 is the rubric's midpoint
// ("borderline / support-function") — below it the dim is actively hurting.
const WEAK_THRESHOLD = 5

/**
 * Identify why the role sits in its current tier rather than a higher one.
 *
 * The most important constraint in this system is the Ease-of-Entry hard gate
 * (EoE ≤ 4 caps the band at T3 regardless of how strong CF is). That gate is
 * surfaced first and explicitly, because it's the failure mode where a role
 * looks strong on paper (CF 8) yet is correctly a growth target — the user
 * needs to see *that specific reason*, not just a T3 stamp.
 *
 * @returns Array<{ kind, dimension?, label?, value?, message }>
 *   kind ∈ 'eoe_gate' | 'bottom_range' | 'low_rollup'
 */
export function bindingConstraints({ sixDims, cf, af, tier }) {
  const out = []
  const eoe = sixDims.ease_of_entry

  // 1. EoE hard gate — the highest-signal constraint. Only meaningful when it
  //    actually bound the tier (CF would otherwise have placed higher).
  if (eoe <= 4 && tier !== 'T1') {
    out.push({
      kind: 'eoe_gate',
      dimension: 'ease_of_entry',
      label: DIM_LABELS.ease_of_entry,
      value: eoe,
      message:
        `Ease of Entry ${eoe}/10 trips the experience-wall gate (≤ 4), capping the band at ` +
        `${af >= 7 ? 'Growth Target' : 'Skip'} regardless of Current Fit ${cf.toFixed(2)}. ` +
        `This is a "you have the profile but not the reach yet" signal, not a fit problem.`,
    })
  }

  // 2. Bottom-range dims (1–2) — each one drags its rollup by 0.30 and is the
  //    strongest negative signal the rubric has. Surface every one.
  for (const dim of [...CF_DIMS, ...AF_DIMS]) {
    const v = sixDims[dim]
    if (v >= 1 && v <= 2) {
      out.push({
        kind: 'bottom_range',
        dimension: dim,
        label: DIM_LABELS[dim],
        value: v,
        message:
          `${DIM_LABELS[dim]} ${v}/10 is bottom-range — it applies a −0.30 penalty to ` +
          `${CF_DIMS.includes(dim) ? 'Current Fit' : 'Aspirational Fit'} on top of dragging its average down.`,
      })
    }
  }

  // 3. If neither special constraint fired, name the weaker rollup + its
  //    lowest dim as the thing holding Overall back.
  if (out.length === 0) {
    const weakerIsCf = cf <= af
    const dims = weakerIsCf ? CF_DIMS : AF_DIMS
    const rollupLabel = weakerIsCf ? 'Current Fit' : 'Aspirational Fit'
    const rollupVal = weakerIsCf ? cf : af
    const lowest = dims.reduce((lo, d) => (sixDims[d] < sixDims[lo] ? d : lo), dims[0])
    out.push({
      kind: 'low_rollup',
      dimension: lowest,
      label: DIM_LABELS[lowest],
      value: sixDims[lowest],
      message:
        `${rollupLabel} (${rollupVal.toFixed(2)}) is the weaker rollup; its lowest dimension is ` +
        `${DIM_LABELS[lowest]} ${sixDims[lowest]}/10 — the main thing pulling Overall down.`,
    })
  }

  return out
}

/**
 * Per-rollup driver analysis: for CF and AF, rank the three dims by how far
 * each sits above/below the rollup's own mean, so the report can say
 * "Brand (9) is carrying AF; Growth (5) is the drag" with numbers.
 *
 * @returns { currentFit: {...}, aspirationalFit: {...} }
 *   each: { mean, topLift: {dimension,label,value,delta}, biggestDrag: {...}, weak: [...] }
 */
export function drivers({ sixDims }) {
  const analyze = (dimKeys) => {
    const vals = dimKeys.map(d => sixDims[d])
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const ranked = dimKeys
      .map(d => ({
        dimension: d,
        label: DIM_LABELS[d],
        value: sixDims[d],
        delta: Number((sixDims[d] - mean).toFixed(2)),
      }))
      .sort((a, b) => b.delta - a.delta)
    return {
      mean: Number(mean.toFixed(2)),
      topLift: ranked[0],
      biggestDrag: ranked[ranked.length - 1],
      weak: ranked.filter(r => r.value <= WEAK_THRESHOLD),
    }
  }
  return {
    currentFit: analyze(CF_DIMS),
    aspirationalFit: analyze(AF_DIMS),
  }
}

/**
 * For each of the 6 dims, find the SMALLEST integer raise (capped at 10) that
 * moves the role into a strictly better tier — replaying the canonical rollup
 * + tier math each step so the answer is always exactly what the engine would
 * produce. Returns only dims that can cross a band, sorted by smallest lift.
 *
 * The Salary/WLB context modifiers are held fixed at the role's current values
 * (passed via `context`) because levers are about the 6 *scoring* dims — comp
 * and WLB are properties of the role, not things the candidate improves.
 *
 * @param context { salary_adj_for_city, work_life_balance, is_intern }
 * @returns Array<{ dimension, label, from, to, lift, fromTier, toTier, message }>
 */
export function tierLevers({ sixDims, context }) {
  const baseline = computeTierFromDims(sixDims, context)
  const baseRank = TIER_RANK[baseline.tier]
  const levers = []

  for (const dim of [...CF_DIMS, ...AF_DIMS]) {
    const current = sixDims[dim]
    for (let candidate = current + 1; candidate <= 10; candidate++) {
      const probe = { ...sixDims, [dim]: candidate }
      const result = computeTierFromDims(probe, context)
      if (TIER_RANK[result.tier] > baseRank) {
        // Round to kill float-epsilon noise (e.g. +0.9999999991) when callers
        // feed fractional/averaged dims; a no-op for the normal integer scores.
        const from = Number(current.toFixed(2))
        const to = Number(candidate.toFixed(2))
        const lift = Number((candidate - current).toFixed(2))
        levers.push({
          dimension: dim,
          label: DIM_LABELS[dim],
          from,
          to,
          lift,
          fromTier: baseline.tier,
          toTier: result.tier,
          message:
            `${DIM_LABELS[dim]} ${from} → ${to} (+${lift}) ` +
            `would move this from ${baseline.tier} to ${result.tier}.`,
        })
        break // smallest lift for this dim found; stop climbing it
      }
    }
  }

  // Smallest lift first; tie-break by current value (cheaper-to-reach dims).
  return levers.sort((a, b) => a.lift - b.lift || b.from - a.from)
}

// Replay the canonical engine for a hypothetical dim set. Kept private so the
// only band logic in the whole module lives in score-bands.mjs.
function computeTierFromDims(sixDims, context) {
  const cf = rollupCurrentFit({
    skills_match: sixDims.skills_match,
    ease_of_entry: sixDims.ease_of_entry,
    strategic_fit: sixDims.strategic_fit,
  })
  const af = rollupAspirationalFit({
    growth_mobility: sixDims.growth_mobility,
    optionality_exit: sixDims.optionality_exit,
    brand_value: sixDims.brand_value,
  })
  const { overall } = rollupOverall(cf, af, {
    salary_adj_for_city: context?.salary_adj_for_city ?? 6,
    work_life_balance: context?.work_life_balance ?? 6,
    is_intern: context?.is_intern === true,
  })
  const { tier } = assignTier({ cf, af, sixDims })
  return { cf, af, overall, tier }
}

/**
 * Top-level convenience: assemble the full explainability bundle from the six
 * dims + the already-computed rollups/tier. This is what score-listing.mjs
 * attaches to its output and what the report/frontend render from.
 *
 * @returns { bindingConstraints, drivers, levers, headline }
 *   headline — a single plain sentence safe to drop into a report as the lede.
 */
export function explainScore({ sixDims, cf, af, tier, context }) {
  const constraints = bindingConstraints({ sixDims, cf, af, tier })
  const drv = drivers({ sixDims })
  const levers = tierLevers({ sixDims, context })

  // Headline: lead with the cheapest band-crossing lever if one exists,
  // otherwise with the primary binding constraint. T1 roles have no lever
  // and get a "no constraints" lede.
  let headline
  if (tier === 'T1') {
    headline = `Top-band match — no dimension is holding it back; ${drv.aspirationalFit.topLift.label} and ${drv.currentFit.topLift.label} lead the fingerprint.`
  } else if (levers.length > 0) {
    const l = levers[0]
    headline = `Closest lever: ${l.message} The binding constraint today is ${constraints[0].label} (${constraints[0].value}/10).`
  } else {
    headline = `Binding constraint: ${constraints[0].message}`
  }

  return { bindingConstraints: constraints, drivers: drv, levers, headline }
}
