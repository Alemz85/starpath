// training-roi.mjs — pure ROI math for the `training` mode.
//
// The question this answers: "Is this course / cert worth it FOR MY ACTUAL
// TARGETING?" — not in the abstract, but against the landscape the user is
// already evaluating in data/score-history.tsv.
//
// The honest version of that question has three parts the user usually can't
// hold in their head at once:
//
//   1. Does it close a gap that's actually dragging my evaluations down?
//      A cert that lifts a dimension already averaging 8 is a vanity purchase;
//      one that attacks the dimension most often holding Overall down (the
//      systemic "dimension drag" from targeting-core.mjs) has real leverage.
//
//   2. Does it map to roles I'm actually targeting? A blockchain cert is
//      useless if every strong match in my corpus is a Strategy & Ops role.
//      We cross the training's mapped archetypes against where the landscape
//      is actually giving the user strong matches (archetypePerformance).
//
//   3. What does it cost vs. what it plausibly returns? Time (weeks × hrs)
//      and money, weighed against how much of the corpus the targeted gap
//      touches. A 12-week grind to nudge a dimension that's only low in 8% of
//      evals is a bad trade; a 2-week course attacking a drag present in 60%
//      of evals is a great one.
//
// The verdict is DETERMINISTIC: the same offer + same corpus always yields the
// same WORTH_IT / TIMEBOX / SKIP. The mode prose reads the trace verbatim so
// the user can audit every step — exactly like the scouting `explanation`
// block. All functions are pure (no I/O, no globals); the file/CLI wrapper is
// scripts/training-roi.mjs.

import {
  DIMENSIONS,
  dimensionDrag,
  archetypePerformance,
  normalizeArchetype,
} from './targeting-core.mjs'

const round2 = (n) => Math.round(n * 100) / 100
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/* ───── Dimension key aliases ───────────────────────────────────────────────
 *
 * A user describing a course will name dimensions loosely ("skills", "ease of
 * entry", "brand"). Map those to the canonical score-history keys so the offer
 * input is forgiving. Returns null for an unrecognized token so the caller can
 * warn rather than silently drop it.
 */
const DIM_ALIASES = {
  skills_match: 'skills_match', skills: 'skills_match', skill: 'skills_match',
  'skills match': 'skills_match', stack: 'skills_match', technical: 'skills_match',
  ease_of_entry: 'ease_of_entry', ease: 'ease_of_entry', eoe: 'ease_of_entry',
  'ease of entry': 'ease_of_entry', reachability: 'ease_of_entry',
  experience: 'ease_of_entry', credential: 'ease_of_entry',
  strategic_fit: 'strategic_fit', strategic: 'strategic_fit',
  'strategic fit': 'strategic_fit', analytical: 'strategic_fit',
  'analytical fit': 'strategic_fit',
  growth_mobility: 'growth_mobility', growth: 'growth_mobility',
  mobility: 'growth_mobility', 'growth mobility': 'growth_mobility',
  optionality_exit: 'optionality_exit', optionality: 'optionality_exit',
  exit: 'optionality_exit', 'optionality exit': 'optionality_exit',
  brand_value: 'brand_value', brand: 'brand_value', 'brand value': 'brand_value',
}

const DIM_LABEL = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]))

export function normalizeDimensionKey(raw) {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase().replace(/[\s/_-]+/g, ' ').trim()
  return DIM_ALIASES[s] || DIM_ALIASES[s.replace(/ /g, '_')] || null
}

/* ───── Gap relevance ───────────────────────────────────────────────────────
 *
 * For each dimension the training claims to lift, how much of a systemic drag
 * is that dimension right now? We pull the drag table (already sorted weakest-
 * first, with avg + lowShare per dimension) and rank where each targeted dim
 * sits. A training pointed at the #1 drag is maximally relevant; one pointed at
 * a dimension that isn't dragging anything is closing a gap the user doesn't
 * have.
 *
 * `gapScore` (0..1) blends two signals so neither alone dominates:
 *   - how far below the 1-10 midpoint the dim's average sits (depth of drag)
 *   - the share of evals where it scores in the bottom range (breadth of drag)
 * A dim averaging 4.5 that's low in 50% of evals is a deeper, broader gap than
 * one averaging 5.5 that's low in 10%.
 */
