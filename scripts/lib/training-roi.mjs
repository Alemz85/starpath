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
//      one that attacks the dimension most often holding Ease down (the
//      systemic "dimension drag" from targeting-core.mjs) has real leverage.
//      A training moves the CANDIDATE, so the dimensions it can lift are the
//      Ease side — skills_match, experience_bar, competition — plus
//      role_content when it repositions the candidate toward the kind of work
//      they want (TRAINABLE_DIMS). The role-side Want dimensions (growth,
//      optionality, brand, city, salary, WLB) belong to the listing, not the
//      candidate; no course moves them.
//
//   2. Does it map to roles I'm actually targeting? A blockchain cert is
//      useless if every actionable match in my corpus is a Strategy & Ops
//      role. We cross the training's mapped archetypes against where the
//      landscape is actually giving the user matches (archetypePerformance).
//
//   3. What does it plausibly return? We REPLAY the scoring engine
//      (rollupEase / rollupWant → assignVerdict → computePriority) on the
//      in-target rows with the targeted dimension(s) lifted by
//      `expectedLift` integer steps, and report the Ease uplift and the
//      verdict changes (e.g. thin → solid). Rules are never re-derived here.
//
//   4. What does it cost? Time (weeks × hrs) and money, weighed against how
//      much of the corpus the targeted gap touches. A 12-week grind to nudge
//      a dimension that's only low in 8% of evals is a bad trade; a 2-week
//      course attacking a drag present in 60% of evals is a great one.
//
// Blocked rows (eligibility red, empty score cells) are excluded from all of
// the score math above; a course can't fix an eligibility wall it doesn't
// model.
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
  scoredRows,
  isActionable,
} from './targeting-core.mjs'
import {
  rollupWant,
  rollupEase,
  assignVerdict,
  computePriority,
  verdictRank,
  EASE_DIMS,
  WANT_DIMS,
} from './score-bands.mjs'
import { classifyMovement } from './scoring-stats.mjs'

const round2 = (n) => Math.round(n * 100) / 100
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/* ───── Trainable dimensions + key aliases ──────────────────────────────────
 *
 * A training can only move what belongs to the candidate: the three Ease
 * dimensions, plus role_content (positioning toward the work they want).
 *
 * A user describing a course will name dimensions loosely ("skills",
 * "experience", "language"). Map those to the canonical score-history keys so
 * the offer input is forgiving. Returns null for an unrecognized or
 * non-trainable token so the caller can warn rather than silently drop it.
 */
export const TRAINABLE_DIMS = Object.freeze(['skills_match', 'experience_bar', 'competition', 'role_content'])

const DIM_ALIASES = {
  'skills match': 'skills_match', skills: 'skills_match', skill: 'skills_match',
  stack: 'skills_match', technical: 'skills_match', tools: 'skills_match',
  'experience bar': 'experience_bar', experience: 'experience_bar',
  seniority: 'experience_bar', yoe: 'experience_bar', 'years of experience': 'experience_bar',
  competition: 'competition', competitiveness: 'competition', pool: 'competition',
  credential: 'competition', signalling: 'competition', signaling: 'competition',
  'role content': 'role_content', role: 'role_content', positioning: 'role_content',
  'day to day': 'role_content', 'work content': 'role_content',
}

/** Default integer steps a training is assumed to lift its target dims by. */
export const DEFAULT_EXPECTED_LIFT = 1

/** Share (%) of replayed in-target rows that must be lifted INTO a better,
 *  actionable verdict (go / stretch / solid) for the projected uplift to
 *  count as a positive ROI signal on its own. skip → thin is an upgrade on
 *  the grid but not one worth paying for. */
export const VERDICT_UPGRADE_SHARE_MIN = 10

const DIM_LABEL = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]))

export function normalizeDimensionKey(raw) {
  if (!raw) return null
  const s = String(raw).trim().toLowerCase().replace(/[\s/_-]+/g, ' ').trim()
  return DIM_ALIASES[s] || null
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
        dragRank: rank.get(d.key), // 1 = weakest of all scored dimensions
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

  // Of the archetypes this training serves, which is the strongest the user
  // is actually seeing in the market? Actionable rate first (share of
  // go/stretch/solid verdicts), then avg Priority as the sort key.
  matched.sort((a, b) => b.actionableRate - a.actionableRate || b.avgPriority - a.avgPriority || b.count - a.count)
  const best = matched[0] || null
  return {
    matched,
    unmatched,
    best,
    // Share of the whole evaluated landscape covered by the matched archetypes.
    landscapeShare: matched.reduce((s, m) => s + (m.share || 0), 0),
  }
}

