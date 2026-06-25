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

// A tiny binary min-heap — just enough for tierPath's uniform-cost search.
// Kept here (no dep) so the module stays runnable under plain `node`. Ordering
// is whatever `cmp(a, b)` defines (negative ⇒ a before b), so the heap is a
// generic priority queue, not hard-wired to a particular node shape.
class MinHeap {
  constructor(cmp) {
    this.cmp = cmp
    this.a = []
  }
  get size() {
    return this.a.length
  }
  push(x) {
    const a = this.a
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.cmp(a[i], a[p]) < 0) {
        ;[a[i], a[p]] = [a[p], a[i]]
        i = p
      } else break
    }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let smallest = i
        if (l < n && this.cmp(a[l], a[smallest]) < 0) smallest = l
        if (r < n && this.cmp(a[r], a[smallest]) < 0) smallest = r
        if (smallest === i) break
        ;[a[i], a[smallest]] = [a[smallest], a[i]]
        i = smallest
      }
    }
    return top
  }
}

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

/**
 * Cheapest MULTI-STEP path to a strictly better tier (and, separately, the
 * cheapest path all the way to T1). Where `tierLevers` answers "what single
 * dimension bump crosses a band?", this answers "if no single bump does it —
 * or if you want the very top — what's the smallest TOTAL number of points,
 * spread across dimensions, that gets there, and in what order?".
 *
 * Why this matters: an EoE-gated T4 role (EoE 3, AF 6.x) can't reach T2 with
 * any single bump — it needs EoE up past the gate AND AF up past 7.0. A naive
 * "no lever" verdict hides a perfectly reachable two-step path. This surfaces
 * it concretely ("+1 Ease of Entry, +1 Growth → T3") with the exact sequence.
 *
 * The search is a deterministic uniform-cost (Dijkstra-style) expansion over
 * single-point bumps, replaying the canonical engine at every node, so the
 * path it returns is always exactly what the real math would produce. Cost is
 * total points raised; ties break toward fewer dimensions touched, then by a
 * stable dimension order — so the same inputs always yield the same path.
 *
 * `maxLift` caps total points spent (default 12) to keep the search bounded
 * and the advice realistic — a path that needs +12 across dims isn't a "lever",
 * it's a different role.
 *
 * @returns {
 *   toNextTier: PathResult | null,   // cheapest path to ANY better tier
 *   toTopTier:  PathResult | null,   // cheapest path to T1 (null if already T1)
 * }
 *   PathResult = {
 *     targetTier, totalLift, dimsTouched,
 *     steps: [{ dimension, label, from, to, lift }],
 *     message,
 *   }
 */
export function tierPath({ sixDims, context, maxLift = 12 }) {
  const baseline = computeTierFromDims(sixDims, context)
  const baseRank = TIER_RANK[baseline.tier]

  // Already top band — nothing to climb toward.
  if (baseline.tier === 'T1') {
    return { toNextTier: null, toTopTier: null }
  }

  // Uniform-cost (Dijkstra) search over a binary min-heap. A node is a full
  // six-dim vector; an edge is a +1 bump on one dim (cap 10). The heap orders
  // by (totalLift asc, dimsTouched asc, stable key) so the first time a node at
  // a better tier is popped, it's a minimum-cost path under that tie-break.
  //
  // The heap (vs. a re-sorted array) keeps each pop O(log n): the +6-deep gate
  // cases that balloon the frontier stay fast and deterministic. The `seen` map
  // prunes any state reached more cheaply before, so the frontier can't blow up
  // across the 6^maxLift naive space.
  const DIM_ORDER = [...CF_DIMS, ...AF_DIMS]
  const keyOf = (dims) => DIM_ORDER.map(d => dims[d]).join(',')

  // Total order on frontier nodes: cheapest lift, then fewest dims touched,
  // then a stable lexicographic key so identical-cost ties resolve the same way
  // every run (determinism the parity/tests rely on).
  const cmp = (a, b) =>
    a.totalLift - b.totalLift ||
    a.touched.size - b.touched.size ||
    a.key.localeCompare(b.key)

  const heap = new MinHeap(cmp)
  heap.push({
    dims: { ...sixDims },
    totalLift: 0,
    touched: new Set(),
    steps: [],
    key: keyOf(sixDims),
  })

  const seen = new Map() // key → cheapest totalLift seen (prune dominated revisits)
  seen.set(keyOf(sixDims), 0)

  let toNextTier = null
  let toTopTier = null

  const buildResult = (node, targetTier) => ({
    targetTier,
    totalLift: node.totalLift,
    dimsTouched: node.touched.size,
    steps: node.steps.slice(),
    message: pathMessage(node.steps, baseline.tier, targetTier),
  })

  while (heap.size > 0 && (!toNextTier || !toTopTier)) {
    const node = heap.pop()

    if (node.totalLift > 0) {
      const nodeTier = computeTierFromDims(node.dims, context).tier
      if (TIER_RANK[nodeTier] > baseRank && !toNextTier) {
        toNextTier = buildResult(node, nodeTier)
      }
      if (nodeTier === 'T1' && !toTopTier) {
        toTopTier = buildResult(node, 'T1')
      }
      if (toNextTier && toTopTier) break
    }

    if (node.totalLift >= maxLift) continue

    for (const dim of DIM_ORDER) {
      const cur = node.dims[dim]
      if (cur >= 10) continue
      const nextDims = { ...node.dims, [dim]: cur + 1 }
      const k = keyOf(nextDims)
      const nextLift = node.totalLift + 1
      if (seen.has(k) && seen.get(k) <= nextLift) continue
      seen.set(k, nextLift)
      const touched = new Set(node.touched)
      touched.add(dim)
      // Merge consecutive bumps of the same dim into one step for readability.
      const steps = node.steps.slice()
      const last = steps[steps.length - 1]
      if (last && last.dimension === dim) {
        steps[steps.length - 1] = {
          ...last,
          to: cur + 1,
          lift: Number((cur + 1 - last.from).toFixed(2)),
        }
      } else {
        steps.push({
          dimension: dim,
          label: DIM_LABELS[dim],
          from: cur,
          to: cur + 1,
          lift: 1,
        })
      }
      heap.push({ dims: nextDims, totalLift: nextLift, touched, steps, key: k })
    }
  }

  return { toNextTier, toTopTier }
}

