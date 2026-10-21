#!/usr/bin/env node

/**
 * score-listing.mjs — Deterministic scoring entry point (scoring v2).
 *
 * Spec: docs/scoring-v2.md. The agent does the JUDGMENT (reads the JD,
 * extracts the eligibility facts, scores the nine judgment dimensions and
 * the soft-benefits modifier). This script does the COMPUTATION, in order:
 *
 *   1. Eligibility gate (scripts/lib/eligibility.mjs): JD facts vs. the
 *      candidate's `eligibility:` profile → green / amber / red. Red stops
 *      here: verdict `blocked`, tier T4, no Want / Ease / Priority, and no
 *      tax / cost-of-living lookups (so no `judgment_scores` needed).
 *   2. Salary Adj for City: total comp → tax (cache or override) → net →
 *      minus the city baseline (cache or override; halved for interns) →
 *      monthly savings → 10-tier band → soft-benefits modifier.
 *   3. Calibration: Brand (only explicit perception corrections —
 *      extra_brand_bonuses; Brand is a CV signal, not preference), the
 *      liked-company Want bonus (lower-tier dream companies), Growth
 *      (onboarding ±1), Competition (referral bonus).
 *   4. Want (motivators mean − bottom penalty + hygiene terms, dream floor,
 *      vetoes) and Ease (weighted geometric mean, experience wall, amber
 *      penalty).
 *   5. Verdict grid → verdict, tier, promotion hint; Priority = √(Want·Ease).
 *   6. Explainability bundle (scripts/lib/explain-score.mjs), which replays
 *      the same engine.
 *   7. Prior evaluation (scripts/lib/prior-score.mjs): the listing's latest
 *      row in data/score-history.tsv (same URL, else company + role) and the
 *      judged dimensions that moved by 1 or more since then. A re-score must
 *      justify each such move with something new, or revert it.
 *
 * Caches are read-only here. Cache writes happen only with `--write-cache`
 * (and only for values passed as overrides), so the agent can verify a
 * fetched value before persisting it.
 *
 * Usage:
 *
 *   echo '{ ...inputs... }' | node scripts/score-listing.mjs
 *   echo '{ ...inputs... }' | node scripts/score-listing.mjs --write-cache
 *   echo '{ "eligibility_facts": {...} }' | node scripts/score-listing.mjs --eligibility-only
 *   echo '{ "company": "...", "role": "...", "url": "..." }' | node scripts/score-listing.mjs --prior-only
 *   node scripts/score-listing.mjs --input batch/work/<id>-score.json [--flags]
 *
 * `--input <file>` reads the JSON from a file inside the checkout instead of
 * stdin. Background workers use it: their shell permissions refuse some
 * quoting (a JSON with an apostrophe escaped as '"'"'), and a file written
 * with the Write tool needs no quoting at all.
 *
 * `--prior-only` returns { prior } — the previous evaluation's dimension
 * scores (or null) — so a re-score can start from them before judging.
 *
 * Profile: `eligibility_profile` and `scoring_weights` in the input win (the
 * key's presence wins, even if empty). When absent, the script reads the
 * `eligibility:` and `scoring:` blocks of user/profile.yml. A missing file
 * or block is an empty profile:
 *   - empty `eligibility:` → every check is "not checked" (green): no
 *     availability date, no blocked windows, no language / work-auth /
 *     graduation / duration constraints. The gate lets everything through.
 *   - empty `scoring:`     → DEFAULT_WANT_WEIGHTS / DEFAULT_EASE_WEIGHTS.
 *
 * SCHEMA (input) — fictional values:
 *   {
 *     "company": "Northwind Analytics",
 *     "role_archetype": "Strategy Analyst",
 *     "city": "Lyon",
 *     "country": "FR",                         // also eligibility_facts.country fallback
 *     "comp": {
 *       "base": 42000,                        // annual base in EUR
 *       "bonusPct": 0.10,                     // optional, decimal
 *       "equityAnnualEur": 0,                 // optional, annualized
 *       "thirteenthMonthMonths": 2,           // optional (0/1/2)
 *       "benefitsMonthlyEur": 100,            // optional, monthly cash-equiv
 *       "signOnEur": 3000,                    // optional, one-off
 *       "tenureYears": 3                      // optional, default 3
 *     },
 *     "comp_source": "disclosed" | "estimate",
 *     "tax_override": { "rate": 0.27, "source": "..." },          // skip tax cache
 *     "col_override": { "baseline_eur": 2100, "source": "..." },  // skip COL cache
 *     "is_intern": false,
 *     "soft_benefits_modifier": 0.5,
 *     "calibration": { ...see scripts/lib/calibration.mjs... },
 *     "eligibility_facts": { ...docs/scoring-v2.md §1.1 (+ "other": [...]) ... },
 *     "eligibility_profile": { ...optional, else user/profile.yml → eligibility... },
 *     "scoring_weights": { "want": {...}, "ease": {...} },        // optional, else profile.yml → scoring.*
 *     "referral": "warm-direct" | "warm-intro" | null,
 *     "today": "2026-10-20",                  // optional reference date (default: now)
 *     "judgment_scores": {
 *       "growth_mobility": 8, "optionality_exit": 8, "brand_value": 9, "role_content": 7,
 *       "best_cities": 8, "work_life_balance": 6,
 *       "skills_match": 8, "experience_bar": 6, "competition": 5
 *     }
 *   }
 *
 * SCHEMA (output): docs/scoring-v2.md §6 — { eligibility, salary_adj_for_city,
 * calibrated_dims, dims, want, ease, priority, verdict, verdict_label,
 * verdict_action, tier, tier_reason, promotion_hint, explanation }. Blocked:
 * { eligibility, verdict: 'blocked', tier: 'T4', want/ease/priority: null,
 * note, explanation }. Errors: { error, message, ... } with exit 0 so the
 * agent can read the reason.
 */

