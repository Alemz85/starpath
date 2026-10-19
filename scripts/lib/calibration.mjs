// calibration.mjs — Apply user-supplied scoring calibrations.
//
// Calibration data MUST come from the caller (the agent reads it from
// `user/profile.yml` and `user/_profile.md`, then passes it into
// score-listing as the `calibration` field of the input JSON). This
// module applies the rules deterministically so they can't drift
// between evaluations — it does NOT bake in any user's specific
// company lists. Everything is data-driven.
//
// Calibration shape (all fields optional; missing = no effect):
//   {
//     "brand_affinity_companies":     ["Fabrikam", ...],          // +0.6 to Brand on match
//     "dream_companies":              ["Northwind", ...],         // override Brand to 10 + Want floor 8.0
//     "lower_tier_dream_companies":   ["Contoso", ...],           // +1.0 to Brand on match
//     "extra_brand_bonuses": [                                    // company-specific top-up
//       { "company": "Northwind", "bonus": 1.0, "reason": "priority target" }
//     ],
//     "has_structured_onboarding":    true,                       // +1.0 to Growth
//     "has_sink_or_swim_signal":      false                       // −1.0 to Growth
//   }
//
// Backward-compat: `cems_adjacent_companies` is accepted as an alias
// for `brand_affinity_companies` so existing user/_profile.md prose
// referencing "CEMS-adjacent firms" continues to flow through the
// agent without refactoring.
//
// Adjustments applied:
//   - Brand:  brand_affinity_companies match → +0.6
//   - Brand:  upper-tier dream_companies match → override to 10
//   - Brand:  lower_tier_dream_companies match → +1.0
//   - Brand:  extra_brand_bonuses entry match → +entry.bonus
//   - Growth: has_structured_onboarding → +1.0
//   - Growth: has_sink_or_swim_signal → −1.0
//   - Competition: referral "warm-direct" → +1.0, "warm-intro" → +0.5 (clamp 10)
//
// The dream-company Want floor (8.0) lives inside rollupWant
// (score-bands.mjs) because it must run AFTER the raw rollup and BEFORE the
// hygiene / role-content vetoes; this module only answers "is it a dream
// company?" (isDreamCompany), still data-driven from dream_companies.
//
// All numbers ultimately clamped to [1, 10].

import { REFERRAL_BONUS } from './score-bands.mjs'

/**
 * Apply Brand calibration to the agent's raw Brand score.
 * Returns { value, adjustments } so the caller can show what fired.
 */
export function applyBrandCalibration(rawBrand, company, calibration) {
  const affinityList =
    calibration?.brand_affinity_companies ??
    calibration?.cems_adjacent_companies ??  // backward-compat alias
    []
  const dreamList = calibration?.dream_companies ?? []
  const lowerTierDreamList = calibration?.lower_tier_dream_companies ?? []
  const extraBonuses = calibration?.extra_brand_bonuses ?? []
  const adjustments = []

  // Upper-tier dream override wins — Brand floors at 10 regardless of other adjustments.
  if (dreamList.some(c => sameCompany(c, company))) {
    adjustments.push({ source: 'dream-company override', value: 10 - rawBrand, type: 'override' })
    return { value: 10, adjustments }
  }

  let value = rawBrand
  if (affinityList.some(c => sameCompany(c, company))) {
    value += 0.6
    adjustments.push({ source: 'brand-affinity firm', value: +0.6 })
  }
  if (lowerTierDreamList.some(c => sameCompany(c, company))) {
    value += 1.0
    adjustments.push({ source: 'lower-tier dream company', value: +1.0 })
  }
  for (const entry of extraBonuses) {
    if (entry?.company && sameCompany(entry.company, company) && Number.isFinite(entry.bonus)) {
      value += entry.bonus
      adjustments.push({
        source: entry.reason ? `${entry.company} bonus (${entry.reason})` : `${entry.company} bonus`,
        value: entry.bonus,
      })
    }
  }
  return { value: clamp(value), adjustments }
}

/**
 * Apply Growth calibration to the agent's raw Growth score.
 */
export function applyGrowthCalibration(rawGrowth, calibration) {
  const adjustments = []
  let value = rawGrowth
  if (calibration?.has_structured_onboarding) {
    value += 1.0
    adjustments.push({ source: 'structured onboarding / learning path', value: +1.0 })
  }
  if (calibration?.has_sink_or_swim_signal) {
    value -= 1.0
    adjustments.push({ source: 'sink-or-swim culture signal', value: -1.0 })
  }
  return { value: clamp(value), adjustments }
}

/**
 * Is the company one of the candidate's upper-tier dream companies? Drives
 * the Want floor in rollupWant (spec §2.2).
 */
export function isDreamCompany(company, calibration) {
  return (calibration?.dream_companies ?? []).some(c => sameCompany(c, company))
}

/**
 * Is the company on any of the candidate's wish lists (dream, lower-tier
 * dream, brand affinity)? A Blocked listing at such a company gets the
 * `Revisit next cycle:` note prefix (spec §1.3).
 */
export function isRevisitCompany(company, calibration) {
  const lists = [
    calibration?.dream_companies,
    calibration?.lower_tier_dream_companies,
    calibration?.brand_affinity_companies ?? calibration?.cems_adjacent_companies,
  ]
  return lists.some(list => (list ?? []).some(c => sameCompany(c, company)))
}

/**
 * Referral modifier on Competition (spec §3.1), applied before the Ease
 * rollup: "warm-direct" → +1.0, "warm-intro" → +0.5, anything else → 0.
 * Returns { value, adjustments } like the other calibrations.
 */
export function applyReferralAdjustment(rawCompetition, referral) {
  const bonus = typeof referral === 'string' && Object.hasOwn(REFERRAL_BONUS, referral) ? REFERRAL_BONUS[referral] : 0
  if (!bonus) return { value: clamp(rawCompetition), adjustments: [] }
  return {
    value: clamp(rawCompetition + bonus),
    adjustments: [{ source: `${referral} referral`, value: bonus }],
  }
}

/* ───── helpers ──────────────────────────────────────────────────── */

function sameCompany(a, b) {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function clamp(n) {
  return Math.max(1, Math.min(10, Number(n.toFixed(2))))
}