// Render a path's steps into a single readable sentence. Steps are already
// merged per-dimension, so this lists each touched dim once with its net raise.
function pathMessage(steps, fromTier, toTier) {
  const parts = steps.map(s => `${s.label} ${s.from} → ${s.to} (+${s.lift})`)
  const joined =
    parts.length === 1
      ? parts[0]
      : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
  const total = steps.reduce((a, s) => a + s.lift, 0)
  return `${joined} — +${Number(total.toFixed(2))} total across ${steps.length} ${steps.length === 1 ? 'dimension' : 'dimensions'} — would move this from ${fromTier} to ${toTier}.`
}

/**
 * Per-dimension downside fragility. For each of the six dims, ask: if this one
 * dropped by `drop` points (default 1), would the role fall to a WORSE tier?
 * A role where any single −1 demotes it is "fragile" — its tier rests on a
 * dimension with no cushion, and the user should know which one.
 *
 * This is the mirror image of `tierLevers` (which looks UP). Looking down is
 * just as decision-relevant: a T2 role that drops to T3 on a −1 to Ease of
 * Entry is a weaker T2 than one that holds T2 even after a −1 everywhere.
 *
 * @returns {
 *   fragile: boolean,                 // any single −drop demotes the tier
 *   tier: string,                     // baseline tier (for context)
 *   weakestLinks: [{ dimension, label, value, drop, toTier, message }],
 *                                     // the dims whose −drop demotes, cheapest first
 *   cushion: number,                  // # of dims that can absorb a −drop with no demotion
 * }
 */