export function gapRelevance(rows, targetDims) {
  const drag = dimensionDrag(rows) // sorted weakest-first
  const dragByKey = new Map(drag.map((d) => [d.key, d]))
  const rank = new Map(drag.map((d, i) => [d.key, i + 1]))

  const targeted = targetDims
    .map((k) => {
      const d = dragByKey.get(k)
      if (!d) return null // dim never appears in the corpus (no data)
      // Depth: how far the average sits below the 1-10 midpoint (5.5),
      // normalized to 0..1 (a dim at avg 1 → ~0.9; at avg 7+ → 0).
      const depth = clamp((5.5 - d.avg) / 4.5, 0, 1)
      // Breadth: share of evals where the dim is an active drag (≤4).
      const breadth = clamp(d.lowShare / 100, 0, 1)
      const gapScore = round2(0.6 * depth + 0.4 * breadth)
      return {
        key: d.key,
        label: d.label,
        avg: d.avg,
        lowShare: d.lowShare,
        dragRank: rank.get(d.key), // 1 = weakest dimension overall
        gapScore,
        isSystemicDrag: d.avg < 6.0 || d.lowShare >= 25,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.gapScore - a.gapScore)

  return {
    targeted,
    // The best gap this training addresses drives the verdict.
    best: targeted[0] || null,
    // How many distinct dimensions exist in the corpus, for context.
    dimsInCorpus: drag.length,
    dragTable: drag,
  }
}

/* ───── Targeting relevance ─────────────────────────────────────────────────
 *
 * Do the archetypes this training maps to overlap with where the user is
 * actually finding strong matches? We match each mapped archetype against the
 * archetypePerformance buckets (normalized, so spacing variants collapse). A
 * training that maps to the user's densest, highest-scoring archetype is on-
 * target; one that maps to nothing in the corpus is a bet on a market the user
 * hasn't validated.
 */
export function targetingRelevance(rows, mappedArchetypes) {
  const perf = archetypePerformance(rows)
  const perfByKey = new Map(perf.map((p) => [p.archetype, p]))
  const norm = mappedArchetypes.map((a) => normalizeArchetype(a))

  const matched = []
  const unmatched = []
  for (const a of norm) {
    // Exact normalized match, else a primary-segment / substring containment
    // match so "Strategy & Operations" maps to "Strategy & Operations / BizOps".
    let hit = perfByKey.get(a)
    if (!hit) {
      hit = perf.find(
        (p) => p.archetype.includes(a) || a.includes(p.archetype),
      )
    }
    if (hit) matched.push({ requested: a, ...hit })
    else unmatched.push(a)
  }

  // Of the archetypes this training serves, how strong is the best one the
  // user is actually seeing in the market? (avg Overall of the matched bucket).
  matched.sort((a, b) => b.avgOverall - a.avgOverall)
  const best = matched[0] || null
  return {
    matched,
    unmatched,
    best,
    // Share of the whole evaluated landscape covered by the matched archetypes.
    landscapeShare: matched.reduce((s, m) => s + (m.share || 0), 0),
  }
}

/* ───── Effort & opportunity cost ───────────────────────────────────────────
 *
 * Total committed hours and a coarse band. The opportunity cost isn't money —
 * it's the applications, projects, and proof points NOT built during the
 * training window. We band total hours so the verdict can weigh a 10-hour
 * micro-course differently from a 200-hour bootcamp.
 */
export function effortProfile({ weeks = 0, hoursPerWeek = 0, costEur = 0 } = {}) {
  const w = Math.max(0, Number(weeks) || 0)
  const hpw = Math.max(0, Number(hoursPerWeek) || 0)
  const totalHours = round2(w * hpw)
  let band
  if (totalHours <= 20) band = 'micro' // a weekend / a few evenings
  else if (totalHours <= 60) band = 'light' // a few weeks part-time
  else if (totalHours <= 150) band = 'heavy' // a real multi-week commitment
  else band = 'major' // bootcamp-scale; displaces a job-search cycle
  return {
    weeks: w,
    hoursPerWeek: hpw,
    totalHours,
    costEur: Math.max(0, Number(costEur) || 0),
    band,
  }
}

/* ───── Verdict ─────────────────────────────────────────────────────────────
 *
 * Combine gap relevance, targeting relevance, effort, and a couple of binary
 * signals (brand strength, portfolio artifact) into a deterministic verdict
 * with a full reasoning trace. The thresholds are intentionally explicit so the
 * mode prose can cite them.
 *
 * Verdicts:
 *   WORTH_IT — closes a real systemic drag on roles the user targets, at a
 *              proportionate effort. Apply the training.
 *   TIMEBOX  — the gap is real but the offer is over-scoped, or the offer is
 *              good but the gap is only moderate: do a condensed version, cap
 *              the hours, take only what closes the gap.
 *   SKIP     — the gap isn't systemic, the archetypes don't match the corpus,
 *              or the effort dwarfs the payoff. Don't do it; cheaper alt below.
 */
export function trainingVerdict(rows, offer) {
  const targetDims = (offer.targetDimensions || [])
    .map(normalizeDimensionKey)
    .filter(Boolean)
  const unknownDims = (offer.targetDimensions || []).filter(
    (d) => normalizeDimensionKey(d) == null,
  )

  const gap = gapRelevance(rows, targetDims)
  const targeting = targetingRelevance(rows, offer.mappedArchetypes || [])
  const effort = effortProfile(offer)

  const trace = []
  const bestGap = gap.best
  const bestArch = targeting.best

  // ── Signal 1: does it attack a systemic drag? ──
  const attacksDrag = !!(bestGap && bestGap.isSystemicDrag)
  if (!bestGap) {
    trace.push(
      targetDims.length === 0
        ? 'No target dimension supplied — cannot tie the training to a gap.'
        : 'The targeted dimension(s) have no data in your corpus yet — no measured gap to close.',
    )
  } else if (attacksDrag) {
    trace.push(
      `Attacks "${bestGap.label}" — a systemic drag (avg ${bestGap.avg}, low in ${bestGap.lowShare}% of evals, drag-rank #${bestGap.dragRank} of ${gap.dimsInCorpus}).`,
    )
  } else {
    trace.push(
      `"${bestGap.label}" is NOT currently dragging your evals (avg ${bestGap.avg}, low in ${bestGap.lowShare}%) — closing it has little leverage.`,
    )
  }

  // ── Signal 2: do the archetypes match the corpus? ──
  const archMatches = !!bestArch
  if (!offer.mappedArchetypes || offer.mappedArchetypes.length === 0) {
    trace.push('No mapped archetypes supplied — cannot tie the training to roles you target.')
  } else if (archMatches) {
    trace.push(
      `Maps to "${bestArch.archetype}" — a real part of your landscape (avg Overall ${bestArch.avgOverall} across ${bestArch.count} roles, ${targeting.landscapeShare}% of all evals).`,
    )
  } else {
    trace.push(
      `Mapped archetypes (${targeting.unmatched.join(', ')}) don't appear in your evaluated corpus — this bets on a market you haven't validated.`,
    )
  }

  // ── Signal 3: effort proportionality ──
  // A training is "proportionate" when its effort band is justified by the
  // breadth of the gap it closes. Heavy/major effort needs a broad, systemic
  // drag to pay off; micro/light effort is forgiven a smaller gap.
  const gapBreadth = bestGap ? bestGap.gapScore : 0
  const effortWeight = { micro: 0.1, light: 0.3, heavy: 0.6, major: 1.0 }[effort.band]
  const proportionate = gapBreadth >= effortWeight - 0.15
  trace.push(
    `Effort: ${effort.totalHours}h over ${effort.weeks}w (${effort.band})${
      effort.costEur ? `, €${effort.costEur}` : ''
    } — ${proportionate ? 'proportionate to' : 'heavy relative to'} the gap it closes (gapScore ${gapBreadth}).`,
  )

  // ── Signal 4: secondary quality signals ──
  const hasArtifact = offer.producesArtifact === true
  if (hasArtifact) trace.push('Produces a demonstrable portfolio artifact (lifts Skills Match directly on your CV).')
  const strongBrand = offer.brandStrength != null && Number(offer.brandStrength) >= 7
  if (offer.brandStrength != null) {
    trace.push(
      strongBrand
        ? `Credential brand is recruiter-recognized (brandStrength ${offer.brandStrength}/10).`
        : `Credential brand is weak (brandStrength ${offer.brandStrength}/10) — limited recruiter signal.`,
    )
  }

  // ── Verdict decision tree (deterministic) ──
  let verdict
  let headline
  if (!attacksDrag || !archMatches) {
    // Either the gap isn't real or the archetypes are off-target.
    verdict = 'SKIP'
    if (!attacksDrag && !archMatches) {
      headline = "Closes a gap you don't have, for roles you aren't targeting."
    } else if (!attacksDrag) {
      headline = `"${bestGap ? bestGap.label : 'The targeted dimension'}" isn't dragging your evals — the lift has little leverage.`
    } else {
      headline = "Maps to archetypes that don't show up in your evaluated landscape."
    }
  } else if (proportionate && (hasArtifact || strongBrand || gapBreadth >= 0.5)) {
    verdict = 'WORTH_IT'
    headline = `Closes "${bestGap.label}" — your ${ordinal(bestGap.dragRank)}-weakest dimension — for "${bestArch.archetype}" roles you actually target.`
  } else {
    // Right gap, right archetypes, but over-scoped or thin secondary signal.
    verdict = 'TIMEBOX'
    headline = proportionate
      ? `Right gap and archetypes, but the credential signal is thin — do it only if the artifact is reusable.`
      : `The gap is real but the offer is over-scoped — take only the ${bestGap.label}-closing part, cap the hours.`
  }

  return {
    verdict, // WORTH_IT | TIMEBOX | SKIP
    headline,
    trace, // ordered reasoning lines, render verbatim
    signals: {
      attacksDrag,
      archMatches,
      proportionate,
      hasArtifact,
      strongBrand,
      gapScore: gapBreadth,
      effortBand: effort.band,
    },
    bestGap,
    bestArchetype: bestArch,
    effort,
    unknownDimensions: unknownDims,
    // Surface the full drag/perf context so the mode can show "here's the
    // dimension you SHOULD be targeting instead" when the verdict is SKIP.
    context: {
      topDrag: gap.dragTable[0] || null,
      dragTable: gap.dragTable,
      topArchetypes: archetypePerformance(rows).slice(0, 5),
    },
  }
}

function ordinal(n) {
  if (!Number.isFinite(n)) return `#${n}`
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export { DIM_LABEL }
