// score-bands.mjs — pure scoring math.
//
// All functions are pure (no I/O, no mutation, no globals). The scoring
// rules encoded here are the canonical source — modes/_shared.md
// describes them in prose for the agent's mental model, but THIS file
// is what actually executes during evaluation. If a rule changes,
// update both — and pin a fixture in test-all.mjs so any regression
// is caught.
//
// Scoring model: v2 (docs/scoring-v2.md): eligibility gate
// (eligibility.mjs), then Want and Ease, then the verdict grid. The v1
// CF/AF/Overall rollups and assignTier were removed with that model.

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

/* ───── v2 rollups: Want, Ease, verdict, Priority ──────────────── */
//
// Spec: docs/scoring-v2.md §2–§5. A listing that passes the eligibility gate
// (scripts/lib/eligibility.mjs) gets two independent numbers:
//
//   Want (1–10) — how much the candidate wants the role. Motivators are
//                 averaged; hygiene factors only nudge (+0.25 when good) or
//                 hurt (down to −1.20 when bad), because a great city or a
//                 fair salary doesn't make a role worth wanting, but a bad
//                 one can ruin it.
//   Ease (1–10) — how realistic it is to get in. Hiring is a funnel, so it's
//                 a weighted GEOMETRIC mean: one weak stage drags more than a
//                 strong one lifts.
//
// The verdict comes from the Want × Ease grid; there is no Overall. Priority
// (√(Want·Ease)) is a sort key only, never a headline score.

export const MOTIVATOR_DIMS = Object.freeze(['growth_mobility', 'optionality_exit', 'brand_value', 'role_content'])
export const HYGIENE_DIMS   = Object.freeze(['best_cities', 'salary_adj_city', 'work_life_balance'])
export const WANT_DIMS      = Object.freeze([...MOTIVATOR_DIMS, ...HYGIENE_DIMS])
export const EASE_DIMS      = Object.freeze(['skills_match', 'experience_bar', 'competition'])

export const DEFAULT_WANT_WEIGHTS = Object.freeze({
  growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1,
})
export const DEFAULT_EASE_WEIGHTS = Object.freeze({
  skills_match: 0.35, experience_bar: 0.35, competition: 0.30,
})

// h(x) for hygiene factors — the first row whose `min` the score reaches wins.
export const HYGIENE_STEPS = Object.freeze([
  Object.freeze({ min: 8, value: +0.25 }),
  Object.freeze({ min: 5, value:  0 }),
  Object.freeze({ min: 4, value: -0.40 }),
  Object.freeze({ min: 3, value: -0.80 }),
  Object.freeze({ min: -Infinity, value: -1.20 }),
])

export const MOTIVATOR_BOTTOM_AT       = 2     // a motivator ≤ this is "bottom-range"
export const MOTIVATOR_BOTTOM_PENALTY  = 0.30  // per bottom-range motivator
export const HYGIENE_VETO_BELOW        = 3     // any hygiene factor < this vetoes…
export const HYGIENE_VETO_CAP          = 5.0   // …capping Want here
export const ROLE_CONTENT_VETO_AT      = 3     // role_content ≤ this vetoes…
export const ROLE_CONTENT_VETO_CAP     = 6.0   // …capping Want here
export const DREAM_WANT_FLOOR          = 8.0

export const EXPERIENCE_WALL_AT        = 3     // experience_bar ≤ this…
export const EXPERIENCE_WALL_CAP       = 4.5   // …caps Ease here
export const AMBER_EASE_PENALTY        = 0.5   // per amber eligibility check
export const AMBER_EASE_PENALTY_MAX    = 1.0
export const REFERRAL_BONUS = Object.freeze({ 'warm-direct': 1.0, 'warm-intro': 0.5 })

export const WANT_HIGH = 8.0
export const WANT_MID  = 6.5
export const EASE_HIGH = 7.0
export const EASE_MID  = 5.0

// Worst → best. explain-score's lever search uses it to decide whether a
// hypothetical change lands in a *better* cell; surfaces can sort on it.
export const VERDICT_ORDER = Object.freeze(['blocked', 'skip', 'thin', 'growth', 'solid', 'stretch', 'go'])

export const VERDICT_LABELS = Object.freeze({
  go:      'Go',
  stretch: 'Stretch',
  growth:  'Growth target',
  solid:   'Solid',
  thin:    'If pipeline thin',
  skip:    'Skip',
  blocked: 'Blocked',
})

// The action phrase from the §4 grid, for "**Verdict:** Stretch — apply with prep".
export const VERDICT_ACTIONS = Object.freeze({
  go:      'apply now',
  stretch: 'apply with prep',
  growth:  'close the gap first',
  solid:   'apply',
  thin:    'only if your pipeline is thin',
  skip:    'recommend against applying',
  blocked: 'not eligible',
})

