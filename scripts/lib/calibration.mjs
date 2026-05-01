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
//     "brand_affinity_companies":     ["McKinsey", "BCG", ...],   // +0.6 to Brand on match
//     "dream_companies":              ["Google", ...],            // override Brand to 10 + AF floor 8.0
//     "lower_tier_dream_companies":   ["Mastercard", "Glovo", ...], // +1.0 to Brand on match
//     "extra_brand_bonuses": [                                    // company-specific top-up
//       { "company": "Google", "bonus": 1.0, "reason": "priority target" }
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
//   - AF:     upper-tier dream_companies match → floor at 8.0 (after rollup)
//
// All numbers ultimately clamped to [1, 10].

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
 * Apply Aspirational Fit floor for dream companies (after rollup).
 */
export function applyAspirationalFitFloor(af, company, calibration) {
  const dreamList = calibration?.dream_companies ?? []
  if (dreamList.some(c => sameCompany(c, company)) && af < 8.0) {
    return { value: 8.0, adjustments: [{ source: 'dream-company AF floor', value: 8.0 - af }] }
  }
  return { value: af, adjustments: [] }
}

/* ───── helpers ──────────────────────────────────────────────────── */

function sameCompany(a, b) {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function clamp(n) {
  return Math.max(1, Math.min(10, Number(n.toFixed(2))))
}
