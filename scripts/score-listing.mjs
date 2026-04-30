#!/usr/bin/env node

/**
 * score-listing.mjs — Deterministic scoring entry point.
 *
 * The agent does the JUDGMENT scoring (Skills Match, Ease of Entry,
 * Strategic Fit, Growth, Optionality, Brand, Sales-Trap Risk, WLB,
 * Best Cities, soft-benefits modifier) and the JD prose-reading. This
 * script does the COMPUTATION:
 *
 *   - Build total annual comp from disclosed components (base + bonus
 *     + equity + 13th/14th month + cash benefits + amortized sign-on)
 *   - Apply the country tax rate (from the cache or a passed override)
 *     to get net
 *   - Subtract the city baseline (from the cache or a passed override)
 *     to get monthly savings
 *   - Score savings on the 10-tier band, apply the soft modifier
 *   - Roll up CF, AF, Overall (with bottom-range penalty + context modifiers)
 *   - Assign tier per the rules in modes/scouting.md
 *   - Return a structured JSON result with full math + provenance
 *
 * Caches are read-only here. Cache writes happen via a separate
 * `--write-cache` flag (see below) so the agent has a chance to verify
 * a fetched value before persisting.
 *
 * Usage:
 *
 *   echo '{ ...inputs... }' | node scripts/score-listing.mjs
 *   echo '{ ...inputs... }' | node scripts/score-listing.mjs --write-cache
 *
 * Input JSON shape — see SCHEMA below or the test fixtures in
 * test-all.mjs. Output is JSON to stdout; non-zero exit on input error.
 *
 * SCHEMA (input):
 *   {
 *     "company": "Google",
 *     "role_archetype": "Software Engineer",
 *     "city": "Dublin",
 *     "country": "IE",
 *     "comp": {
 *       "base":             105000,        // annual base in EUR
 *       "bonusPct":         0.15,          // optional, decimal
 *       "equityAnnualEur":  34500,         // optional, annualized
 *       "thirteenthMonthMonths": 0,        // optional (0/1/2)
 *       "benefitsMonthlyEur": 100,         // optional, monthly cash-equiv
 *       "signOnEur":        5000,          // optional, one-off
 *       "tenureYears":      3              // optional, default 3
 *     },
 *     "tax_override":         { "rate": 0.27, "source": "talent.com 2026-04" },  // skip cache
 *     "col_override":         { "baseline_eur": 3050, "source": "numbeo 2026-04" }, // skip cache
 *     "is_intern": false,
 *     "soft_benefits_modifier": 0.5,
 *     "judgment_scores": {
 *       "skills_match": 8, "ease_of_entry": 6, "strategic_fit": 8,
 *       "growth_mobility": 9, "optionality_exit": 9, "brand_value": 9,
 *       "sales_trap_risk": 9, "work_life_balance": 7, "best_cities": 9
 *     }
 *   }
 *
 * SCHEMA (output): see jsdoc on `scoreListing()` below.
 */

import { readFile } from 'fs/promises'

import {
  savingsToBaseScore, applyBenefitsModifier,
  buildTotalComp, grossToNet,
  rollupCurrentFit, rollupAspirationalFit, rollupOverall,
  assignTier,
} from './lib/score-bands.mjs'

import {
  applyBrandCalibration, applyGrowthCalibration, applyAspirationalFitFloor,
} from './lib/calibration.mjs'

import * as taxCache from './lib/tax-cache.mjs'
import * as colCache from './lib/col-cache.mjs'

const writeCache = process.argv.includes('--write-cache')

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const raw = await readStdin()
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
  const result = await scoreListing(input)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

/**
 * Pure(-ish) function form so test-all.mjs can import + assert without
 * shelling out. Side effects: reads cache TSVs (cheap), optionally
 * writes them when --write-cache.
 */