import { readFile } from 'fs/promises'
import { readFileSync, realpathSync } from 'fs'
import { dirname, join, sep } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

import {
  savingsToBaseScore, applyBenefitsModifier,
  buildTotalComp, grossToNet,
  rollupWant, rollupEase, assignVerdict, computePriority, promotionHint,
  VERDICT_LABELS, VERDICT_ACTIONS,
} from './lib/score-bands.mjs'

import {
  applyBrandCalibration, applyGrowthCalibration, applyReferralAdjustment, wantPreference,
  isDreamCompany, isRevisitCompany,
} from './lib/calibration.mjs'

import { evaluateEligibility } from './lib/eligibility.mjs'
import { parseScoreHistory } from './lib/targeting-core.mjs'
import { findPrior, compareToPrior } from './lib/prior-score.mjs'
import { explainScore, LEVER_DIMS } from './lib/explain-score.mjs'

import * as taxCache from './lib/tax-cache.mjs'
import * as colCache from './lib/col-cache.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const DEFAULT_PROFILE_PATH = join(ROOT, 'user', 'profile.yml')
export const DEFAULT_HISTORY_PATH = join(ROOT, 'data', 'score-history.tsv')

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

/** `--input <file>`: a JSON file inside the checkout (null when not given). */
function readInputFile(argv) {
  const i = argv.indexOf('--input')
  if (i === -1) return null
  const file = argv[i + 1]
  if (!file) {
    process.stderr.write('score-listing: --input needs a file path\n')
    process.exit(2)
  }
  let real
  try { real = realpathSync(file) } catch {
    process.stderr.write(`score-listing: cannot read ${file}\n`)
    process.exit(1)
  }
  const roots = [realpathSync(process.cwd()), realpathSync(ROOT)]
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) {
    process.stderr.write('score-listing: --input must be a file inside the checkout\n')
    process.exit(2)
  }
  return readFileSync(real, 'utf8')
}

