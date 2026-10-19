// explain-score.mjs — pure scoring EXPLAINABILITY (scoring v2).
//
// score-bands.mjs answers "what are Want, Ease and the verdict". This module
// answers the question the user actually has when they read a report:
//
//   "Why did it land in this cell, and what single thing would move it up?"
//
// It is pure (no I/O, no mutation, no globals) and it does NOT re-implement
// any rule. Every hypothetical ("what if Skills Match were 8?", "what if the
// start-date amber were resolved?") is answered by replaying the canonical
// rollupWant / rollupEase / assignVerdict from score-bands.mjs, so the
// explanation can never drift from the engine. If a threshold changes there,
// the constraints and levers here recompute with zero edits.
//
// Spec: docs/scoring-v2.md §7.
//
// Outputs:
//   bindingConstraints — what keeps the listing out of a better cell
//                        (eligibility_red, experience_wall, hygiene_veto,
//                        role_content_veto, low_want, low_ease, amber)
//   drivers            — which motivators / hygiene terms / Ease stages
//                        carry or drag each rollup
//   levers             — the smallest single-dimension integer raise (≤ +4),
//                        or single amber resolved, that reaches a better cell
//   sensitivity        — which single −1 would drop the verdict
//   headline / whyThisScore — the report-ready text ("Holding it back:" /
//                        "Closest lever:" labels, same as v1 so parsers work)

import {
  rollupWant,
  rollupEase,
  assignVerdict,
  verdictRank,
  MOTIVATOR_DIMS,
  HYGIENE_DIMS,
  EASE_DIMS,
  WANT_HIGH,
  WANT_MID,
  EASE_HIGH,
  EASE_MID,
  EXPERIENCE_WALL_AT,
  EXPERIENCE_WALL_CAP,
  HYGIENE_VETO_BELOW,
  ROLE_CONTENT_VETO_AT,
  VERDICT_LABELS,
} from './score-bands.mjs'

// Display labels, matching the report's dimensional table (spec §8.5). Kept
// here (not imported from a frontend module) so this stays runnable under
// plain `node`. Includes the computed Salary dimension for table rendering.
export const DIM_LABELS = Object.freeze({
  growth_mobility:   'Growth / Mobility',
  optionality_exit:  'Optionality / Exit',
  brand_value:       'Brand Value',
  role_content:      'Role content',
  best_cities:       'City',
  salary_adj_city:   'Salary Adj for City',
  work_life_balance: 'Work-Life Balance',
  skills_match:      'Skills Match',
  experience_bar:    'Experience bar',
  competition:       'Competition',
})

export const CHECK_LABELS = Object.freeze({
  start_date: 'Start date',
  duration:   'Duration',
  graduation: 'Graduation',
  language:   'Language',
  work_auth:  'Work authorisation',
  other:      'Other requirement',
})

// The nine judgment dimensions the agent scores. Salary Adj is computed from
// comp / tax / cost of living, so it isn't a lever: it moves only when the
// offer does.
export const LEVER_DIMS = Object.freeze([...MOTIVATOR_DIMS, 'best_cities', 'work_life_balance', ...EASE_DIMS])

export const MAX_LEVER_STEPS = 4

// A dimension at or below this is a "weak" driver worth naming as a drag.
const WEAK_THRESHOLD = 5

const round2 = (n) => Number(n.toFixed(2))
const label = (dim) => DIM_LABELS[dim] ?? dim
const vLabel = (v) => VERDICT_LABELS[v] ?? v

/* ───── engine replay ───────────────────────────────────────────── */

// Replay the canonical engine for a (possibly hypothetical) dim set and
// amber count. The only scoring logic in this module is the call below.
function replay(dims, status, amberCount, context) {
  if (status === 'red') return { want: null, ease: null, verdict: 'blocked' }
  const want = rollupWant(dims, {
    weights: context?.weights?.want,
    is_intern: context?.is_intern === true,
    dream: context?.dream === true,
  })
  const ease = rollupEase(dims, { weights: context?.weights?.ease, amber_count: amberCount })
  const { verdict } = assignVerdict({ want: want.score, ease: ease.score, eligibility: status })
  return { want, ease, verdict }
}