/* ───── Projected uplift (engine replay) ───────────────────────────────────
 *
 * "If this course lifts Skills Match by one step, what happens to my
 * landscape?" For every scored (non-blocked) row in scope, replay the engine
 * twice — as stored, and with each targeted dimension raised by `lift` steps
 * (capped at 10) — and compare:
 *
 *   - Ease (when an Ease dim is targeted) via rollupEase, with the row's
 *     amber-flag count as `amber_count`;
 *   - Want (when role_content is targeted) via rollupWant, is_intern from the
 *     row's employment_type (dream floor unknown at row level → off; both
 *     sides use the same assumption so the delta isolates the lift);
 *   - the side not touched keeps the stored value;
 *   - verdict via assignVerdict, Priority via computePriority.
 *
 * Both "before" and "after" are replays (not the stored cells), so the delta
 * comes purely from the lift even when the stored row was scored with
 * different weights or a referral bonus already folded into competition.
 *
 * Scope: rows whose archetype matched one of the training's mapped
 * archetypes; the whole scored landscape when none were supplied.
 *
 * Returns { scope, lift, dims, rows, avgEaseBefore, avgEaseAfter, easeDelta,
 *           easeMovement, avgWantDelta, avgPriorityDelta, upgrades,
 *           downgrades, upgradeShare, actionableUpgrades,
 *           actionableUpgradeShare, transitions: { 'thin→solid': n, … } }
 * upgrades = any better grid cell (VERDICT_ORDER); actionableUpgrades = the
 * subset that lands on go / stretch / solid.
 * easeMovement is classifyMovement(easeDelta, { metric: 'ease' }) —
 * 'improving' | 'declining' | 'within-noise' against the Ease noise floor
 * ('unknown' when no row could be replayed).
 */
const round2u = (n) => Math.round(n * 100) / 100
const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

function rowDims(row, keys) {
  const out = {}
  for (const k of keys) out[k] = row[k]
  return out
}

