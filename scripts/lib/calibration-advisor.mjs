// calibration-advisor.mjs — pure calibration-feedback math.
//
// The scoring engine reads calibration from user/profile.yml + user/_profile.md
// (weights, brand-bonus lists, comp targets) and applies it deterministically in
// scripts/lib/calibration.mjs. But the user has no feedback loop telling them
// whether that calibration still matches reality. They flagged some company as
// a dream company (floor its AF at 8) once, months ago — is it still earning
// that floor?
// Is a brand-affinity bonus firing on companies that score so high they didn't
// need it (the bonus is inert), or on companies that score so low even +1.0
// can't lift them past the apply bar (the bonus is misdirected)? Is a rubric
// dimension pinned at the ceiling on every single eval (it carries no
// discriminating signal — its weight is wasted)? Are the user's comp targets
// above what the landscape actually pays?
//
// targeting-core.mjs already answers "where is the landscape strong" from the
// same score-history.tsv. This module asks a different, complementary question:
// "does your stated calibration match the evidence?" — and turns the gaps into
// concrete, *suggested* edits to user/* (never applied automatically; the caller
// shows them and the user decides).
//
// Everything here is PURE: no I/O, no mutation of inputs, no globals. It takes
// already-parsed rows (via targeting-core's parseScoreHistory), an optional
// outcomes array (parsed from applications.md by the CLI), and the calibration
// object (the same shape calibration.mjs consumes). The thin file/CLI wrapper
// lives in scripts/calibration-advisor.mjs.

//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.4.
//
// The advisor produces two kinds of output and they are held to different
// standards. A DIAGNOSTIC describes the log ("this company's roles average
// 5.8 over 3 evals") and may be shown with its n at any sample size. An
// ADVISORY asks the user to change calibration, which silently alters every
// future score — so it is gated. Every advisory carries `sampleSize`, `gate`,
// and `confidence`; an advisory under its gate is not softened or hedged, it
// is moved into the `insufficientData` list and never rendered as a
// recommendation. Gate values live in scoring-stats.mjs, never here.

import { overallBand, normalizeArchetype, DIMENSIONS } from './targeting-core.mjs'
import { GATES, confidenceTier, describeSample } from './scoring-stats.mjs'

/* ───── small stats helpers (kept local so the lib is import-light) ───────── */
const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100
const finite = (arr) => arr.filter(Number.isFinite)
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN)
const median = (arr) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const stdev = (arr) => {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(mean(arr.map(v => (v - m) ** 2)))
}

/** Read the brand-bonus lists out of a calibration object, honoring the
 *  cems_adjacent_companies backward-compat alias exactly as calibration.mjs does. */
export function brandLists(calibration = {}) {
  return {
    affinity:
      calibration?.brand_affinity_companies ??
      calibration?.cems_adjacent_companies ??
      [],
    dream: calibration?.dream_companies ?? [],
    lowerDream: calibration?.lower_tier_dream_companies ?? [],
    extra: calibration?.extra_brand_bonuses ?? [],
  }
}

/** Every company that currently carries SOME brand bonus, flattened with its
 *  source list — so we can check each one against the evidence. */
function configuredBonusCompanies(calibration = {}) {
  const { affinity, dream, lowerDream, extra } = brandLists(calibration)
  const out = []
  for (const c of dream) out.push({ company: c, source: 'dream_companies', kind: 'dream' })
  for (const c of lowerDream) out.push({ company: c, source: 'lower_tier_dream_companies', kind: 'lower_dream' })
  for (const c of affinity) out.push({ company: c, source: 'brand_affinity_companies', kind: 'affinity' })
  for (const e of extra) {
    if (e?.company) out.push({ company: e.company, source: 'extra_brand_bonuses', kind: 'extra', bonus: e.bonus })
  }
  return out
}

/* ───── 1. Brand-bonus drift ──────────────────────────────────────────────────
 *
 * Two failure modes for a configured brand bonus, both detectable from the
 * scores its companies actually earned:
 *
 *   (a) INERT — the company already scores so strongly that the bonus is
 *       cosmetic. It never changes a decision. Not harmful, but it's noise the
 *       user can clean up, and an inert *dream* floor (AF→8) hides whether the
 *       role is genuinely strong.
 *   (b) MISDIRECTED — the company's roles score so weakly that even the bonus
 *       can't lift them to the apply bar. The user keeps spending evaluation
 *       effort on a "favorite" the landscape isn't rewarding. Worth a re-think.
 *
 * We need at least `minRoles` evaluated roles for a company before judging its
 * bonus — one data point is noise.
 */
