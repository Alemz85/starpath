// score-bands.mjs — pure scoring math.
//
// All functions are pure (no I/O, no mutation, no globals). The scoring
// rules encoded here are the canonical source — modes/_shared.md
// describes them in prose for the agent's mental model, but THIS file
// is what actually executes during evaluation. If a rule changes,
// update both — and pin a fixture in test-all.mjs so any regression
// is caught.

/* ───── Salary Adj — savings band ───────────────────────────────── */

/**
 * Map monthly savings (in EUR) to a base 1-10 score on the
 * savings-power band documented in _shared.md § Salary Adj for City.
 * Monotonic across all 10 tiers — no skipped values.
 */
export function savingsToBaseScore(monthlySavingsEur) {
  const s = monthlySavingsEur
  if (s >= 2000) return 10
  if (s >= 1500) return 9
  if (s >= 1100) return 8
  if (s >=  800) return 7
  if (s >=  500) return 6
  if (s >=  250) return 5
  if (s >=   50) return 4
  if (s >= -150) return 3
  if (s >= -400) return 2
  return 1
}

/**
 * Apply soft-benefits modifier to base score, clamp to [1, 10].
 * Modifier is typically in [-0.5, +1.0]; we don't enforce the cap on
 * input but clamp the output so a runaway modifier can't escape the band.
 */
export function applyBenefitsModifier(baseScore, modifier) {
  const raw = baseScore + (modifier ?? 0)
  return Math.max(1, Math.min(10, Number(raw.toFixed(2))))
}

/* ───── Total comp build-up ─────────────────────────────────────── */

/**
 * Build total annual comp from disclosed components. Pass each component
 * separately; the function sums them. Pass undefined for missing parts —
 * don't pass 0 for "unknown" (a 0 bonus and an unknown bonus would be
 * indistinguishable, which we don't want for downstream provenance logging).
 *
 *   base                  Annual base salary in EUR
 *   bonusPct              Target bonus as a fraction of base (e.g. 0.15 for 15%)
 *   equityAnnualEur       Annualized equity (RSU grant / vest years × USD-EUR)
 *   thirteenthMonthMonths 1 if 13th month, 2 if 13th + 14th, etc.
 *   benefitsMonthlyEur    Monthly cash-equivalent benefits (transit, meals, gym)
 *   signOnEur             One-off signing bonus
 *   tenureYears           For sign-on amortization (default 3)
 */
export function buildTotalComp({
  base,
  bonusPct,
  equityAnnualEur,
  thirteenthMonthMonths,
  benefitsMonthlyEur,
  signOnEur,
  tenureYears = 3,
}) {
  const breakdown = { base }
  if (bonusPct           != null) breakdown.bonus            = base * bonusPct
  if (equityAnnualEur    != null) breakdown.equity           = equityAnnualEur
  if (thirteenthMonthMonths) breakdown.thirteenth_etc        = (base / 12) * thirteenthMonthMonths
  if (benefitsMonthlyEur != null) breakdown.cash_benefits    = benefitsMonthlyEur * 12
  if (signOnEur          != null) breakdown.sign_on          = signOnEur / tenureYears
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  return { total, breakdown }
}

/* ───── Rollups ─────────────────────────────────────────────────── */

const BOTTOM_RANGE_PENALTY = 0.30  // per dimension scoring 1 or 2

function bottomRangePenalty(scores) {
  const lowCount = scores.filter(s => s >= 1 && s <= 2).length
  return lowCount * BOTTOM_RANGE_PENALTY
}

/**
 * Roll up the three Current Fit dims (Skills Match + Ease of Entry +
 * Strategic Fit) → CF, with bottom-range penalty.
 */
export function rollupCurrentFit({ skills_match, ease_of_entry, strategic_fit }) {
  const dims = [skills_match, ease_of_entry, strategic_fit]
  const avg = dims.reduce((a, b) => a + b, 0) / 3
  const penalty = bottomRangePenalty(dims)
  return Number((avg - penalty).toFixed(2))
}

/**
 * Roll up the three Aspirational Fit dims (Growth + Optionality + Brand) → AF.
 * Sales-Trap Risk is NOT in the rollup (decision-support only) per _shared.md.
 */
export function rollupAspirationalFit({ growth_mobility, optionality_exit, brand_value }) {
  const dims = [growth_mobility, optionality_exit, brand_value]
  const avg = dims.reduce((a, b) => a + b, 0) / 3
  const penalty = bottomRangePenalty(dims)
  return Number((avg - penalty).toFixed(2))
}