const verdictFor = (want, ease) => assignVerdict({ want, ease, eligibility: 'green' }).verdict

// Every amber item that can be resolved on its own: one per amber check,
// and one per amber entry of the `other` check (each counts toward
// amber_count separately).
function amberItems(eligibility) {
  const items = []
  for (const c of eligibility?.checks ?? []) {
    if (c.check === 'other' && Array.isArray(c.entries)) {
      c.entries.forEach((e, index) => {
        if (e.status === 'amber') items.push({ check: 'other', index, reason: e.reason, question: e.question })
      })
    } else if (c.status === 'amber') {
      items.push({ check: c.check, reason: c.reason, question: c.question })
    }
  }
  return items
}

function redItems(eligibility) {
  const items = []
  for (const c of eligibility?.checks ?? []) {
    if (c.check === 'other' && Array.isArray(c.entries)) {
      c.entries.forEach((e, index) => {
        if (e.status === 'red') items.push({ check: 'other', index, reason: e.reason })
      })
    } else if (c.status === 'red') {
      items.push({ check: c.check, reason: c.reason })
    }
  }
  return items
}

function normalise({ dims, eligibility }) {
  const status = eligibility?.status ?? 'green'
  const amberCount = eligibility?.amber_count ?? amberItems(eligibility).length
  return { dims: dims ?? {}, status, amberCount }
}

const lowest = (dims, keys) => keys.reduce((lo, k) => (dims[k] < dims[lo] ? k : lo), keys[0])

/* ───── binding constraints ─────────────────────────────────────── */

/**
 * What keeps the listing out of a better cell. Each entry:
 *   { kind, dimension?, label, value?, check?, question?, binding, message }
 * `binding` = lifting this constraint alone (to its threshold) would reach a
 * better cell. Binding constraints come first; within each group the order
 * is eligibility_red, experience_wall, hygiene_veto, role_content_veto,
 * low_want, low_ease, amber. A `go` listing only ever carries non-binding
 * ambers.
 */
