// calibration.mjs — Apply user-specific scoring calibrations
// (documented in user/_profile.md § Score Calibration).
//
// The agent extracts the company name + JD signals (onboarding /
// sink-or-swim / dream-company / CEMS list) and passes them as
// `calibration` input to score-listing. This module applies the
// documented bonuses deterministically so they can't drift between
// evaluations.
//
// Documented adjustments:
//   - Brand:  CEMS-adjacent firms (McKinsey/BCG/EY/Accenture/Google/Spotify/Wise) → +0.6
//   - Brand:  Google specifically → +1.0 ON TOP of the +0.6 (so Google = +1.6 total)
//   - Brand:  upper-tier dream company → override to 10 (regardless of raw judgment)
//   - Brand:  lower-tier dream company → +1.0 bonus (stacks with CEMS-adjacent;
//             NO override to 10 and no AF floor — just a meaningful brand boost)
//   - Growth: structured onboarding / mentorship / learning path → +1.0
//   - Growth: sink-or-swim culture signal → −1.0
//   - AF:     upper-tier dream company → floor at 8.0 (after rollup; lower tier does NOT floor)
//
// All numbers ultimately clamped to [1, 10].

const DEFAULT_CEMS_ADJACENT = ['McKinsey', 'BCG', 'EY', 'Accenture', 'Google', 'Spotify', 'Wise']

/**
 * Apply Brand calibration to the agent's raw Brand score.
 * Returns { value, adjustments } so the caller can show what fired.
 */
export function applyBrandCalibration(rawBrand, company, calibration) {
  const cemsList = calibration?.cems_adjacent_companies ?? DEFAULT_CEMS_ADJACENT
  const dreamList = calibration?.dream_companies ?? []
  const lowerTierDreamList = calibration?.lower_tier_dream_companies ?? []
  const adjustments = []

  // Upper-tier dream override wins — Brand floors at 10 regardless of other adjustments.
  if (dreamList.some(c => sameCompany(c, company))) {
    adjustments.push({ source: 'dream-company override', value: 10 - rawBrand, type: 'override' })
    return { value: 10, adjustments }
  }

  let value = rawBrand
  if (cemsList.some(c => sameCompany(c, company))) {
    value += 0.6
    adjustments.push({ source: 'CEMS-adjacent firm', value: +0.6 })
  }
  if (sameCompany('Google', company)) {
    value += 1.0
    adjustments.push({ source: 'Google special', value: +1.0 })
  }
  if (lowerTierDreamList.some(c => sameCompany(c, company))) {
    value += 1.0
    adjustments.push({ source: 'lower-tier dream company', value: +1.0 })
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