export function sensitivity({ sixDims, context, drop = 1 }) {
  const baseline = computeTierFromDims(sixDims, context)
  const baseRank = TIER_RANK[baseline.tier]
  const weakestLinks = []
  let cushion = 0

  for (const dim of [...CF_DIMS, ...AF_DIMS]) {
    const cur = sixDims[dim]
    const lowered = Math.max(1, Number((cur - drop).toFixed(2)))
    if (lowered === cur) {
      // Already at the floor — can't drop, so it can't be a weak link this way.
      cushion++
      continue
    }
    const probe = { ...sixDims, [dim]: lowered }
    const result = computeTierFromDims(probe, context)
    if (TIER_RANK[result.tier] < baseRank) {
      weakestLinks.push({
        dimension: dim,
        label: DIM_LABELS[dim],
        value: Number(cur.toFixed(2)),
        drop: Number((cur - lowered).toFixed(2)),
        toTier: result.tier,
        message:
          `${DIM_LABELS[dim]} is load-bearing: a −${Number((cur - lowered).toFixed(2))} (to ${lowered}/10) ` +
          `would drop this from ${baseline.tier} to ${result.tier}.`,
      })
    } else {
      cushion++
    }
  }

  // Cheapest-to-trip first: the dim sitting closest to a cliff is the one a
  // re-score is most likely to knock over, so it leads.
  weakestLinks.sort((a, b) => a.value - b.value)

  return {
    fragile: weakestLinks.length > 0,
    tier: baseline.tier,
    weakestLinks,
    cushion,
  }
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
 * @returns { bindingConstraints, drivers, levers, path, sensitivity, headline, whyThisScore }
 *   headline     — a single plain sentence safe to drop into a report as the lede.
 *   path         — { toNextTier, toTopTier } cheapest multi-step climbs (tierPath).
 *   sensitivity  — downside fragility report (sensitivity()).
 *   whyThisScore — a multi-sentence paragraph: where it landed + what drives it
 *                  + the cheapest way up + how fragile the band is. Safe to drop
 *                  into a report's "## Why this score" block verbatim.
 */
export function explainScore({ sixDims, cf, af, tier, context }) {
  const constraints = bindingConstraints({ sixDims, cf, af, tier })
  const drv = drivers({ sixDims })
  const levers = tierLevers({ sixDims, context })
  const path = tierPath({ sixDims, context })
  const fragility = sensitivity({ sixDims, context })

  // Headline: lead with the cheapest band-crossing lever if one exists,
  // otherwise with the primary binding constraint. T1 roles have no lever
  // and get a "no constraints" lede. (Kept stable — frontend parity + tests
  // pin these three branches; the deeper prose lives in whyThisScore below.)
  let headline
  if (tier === 'T1') {
    headline = `Top-band match — no dimension is holding it back; ${drv.aspirationalFit.topLift.label} and ${drv.currentFit.topLift.label} lead the fingerprint.`
  } else if (levers.length > 0) {
    const l = levers[0]
    headline = `Closest lever: ${l.message} The binding constraint today is ${constraints[0].label} (${constraints[0].value}/10).`
  } else {
    headline = `Binding constraint: ${constraints[0].message}`
  }

  const whyThisScore = buildWhyThisScore({
    tier, cf, af, drivers: drv, constraints, levers, path, fragility,
  })

  return {
    bindingConstraints: constraints,
    drivers: drv,
    levers,
    path,
    sensitivity: fragility,
    headline,
    whyThisScore,
  }
}

const TIER_NAME = {
  T1: 'Stellar (top band)',
  T2: 'Strong / Decent',
  T3: 'Pass / Growth Target',
  T4: 'Skip',
}

/**
 * Assemble the long-form "Why this score" paragraph from the already-computed
 * pieces. Pure string-building — no math, no re-derivation. Reads as four
 * beats: where it landed, what carries vs. drags it, the cheapest way up, and
 * how exposed the band is to a re-score downward.
 */
function buildWhyThisScore({ tier, cf, af, drivers: drv, constraints, levers, path, fragility }) {
  const sentences = []

  // 1. Where it landed + the rollup split.
  sentences.push(
    `${TIER_NAME[tier] ?? tier} band: Current Fit ${cf.toFixed(2)}, Aspirational Fit ${af.toFixed(2)}.`,
  )

  // 2. What carries it vs. what drags it (use whichever rollup is weaker for
  //    the drag, the stronger rollup's top lift for the carry).
  const carry = cf >= af ? drv.currentFit : drv.aspirationalFit
  const dragSrc = cf <= af ? drv.currentFit : drv.aspirationalFit
  sentences.push(
    `${carry.topLift.label} (${carry.topLift.value}/10) carries it; ` +
    `${dragSrc.biggestDrag.label} (${dragSrc.biggestDrag.value}/10) is the biggest drag.`,
  )

  // 3. The cheapest way up. Prefer the single-dim lever (smallest, most
  //    actionable); fall back to the multi-step path when no single bump
  //    crosses a band; say so plainly when even the path can't reach within
  //    budget. T1 gets a "nothing above" note.
  if (tier === 'T1') {
    sentences.push(`Nothing sits above this band — it's already top-tier.`)
  } else if (levers.length > 0) {
    sentences.push(`Cheapest way up: ${levers[0].message}`)
    if (path.toTopTier && path.toTopTier.targetTier === 'T1' && levers[0].toTier !== 'T1') {
      sentences.push(`All the way to top band: ${path.toTopTier.message}`)
    }
  } else if (path.toNextTier) {
    sentences.push(`No single bump crosses a band; cheapest path up: ${path.toNextTier.message}`)
  } else {
    sentences.push(
      `No realistic single- or multi-step bump (within budget) crosses into a better band — ` +
      `the binding constraint is ${constraints[0].label} (${constraints[0].value}/10).`,
    )
  }

  // 4. Downside fragility — only worth a sentence when the band is exposed.
  if (fragility.fragile) {
    const w = fragility.weakestLinks[0]
    sentences.push(
      `Fragile: a −${w.drop} on ${w.label} (now ${w.value}/10) would drop it to ${w.toTier}.`,
    )
  } else if (tier !== 'T4') {
    sentences.push(`Robust: no single −1 on any dimension drops the band.`)
  }

  return sentences.join(' ')
}