export function bindingConstraints({ dims, eligibility, context }) {
  const n = normalise({ dims, eligibility })
  if (n.status === 'red') {
    return redItems(eligibility).map(r => ({
      kind: 'eligibility_red',
      check: r.check,
      label: CHECK_LABELS[r.check] ?? r.check,
      binding: true,
      message: `${CHECK_LABELS[r.check] ?? r.check} is red: ${r.reason}. Eligibility is a gate, so the listing is Blocked and not scored.`,
    }))
  }

  const base = replay(n.dims, n.status, n.amberCount, context)
  const rank = verdictRank(base.verdict)
  const better = (v) => verdictRank(v) > rank
  const want = base.want.score
  const ease = base.ease.score
  const out = []

  // 1. Experience wall.
  if (base.ease.wall) {
    out.push({
      kind: 'experience_wall',
      dimension: 'experience_bar',
      label: label('experience_bar'),
      value: n.dims.experience_bar,
      binding: better(verdictFor(want, base.ease.unwalled)),
      message:
        `${label('experience_bar')} ${n.dims.experience_bar}/10 hits the experience wall (≤ ${EXPERIENCE_WALL_AT}): ` +
        `Ease is capped at ${EXPERIENCE_WALL_CAP} (it would be ${base.ease.unwalled} without the wall).`,
    })
  }

  // 2–3. Want vetoes. Lifting one veto leaves the others in force.
  for (const veto of base.want.vetoes) {
    const others = base.want.vetoes.filter(v => v !== veto)
    const without = Math.min(base.want.uncapped, ...others.map(v => v.cap))
    const isHygiene = veto.kind === 'hygiene_veto'
    out.push({
      kind: veto.kind,
      dimension: veto.dimension,
      label: label(veto.dimension),
      value: veto.value,
      binding: veto.applied && better(verdictFor(without, ease)),
      message: isHygiene
        ? `${label(veto.dimension)} ${veto.value}/10 is below ${HYGIENE_VETO_BELOW}: the hygiene veto caps Want at ${veto.cap.toFixed(1)}.`
        : `${label('role_content')} ${veto.value}/10 (≤ ${ROLE_CONTENT_VETO_AT}): the role-content veto caps Want at ${veto.cap.toFixed(1)}.`,
    })
  }

  // 4. Want below the next row.
  if (want < WANT_HIGH) {
    const threshold = want < WANT_MID ? WANT_MID : WANT_HIGH
    const weakest = lowest(n.dims, MOTIVATOR_DIMS)
    out.push({
      kind: 'low_want',
      dimension: weakest,
      label: 'Want',
      value: want,
      threshold,
      binding: better(verdictFor(threshold, ease)),
      message:
        `Want ${want} is below ${threshold.toFixed(1)}; its weakest motivator is ` +
        `${label(weakest)} ${n.dims[weakest]}/10.`,
    })
  }

  // 5. Ease below the next column.
  if (ease < EASE_HIGH) {
    const threshold = ease < EASE_MID ? EASE_MID : EASE_HIGH
    const weakest = lowest(n.dims, EASE_DIMS)
    out.push({
      kind: 'low_ease',
      dimension: weakest,
      label: 'Ease',
      value: ease,
      threshold,
      binding: better(verdictFor(want, threshold)),
      message:
        `Ease ${ease} is below ${threshold.toFixed(1)}; its weakest stage is ` +
        `${label(weakest)} ${n.dims[weakest]}/10.`,
    })
  }

  // 6. Each amber, with what resolving it alone is worth.
  if (n.amberCount > 0) {
    const resolved = replay(n.dims, n.status, n.amberCount - 1, context)
    const gain = round2(resolved.ease.score - ease)
    for (const a of amberItems(eligibility)) {
      out.push({
        kind: 'amber',
        check: a.check,
        label: CHECK_LABELS[a.check] ?? a.check,
        question: a.question,
        value: gain,
        binding: better(resolved.verdict),
        message:
          `${CHECK_LABELS[a.check] ?? a.check} is amber: ${a.reason}. ` +
          `Resolve: ${a.question} (worth +${gain} Ease).`,
      })
    }
  }

  // Binding first, stable within each group.
  return [...out.filter(c => c.binding), ...out.filter(c => !c.binding)]
}

/* ───── drivers ─────────────────────────────────────────────────── */

/**
 * Per-rollup driver analysis.
 *   want: { motivators_mean, topLift, biggestDrag, hygiene: [{dimension,label,value,term}], weak }
 *   ease: { topLift, biggestDrag, weak }
 * Motivator deltas are against the motivator mean; hygiene entries are the
 * h(x) terms the engine added (most negative first). Null when blocked.
 */
export function drivers({ dims, eligibility, context }) {
  const n = normalise({ dims, eligibility })
  if (n.status === 'red') return null
  const base = replay(n.dims, n.status, n.amberCount, context)
  const mean = base.want.motivators_mean
  const motivators = MOTIVATOR_DIMS
    .map(d => ({ dimension: d, label: label(d), value: n.dims[d], delta: round2(n.dims[d] - mean) }))
    .sort((a, b) => b.delta - a.delta)
  const hygiene = HYGIENE_DIMS
    .map(d => ({ dimension: d, label: label(d), value: n.dims[d], term: base.want.hygiene[d] }))
    .sort((a, b) => a.term - b.term)
  const stages = EASE_DIMS
    .map(d => ({ dimension: d, label: label(d), value: n.dims[d] }))
    .sort((a, b) => b.value - a.value)
  return {
    want: {
      score: base.want.score,
      motivators_mean: mean,
      topLift: motivators[0],
      biggestDrag: motivators[motivators.length - 1],
      hygiene,
      weak: motivators.filter(m => m.value <= WEAK_THRESHOLD),
    },
    ease: {
      score: base.ease.score,
      geometric: base.ease.geometric,
      topLift: stages[0],
      biggestDrag: stages[stages.length - 1],
      weak: stages.filter(s => s.value <= WEAK_THRESHOLD),
    },
  }
}