export function brandBonusDrift(rows, calibration = {}, { minRoles = 2 } = {}) {
  const configured = configuredBonusCompanies(calibration)
  if (configured.length === 0) return []

  // Group evaluated overalls by company.
  const byCompany = new Map()
  for (const r of rows) {
    if (!r.company || !Number.isFinite(r.overall)) continue
    const key = r.company.trim().toLowerCase()
    if (!byCompany.has(key)) byCompany.set(key, { name: r.company.trim(), overalls: [] })
    byCompany.get(key).overalls.push(r.overall)
  }

  const seen = new Set()
  const out = []
  for (const cfg of configured) {
    const key = cfg.company.trim().toLowerCase()
    if (seen.has(key + '|' + cfg.kind)) continue
    seen.add(key + '|' + cfg.kind)
    const grp = byCompany.get(key)
    if (!grp || grp.overalls.length < minRoles) continue // not enough evidence
    const avg = round1(mean(grp.overalls))
    const band = overallBand(avg)

    let verdict = null
    if (band === 'strong') {
      // ≥7.5 unaided — a +bonus / floor is cosmetic.
      verdict = 'inert'
    } else if (band === 'weak') {
      // <6.0 — even the bonus won't reach the apply bar.
      verdict = 'misdirected'
    }
    if (!verdict) continue
    out.push({
      company: grp.name,
      source: cfg.source,
      kind: cfg.kind,
      roles: grp.overalls.length,
      avgOverall: avg,
      band,
      verdict,
      // ADDED — the n is `roles`; this is its tier against the advisory gate.
      confidence: confidenceTier(grp.overalls.length, GATES.calibrationMinCompanyRoles),
    })
  }
  return out.sort((a, b) => a.avgOverall - b.avgOverall)
}

/* ───── 2. Brand-bonus candidates (companies earning a bonus they don't have) ─
 *
 * The mirror of drift: companies the user is NOT giving any brand bonus, yet
 * whose roles consistently score strong across several evaluations. These are
 * candidates to ADD to brand_affinity_companies / lower_tier_dream_companies —
 * the calibration is *under*-crediting a company the landscape keeps rewarding.
 */
export function brandBonusCandidates(rows, calibration = {}, { minRoles = 3, minAvg = 7.5 } = {}) {
  const configured = new Set(configuredBonusCompanies(calibration).map(c => c.company.trim().toLowerCase()))
  const byCompany = new Map()
  for (const r of rows) {
    if (!r.company || !Number.isFinite(r.overall)) continue
    const key = r.company.trim().toLowerCase()
    if (configured.has(key)) continue // already credited
    if (!byCompany.has(key)) byCompany.set(key, { name: r.company.trim(), overalls: [] })
    byCompany.get(key).overalls.push(r.overall)
  }
  const out = []
  for (const grp of byCompany.values()) {
    if (grp.overalls.length < minRoles) continue
    const avg = round1(mean(grp.overalls))
    if (avg < minAvg) continue
    out.push({
      company: grp.name,
      roles: grp.overalls.length,
      avgOverall: avg,
      confidence: confidenceTier(grp.overalls.length, GATES.calibrationMinCompanyRoles),
    })
  }
  return out.sort((a, b) => b.avgOverall - a.avgOverall || b.roles - a.roles)
}

/* ───── 3. Dimension signal health (extreme clustering) ───────────────────────
 *
 * A rubric dimension that scores the SAME value on (almost) every evaluation
 * carries no discriminating signal — it can't separate a good role from a bad
 * one, so whatever weight the rubric gives it is effectively wasted, and the
 * anchor is probably mis-set (too easy → everything 9-10; too harsh →
 * everything 1-3). We flag a dimension when its spread (stdev) is tiny AND it's
 * pinned near a ceiling or floor.
 */