export async function scoreListing(input) {
  // 1. Total comp build-up
  const { total: totalComp, breakdown } = buildTotalComp(input.comp)

  // 2. Tax rate
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
        totalComp, breakdown,
      }
    }
  }
  const { annualNet, monthlyNet } = grossToNet(totalComp, taxRate)

  // 3. City baseline
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
        totalComp, breakdown, taxRate,
      }
    }
  }
  if (input.is_intern) baseline = baseline / 2  // shared housing assumed

  // 4. Savings → score
  const savings    = Number((monthlyNet - baseline).toFixed(2))
  const baseScore  = savingsToBaseScore(savings)
  const finalSalaryAdjScore = applyBenefitsModifier(baseScore, input.soft_benefits_modifier)

  // 5. Cache writes (optional, only when --write-cache and we did fetches via override)
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

  // 6. Calibration adjustments (documented in user/_profile.md)
  // Apply BEFORE the rollups so the calibrated values flow into CF/AF.
  const j = input.judgment_scores
  const calibration = input.calibration ?? {}
  const brandCal  = applyBrandCalibration(j.brand_value, input.company, calibration)
  const growthCal = applyGrowthCalibration(j.growth_mobility, calibration)
  const calibrated = {
    ...j,
    brand_value:     brandCal.value,
    growth_mobility: growthCal.value,
  }

  // 7. Rollups using calibrated judgment scores + the computed Salary Adj
  const cf = rollupCurrentFit(calibrated)
  const afRaw = rollupAspirationalFit(calibrated)
  const afFloor = applyAspirationalFitFloor(afRaw, input.company, calibration)
  const af = afFloor.value
  const { overall, modifiersApplied } = rollupOverall(cf, af, {
    salary_adj_for_city: finalSalaryAdjScore,
    work_life_balance:   j.work_life_balance,
  })
  const sixDims = {
    skills_match:     calibrated.skills_match,
    ease_of_entry:    calibrated.ease_of_entry,
    strategic_fit:    calibrated.strategic_fit,
    growth_mobility:  calibrated.growth_mobility,
    optionality_exit: calibrated.optionality_exit,
    brand_value:      calibrated.brand_value,
  }
  const tierResult = assignTier({ cf, af, sixDims })

  // 7. Provenance string for the Salary Adj reasoning cell.
  // When the comp comes from an estimate (Glassdoor / Levels.fyi /
  // comp-cache lookup) instead of being disclosed in the JD, mark the
  // gross with `**` and append `(** = estimated)` to the end of the math
  // chain — keeps the cell tight while still surfacing provenance.
  const compSource = input.comp_source ?? 'disclosed'
  const compTag    = compSource === 'estimate' ? '**' : ''
  const compFootnote = compSource === 'estimate' ? ' (** = estimated)' : ''
  const componentLines = [
    `base €${input.comp.base.toLocaleString()}`,
    breakdown.bonus           != null ? `bonus €${breakdown.bonus.toFixed(0)}` : null,
    breakdown.equity          != null ? `equity €${breakdown.equity.toLocaleString()}` : null,
    breakdown.thirteenth_etc  != null ? `13th/14th €${breakdown.thirteenth_etc.toFixed(0)}` : null,
    breakdown.cash_benefits   != null ? `benefits €${breakdown.cash_benefits.toLocaleString()}` : null,
    breakdown.sign_on         != null ? `sign-on amortized €${breakdown.sign_on.toFixed(0)}` : null,
  ].filter(Boolean)
  const math =
    `comp €${totalComp.toLocaleString()}${compTag} (= ${componentLines.join(' + ')}) ` +
    `→ net €${annualNet.toLocaleString()}/yr = €${monthlyNet.toFixed(0)}/mo (tax ${(taxRate*100).toFixed(1)}%, source: ${taxSource}) ` +
    `→ minus baseline €${baseline.toFixed(0)} (source: ${colSource})${input.is_intern ? ' [intern half-baseline]' : ''} ` +
    `→ savings €${savings.toFixed(0)}/mo → base ${baseScore} ` +
    `→ modifier ${(input.soft_benefits_modifier ?? 0) >= 0 ? '+' : ''}${input.soft_benefits_modifier ?? 0} ` +
    `→ final ${finalSalaryAdjScore}` +
    compFootnote

  return {
    salary_adj_for_city: {
      score:      finalSalaryAdjScore,
      base_score: baseScore,
      modifier:   input.soft_benefits_modifier ?? 0,
      math,
      provenance: { tax: taxSource, col: colSource },
      computed:   { totalComp, annualNet, monthlyNet, baseline, savings },
    },
    calibrated_dims: {
      brand_value:     { raw: j.brand_value,     final: calibrated.brand_value,     adjustments: brandCal.adjustments },
      growth_mobility: { raw: j.growth_mobility, final: calibrated.growth_mobility, adjustments: growthCal.adjustments },
    },
    current_fit: cf,
    aspirational_fit: af,
    aspirational_fit_floor: afFloor.adjustments.length > 0 ? { raw: afRaw, floored_to: af, ...afFloor.adjustments[0] } : null,
    overall,
    overall_modifiers: modifiersApplied,
    tier: tierResult.tier,
    tier_reason: tierResult.reason,
  }
}

// Run when invoked as a script (skip when imported by test-all.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`score-listing: ${err.stack ?? err.message ?? err}\n`)
    process.exit(2)
  })
}