/* ───── levers ──────────────────────────────────────────────────── */

/**
 * For each judgment dimension, the smallest integer raise (up to +4, capped
 * at 10) that reaches a strictly better cell; plus each amber that, resolved
 * alone, does. Better = higher in VERDICT_ORDER. Replays the engine at every
 * probe.
 *
 * Returns levers sorted cheapest first (an amber counts as a lift of 1 and
 * wins ties: asking one question is cheaper than changing the role), then by
 * the better resulting cell. Each lever:
 *   dimension lever: { kind: 'dimension', dimension, label, from, to, lift, fromVerdict, newVerdict, message }
 *   amber lever:     { kind: 'amber', check, label, question, from: 'amber', to: 'green', lift: 1, fromVerdict, newVerdict, message }
 * Empty array = "no single lever" (or already `go`, or blocked).
 */
export function verdictLevers({ dims, eligibility, context, maxSteps = MAX_LEVER_STEPS }) {
  const n = normalise({ dims, eligibility })
  if (n.status === 'red') return []
  const base = replay(n.dims, n.status, n.amberCount, context)
  const rank = verdictRank(base.verdict)
  const levers = []

  for (const dim of LEVER_DIMS) {
    const cur = n.dims[dim]
    if (!Number.isFinite(cur) || cur >= 10) continue
    for (let step = 1; step <= maxSteps; step++) {
      const to = round2(Math.min(10, cur + step))
      const probe = replay({ ...n.dims, [dim]: to }, n.status, n.amberCount, context)
      if (verdictRank(probe.verdict) > rank) {
        const from = round2(cur)
        const lift = round2(to - cur)
        levers.push({
          kind: 'dimension',
          dimension: dim,
          label: label(dim),
          from,
          to,
          lift,
          fromVerdict: base.verdict,
          newVerdict: probe.verdict,
          message:
            `${label(dim)} ${from} → ${to} (+${lift}) would move this from ` +
            `${vLabel(base.verdict)} to ${vLabel(probe.verdict)}.`,
        })
        break
      }
      if (to >= 10) break
    }
  }

  if (n.amberCount > 0) {
    const resolved = replay(n.dims, n.status, n.amberCount - 1, context)
    if (verdictRank(resolved.verdict) > rank) {
      const gain = round2(resolved.ease.score - base.ease.score)
      for (const a of amberItems(eligibility)) {
        levers.push({
          kind: 'amber',
          check: a.check,
          label: CHECK_LABELS[a.check] ?? a.check,
          question: a.question,
          from: 'amber',
          to: 'green',
          lift: 1,
          fromVerdict: base.verdict,
          newVerdict: resolved.verdict,
          message:
            `Resolve the ${(CHECK_LABELS[a.check] ?? a.check).toLowerCase()} amber (ask: "${a.question}"): ` +
            `+${gain} Ease would move this from ${vLabel(base.verdict)} to ${vLabel(resolved.verdict)}.`,
        })
      }
    }
  }

  const order = (l) => (l.kind === 'amber' ? -1 : LEVER_DIMS.indexOf(l.dimension))
  return levers.sort((a, b) =>
    a.lift - b.lift ||
    (a.kind === 'amber' ? 0 : 1) - (b.kind === 'amber' ? 0 : 1) ||
    verdictRank(b.newVerdict) - verdictRank(a.newVerdict) ||
    order(a) - order(b))
}

/* ───── sensitivity ─────────────────────────────────────────────── */

/**
 * Downside fragility: which single −1 on a judgment dimension drops the
 * verdict to a worse cell. Returns { fragile, verdict, weakestLinks, cushion }.
 */