export function dimensionSignal(rows, { minRows = 5, lowStdev = 0.8 } = {}) {
  return DIMENSIONS.map(({ key, label }) => {
    const vals = finite(rows.map(r => r[key]))
    // `count` is the n of this dimension; `confidence` tiers it against the
    // per-dim advisory gate (20 — a share claim from fewer observations has a
    // confidence interval wide enough to contain "not pinned at all").
    const confidence = confidenceTier(vals.length, GATES.calibrationMinDimRows)
    if (vals.length < minRows) return { key, label, count: vals.length, status: 'sparse', confidence }
    const m = round2(mean(vals))
    const sd = round2(stdev(vals))
    // Share at each extreme.
    const ceilShare = Math.round((vals.filter(v => v >= 9).length / vals.length) * 100)
    const floorShare = Math.round((vals.filter(v => v <= 2).length / vals.length) * 100)
    let status = 'healthy'
    let pinned = null
    if (sd <= lowStdev && ceilShare >= 70) { status = 'pinned-ceiling'; pinned = 'ceiling' }
    else if (sd <= lowStdev && floorShare >= 70) { status = 'pinned-floor'; pinned = 'floor' }
    else if (sd <= lowStdev) { status = 'low-variance' }
    return { key, label, count: vals.length, mean: m, stdev: sd, ceilShare, floorShare, status, pinned, confidence }
  })
}

/* ───── 4. Comp-target reality check ──────────────────────────────────────────
 *
 * salary_adj_city is the per-role savings-power score (1-10, from
 * score-bands.savingsToBaseScore). If it's chronically low across the landscape,
 * the user's comp expectations sit above what the roles they evaluate actually
 * pay (for their target cities) — a calibration signal to either widen the comp
 * band, shift cities, or accept that the target market pays less. If it's
 * chronically maxed, the floor is set so low it never bites.
 */
export function compReality(rows, { minRows = 5 } = {}) {
  const vals = finite(rows.map(r => r.salary_adj_city))
  const confidence = confidenceTier(vals.length, GATES.calibrationMinCompRows)
  if (vals.length < minRows) return { count: vals.length, status: 'sparse', confidence }
  const m = round1(mean(vals))
  const med = round1(median(vals))
  const lowShare = Math.round((vals.filter(v => v <= 4).length / vals.length) * 100)
  const highShare = Math.round((vals.filter(v => v >= 9).length / vals.length) * 100)
  let status = 'aligned'
  if (m <= 4.5 || lowShare >= 50) status = 'targets-above-market'
  else if (m >= 9 || highShare >= 80) status = 'targets-below-market'
  return { count: vals.length, mean: m, median: med, lowShare, highShare, status, confidence }
}

/* ───── 5. Score → outcome calibration (needs applications.md outcomes) ───────
 *
 * The ultimate calibration test: do high scores actually convert? We join the
 * score landscape (per archetype) to the outcome funnel. Two mis-rankings:
 *
 *   (a) HIGH-SCORE, NO-CONVERT — an archetype the rubric loves (high avg) but
 *       which only ever ends Rejected/Discarded once applied. The rubric is
 *       over-crediting something the market disagrees with.
 *   (b) LOW-SCORE, CONVERTS — an archetype the rubric under-rates yet which
 *       produces interviews/offers. The rubric is missing a real strength.
 *
 * `outcomes` is an array of { archetype?, company, role, status } where status
 * is already normalized to the canonical lowercase set (applied/responded/
 * interview/offer/rejected/discarded/...). Because applications.md rows don't
 * carry an archetype, we join on company+role back to the score rows.
 */
const POSITIVE = new Set(['responded', 'interview', 'offer'])
const NEGATIVE = new Set(['rejected', 'discarded'])
const APPLIED_ISH = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded'])

function joinOutcomeArchetype(outcome, rows) {
  if (outcome.archetype) return normalizeArchetype(outcome.archetype)
  const co = (outcome.company || '').trim().toLowerCase()
  const ro = (outcome.role || '').trim().toLowerCase()
  for (const r of rows) {
    if ((r.company || '').trim().toLowerCase() === co &&
        (r.role || '').trim().toLowerCase() === ro) {
      return normalizeArchetype(r.archetype)
    }
  }
  return null
}