export const VERDICT_TIERS = Object.freeze({
  go: 'T1', stretch: 'T2', solid: 'T2', thin: 'T2', growth: 'T3', skip: 'T4', blocked: 'T4',
})

const round2 = (n) => Number(n.toFixed(2))
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

/** Hygiene term h(x) per HYGIENE_STEPS. */
export function hygieneTerm(x) {
  for (const step of HYGIENE_STEPS) if (x >= step.min) return step.value
  return HYGIENE_STEPS[HYGIENE_STEPS.length - 1].value
}

// Merge caller weights over the defaults. A missing, negative or non-finite
// weight falls back to the default; an explicit 0 drops the dimension. If
// everything ends up 0 the defaults are used, so the mean is always defined.
function resolveWeights(custom, defaults) {
  const out = {}
  for (const [k, def] of Object.entries(defaults)) {
    const w = custom?.[k]
    out[k] = Number.isFinite(w) && w >= 0 ? w : def
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0)
  return total > 0 ? out : { ...defaults }
}

/**
 * Want rollup (spec §2.2).
 *
 *   dims  { growth_mobility, optionality_exit, brand_value, role_content,
 *           best_cities, salary_adj_city, work_life_balance }
 *         — calibrated values (Brand / Growth already adjusted).
 *   opts  { weights, is_intern, dream }
 *         weights:   scoring.want_weights (partial OK, merged over defaults)
 *         is_intern: the salary term is 0 and salary can't veto (stipends
 *                    are not salaries)
 *         dream:     company ∈ calibration.dream_companies → floor at 8.0
 *
 * Order matters: raw → dream floor → vetoes. The vetoes win over the floor,
 * so a dream company with a poverty-level city or a quota-carrying role
 * still can't reach 8.
 *
 * Returns { score, raw, uncapped, motivators_mean, motivator_penalty,
 *           hygiene: { best_cities, salary_adj_city, work_life_balance },
 *           hygiene_total, floor, vetoes, weights }
 *   raw      = clamp(M − penalty + H, 1, 10)
 *   uncapped = after the floor, before the vetoes (explain-score uses it to
 *              tell whether a veto is what holds the verdict down)
 *   vetoes   = every veto whose condition fired: { kind, dimension, value,
 *              cap, applied } — applied=false when Want was already ≤ cap.
 */
export function rollupWant(dims, { weights, is_intern = false, dream = false } = {}) {
  const w = resolveWeights(weights, DEFAULT_WANT_WEIGHTS)
  let num = 0, den = 0, bottom = 0
  for (const k of MOTIVATOR_DIMS) {
    num += w[k] * dims[k]
    den += w[k]
    if (w[k] > 0 && dims[k] <= MOTIVATOR_BOTTOM_AT) bottom++
  }
  const M = num / den
  const penalty = bottom * MOTIVATOR_BOTTOM_PENALTY

  const hygiene = {
    best_cities:       hygieneTerm(dims.best_cities),
    salary_adj_city:   is_intern ? 0 : hygieneTerm(dims.salary_adj_city),
    work_life_balance: hygieneTerm(dims.work_life_balance),
  }
  const H = hygiene.best_cities + hygiene.salary_adj_city + hygiene.work_life_balance

  const raw = clamp(M - penalty + H, 1, 10)
  let want = raw

  let floor = null
  if (dream && want < DREAM_WANT_FLOOR) {
    floor = { source: 'dream-company Want floor', from: round2(want), to: DREAM_WANT_FLOOR }
    want = DREAM_WANT_FLOOR
  }
  const uncapped = want

  const vetoes = []
  for (const k of HYGIENE_DIMS) {
    if (k === 'salary_adj_city' && is_intern) continue
    if (dims[k] < HYGIENE_VETO_BELOW) {
      vetoes.push({ kind: 'hygiene_veto', dimension: k, value: dims[k], cap: HYGIENE_VETO_CAP, applied: want > HYGIENE_VETO_CAP })
      want = Math.min(want, HYGIENE_VETO_CAP)
    }
  }
  if (dims.role_content <= ROLE_CONTENT_VETO_AT) {
    vetoes.push({ kind: 'role_content_veto', dimension: 'role_content', value: dims.role_content, cap: ROLE_CONTENT_VETO_CAP, applied: want > ROLE_CONTENT_VETO_CAP })
    want = Math.min(want, ROLE_CONTENT_VETO_CAP)
  }

  return {
    score: round2(want),
    raw: round2(raw),
    uncapped: round2(uncapped),
    motivators_mean: round2(M),
    motivator_penalty: round2(penalty),
    hygiene,
    hygiene_total: round2(H),
    floor,
    vetoes,
    weights: w,
  }
}

