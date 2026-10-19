// calibration-advisor.mjs — pure calibration-feedback math (scoring v2).
//
// The scoring engine reads calibration from user/profile.yml + user/_profile.md
// (brand-bonus lists, dream companies, Want / Ease weights, comp targets) and
// applies it deterministically in scripts/lib/calibration.mjs and
// scripts/lib/score-bands.mjs. But the user has no feedback loop telling them
// whether that calibration still matches reality. They flagged some company as
// a dream company (Brand → 10, Want floored at 8.0) once, months ago — is that
// floor still doing anything? Is a brand-affinity bonus firing on companies
// whose Want sits in the top verdict row without it (the bonus is inert), or on
// companies whose Want stays in the bottom row even with it, so every verdict
// is Skip (the bonus is misdirected)? Is a rubric dimension pinned at the
// ceiling on every eval (it carries no discriminating signal, so its weight is
// wasted)? Are the user's comp targets above what the landscape pays? Do the
// archetypes the verdict grid says to apply to actually convert?
//
// targeting-core.mjs already answers "where is the landscape strong" from the
// same score-history.tsv. This module asks a different, complementary question:
// "does your stated calibration match the evidence?" — and turns the gaps into
// concrete, *suggested* edits to user/* (never applied automatically; the caller
// shows them and the user decides).
//
// Scoring model: v2 (docs/scoring-v2.md). Every claim is stated on Want and/or
// Ease (never an Overall); band boundaries are the verdict grid's own
// (WANT_MID / WANT_HIGH, assignVerdict), imported from score-bands.mjs. Blocked
// rows (eligibility red) carry no scores and never enter any score claim here.
//
// Everything here is PURE: no I/O, no mutation of inputs, no globals. It takes
// already-parsed rows (via targeting-core's parseScoreHistory), an optional
// outcomes array (parsed from applications.md by the CLI), the calibration
// object (the same shape calibration.mjs consumes) and the optional
// `scoring.want_weights` / `ease_weights` from user/profile.yml. The thin
// file/CLI wrapper lives in scripts/calibration-advisor.mjs.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.4.
//
// The advisor produces two kinds of output and they are held to different
// standards. A DIAGNOSTIC describes the log ("this company's roles average
// Want 5.8 over 3 evals") and may be shown with its n at any sample size. An
// ADVISORY asks the user to change calibration, which silently alters every
// future score — so it is gated. Every advisory carries `sampleSize`, `gate`,
// and `confidence`; an advisory under its gate is not softened or hedged, it
// is moved into the `insufficientData` list and never rendered as a
// recommendation. Gate values live in scoring-stats.mjs, never here.

import {
  normalizeArchetype, DIMENSIONS, isScored, isBlocked, scoredRows, isActionable, ACTIONABLE_VERDICTS,
} from './targeting-core.mjs'
import {
  rollupWant, rollupEase, assignVerdict, computePriority,
  WANT_HIGH, WANT_MID, DREAM_WANT_FLOOR, WANT_DIMS, VERDICT_LABELS,
} from './score-bands.mjs'
import { applyBrandCalibration } from './calibration.mjs'
import { parseScoreCell } from './tracker-core.mjs'
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
const companyKey = (s) => String(s || '').trim().toLowerCase()
const fmtW = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a')

/**
 * Which verdict-grid ROW a Want value falls in (docs/scoring-v2.md §4): 'high'
 * (≥ WANT_HIGH: go / stretch / growth), 'mid' (WANT_MID–WANT_HIGH: solid / thin
 * / skip), 'low' (< WANT_MID: skip whatever the Ease). The boundaries are the
 * engine's constants, not new cut-offs.
 */
export function wantRow(want) {
  if (!Number.isFinite(want)) return null
  return want >= WANT_HIGH ? 'high' : want >= WANT_MID ? 'mid' : 'low'
}