export function scoreOutcomeCalibration(rows, outcomes = [], { minApplied = 3 } = {}) {
  if (!outcomes || outcomes.length === 0) return { available: false, archetypes: [] }

  // Per-archetype average Overall from the score landscape.
  const scoreByArch = new Map()
  for (const r of rows) {
    if (!Number.isFinite(r.overall)) continue
    const a = r.archetype || 'Unknown'
    if (!scoreByArch.has(a)) scoreByArch.set(a, [])
    scoreByArch.get(a).push(r.overall)
  }

  // Per-archetype outcome funnel.
  const funnel = new Map()
  let anyApplied = false
  for (const o of outcomes) {
    const status = String(o.status || '').toLowerCase()
    if (!APPLIED_ISH.has(status)) continue // only count things that reached the market
    anyApplied = true
    const a = joinOutcomeArchetype(o, rows) || 'Unknown'
    if (!funnel.has(a)) funnel.set(a, { applied: 0, positive: 0, negative: 0 })
    const f = funnel.get(a)
    f.applied++
    if (POSITIVE.has(status)) f.positive++
    else if (NEGATIVE.has(status)) f.negative++
  }
  if (!anyApplied) return { available: false, archetypes: [] }

  const archetypes = []
  for (const [arch, f] of funnel.entries()) {
    if (f.applied < minApplied) continue
    const scores = scoreByArch.get(arch) || []
    const avgScore = scores.length ? round1(mean(scores)) : null
    const convertRate = Math.round((f.positive / f.applied) * 100)
    let flag = null
    if (avgScore != null) {
      if (avgScore >= 7.5 && f.positive === 0) flag = 'high-score-no-convert'
      else if (avgScore < 6.5 && convertRate >= 50) flag = 'low-score-converts'
    }
    archetypes.push({
      archetype: arch,
      applied: f.applied,
      positive: f.positive,
      negative: f.negative,
      convertRate,
      avgScore,
      flag,
      // ADDED — the n is `applied`; gate 8, because "0 of n converted" is only
      // remarkable once 0 is unlikely under a healthy conversion rate.
      confidence: confidenceTier(f.applied, GATES.calibrationMinApplied),
    })
  }
  archetypes.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))
  return { available: true, archetypes }
}

/* ───── Suggestions — turn the diagnostics into concrete user/* edits ─────────
 *
 * Each suggestion is { target, action, reasoning, severity, edit } where:
 *   - target   = which user file the edit lands in (user/profile.yml etc.)
 *   - action   = one-line imperative the UI shows
 *   - reasoning= why the evidence supports it
 *   - severity = 'high' | 'medium' | 'low' (ordering / emphasis)
 *   - edit     = a copy-pasteable hint (NOT applied automatically)
 *
 * CRITICAL: this module NEVER writes user files. It only describes the edit the
 * user can choose to make. That keeps the system layer free of user data and
 * respects "personalization goes in user/*, the user applies it."
 *
 * STATISTICAL CONTRACT (docs § 3.4): every advisory ALSO carries
 *   - sampleSize = the n the claim rests on
 *   - gate       = the minimum n its claim type requires
 *   - confidence = the § 3.1 tier over (sampleSize, gate)
 * and an advisory whose confidence is 'insufficient' is routed out of the
 * recommendation list entirely by partitionSuggestions() below.
 */
export function buildSuggestions(diag) {
  return partitionSuggestions(diag).suggestions
}

/**
 * Split the advisories into the ones the evidence supports and the ones it
 * doesn't. The suppressed entries keep their full text so a renderer can show
 * "what the advisor would say once the evidence arrives" — clearly labelled as
 * insufficient data, never as a recommendation.
 *
 * @returns {{ suggestions: Array, insufficientData: Array }}
 */