/**
 * Compute Overall = CF × 0.70 + AF × 0.30 + context modifiers.
 *
 * Context modifiers (from _shared.md § Context modifiers):
 *   Salary Adj ≤ 4   → -0.4    (skipped for interns — stipends aren't salaries)
 *   Salary Adj ≥ 9   → +0.2    (skipped for interns)
 *   Work-Life Bal ≤ 4 → -0.2   (still applies to interns — sweatshop signal matters)
 *
 * Why the intern carve-out: intern stipends are by-design close to break-even
 * after rent. Penalizing Overall by -0.4 for nearly every intern role would
 * be near-universal noise that doesn't differentiate good intern roles from
 * bad ones. The Salary Adj score itself is still surfaced in the report;
 * only its effect on Overall is suppressed for interns.
 *
 * Returns { overall, modifiersApplied } so callers can show the math.
 */
export function rollupOverall(cf, af, { salary_adj_for_city, work_life_balance, is_intern }) {
  const base = cf * 0.70 + af * 0.30
  const modifiers = []
  let delta = 0
  if (!is_intern) {
    if (salary_adj_for_city <= 4) { delta -= 0.4; modifiers.push({ source: 'Salary Adj ≤ 4', value: -0.4 }) }
    if (salary_adj_for_city >= 9) { delta += 0.2; modifiers.push({ source: 'Salary Adj ≥ 9', value: +0.2 }) }
  } else if (salary_adj_for_city <= 4 || salary_adj_for_city >= 9) {
    // Surface the skip explicitly so the math line in the report shows
    // why no Salary modifier appears even when the score would otherwise trigger one.
    modifiers.push({ source: `Salary Adj modifier skipped (intern role)`, value: 0 })
  }
  if (work_life_balance    <= 4) { delta -= 0.2; modifiers.push({ source: 'WLB ≤ 4',         value: -0.2 }) }
  const overall = Number((base + delta).toFixed(2))
  return { overall, modifiersApplied: modifiers }
}

/* ───── Score Band & Tier assignment ─────────────────────────────── */

/**
 * Assigns the conceptual Score Band and legacy Tier indicator.
 * Under the hood, legacy symbols ('T1'–'T4') are returned to maintain
 * perfect compatibility with Electron scanners, SQLite schemas, and TSV parsers.
 *
 * Mapping Rules:
 *   - Stellar (T1): CF ≥ 9.0  OR  (all 6 dims ≥ 8 AND both rollups ≥ 8.0)  ← uniform-fingerprint override
 *   - Strong (T2): CF 8.0–8.9 AND Ease of Entry > 4 (verdict: "Apply with prep")
 *   - Decent (T2): CF 7.0–7.9 AND Ease of Entry > 4 (verdict: "Apply if pipeline thin")
 *   - Pass / Growth Target (T3): Overall 5.0–6.9, or < 7.0 with AF ≥ 7.0, OR Ease of Entry ≤ 4 gate
 *   - Skip (T4): else / language wall exception
 *
 *   sixDims = { skills_match, ease_of_entry, strategic_fit, growth_mobility, optionality_exit, brand_value }
 */
export function assignTier({ cf, af, sixDims }) {
  const eoe = sixDims.ease_of_entry
  const allDimsAtLeast = (n) => Object.values(sixDims).every(s => s >= n)

  // Stellar Band (maps to legacy Tier 1)
  if (cf >= 9.0) return { tier: 'T1', reason: 'CF ≥ 9.0' }
  
  // Stellar Band uniform-fingerprint override
  if (allDimsAtLeast(8) && cf >= 8.0 && af >= 8.0) {
    return { tier: 'T1', reason: 'uniform fingerprint: all 6 dims ≥ 8 AND CF/AF ≥ 8.0' }
  }
  
  // Pass / Growth Target Band: Ease of Entry ≤ 4 gate demotes to legacy Tier 3
  if (eoe <= 4) {
    if (af >= 7.0) return { tier: 'T3', reason: 'EoE ≤ 4 gate (growth target)' }
    return { tier: 'T4', reason: 'EoE ≤ 4 AND AF < 7' }
  }
  
  // Strong & Decent Bands (map to legacy Tier 2)
  if (cf >= 7.0) return { tier: 'T2', reason: 'CF ≥ 7.0 AND EoE > 4' }
  
  // Pass / Growth Target Band: low Current Fit but high Aspirational Fit
  if (af >= 7.0) return { tier: 'T3', reason: 'CF < 7.0 AND AF ≥ 7.0' }
  
  // Skip Band (maps to legacy Tier 4)
  return { tier: 'T4', reason: 'CF < 7.0 AND AF < 7.0' }
}

/* ───── Tax math (helper used after a tax-cache lookup) ─────────── */

/**
 * Apply an effective tax rate to gross. Returns annual net + monthly net.
 * The actual tax rate comes from a calculator lookup (cached in
 * data/tax-cache.tsv) — this function just does the arithmetic so the
 * caller can hold provenance separately.
 */
export function grossToNet(annualGross, effectiveRate) {
  const annualNet = annualGross * (1 - effectiveRate)
  return {
    annualNet:   Number(annualNet.toFixed(2)),
    monthlyNet:  Number((annualNet / 12).toFixed(2)),
  }
}