export function sensitivity({ dims, eligibility, context, drop = 1 }) {
  const n = normalise({ dims, eligibility })
  if (n.status === 'red') return { fragile: false, verdict: 'blocked', weakestLinks: [], cushion: 0 }
  const base = replay(n.dims, n.status, n.amberCount, context)
  const rank = verdictRank(base.verdict)
  const weakestLinks = []
  let cushion = 0
  for (const dim of LEVER_DIMS) {
    const cur = n.dims[dim]
    const lowered = Math.max(1, round2(cur - drop))
    if (lowered === cur) { cushion++; continue }
    const probe = replay({ ...n.dims, [dim]: lowered }, n.status, n.amberCount, context)
    if (verdictRank(probe.verdict) < rank) {
      weakestLinks.push({
        dimension: dim,
        label: label(dim),
        value: round2(cur),
        drop: round2(cur - lowered),
        toVerdict: probe.verdict,
        message:
          `${label(dim)} is load-bearing: −${round2(cur - lowered)} (to ${lowered}/10) ` +
          `would drop this from ${vLabel(base.verdict)} to ${vLabel(probe.verdict)}.`,
      })
    } else {
      cushion++
    }
  }
  weakestLinks.sort((a, b) => a.value - b.value)
  return { fragile: weakestLinks.length > 0, verdict: base.verdict, weakestLinks, cushion }
}

/* ───── bundle ──────────────────────────────────────────────────── */

/**
 * Assemble the full explainability bundle. This is what score-listing.mjs
 * attaches to its output and what the report renders from.
 *
 *   dims         final dimension values (calibrated, competition incl. the
 *                referral bonus, salary_adj_city computed); null when blocked
 *   eligibility  evaluateEligibility() result
 *   context      { is_intern, dream, weights: { want, ease } }
 *
 * Returns { verdict, bindingConstraints, drivers, levers, sensitivity,
 *           headline, holdingItBack, closestLever, whyThisScore }
 *   whyThisScore = the two report bullets, verbatim:
 *     - **Holding it back:** …
 *     - **Closest lever:** …
 */
export function explainScore({ dims, eligibility, context }) {
  const n = normalise({ dims, eligibility })
  const verdict = n.status === 'red' ? 'blocked' : replay(n.dims, n.status, n.amberCount, context).verdict
  const constraints = bindingConstraints({ dims, eligibility, context })
  const drv = drivers({ dims, eligibility, context })
  const levers = verdictLevers({ dims, eligibility, context })
  const fragility = sensitivity({ dims, eligibility, context })

  let holdingItBack
  let closestLever
  let headline
  if (verdict === 'blocked') {
    holdingItBack = constraints[0]?.message ?? 'Eligibility is red.'
    closestLever = 'No single lever: eligibility is a gate, not a score. It changes only if the blocking fact changes.'
    const reds = redItems(eligibility).map(r => `${CHECK_LABELS[r.check] ?? r.check}: ${r.reason}`)
    headline = `Blocked by eligibility (${reds.join('; ') || 'red'}).`
  } else if (verdict === 'go') {
    holdingItBack = `Nothing: Want ${drv.want.score} and Ease ${drv.ease.score} both clear the Go thresholds.`
    closestLever = 'None needed: already the top cell.'
    headline =
      `Go: Want ${drv.want.score}, Ease ${drv.ease.score}; ` +
      `${drv.want.topLift.label} and ${drv.ease.topLift.label} lead.`
  } else {
    holdingItBack = constraints[0]?.message ?? `${vLabel(verdict)} cell.`
    closestLever = levers[0]?.message ??
      `No single lever: no one-dimension raise of up to +${MAX_LEVER_STEPS}, or single amber resolved, reaches a better cell.`
    headline = levers[0]
      ? `${vLabel(verdict)}: ${holdingItBack} Closest lever: ${levers[0].message}`
      : `${vLabel(verdict)}: ${holdingItBack} No single change moves the verdict.`
  }

  const whyThisScore = `- **Holding it back:** ${holdingItBack}\n- **Closest lever:** ${closestLever}`

  return {
    verdict,
    bindingConstraints: constraints,
    drivers: drv,
    levers,
    sensitivity: fragility,
    headline,
    holdingItBack,
    closestLever,
    whyThisScore,
  }
}