/**
 * The engine's resolved Want / Ease weights for a `scoring` block
 * ({ want, ease } or { want_weights, ease_weights }). Read off the rollups
 * themselves so the default-merge rules are never re-implemented here.
 */
export function resolvedWeights(weights = {}) {
  const neutral = { growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 5,
    best_cities: 5, salary_adj_city: 5, work_life_balance: 5,
    skills_match: 5, experience_bar: 5, competition: 5 }
  return {
    want: rollupWant(neutral, { weights: weights?.want ?? weights?.want_weights }).weights,
    ease: rollupEase(neutral, { weights: weights?.ease ?? weights?.ease_weights }).weights,
  }
}

const wantWeightsOf = (weights) => weights?.want ?? weights?.want_weights

// Reading: score-history has no is_intern column; `employment_type` is the
// closest stored fact. Stipend-type contracts (internship, working student)
// are treated as interns, matching the engine's "stipends are not salaries".
export function rowIsIntern(row) {
  return /intern|working[- ]?student/i.test(String(row?.employment_type || ''))
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

/**
 * What the calibration does to this company's Brand, asked of calibration.mjs
 * itself: { kind: 'dream' } (override to 10 + Want floor) or
 * { kind: 'additive', bonus } (sum of the +0.6 / +1.0 / extra bonuses), or null.
 */
function brandEffect(company, calibration) {
  const { adjustments } = applyBrandCalibration(5, company, calibration)
  if (!adjustments.length) return null
  if (adjustments.some(a => a.type === 'override')) return { kind: 'dream' }
  return { kind: 'additive', bonus: adjustments.reduce((a, b) => a + (Number(b.value) || 0), 0) }
}

/**
 * The row's Want with the company's brand calibration taken out, by replaying
 * the engine on the row's stored dims WITHOUT the effect (current weights):
 *   dream:    rollupWant with dream: false — the Want floor removed. Brand stays
 *             as stored (the raw Brand isn't logged, so the 10 override can't be
 *             undone); the floor is what's tested. Exact whether or not the
 *             company was already a dream company when the row was scored.
 *   additive: Brand lowered by the bonus (clamped at 1). If the company was
 *             added to the list after the row was scored this over-subtracts by
 *             at most bonus × w_brand / Σw (≤ 0.25 Want at equal weights).
 * Falls back to the stored Want when a Want dimension is missing.
 */
function unaidedWant(row, effect, weights) {
  const dims = {}
  for (const k of WANT_DIMS) dims[k] = row[k]
  if (!WANT_DIMS.every(k => Number.isFinite(dims[k]))) return row.want
  const opts = { weights: wantWeightsOf(weights), is_intern: rowIsIntern(row) }
  if (effect.kind === 'dream') return rollupWant(dims, { ...opts, dream: false }).score
  return rollupWant({ ...dims, brand_value: Math.max(1, dims.brand_value - effect.bonus) }, opts).score
}

/* ───── 1. Brand-bonus drift (on Want) ────────────────────────────────────────
 *
 * Brand only feeds Want, so a brand bonus is judged on the company's mean Want
 * against the verdict grid's Want rows (WANT_MID 6.5 / WANT_HIGH 8.0). Two
 * failure modes, both detectable from the scores its companies actually earned:
 *
 *   (a) INERT — the company's mean Want, with the bonus taken out by an engine
 *       replay, is already in the top row (≥ 8.0). The bonus never changes a
 *       verdict row. Not harmful, but noise the user can clean up — and an inert
 *       *dream* floor hides whether the role is genuinely strong.
 *   (b) MISDIRECTED — even WITH the bonus the company's mean Want is in the
 *       bottom row (< 6.5), where every verdict is Skip whatever the Ease. The
 *       user keeps spending evaluation effort on a "favorite" the landscape
 *       isn't rewarding. Worth a re-think.
 *
 * Only scored, non-blocked rows count (a blocked row has no Want). We need at
 * least `minRoles` of them for a company before describing its bonus; the
 * advisory gate (GATES.calibrationMinCompanyRoles) is applied later.
 */
export function brandBonusDrift(rows, calibration = {}, { minRoles = 2, weights } = {}) {
  const configured = configuredBonusCompanies(calibration)
  if (configured.length === 0) return []

  const byCompany = new Map()
  for (const r of rows) {
    if (!r.company || !isScored(r)) continue
    const key = companyKey(r.company)
    if (!byCompany.has(key)) byCompany.set(key, { name: r.company.trim(), rows: [] })
    byCompany.get(key).rows.push(r)
  }

  // One entry per company: its lists are combined, because the boundary
  // question is about the company's total brand effect.
  const perCompany = new Map()
  for (const cfg of configured) {
    const key = companyKey(cfg.company)
    if (!perCompany.has(key)) perCompany.set(key, { company: cfg.company, sources: [], kinds: [] })
    const e = perCompany.get(key)
    if (!e.sources.includes(cfg.source)) e.sources.push(cfg.source)
    if (!e.kinds.includes(cfg.kind)) e.kinds.push(cfg.kind)
  }

  const out = []
  for (const [key, cfg] of perCompany) {
    const grp = byCompany.get(key)
    if (!grp || grp.rows.length < minRoles) continue // not enough evidence
    const effect = brandEffect(cfg.company, calibration)
    if (!effect) continue
    const wants = grp.rows.map(r => r.want)
    const avgWant = round2(mean(wants))
    const avgWantUnaided = round2(mean(grp.rows.map(r => unaidedWant(r, effect, weights))))
    const avgEase = round2(mean(grp.rows.map(r => r.ease)))
    const row = wantRow(avgWant)
    const rowUnaided = wantRow(avgWantUnaided)

    let verdict = null
    if (rowUnaided === 'high') verdict = 'inert'
    else if (row === 'low') verdict = 'misdirected'
    if (!verdict) continue
    const kind = effect.kind === 'dream' ? 'dream' : cfg.kinds.find(k => k !== 'dream') ?? cfg.kinds[0]
    out.push({
      company: grp.name,
      source: cfg.sources.join(' / '),
      sources: cfg.sources,
      kind,
      roles: grp.rows.length,
      avgWant,
      avgWantUnaided,
      avgEase,
      wantRow: row,
      wantRowUnaided: rowUnaided,
      verdict,
      // The n is `roles`; this is its tier against the advisory gate.
      confidence: confidenceTier(grp.rows.length, GATES.calibrationMinCompanyRoles),
    })
  }
  return out.sort((a, b) => a.avgWant - b.avgWant)
}

/* ───── 2. Brand-bonus candidates (companies earning a bonus they don't have) ─
 *
 * The mirror of drift: companies the user is NOT giving any brand bonus, yet
 * whose scored roles' mean Want sits in the top verdict row (≥ WANT_HIGH) across
 * several evaluations. These are candidates to ADD to brand_affinity_companies /
 * lower_tier_dream_companies — the calibration is *under*-crediting a company
 * the landscape keeps rewarding.
 */
export function brandBonusCandidates(rows, calibration = {}, { minRoles = 3, minWant = WANT_HIGH } = {}) {
  const configured = new Set(configuredBonusCompanies(calibration).map(c => companyKey(c.company)))
  const byCompany = new Map()
  for (const r of rows) {
    if (!r.company || !isScored(r)) continue
    const key = companyKey(r.company)
    if (configured.has(key)) continue // already credited
    if (!byCompany.has(key)) byCompany.set(key, { name: r.company.trim(), wants: [], eases: [] })
    byCompany.get(key).wants.push(r.want)
    byCompany.get(key).eases.push(r.ease)
  }
  const out = []
  for (const grp of byCompany.values()) {
    if (grp.wants.length < minRoles) continue
    const avgWant = round2(mean(grp.wants))
    if (avgWant < minWant) continue
    out.push({
      company: grp.name,
      roles: grp.wants.length,
      avgWant,
      avgEase: round2(mean(grp.eases)),
      wantRow: wantRow(avgWant),
      confidence: confidenceTier(grp.wants.length, GATES.calibrationMinCompanyRoles),
    })
  }
  return out.sort((a, b) => b.avgWant - a.avgWant || b.roles - a.roles)
}

/* ───── 3. Dimension signal health (extreme clustering) ───────────────────────
 *
 * A rubric dimension that scores the SAME value on (almost) every evaluation
 * carries no discriminating signal — it can't separate a good role from a bad
 * one, so whatever weight it carries in its rollup is effectively wasted, and
 * the anchor is probably mis-set (too easy → everything 9-10; too harsh →
 * everything 1-3). We flag a dimension when its spread (stdev) is tiny AND it's
 * pinned near a ceiling or floor. Covers the ten v2 dimensions; blocked rows
 * have no dimensions and are skipped. Each entry carries the dimension's
 * current rollup weight (motivators: scoring.want_weights; Ease stages:
 * scoring.ease_weights; hygiene factors are step terms with no weight → null).
 */
export function dimensionSignal(rows, { minRows = 5, lowStdev = 0.8, weights } = {}) {
  const scored = rows.filter(r => !isBlocked(r))
  const w = resolvedWeights(weights)
  return DIMENSIONS.map(({ key, label, group, rollup }) => {
    const vals = finite(scored.map(r => r[key]))
    const weight = group === 'motivator' ? w.want[key] : group === 'ease' ? w.ease[key] : null
    // `count` is the n of this dimension; `confidence` tiers it against the
    // per-dim advisory gate (20 — a share claim from fewer observations has a
    // confidence interval wide enough to contain "not pinned at all").
    const confidence = confidenceTier(vals.length, GATES.calibrationMinDimRows)
    if (vals.length < minRows) return { key, label, group, rollup, weight, count: vals.length, status: 'sparse', confidence }
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
    return { key, label, group, rollup, weight, count: vals.length, mean: m, stdev: sd, ceilShare, floorShare, status, pinned, confidence }
  })
}

/* ───── 4. Comp-target reality check ──────────────────────────────────────────
 *
 * salary_adj_city is the per-role savings-power score (1-10, from
 * score-bands.savingsToBaseScore), a Want hygiene factor. If it's chronically
 * low across the landscape, the user's comp expectations sit above what the
 * roles they evaluate actually pay (for their target cities) — a calibration
 * signal to either widen the comp band, shift cities, or accept that the target
 * market pays less. If it's chronically maxed, the floor is set so low it never
 * bites.
 *
 * Reading: internship / working-student rows are excluded. The engine gives
 * their salary term 0 (stipends are not salaries), so their salary score never
 * moves Want and says nothing about the candidate's comp targets.
 */
export function compReality(rows, { minRows = 5 } = {}) {
  const pool = rows.filter(r => !isBlocked(r))
  const interns = pool.filter(rowIsIntern)
  const vals = finite(pool.filter(r => !rowIsIntern(r)).map(r => r.salary_adj_city))
  const confidence = confidenceTier(vals.length, GATES.calibrationMinCompRows)
  const internsExcluded = finite(interns.map(r => r.salary_adj_city)).length
  if (vals.length < minRows) return { count: vals.length, internsExcluded, status: 'sparse', confidence }
  const m = round1(mean(vals))
  const med = round1(median(vals))
  const lowShare = Math.round((vals.filter(v => v <= 4).length / vals.length) * 100)
  const highShare = Math.round((vals.filter(v => v >= 9).length / vals.length) * 100)
  let status = 'aligned'
  if (m <= 4.5 || lowShare >= 50) status = 'targets-above-market'
  else if (m >= 9 || highShare >= 80) status = 'targets-below-market'
  return { count: vals.length, internsExcluded, mean: m, median: med, lowShare, highShare, status, confidence }
}

/* ───── 5. Score → outcome calibration (needs applications.md outcomes) ───────
 *
 * The ultimate calibration test: do the verdicts actually convert? Each
 * application's own Score cell (`W8.3 E5.6`, parsed by tracker-core
 * parseScoreCell) places it on the verdict grid; its status says what the
 * market did. Per archetype, the applications' mean Want and Ease replayed
 * through assignVerdict give the archetype's TYPICAL verdict. Two mis-rankings:
 *
 *   (a) HIGH-SCORE, NO-CONVERT — the typical verdict is actionable (go /
 *       stretch / solid: the grid says apply) but none of the applications got a
 *       positive response. The rubric is over-crediting something the market
 *       disagrees with.
 *   (b) LOW-SCORE, CONVERTS — the typical verdict is NOT actionable (thin /
 *       growth / skip) yet ≥ 50% of the applications converted. The rubric is
 *       missing a real strength.
 *
 * `outcomes` is an array of { archetype?, company, role, status, score? } where
 * status is already normalized to the canonical lowercase set (applied/
 * responded/interview/offer/rejected/discarded/...) and score is the raw Score
 * cell. applications.md rows don't carry an archetype, so we join on
 * company+role back to the score rows (latest match).
 *
 * Score source, in order: the Score cell when it is a v2 `W.. E..` cell; the
 * matched score-history row's Want / Ease when the cell is empty or unparseable.
 * LEGACY `X.X/10` cells (v1 Overall) are EXCLUDED: an Overall has no Want / Ease
 * split, so it can't be placed on the verdict grid, and it isn't on Priority's
 * scale either (a v1 weighted mean of CF/AF vs. √(Want·Ease)). They are counted
 * in `excluded.legacy` instead, never folded into a claim.
 */
const POSITIVE = new Set(['responded', 'interview', 'offer'])
const NEGATIVE = new Set(['rejected', 'discarded'])
const APPLIED_ISH = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded'])

function matchHistoryRow(outcome, rows) {
  const co = companyKey(outcome.company)
  const ro = companyKey(outcome.role)
  if (!co) return null
  let best = null
  for (const r of rows) {
    if (companyKey(r.company) !== co || companyKey(r.role) !== ro) continue
    if (!best || String(r.date || '') >= String(best.date || '')) best = r
  }
  return best
}

function outcomeScore(outcome, match) {
  const cell = parseScoreCell(outcome.score)
  if (cell && 'want' in cell) return { want: cell.want, ease: cell.ease, source: 'cell' }
  if (cell && 'legacy' in cell) return { legacy: cell.legacy }
  if (match && isScored(match)) return { want: match.want, ease: match.ease, source: 'history' }
  return null
}

const emptyVerdicts = () => ({ go: 0, stretch: 0, solid: 0, thin: 0, growth: 0, skip: 0 })

export function scoreOutcomeCalibration(rows, outcomes = [], { minApplied = 3 } = {}) {
  const excluded = { legacy: 0, unscored: 0 }
  if (!outcomes || outcomes.length === 0) return { available: false, archetypes: [], excluded }

  const funnel = new Map()
  let anyApplied = false
  for (const o of outcomes) {
    const status = String(o.status || '').toLowerCase()
    if (!APPLIED_ISH.has(status)) continue // only count things that reached the market
    anyApplied = true
    const match = matchHistoryRow(o, rows)
    const a = o.archetype ? normalizeArchetype(o.archetype)
      : match ? normalizeArchetype(match.archetype) : 'Unknown'
    if (!funnel.has(a)) {
      funnel.set(a, { applied: 0, positive: 0, negative: 0, wants: [], eases: [], prios: [],
        verdicts: emptyVerdicts(), legacy: 0, unscored: 0 })
    }
    const f = funnel.get(a)
    const score = outcomeScore(o, match)
    if (!score) { f.unscored++; excluded.unscored++; continue }
    if ('legacy' in score) { f.legacy++; excluded.legacy++; continue }
    f.applied++
    f.wants.push(score.want)
    f.eases.push(score.ease)
    const p = computePriority(score.want, score.ease)
    if (p != null) f.prios.push(p)
    // Blocked listings are never promoted to applications.md, so the grid is
    // read with eligibility green.
    const v = assignVerdict({ want: score.want, ease: score.ease, eligibility: 'green' }).verdict
    if (v in f.verdicts) f.verdicts[v]++
    if (POSITIVE.has(status)) f.positive++
    else if (NEGATIVE.has(status)) f.negative++
  }
  if (!anyApplied) return { available: false, archetypes: [], excluded }

  const archetypes = []
  for (const [arch, f] of funnel.entries()) {
    if (f.applied < minApplied) continue
    const avgWant = round2(mean(f.wants))
    const avgEase = round2(mean(f.eases))
    const typicalVerdict = assignVerdict({ want: avgWant, ease: avgEase, eligibility: 'green' }).verdict
    const actionable = ACTIONABLE_VERDICTS.reduce((s, v) => s + f.verdicts[v], 0)
    const convertRate = Math.round((f.positive / f.applied) * 100)
    let flag = null
    if (isActionable(typicalVerdict) && f.positive === 0) flag = 'high-score-no-convert'
    else if (!isActionable(typicalVerdict) && convertRate >= 50) flag = 'low-score-converts'
    archetypes.push({
      archetype: arch,
      applied: f.applied,
      positive: f.positive,
      negative: f.negative,
      convertRate,
      avgWant,
      avgEase,
      avgPriority: round2(mean(f.prios)),
      typicalVerdict,
      verdicts: f.verdicts,
      actionableShare: Math.round((actionable / f.applied) * 100),
      excluded: { legacy: f.legacy, unscored: f.unscored },
      flag,
      // The n is `applied` (v2-scored applications only); gate 8, because
      // "0 of n converted" is only remarkable once 0 is unlikely under a
      // healthy conversion rate.
      confidence: confidenceTier(f.applied, GATES.calibrationMinApplied),
    })
  }
  archetypes.sort((a, b) => b.avgPriority - a.avgPriority || b.applied - a.applied)
  return { available: true, archetypes, excluded }
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

const vLabel = (v) => VERDICT_LABELS[v] ?? v

function weightHint(d) {
  if (d.group === 'motivator') {
    return `down-weight it via scoring.want_weights.${d.key} in user/profile.yml (currently ${d.weight})`
  }
  if (d.group === 'ease') {
    return `down-weight it via scoring.ease_weights.${d.key} in user/profile.yml (currently ${d.weight})`
  }
  return null // hygiene factors are step terms: no weight to change
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
        action: `Reconsider the brand bonus on "${d.company}" — its roles average Want ${fmtW(d.avgWant)} even with it, below ${WANT_MID.toFixed(1)}, across ${d.roles} evals`,
        reasoning: `"${d.company}" is in ${d.source}, but even with the bonus its mean Want sits in the bottom verdict row (< ${WANT_MID.toFixed(1)}), where every verdict is Skip whatever the Ease. The bonus is propping up a company the landscape isn't rewarding for you.`,
        severity: 'medium',
        edit: `Remove "${d.company}" from ${d.source}, or move it to a lower bonus tier.`,
      })
    } else if (d.verdict === 'inert' && d.kind === 'dream') {
      s.push({
        sampleSize: d.roles,
        gate: GATES.calibrationMinCompanyRoles,
        target: 'user/profile.yml',
        action: `"${d.company}" averages Want ${fmtW(d.avgWantUnaided)} without the dream floor — its Want floor (${DREAM_WANT_FLOOR.toFixed(1)}) never bites`,
        reasoning: `The dream floor (Want → ${DREAM_WANT_FLOOR.toFixed(1)}) only matters for roles whose Want would fall below the top verdict row. "${d.company}" clears ${WANT_HIGH.toFixed(1)} on its own across ${d.roles} evals, so the floor is cosmetic and hides whether a specific role is genuinely strong.`,
        severity: 'low',
        edit: `Optional: drop "${d.company}" from dream_companies (its roles reach the top Want row without the floor), or keep it as an intentional priority signal.`,
      })
    }
  }

  for (const c of (diag.brandBonusCandidates || []).slice(0, 5)) {
    s.push({
      sampleSize: c.roles,
      gate: GATES.calibrationMinCompanyRoles,
      target: 'user/profile.yml',
      action: `Consider adding "${c.company}" to a brand-bonus list — ${c.roles} evals averaging Want ${fmtW(c.avgWant)} · Ease ${fmtW(c.avgEase)}`,
      reasoning: `"${c.company}" consistently produces roles in the top Want row (≥ ${WANT_HIGH.toFixed(1)}) for you but carries no brand bonus. Crediting it would correctly prioritize it in borderline scoring.`,
      severity: 'low',
      edit: `Add "${c.company}" to brand_affinity_companies (+0.6 Brand) or lower_tier_dream_companies (+1.0 Brand) in user/profile.yml.`,
    })
  }

  for (const d of diag.dimensionSignal || []) {
    if (d.status !== 'pinned-ceiling' && d.status !== 'pinned-floor') continue
    const hint = weightHint(d)
    const rollup = d.rollup === 'ease' ? 'Ease' : 'Want'
    if (d.status === 'pinned-ceiling') {
      s.push({
        sampleSize: d.count,
        gate: GATES.calibrationMinDimRows,
        target: hint ? 'user/profile.yml' : 'user/_profile.md',
        action: `"${d.label}" is pinned at the ceiling (mean ${d.mean}, ${d.ceilShare}% ≥9) — it isn't discriminating between roles`,
        reasoning: `When a dimension scores ~max on almost every evaluation it can't separate good roles from bad, so its share of ${rollup} is wasted. Either the anchor is too generous or this dimension genuinely doesn't vary for your search.`,
        severity: 'medium',
        edit: hint
          ? `Tighten the "${d.label}" anchor in user/_profile.md (what a 5 vs a 9 means), or ${hint} if it's not a real differentiator.`
          : `In user/_profile.md, tighten the "${d.label}" anchor (what a 5 vs a 9 means); it is a hygiene factor, so it only nudges Want once it's good.`,
      })
    } else {
      s.push({
        sampleSize: d.count,
        gate: GATES.calibrationMinDimRows,
        target: 'user/_profile.md',
        action: `"${d.label}" is pinned at the floor (mean ${d.mean}, ${d.floorShare}% ≤2) — it's a blanket drag on ${rollup}, not a signal`,
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
      action: `Salary scores chronically low (mean ${comp.mean}, ${comp.lowShare}% ≤4) — your comp targets sit above this landscape`,
      reasoning: `salary_adj_city is the savings-power score for the cities you target, and a Want hygiene factor: a score under 5 pulls Want down, under 3 vetoes it. A persistently low average means the roles you evaluate rarely meet your comp expectations — the targets, the city mix, or the seniority band may be misaligned with the market you're searching.`,
      severity: 'high',
      edit: `In user/profile.yml, revisit the salary range / preferred_cities, or accept a lower comp band for this segment.`,
    })
  } else if (comp?.status === 'targets-below-market') {
    s.push({
      sampleSize: comp.count,
      gate: GATES.calibrationMinCompRows,
      target: 'user/profile.yml',
      action: `Salary scores maxed out (mean ${comp.mean}) — your comp floor is set so low it never bites`,
      reasoning: `Nearly every role clears your comp expectation, so the salary hygiene term is a flat +0.25 on Want and isn't differentiating roles. You may be under-asking for the market you're in.`,
      severity: 'low',
      edit: `In user/profile.yml, consider raising the salary range to reflect the market — comp is currently a non-factor in your scores.`,
    })
  }

  for (const a of (diag.scoreOutcome?.archetypes || [])) {
    const scoreText = `Want ${fmtW(a.avgWant)} · Ease ${fmtW(a.avgEase)}`
    if (a.flag === 'high-score-no-convert') {
      s.push({
        sampleSize: a.applied,
        gate: GATES.calibrationMinApplied,
        target: 'user/_profile.md',
        action: `"${a.archetype}" lands in ${vLabel(a.typicalVerdict)} on average (${scoreText}) but 0/${a.applied} applications converted`,
        reasoning: `The verdict grid says to apply to this archetype, yet the market keeps rejecting your applications to it. The scoring is over-crediting something — a gap the rubric isn't capturing (seniority, location reality, a missing must-have) that probably belongs in Ease.`,
        severity: 'high',
        edit: `In user/_profile.md, add a gap check for "${a.archetype}" (most likely on Experience bar or Competition), or re-examine which dimension is inflating it.`,
      })
    } else if (a.flag === 'low-score-converts') {
      s.push({
        sampleSize: a.applied,
        gate: GATES.calibrationMinApplied,
        target: 'user/_profile.md',
        action: `"${a.archetype}" lands in ${vLabel(a.typicalVerdict)} on average (${scoreText}) yet converts ${a.convertRate}% (${a.positive}/${a.applied})`,
        reasoning: `The market responds well to this archetype but the grid doesn't call it actionable. A real strength isn't being credited — worth finding which dimension is unfairly dragging its Want or Ease.`,
        severity: 'high',
        edit: `In user/_profile.md, re-anchor the dimension that's under-scoring "${a.archetype}" (or raise its weight under scoring.want_weights / ease_weights in user/profile.yml).`,
      })
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  const bySeverity = (a, b) => order[a.severity] - order[b.severity]

  // Attach the tier, then split. Nothing is softened: an advisory either has
  // the evidence to be a recommendation or it is insufficient data.
  // describeSample returns { n, gate, confidence, sufficient }; keep the
  // advisory's own `sampleSize` name as the public one and drop the alias.
  const tiered = s.map(x => {
    const { n, ...sample } = describeSample(x.sampleSize, x.gate)
    return { ...x, ...sample }
  })

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
export function analyzeCalibration(rows, { calibration = {}, outcomes = [], weights, opts = {} } = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv. Evaluate some roles first — calibration feedback needs a score history to mine.' }
  }
  const scored = scoredRows(rows)
  const blocked = rows.filter(isBlocked).length
  if (scored.length === 0) {
    return {
      error: `No scored (non-blocked) rows with Want and Ease in score-history.tsv${blocked ? ` (${blocked} blocked by eligibility)` : ''}.`,
    }
  }

  const diag = {
    brandBonusDrift: brandBonusDrift(scored, calibration, { ...opts, weights }),
    brandBonusCandidates: brandBonusCandidates(scored, calibration, opts),
    dimensionSignal: dimensionSignal(scored, { ...opts, weights }),
    compReality: compReality(scored, opts),
    // All rows for the archetype join (any evaluation names the archetype);
    // the scores themselves come from each application's Score cell.
    scoreOutcome: scoreOutcomeCalibration(rows, outcomes, opts),
  }

  const { suggestions, insufficientData } = partitionSuggestions(diag)

  const dates = scored.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      blocked,
      calibrationConfigured:
        configuredBonusCompanies(calibration).length > 0 ||
        Boolean(calibration?.has_structured_onboarding) ||
        Boolean(calibration?.has_sink_or_swim_signal),
      weights: resolvedWeights(weights),
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
        wantRows: { mid: WANT_MID, high: WANT_HIGH },
      },
    },
    diagnostics: diag,
    suggestions,
    // Advisories the evidence does not yet support. Never rendered as
    // recommendations; shown so the user can see what unlocks with more data.
    insufficientData,
  }
}