export function projectedUplift(rows, targetDims, opts = {}) {
  const {
    lift = DEFAULT_EXPECTED_LIFT,
    archetypes = null,       // normalized archetype names in scope, or null = all
    wantWeights,
    easeWeights,
  } = opts
  const step = Math.max(0, Number(lift) || 0)
  const dims = [...new Set((targetDims || []).filter((k) => TRAINABLE_DIMS.includes(k)))]
  const touchesEase = dims.some((k) => EASE_DIMS.includes(k))
  const touchesWant = dims.some((k) => WANT_DIMS.includes(k))

  const inScope = scoredRows(rows).filter((r) => !archetypes || archetypes.includes(r.archetype))
  // A row can only be replayed when every dimension of each replayed rollup
  // is present (old/partial rows are skipped, never filled with 0).
  const replayable = inScope.filter((r) =>
    (!touchesEase || EASE_DIMS.every((k) => Number.isFinite(r[k]))) &&
    (!touchesWant || WANT_DIMS.every((k) => Number.isFinite(r[k]))))

  const easeB = [], easeA = [], wantD = [], prioD = []
  const transitions = {}
  let upgrades = 0, downgrades = 0, actionableUpgrades = 0
  for (const r of replayable) {
    const amber = (r.eligibilityFlags || []).filter((f) => f.status === 'amber').length
    const isIntern = /intern/i.test(r.employment_type || '')
    const replay = (bump) => {
      const lifted = (k) => (bump && dims.includes(k) ? Math.min(10, r[k] + step) : r[k])
      const ease = touchesEase
        ? rollupEase(Object.fromEntries(EASE_DIMS.map((k) => [k, lifted(k)])), { weights: easeWeights, amber_count: amber }).score
        : r.ease
      const want = touchesWant
        ? rollupWant(Object.fromEntries(WANT_DIMS.map((k) => [k, lifted(k)])), { weights: wantWeights, is_intern: isIntern }).score
        : r.want
      const { verdict } = assignVerdict({ want, ease, eligibility: r.eligibility || 'green' })
      return { want, ease, verdict, priority: computePriority(want, ease) }
    }
    const before = replay(false)
    const after = replay(true)
    easeB.push(before.ease)
    easeA.push(after.ease)
    wantD.push(after.want - before.want)
    prioD.push(after.priority - before.priority)
    const rb = verdictRank(before.verdict), ra = verdictRank(after.verdict)
    if (ra > rb) {
      upgrades++
      if (isActionable(after.verdict)) actionableUpgrades++
    } else if (ra < rb) downgrades++
    if (before.verdict !== after.verdict) {
      const key = `${before.verdict}→${after.verdict}`
      transitions[key] = (transitions[key] || 0) + 1
    }
  }

  const n = replayable.length
  const easeDelta = round2u(meanOf(easeA) - meanOf(easeB))
  return {
    scope: archetypes ? 'mapped-archetypes' : 'landscape',
    lift: step,
    dims,
    rows: n,
    avgEaseBefore: round2u(meanOf(easeB)),
    avgEaseAfter: round2u(meanOf(easeA)),
    easeDelta,
    easeMovement: n ? classifyMovement(easeDelta, { metric: 'ease' }) : 'unknown',
    avgWantDelta: round2u(meanOf(wantD)),
    avgPriorityDelta: round2u(meanOf(prioD)),
    upgrades,
    downgrades,
    upgradeShare: n ? Math.round((upgrades / n) * 100) : 0,
    actionableUpgrades,
    actionableUpgradeShare: n ? Math.round((actionableUpgrades / n) * 100) : 0,
    transitions,
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
export function trainingVerdict(rows, offer, opts = {}) {
  const targetDims = [...new Set((offer.targetDimensions || [])
    .map(normalizeDimensionKey)
    .filter(Boolean))]
  const unknownDims = (offer.targetDimensions || []).filter(
    (d) => normalizeDimensionKey(d) == null,
  )

  const gap = gapRelevance(rows, targetDims)
  const targeting = targetingRelevance(rows, offer.mappedArchetypes || [])
  const effort = effortProfile(offer)
  const uplift = projectedUplift(rows, targetDims, {
    lift: offer.expectedLift ?? DEFAULT_EXPECTED_LIFT,
    archetypes: targeting.matched.length ? [...new Set(targeting.matched.map((m) => m.archetype))] : null,
    wantWeights: opts.wantWeights,
    easeWeights: opts.easeWeights,
  })

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
      `Maps to "${bestArch.archetype}" — a real part of your landscape (avg Want ${bestArch.avgWant} · Ease ${bestArch.avgEase} across ${bestArch.count} scored roles, ${bestArch.actionableRate}% actionable, ${targeting.landscapeShare}% of all scored evals).`,
    )
  } else {
    trace.push(
      `Mapped archetypes (${targeting.unmatched.join(', ')}) don't appear in your evaluated corpus — this bets on a market you haven't validated.`,
    )
  }

  // ── Signal 3: projected uplift (engine replay) ──
  const movesVerdicts = uplift.rows > 0 && uplift.actionableUpgradeShare >= VERDICT_UPGRADE_SHARE_MIN
  if (uplift.rows > 0) {
    const where = uplift.scope === 'mapped-archetypes' ? 'in-target' : 'scored'
    const easePart = uplift.dims.some((k) => EASE_DIMS.includes(k))
      ? `Ease ${uplift.avgEaseBefore} → ${uplift.avgEaseAfter} (${signed(uplift.easeDelta)}, ${uplift.easeMovement})`
      : `Want ${signed(uplift.avgWantDelta)} (Ease unchanged)`
    const moves = Object.entries(uplift.transitions)
      .filter(([k]) => { const [b, a] = k.split('→'); return verdictRank(a) > verdictRank(b) })
      .map(([k, c]) => `${k} ×${c}`)
    trace.push(
      `Projected: +${uplift.lift} step on ${uplift.dims.map((k) => DIM_LABEL[k] || k).join(' + ')} across ${uplift.rows} ${where} roles → ${easePart}; ${uplift.upgrades} verdict upgrade(s)${moves.length ? ` (${moves.join(', ')})` : ''}, ${uplift.actionableUpgrades} into an actionable verdict (${uplift.actionableUpgradeShare}%).`,
    )
  }

  // ── Signal 4: effort proportionality ──
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

  // ── Signal 5: secondary quality signals ──
  const hasArtifact = offer.producesArtifact === true
  if (hasArtifact) trace.push('Produces a demonstrable portfolio artifact (lifts Skills Match directly on your CV).')
  const strongBrand = offer.brandStrength != null && Number(offer.brandStrength) >= 7
  if (offer.brandStrength != null) {
    trace.push(
      strongBrand
        ? `Credential brand is recruiter-recognized (brandStrength ${offer.brandStrength} of 10).`
        : `Credential brand is weak (brandStrength ${offer.brandStrength} of 10) — limited recruiter signal.`,
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
  } else if (proportionate && (hasArtifact || strongBrand || gapBreadth >= 0.5 || movesVerdicts)) {
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
      movesVerdicts,
      hasArtifact,
      strongBrand,
      gapScore: gapBreadth,
      effortBand: effort.band,
    },
    bestGap,
    bestArchetype: bestArch,
    effort,
    uplift,
    unknownDimensions: unknownDims,
    // Surface the full drag/perf context so the mode can show "here's the
    // dimension you SHOULD be targeting instead" when the verdict is SKIP.
    context: {
      topDrag: gap.dragTable[0] || null,
      // The weakest dimension a training can actually move (TRAINABLE_DIMS).
      topTrainableDrag: gap.dragTable.find((d) => TRAINABLE_DIMS.includes(d.key)) || null,
      dragTable: gap.dragTable,
      topArchetypes: archetypePerformance(rows).slice(0, 5),
    },
  }
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n)
}

function ordinal(n) {
  if (!Number.isFinite(n)) return `#${n}`
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export { DIM_LABEL }