async function main() {
  const raw = readInputFile(process.argv) ?? await readStdin()
  if (!raw.trim()) {
    process.stderr.write('score-listing: empty stdin — pipe a JSON input\n')
    process.exit(1)
  }
  let input
  try { input = JSON.parse(raw) }
  catch (e) {
    process.stderr.write(`score-listing: invalid JSON on stdin — ${e.message}\n`)
    process.exit(1)
  }
  const result = await scoreListing(input, {
    writeCache: process.argv.includes('--write-cache'),
    eligibilityOnly: process.argv.includes('--eligibility-only'),
    priorOnly: process.argv.includes('--prior-only'),
  })
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

/**
 * The listing's previous evaluation. `input.prior` wins when present (an
 * object, or false to skip the lookup — tests); otherwise read the history
 * file. A missing file means no prior.
 */
export async function loadPrior(input, historyPath = DEFAULT_HISTORY_PATH) {
  if (input.prior === false) return null
  if (input.prior && typeof input.prior === 'object') return input.prior
  let text
  try { text = await readFile(historyPath, 'utf8') }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
  return findPrior(parseScoreHistory(text), { company: input.company, role: input.role, url: input.url })
}

/**
 * Read the `eligibility:` and `scoring:` blocks from user/profile.yml.
 * Missing file or block → {}. A YAML syntax error throws (caller reports it).
 */
export async function loadProfileBlocks(path = DEFAULT_PROFILE_PATH) {
  let text
  try { text = await readFile(path, 'utf8') }
  catch (e) {
    if (e.code === 'ENOENT') return { eligibility: {}, scoring: {} }
    throw e
  }
  const doc = yaml.load(text) ?? {}
  return {
    eligibility: doc.eligibility ?? {},
    scoring: doc.scoring ?? {},
  }
}

// `scoring:` in profile.yml uses want_weights / ease_weights; the input's
// `scoring_weights` uses want / ease. Accept either spelling in both places.
function weightsFrom(block) {
  return {
    want: block?.want ?? block?.want_weights,
    ease: block?.ease ?? block?.ease_weights,
  }
}

/**
 * Function form so test-all.mjs can import + assert without shelling out.
 * Side effects: reads user/profile.yml (only when the input lacks the
 * profile keys) and the cache TSVs; writes caches only with writeCache.
 *
 *   opts { writeCache, eligibilityOnly, priorOnly, profilePath, historyPath }
 */
export async function scoreListing(input, opts = {}) {
  const { writeCache = false, eligibilityOnly = false, priorOnly = false, profilePath, historyPath } = opts

  let prior = null
  try { prior = await loadPrior(input, historyPath) }
  catch (e) { return { error: 'history_unreadable', message: `Could not read data/score-history.tsv: ${e.message}` } }
  if (priorOnly) return { prior }

  // 0. Profile blocks: input wins over file.
  const needFile = !('eligibility_profile' in input) || !('scoring_weights' in input)
  let fileBlocks = { eligibility: {}, scoring: {} }
  if (needFile) {
    try { fileBlocks = await loadProfileBlocks(profilePath) }
    catch (e) {
      return { error: 'profile_unreadable', message: `Could not read user/profile.yml: ${e.message}` }
    }
  }
  const eligibilityProfile = 'eligibility_profile' in input ? (input.eligibility_profile ?? {}) : fileBlocks.eligibility
  const weights = weightsFrom('scoring_weights' in input ? input.scoring_weights : fileBlocks.scoring)

  // 1. Eligibility gate — always first.
  const facts = { ...(input.eligibility_facts ?? {}) }
  if (facts.country == null && input.country) facts.country = input.country
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const eligibility = evaluateEligibility(facts, eligibilityProfile, { today })

  if (eligibilityOnly) return { eligibility }

  const calibration = input.calibration ?? {}
  // A red listing is Blocked. It still gets Want / Ease when the profile's
  // `score_through_red` allows every red check (eligibility.redIsScored):
  // the verdict stays `blocked`, Priority stays null, only the scores fill in.
  if (eligibility.status === 'red' && !eligibility.scored) {
    const verdict = assignVerdict({ want: null, ease: null, eligibility })
    const reason = eligibility.blocking_reason
    return {
      eligibility,
      want: null,
      ease: null,
      priority: null,
      verdict: verdict.verdict,
      verdict_label: VERDICT_LABELS.blocked,
      verdict_action: VERDICT_ACTIONS.blocked,
      tier: verdict.tier,
      tier_reason: verdict.reason,
      promotion_hint: '',
      note: isRevisitCompany(input.company, calibration) ? `Revisit next cycle: ${reason}` : reason,
      explanation: explainScore({ dims: null, eligibility, context: {} }),
      prior: prior ? { ...prior, changes: [] } : null,
    }
  }

  const j = input.judgment_scores ?? {}
  const missing = LEVER_DIMS.filter(k => !Number.isFinite(j[k]))
  if (missing.length > 0) {
    return {
      error: 'judgment_scores_incomplete',
      message: `judgment_scores is missing or non-numeric for: ${missing.join(', ')}`,
      missing,
      eligibility,
    }
  }
  if (!input.comp || !Number.isFinite(input.comp.base)) {
    return { error: 'comp_missing', message: 'comp.base (annual EUR) is required to compute Salary Adj for City', eligibility }
  }

  // 2. Salary Adj for City. Total comp build-up → tax → net.
  const { total: totalComp, breakdown } = buildTotalComp(input.comp)

  let taxRate, taxSource
  if (input.tax_override) {
    taxRate   = input.tax_override.rate
    taxSource = input.tax_override.source
  } else {
    const hit = await taxCache.lookup(input.country, totalComp)
    if (hit) {
      taxRate   = hit.effective_rate
      taxSource = `cache: ${hit.source} (${hit.last_updated})`
    } else {
      return { error: 'tax_rate_unresolved',
        message: `No tax rate found for country=${input.country} band=${totalComp}. Provide tax_override or run a tax-calculator WebSearch first.`,
        totalComp, breakdown, eligibility,
      }
    }
  }
  const { annualNet, monthlyNet } = grossToNet(totalComp, taxRate)

  let baseline, colSource
  if (input.col_override) {
    baseline  = input.col_override.baseline_eur
    colSource = input.col_override.source
  } else {
    const hit = await colCache.lookup(input.city)
    if (hit) {
      baseline  = hit.baseline_eur
      colSource = `cache: ${hit.source} (${hit.last_updated})`
    } else {
      return { error: 'col_baseline_unresolved',
        message: `No COL baseline found for city=${input.city}. Provide col_override or run a Numbeo WebSearch first.`,
        totalComp, breakdown, taxRate, eligibility,
      }
    }
  }
  const isIntern = input.is_intern === true
  if (isIntern) baseline = baseline / 2  // shared housing assumed

  const savings    = Number((monthlyNet - baseline).toFixed(2))
  const baseScore  = savingsToBaseScore(savings)
  const finalSalaryAdjScore = applyBenefitsModifier(baseScore, input.soft_benefits_modifier)

  if (writeCache && input.tax_override) {
    await taxCache.append({
      country:        input.country,
      gross:          totalComp,
      effective_rate: taxRate,
      source:         taxSource,
    })
  }
  if (writeCache && input.col_override) {
    await colCache.append({
      city:         input.city,
      baseline_eur: input.col_override.baseline_eur,
      source:       colSource,
    })
  }

  // 3. Calibration, before the rollups so calibrated values flow into them.
  const brandCal  = applyBrandCalibration(j.brand_value, input.company, calibration)
  const growthCal = applyGrowthCalibration(j.growth_mobility, calibration)
  const compCal   = applyReferralAdjustment(j.competition, input.referral)
  const dims = {
    growth_mobility:   growthCal.value,
    optionality_exit:  j.optionality_exit,
    brand_value:       brandCal.value,
    role_content:      j.role_content,
    best_cities:       j.best_cities,
    salary_adj_city:   finalSalaryAdjScore,
    work_life_balance: j.work_life_balance,
    skills_match:      j.skills_match,
    experience_bar:    j.experience_bar,
    competition:       compCal.value,
  }
  const dream = isDreamCompany(input.company, calibration)
  const pref = wantPreference(input.company, calibration)

  // 4. Want and Ease.
  const want = rollupWant(dims, { weights: weights.want, is_intern: isIntern, dream, preference: pref.bonus })
  const ease = rollupEase(dims, { weights: weights.ease, amber_count: eligibility.amber_count })

  // 5. Verdict + Priority.
  const verdict = assignVerdict({ want: want.score, ease: ease.score, eligibility })
  const priority = eligibility.status === 'red' ? null : computePriority(want.score, ease.score)

  // 6. Explainability — replays the same engine, so it can't drift.
  const explanation = explainScore({
    dims,
    eligibility,
    context: { is_intern: isIntern, dream, preference: pref.bonus, weights },
  })

  // Salary text. `summary` is the one plain line for the report's Salary cell
  // ("About €150 a month left after living costs in Lyon"); `math` is the
  // full provenance chain for the report's single `Salary math:` footer line.
  // Both stay markdown-safe (no `**`, no [..] tokens) because the app renders
  // report text as inline markdown.
  const compSource = input.comp_source ?? 'disclosed'
  const estimated  = compSource === 'estimate'
  const componentLines = [
    `base €${input.comp.base.toLocaleString()}`,
    breakdown.bonus           != null ? `bonus €${breakdown.bonus.toFixed(0)}` : null,
    breakdown.equity          != null ? `equity €${breakdown.equity.toLocaleString()}` : null,
    breakdown.thirteenth_etc  != null ? `13th/14th €${breakdown.thirteenth_etc.toFixed(0)}` : null,
    breakdown.cash_benefits   != null ? `benefits €${breakdown.cash_benefits.toLocaleString()}` : null,
    breakdown.sign_on         != null ? `sign-on amortized €${breakdown.sign_on.toFixed(0)}` : null,
  ].filter(Boolean)
  const math =
    `comp €${totalComp.toLocaleString()}${estimated ? ' (estimated)' : ''} (= ${componentLines.join(' + ')}) ` +
    `→ net €${annualNet.toLocaleString()}/yr = €${monthlyNet.toFixed(0)}/mo (tax ${(taxRate*100).toFixed(1)}%, source: ${taxSource}) ` +
    `→ minus baseline €${baseline.toFixed(0)} (source: ${colSource})${isIntern ? ' (intern: shared-housing half baseline)' : ''} ` +
    `→ savings €${savings.toFixed(0)}/mo → base ${baseScore} ` +
    `→ modifier ${(input.soft_benefits_modifier ?? 0) >= 0 ? '+' : ''}${input.soft_benefits_modifier ?? 0} ` +
    `→ final ${finalSalaryAdjScore}`
  const summary = salarySummary({ savings, city: input.city, estimated, isIntern })

  return {
    eligibility,
    salary_adj_for_city: {
      score:      finalSalaryAdjScore,
      base_score: baseScore,
      modifier:   input.soft_benefits_modifier ?? 0,
      summary,
      math,
      provenance: { tax: taxSource, col: colSource },
      computed:   { totalComp, annualNet, monthlyNet, baseline, savings },
    },
    calibrated_dims: {
      brand_value:     { raw: j.brand_value,     final: brandCal.value,  adjustments: brandCal.adjustments },
      growth_mobility: { raw: j.growth_mobility, final: growthCal.value, adjustments: growthCal.adjustments },
      competition:     { raw: j.competition,     final: compCal.value,   adjustments: compCal.adjustments },
    },
    dims,
    want,
    ease,
    priority,
    verdict: verdict.verdict,
    verdict_label: VERDICT_LABELS[verdict.verdict],
    verdict_action: VERDICT_ACTIONS[verdict.verdict],
    tier: verdict.tier,
    tier_reason: verdict.reason,
    promotion_hint: promotionHint(verdict.verdict),
    explanation,
    prior: prior ? { ...prior, changes: compareToPrior(prior, dims) } : null,
  }
}

/**
 * One plain sentence for the report's Salary cell, rounded to the nearest
 * €10 so it reads like advice rather than an audit:
 *   "About €150 a month left after living costs in Lyon (estimated pay)."
 *   "About €150 a month short of living costs in Dublin."
 */
export function salarySummary({ savings, city, estimated = false, isIntern = false }) {
  const amount = Math.round(Math.abs(savings) / 10) * 10
  const where  = city ? ` in ${city}` : ''
  const notes  = [estimated ? 'estimated pay' : null, isIntern ? 'shared housing assumed' : null].filter(Boolean)
  const tail   = notes.length ? ` (${notes.join(', ')})` : ''
  if (amount === 0) return `Roughly breaks even after living costs${where}${tail}.`
  return savings > 0
    ? `About €${amount.toLocaleString('en-US')} a month left after living costs${where}${tail}.`
    : `About €${amount.toLocaleString('en-US')} a month short of living costs${where}${tail}.`
}

// Run when invoked as a script (skip when imported by test-all.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`score-listing: ${err.stack ?? err.message ?? err}\n`)
    process.exit(2)
  })
}