export function partitionSuggestions(diag) {
  const s = []

  for (const d of diag.brandBonusDrift || []) {
    if (d.verdict === 'misdirected') {
      s.push({
        sampleSize: d.roles,
        gate: GATES.calibrationMinCompanyRoles,
        target: 'user/profile.yml',
        action: `Reconsider the brand bonus on "${d.company}" — its roles average ${d.avgOverall}/10 (weak) across ${d.roles} evals`,
        reasoning: `"${d.company}" is in ${d.source}, but even with the bonus its roles don't clear the apply bar. The bonus is propping up a company the landscape isn't rewarding for you.`,
        severity: 'medium',
        edit: `Remove "${d.company}" from ${d.source}, or move it to a lower bonus tier.`,
      })
    } else if (d.verdict === 'inert' && d.kind === 'dream') {
      s.push({
        sampleSize: d.roles,
        gate: GATES.calibrationMinCompanyRoles,
        target: 'user/profile.yml',
        action: `"${d.company}" already scores ${d.avgOverall}/10 unaided — its dream-company AF floor never bites`,
        reasoning: `The dream floor (AF→8.0) only matters for borderline roles. "${d.company}" clears it on its own across ${d.roles} evals, so the override is cosmetic and hides whether a specific role is genuinely strong.`,
        severity: 'low',
        edit: `Optional: drop "${d.company}" from dream_companies (it scores strong without the floor), or keep it as an intentional priority signal.`,
      })
    }
  }

  for (const c of (diag.brandBonusCandidates || []).slice(0, 5)) {
    s.push({
      sampleSize: c.roles,
      gate: GATES.calibrationMinCompanyRoles,
      target: 'user/profile.yml',
      action: `Consider adding "${c.company}" to a brand-bonus list — ${c.roles} evals averaging ${c.avgOverall}/10`,
      reasoning: `"${c.company}" consistently produces strong roles for you but carries no brand bonus. Crediting it would correctly prioritize it in borderline scoring.`,
      severity: 'low',
      edit: `Add "${c.company}" to brand_affinity_companies (+0.6) or lower_tier_dream_companies (+1.0) in user/profile.yml.`,
    })
  }

  for (const d of diag.dimensionSignal || []) {
    if (d.status === 'pinned-ceiling') {
      s.push({
        sampleSize: d.count,
        gate: GATES.calibrationMinDimRows,
        target: 'user/_profile.md',
        action: `"${d.label}" is pinned at the ceiling (mean ${d.mean}, ${d.ceilShare}% ≥9) — it isn't discriminating between roles`,
        reasoning: `When a dimension scores ~max on almost every evaluation it can't separate good roles from bad, so its rubric weight is wasted. Either the anchor is too generous or this dimension genuinely doesn't vary for your search.`,
        severity: 'medium',
        edit: `In user/_profile.md, tighten the "${d.label}" anchor (what a 5 vs a 9 means), or down-weight it if it's not a real differentiator.`,
      })
    } else if (d.status === 'pinned-floor') {
      s.push({
        sampleSize: d.count,
        gate: GATES.calibrationMinDimRows,
        target: 'user/_profile.md',
        action: `"${d.label}" is pinned at the floor (mean ${d.mean}, ${d.floorShare}% ≤2) — it's a blanket drag, not a signal`,
        reasoning: `A dimension stuck near the floor on nearly every role is either mis-anchored (too harsh) or pointing at a systemic targeting gap rather than a per-role distinction.`,
        severity: 'medium',
        edit: `In user/_profile.md, re-anchor "${d.label}", or treat the low scores as a targeting problem (the roles you source genuinely lack it).`,
      })
    }
  }

  const comp = diag.compReality
  if (comp?.status === 'targets-above-market') {
    s.push({
      sampleSize: comp.count,
      gate: GATES.calibrationMinCompRows,
      target: 'user/profile.yml',
      action: `Comp scores chronically low (mean ${comp.mean}/10, ${comp.lowShare}% ≤4) — your comp targets sit above this landscape`,
      reasoning: `salary_adj_city is the savings-power score for the cities you target. A persistently low average means the roles you evaluate rarely meet your comp expectations — the targets, the city mix, or the seniority band may be misaligned with the market you're searching.`,
      severity: 'high',
      edit: `In user/profile.yml, revisit the salary range / preferred_cities, or accept a lower comp band for this segment.`,
    })
  } else if (comp?.status === 'targets-below-market') {
    s.push({
      sampleSize: comp.count,
      gate: GATES.calibrationMinCompRows,
      target: 'user/profile.yml',
      action: `Comp scores maxed out (mean ${comp.mean}/10) — your comp floor is set so low it never bites`,
      reasoning: `Nearly every role clears your comp expectation, so comp isn't differentiating roles. You may be under-asking for the market you're in.`,
      severity: 'low',
      edit: `In user/profile.yml, consider raising the salary range to reflect the market — comp is currently a non-factor in your scores.`,
    })
  }

  for (const a of (diag.scoreOutcome?.archetypes || [])) {
    if (a.flag === 'high-score-no-convert') {
      s.push({
        sampleSize: a.applied,
        gate: GATES.calibrationMinApplied,
        target: 'user/_profile.md',
        action: `"${a.archetype}" scores high (avg ${a.avgScore}) but 0/${a.applied} applications converted`,
        reasoning: `The rubric loves this archetype, yet the market keeps rejecting your applications to it. The scoring is over-crediting something — a gap the rubric isn't capturing (seniority, location reality, a missing must-have).`,
        severity: 'high',
        edit: `In user/_profile.md, add a penalty/gap check for "${a.archetype}", or re-examine which dimension is inflating it.`,
      })
    } else if (a.flag === 'low-score-converts') {
      s.push({
        sampleSize: a.applied,
        gate: GATES.calibrationMinApplied,
        target: 'user/_profile.md',
        action: `"${a.archetype}" scores low (avg ${a.avgScore}) yet converts ${a.convertRate}% (${a.positive}/${a.applied})`,
        reasoning: `The market responds well to this archetype but the rubric under-rates it. A real strength isn't being credited — worth finding which dimension is unfairly dragging it.`,
        severity: 'high',
        edit: `In user/_profile.md, raise the weight (or anchor) on the dimension that's under-scoring "${a.archetype}".`,
      })
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  const bySeverity = (a, b) => order[a.severity] - order[b.severity]

  // Attach the tier, then split. Nothing is softened: an advisory either has
  // the evidence to be a recommendation or it is insufficient data.
  const tiered = s.map(x => ({
    ...x,
    ...describeSample(x.sampleSize, x.gate),
    // describeSample returns { n, gate, confidence, sufficient }; keep the
    // advisory's own `sampleSize` name as the public one and drop the alias.
    n: undefined,
  })).map(({ n, ...rest }) => rest)

  return {
    suggestions: tiered.filter(x => x.sufficient).sort(bySeverity),
    insufficientData: tiered
      .filter(x => !x.sufficient)
      .map(x => ({
        ...x,
        reason: `Needs ${x.gate} observations for this claim; have ${x.sampleSize}. Shown for transparency — not a recommendation.`,
      }))
      .sort(bySeverity),
  }
}

/* ───── Top-level analysis object (consumed by the CLI/mode) ──────────────── */
export function analyzeCalibration(rows, { calibration = {}, outcomes = [], opts = {} } = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv. Evaluate some roles first — calibration feedback needs a score history to mine.' }
  }
  const scored = rows.filter(r => Number.isFinite(r.overall))
  if (scored.length === 0) {
    return { error: 'No rows with a valid Overall score in score-history.tsv.' }
  }

  const diag = {
    brandBonusDrift: brandBonusDrift(scored, calibration, opts),
    brandBonusCandidates: brandBonusCandidates(scored, calibration, opts),
    dimensionSignal: dimensionSignal(scored, opts),
    compReality: compReality(scored, opts),
    scoreOutcome: scoreOutcomeCalibration(scored, outcomes, opts),
  }

  const { suggestions, insufficientData } = partitionSuggestions(diag)

  const dates = scored.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      calibrationConfigured:
        configuredBonusCompanies(calibration).length > 0 ||
        Boolean(calibration?.has_structured_onboarding) ||
        Boolean(calibration?.has_sink_or_swim_signal),
      outcomesAvailable: diag.scoreOutcome.available,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
      // The gates this run was bound by, so a renderer can state them without
      // re-deriving (docs/scoring-statistical-design.md § 3.4).
      contract: {
        doc: 'docs/scoring-statistical-design.md',
        gates: {
          companyRoles: GATES.calibrationMinCompanyRoles,
          dimRows: GATES.calibrationMinDimRows,
          compRows: GATES.calibrationMinCompRows,
          applied: GATES.calibrationMinApplied,
        },
      },
    },
    diagnostics: diag,
    suggestions,
    // ADDED — advisories the evidence does not yet support. Never rendered as
    // recommendations; shown so the user can see what unlocks with more data.
    insufficientData,
  }
}
