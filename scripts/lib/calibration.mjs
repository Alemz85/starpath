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
//     "dream_companies":              ["Northwind", ...],         // Want floor 8.0 (rollupWant)
//     "lower_tier_dream_companies":   ["Contoso", ...],           // +0.25 Want (preference)
//     "brand_affinity_companies":     ["Fabrikam", ...],          // no score effect here (see below)
//     "extra_brand_bonuses": [                                    // Brand perception correction
//       { "company": "Northwind", "bonus": 1.0, "reason": "household name in the target market" }
//     ],
//     "has_structured_onboarding":    true,                       // +1.0 to Growth
//     "has_sink_or_swim_signal":      false                       // −1.0 to Growth
//   }
//
// Brand Value is a CV signal: how a recruiter at another company reads the
// name. It is NOT moved by the candidate's own liking for a company — that
// is preference, and preference lives in Want (the dream floor, and the
// small lower-tier bonus below), where it is counted once and labelled as
// such. `extra_brand_bonuses` stays for genuine perception corrections the
// tier table misses (a name that carries more weight in the candidate's
// target market than its global tier suggests).
//
// `brand_affinity_companies` (e.g. CEMS corporate partners) no longer touch
// Brand: a dedicated recruiting channel changes the odds, which Competition
// already credits. The list still feeds pipeline triage and the daily brief.
// `cems_adjacent_companies` remains accepted as its alias there.
//
// Adjustments applied:
//   - Brand:  extra_brand_bonuses entry match → +entry.bonus
//   - Want:   lower_tier_dream_companies match → +0.25 (wantPreference)
//   - Want:   dream_companies match → floor 8.0 (in rollupWant, via isDreamCompany)
//   - Growth: has_structured_onboarding → +1.0
//   - Growth: has_sink_or_swim_signal → −1.0
//   - Competition: referral "warm-direct" → +1.0, "warm-intro" → +0.5 (clamp 10)
//
// All numbers ultimately clamped to [1, 10].

import { REFERRAL_BONUS, PREFERRED_COMPANY_WANT_BONUS } from './score-bands.mjs'

/**
 * Apply Brand calibration to the agent's raw Brand score: only the explicit
 * perception corrections in `extra_brand_bonuses`. Dream / lower-tier dream /
 * affinity lists do not move Brand (see the header).
 * Returns { value, adjustments } so the caller can show what fired.
 */
export function applyBrandCalibration(rawBrand, company, calibration) {
  const extraBonuses = calibration?.extra_brand_bonuses ?? []
  const adjustments = []
  let value = rawBrand
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
 * The candidate's own preference for a company, as a Want bonus: a
 * lower-tier dream company adds PREFERRED_COMPANY_WANT_BONUS. Dream companies
 * get the Want floor instead (rollupWant), not this bonus.
 * Returns { bonus, source } (bonus 0 when nothing applies).
 */
export function wantPreference(company, calibration) {
  if (isDreamCompany(company, calibration)) return { bonus: 0, source: null }
  const lower = calibration?.lower_tier_dream_companies ?? []
  if (lower.some(c => sameCompany(c, company))) {
    return { bonus: PREFERRED_COMPANY_WANT_BONUS, source: 'lower-tier dream company' }
  }
  return { bonus: 0, source: null }
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