/**
 * Ease rollup (spec §3.2): weighted geometric mean → experience wall →
 * amber penalty → clamp.
 *
 *   dims  { skills_match, experience_bar, competition } — competition already
 *         carries the referral bonus (calibration.applyReferralAdjustment).
 *   opts  { weights, amber_count }
 *
 * Returns { score, geometric, wall, unwalled, amber_penalty, weights }
 *   geometric = the weighted geometric mean before the wall and ambers
 *   wall      = true when experience_bar ≤ EXPERIENCE_WALL_AT
 *   unwalled  = Ease without the wall (explain-score uses it)
 */
export function rollupEase(dims, { weights, amber_count = 0 } = {}) {
  const w = resolveWeights(weights, DEFAULT_EASE_WEIGHTS)
  let num = 0, den = 0
  for (const k of EASE_DIMS) {
    // ln(x) needs x > 0; the rubric's floor is 1, so clamp there.
    num += w[k] * Math.log(clamp(dims[k], 1, 10))
    den += w[k]
  }
  const geo = Math.exp(num / den)
  const wall = dims.experience_bar <= EXPERIENCE_WALL_AT
  const walled = wall ? Math.min(geo, EXPERIENCE_WALL_CAP) : geo
  const ambers = Math.max(0, amber_count || 0)
  const amberPenalty = Math.min(AMBER_EASE_PENALTY * ambers, AMBER_EASE_PENALTY_MAX)
  return {
    score: round2(clamp(walled - amberPenalty, 1, 10)),
    geometric: round2(geo),
    wall,
    unwalled: round2(clamp(geo - amberPenalty, 1, 10)),
    amber_penalty: round2(amberPenalty),
    weights: w,
  }
}

const fmt = (n) => String(round2(n))
const fmtC = (n) => n.toFixed(1)

/**
 * Verdict grid (spec §4). `eligibility` is the evaluateEligibility() result
 * or just its status string. Red → blocked whatever the numbers (want/ease
 * are null then).
 *
 * Returns { verdict, tier, reason }.
 */
export function assignVerdict({ want, ease, eligibility }) {
  const status = typeof eligibility === 'string' ? eligibility : eligibility?.status
  if (status === 'red') {
    const red = typeof eligibility === 'object'
      ? (eligibility.checks ?? []).find(c => c.status === 'red')
      : null
    return {
      verdict: 'blocked',
      tier: VERDICT_TIERS.blocked,
      reason: red ? `Eligibility red (${red.check}): ${red.reason}` : 'Eligibility red',
    }
  }

  const row = want >= WANT_HIGH ? 'high' : want >= WANT_MID ? 'mid' : 'low'
  const col = ease >= EASE_HIGH ? 'high' : ease >= EASE_MID ? 'mid' : 'low'
  const GRID = {
    high: { high: 'go',    mid: 'stretch', low: 'growth' },
    mid:  { high: 'solid', mid: 'thin',    low: 'skip' },
    low:  { high: 'skip',  mid: 'skip',    low: 'skip' },
  }
  const verdict = GRID[row][col]

  const wantPart =
    row === 'high' ? `Want ${fmt(want)} ≥ ${fmtC(WANT_HIGH)}`
    : row === 'mid' ? `Want ${fmt(want)} in ${fmtC(WANT_MID)}–${fmtC(WANT_HIGH)}`
    : `Want ${fmt(want)} < ${fmtC(WANT_MID)}`
  const easePart =
    col === 'high' ? `Ease ${fmt(ease)} ≥ ${fmtC(EASE_HIGH)}`
    : col === 'mid' ? `Ease ${fmt(ease)} in ${fmtC(EASE_MID)}–${fmtC(EASE_HIGH)}`
    : `Ease ${fmt(ease)} < ${fmtC(EASE_MID)}`

  return { verdict, tier: VERDICT_TIERS[verdict], reason: `${wantPart}, ${easePart}` }
}

/** Position of a verdict in VERDICT_ORDER (higher = better; −1 if unknown). */
export function verdictRank(verdict) {
  return VERDICT_ORDER.indexOf(verdict)
}

/** Promotion hint (spec §4): READY for go, MONITOR for stretch / solid, '' otherwise. */
export function promotionHint(verdict) {
  if (verdict === 'go') return 'READY'
  if (verdict === 'stretch' || verdict === 'solid') return 'MONITOR'
  return ''
}

/**
 * Priority (spec §5): √(Want × Ease), 2 decimals. A sort key only, never a
 * headline score. Takes plain numbers or the rollup detail objects; null when
 * either side is missing (blocked listings).
 */
export function computePriority(want, ease) {
  const w = want != null && typeof want === 'object' ? want.score : want
  const e = ease != null && typeof ease === 'object' ? ease.score : ease
  if (w == null || e == null || !Number.isFinite(w) || !Number.isFinite(e)) return null
  return round2(Math.sqrt(w * e))
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
