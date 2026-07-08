// comp-bench-core.mjs — pure compensation-benchmarking math over the user's own
// evaluated landscape (data/score-history.tsv + scouting Notes), benchmarked
// against the comp targets the user states in user/profile.yml.
//
// WHAT THIS IS (and is NOT)
// -------------------------
// `ofertas` / offer-compare.mjs compares 2+ *concrete live offers* the user
// holds. This module never sees an offer. It mines the *landscape the user has
// already evaluated* and answers a different, earlier question:
//
//   "For the roles I actually target — by archetype, by city — what does this
//    landscape pay, and is my stated target band above or below it?"
//
// THE DATA REALITY (why this is built the way it is)
// --------------------------------------------------
// Disclosed comp in the landscape is SPARSE. Of a typical score-history.tsv,
// only a handful of rows carry a parseable `salary_raw` ("€2,300/mo",
// "£42K + 10% bonus", "€2.2-3.3K/mo"); the vast majority are "n/d" or
// "undisclosed". So a benchmark built ONLY on disclosed numbers would speak
// from ~8 data points and mislead.
//
// But there IS a dense, canonical comp signal on EVERY scored row: the
// `salary_adj_city` dimension — the 1-10 *savings-power-after-cost-of-living*
// score the scouting engine already computes (see modes/_shared.md § Salary Adj
// for City). That is the comp axis the whole system is calibrated on. So the
// benchmark is built in two layers:
//
//   • PROXY layer (dense): the `salary_adj_city` distribution per archetype and
//     per city — where the landscape's comp competitiveness runs high vs low.
//     This is the trustworthy backbone because it exists for every role.
//   • ANCHOR layer (sparse): the few disclosed salaries, normalized to annual
//     EUR, as ground-truth checkpoints and as the only thing that can be
//     compared *directly in euros* to the user's stated target band.
//
// The two are kept distinct on purpose: the proxy tells the user where the
// comp pressure is; the anchors validate it in absolute money where they exist.
//
// All functions are PURE (no I/O, no mutation, no globals). The file/CLI
// wrapper lives in scripts/comp-bench.mjs. TSV parsing + archetype
// normalization + the savings band are reused from the existing single-sourced
// libs (targeting-core, score-bands) so comp semantics never drift.

// `salary_adj_city` rows are already the OUTPUT of score-bands' savingsToBaseScore
// (the scouting engine ran it at evaluation time), so the proxy backbone reads
// those scores directly rather than re-deriving them — no score-bands import is
// needed here, and comp semantics stay single-sourced to the original evaluation.
import { normalizeArchetype } from './targeting-core.mjs'

const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN)
const median = (arr) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAYER 1 — Salary string parsing  (annual gross EUR, with provenance)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The disclosed `salary_raw` field is free text written by the evaluating
 * agent. Observed forms (all real):
 *   "€750/mo", "€800/mo", "€1,600/mo", "€2,300/mo"        monthly stipend
 *   "€2.2-3.3K/mo"                                         monthly range, K-scaled
 *   "£42K + 10% bonus"                                     annual + bonus, GBP
 *   "£40-65K London disclosed"                             annual range, GBP, noise
 *   "undisclosed", "n/d", "competitive", "hourly (...)"    NOT parseable
 *
 * parseSalary turns a parseable form into { annualEur, ... provenance } and
 * returns null for anything it can't ground in a number. It NEVER guesses: an
 * undisclosed/competitive/hourly string yields null, not a fabricated figure.
 *
 * FX: there is no FX-rate constant anywhere in the repo, so the GBP→EUR rate is
 * an explicit, overridable parameter (default below) and any converted figure
 * is tagged { fxApplied: true } so the caller can flag it as approximate. We do
 * NOT convert USD here — no USD disclosures appear in the landscape, and silent
 * USD→EUR would be a hidden assumption; a "$" string returns null + a reason.
 */

// Default GBP→EUR. Deliberately a single, named, overridable constant — pass
// `{ gbpToEur }` to re-peg it at call time rather than trusting this forever.
export const DEFAULT_GBP_TO_EUR = 1.17

// Months used to annualize a monthly stipend/salary. Intern stipends in the
// landscape are quoted per month; 12× is the honest annualization (we do NOT
// assume 13th/14th here — that lives in the full offer build-up, not in a
// back-of-envelope landscape benchmark).
const MONTHS_PER_YEAR = 12

/**
 * Parse one disclosed-salary string to annual gross EUR with provenance.
 *
 * @param {string} raw                 the salary_raw cell (or a Notes-extracted string)
 * @param {object} [opts]
 * @param {number} [opts.gbpToEur]     GBP→EUR rate (default DEFAULT_GBP_TO_EUR)
 * @returns {null | {
 *   annualEur: number,        // best point estimate (midpoint of a range)
 *   annualEurLow: number,     // low end (== annualEur if not a range)
 *   annualEurHigh: number,    // high end (== annualEur if not a range)
 *   currency: 'EUR'|'GBP',    // source currency
 *   period: 'year'|'month',   // source period
 *   isRange: boolean,
 *   bonusPct: number|null,    // disclosed bonus %, if any (e.g. 0.10)
 *   fxApplied: boolean,       // true if a non-EUR currency was converted
 *   source: string,           // the trimmed source string
 * }}
 */
export function parseSalary(raw, { gbpToEur = DEFAULT_GBP_TO_EUR } = {}) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null

  // Fast reject: explicit non-disclosures and forms we refuse to guess at.
  // "competitive", "undisclosed (...)", "not disclosed", "hourly (...)", "n/d".
  if (/^n\/?d$/i.test(s)) return null
  if (/undisclosed|not disclosed|competitive/i.test(s)) return null
  // Hourly/per-hour rates can't be annualized without hours/week. The literal
  // word "hourly" was too narrow — "€25/hour", "€16/hr", "€16 per hour" all fell
  // through and were parsed as ANNUAL, poisoning the medians. Reject any of them.
  if (/\bhour(ly)?\b|\/\s*hr?\b|\bper\s+hour\b/i.test(s)) return null
  if (/\$|usd/i.test(s)) return null // see header: no silent USD→EUR
  // Nordic krone (DKK/SEK/NOK, "kr", "kr.") — same fail-closed stance as USD:
  // refuse explicitly rather than letting it drop through the no-currency path,
  // and never silently convert krone→EUR.
  if (/\bdkk\b|\bnok\b|\bsek\b|\bkr\b|kr\./i.test(s)) return null

  // Currency: € / EUR  vs  £ / GBP. If neither symbol appears, we can't trust
  // the unit, so bail (avoids reading a bare "40-65" as euros).
  let currency
  if (/€|eur/i.test(s)) currency = 'EUR'
  else if (/£|gbp/i.test(s)) currency = 'GBP'
  else return null

  // Period: monthly if "/mo", "/month", "per month", "pcm"; else annual. Annual
  // is the default for K-scaled figures (£42K) which are virtually always yearly.
  const period = /\/\s*mo|\/\s*month|per month|p\s*\/?\s*m\b|pcm/i.test(s) ? 'month' : 'year'

  // Bonus %, if disclosed ("+ 10% bonus" / "10% bonus").
  const bonusMatch = s.match(/(\d+(?:\.\d+)?)\s*%\s*(?:target\s*)?bonus/i)
  const bonusPct = bonusMatch ? round2(Number(bonusMatch[1]) / 100) : null

  // Strip the bonus clause BEFORE pulling base numbers, so "42K + 10%" doesn't
  // read 10 as a salary figure.
  const base = bonusMatch ? s.slice(0, bonusMatch.index) : s

  // Pull the numeric figure(s). Each may carry a trailing K/k multiplier
  // ("2.2", "3.3K", "42K", "65"). We capture number + optional K per token.
  const numTokens = [...base.matchAll(/(\d+(?:[.,]\d+)?)\s*([kK])?/g)]
    .map((m) => {
      const n = Number(m[1].replace(/,/g, ''))
      if (!Number.isFinite(n)) return null
      return m[2] ? n * 1000 : n
    })
    .filter((n) => n != null && n > 0)

  if (numTokens.length === 0) return null

  // A range like "2.2-3.3K/mo" or "40-65K": the K on the SECOND token scales
  // both ends ("2.2-3.3K" = 2200–3300). Detect: a dash between two numbers and
  // the low end is implausibly small for the high end's magnitude.
  let low, high
  const rangeLike = /\d\s*[-–]\s*\d/.test(base) && numTokens.length >= 2
  if (rangeLike) {
    low = numTokens[0]
    high = numTokens[1]
    // Trailing-K-scales-both heuristic: "2.2-3.3K" parses low=2.2, high=3300.
    // If low is < 5% of high, the low end almost certainly shares the K scale.
    if (low < high * 0.05) low *= 1000
    if (low > high) [low, high] = [high, low]
  } else {
    low = high = numTokens[0]
  }

  // Annualize monthly figures.
  if (period === 'month') {
    low *= MONTHS_PER_YEAR
    high *= MONTHS_PER_YEAR
  }

  // FX → EUR.
  const fxApplied = currency === 'GBP'
  if (fxApplied) {
    low *= gbpToEur
    high *= gbpToEur
  }

  const annualEurLow = Math.round(low)
  const annualEurHigh = Math.round(high)
  return {
    annualEur: Math.round((annualEurLow + annualEurHigh) / 2),
    annualEurLow,
    annualEurHigh,
    currency,
    period,
    isRange: annualEurLow !== annualEurHigh,
    bonusPct,
    fxApplied,
    source: s,
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAYER 1b — Parse the user's stated comp target from profile.yml values
 * ════════════════════════════════════════════════════════════════════════════
 *
 * profile.yml § compensation holds strings — illustratively (fictional band):
 *   target_range: "€30K-55K"   minimum: "€15K"   currency: "EUR"
 * The CLI reads those raw strings and hands them here. We do NOT hardcode any
 * particular band — whatever the user wrote flows through.
 */

/** Parse a single "€30K" / "30K" / "€30,000" token → number (annual EUR). */
function parseMoneyToken(tok, gbpToEur) {
  if (tok == null) return NaN
  const s = String(tok).trim()
  if (!s) return NaN
  const isGbp = /£|gbp/i.test(s)
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*([kK])?/)
  if (!m) return NaN
  let n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return NaN
  if (m[2]) n *= 1000
  if (isGbp) n *= gbpToEur
  return Math.round(n)
}

/**
 * Parse the compensation block's strings into a normalized target.
 *
 * @param {object} comp  e.g. { target_range: "€30K-55K", minimum: "€15K" }
 * @param {object} [opts] { gbpToEur }
 * @returns {{
 *   targetLow: number|null, targetHigh: number|null, floor: number|null,
 *   raw: object
 * }}  all figures annual EUR; nulls where the field was absent/unparseable.
 */
export function parseCompTarget(comp = {}, { gbpToEur = DEFAULT_GBP_TO_EUR } = {}) {
  const out = { targetLow: null, targetHigh: null, floor: null, raw: { ...comp } }
  const rangeStr = comp.target_range ?? comp.targetRange ?? null
  if (rangeStr) {
    const parts = String(rangeStr).split(/[-–]/)
    const lo = parseMoneyToken(parts[0], gbpToEur)
    const hi = parseMoneyToken(parts[1] ?? parts[0], gbpToEur)
    if (Number.isFinite(lo)) out.targetLow = lo
    if (Number.isFinite(hi)) out.targetHigh = hi
    if (out.targetLow != null && out.targetHigh != null && out.targetLow > out.targetHigh) {
      [out.targetLow, out.targetHigh] = [out.targetHigh, out.targetLow]
    }
  }
  const minStr = comp.minimum ?? comp.floor ?? null
  if (minStr) {
    const f = parseMoneyToken(minStr, gbpToEur)
    if (Number.isFinite(f)) out.floor = f
  }
  return out
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAYER 2 — Enrich rows: attach a parsed disclosed-salary + a clean city
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Normalize a location token to a bare city. Mirrors targeting-core's intent:
 * strip a trailing country code, drop "n/d"/remote, collapse a multi-hub blob
 * to its first city. Kept local (not exported there) so this stays self-contained.
 */
export function cleanCity(raw) {
  if (!raw) return ''
  let c = String(raw).trim().replace(/\s+/g, ' ')
  if (/^n\/?d$/i.test(c)) return ''
  if (/^remote/i.test(c)) return ''
  // "Multi-hub (London/Madrid/...)" → first named city.
  const paren = c.match(/\(([^)]+)\)/)
  if (/multi[- ]?hub|multiple|various/i.test(c) && paren) c = paren[1]
  // First city of a slash/comma list.
  c = c.split(/[;,/]| and /i)[0].trim()
  // Strip trailing 2-letter uppercase country code: "Madrid ES" → "Madrid".
  c = c.replace(/\s+[A-Z]{2}$/, '')
  // Guard the column-shift bug targeting-core warns about: best_cities can leak
  // a bare numeric score ("6", "10.0") when columns shift. Reject tokens with no
  // letter or a leading digit so a stray "6" never becomes a "city".
  if (!/[a-zA-Z]/.test(c) || /^\d/.test(c)) return ''
  return c
}

/**
 * Attach `disclosed` (parseSalary result or null) and `city` to each scored row.
 * Rows without a finite `salary_adj_city` are kept (the proxy filter happens in
 * the aggregators) but rows are expected to come pre-filtered to scored ones.
 */
export function enrichRows(rows, opts = {}) {
  return rows.map((r) => ({
    ...r,
    disclosed: parseSalary(r.salary_raw, opts),
    city: cleanCity(r.location) || cleanCity(r.best_cities),
  }))
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAYER 2 — Group benchmarks (the dense proxy backbone)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * For a set of enriched rows grouped by a key (archetype or city), summarize:
 *   • the salary_adj_city distribution (n, mean, median, low-share) — the PROXY
 *   • the disclosed anchors that exist in the group (count + annual-EUR median)
 * The proxy is the trustworthy part; anchors are surfaced when present.
 */

// salary_adj_city ≤ this is a "comp-weak" role (savings-power floor). Matches
// the score-bands Overall modifier threshold (Salary Adj ≤ 4 → −0.4), so
// "comp-weak" here means exactly what the scoring engine penalizes.
const COMP_WEAK_ADJ = 4
// salary_adj_city ≥ this is a "comp-strong" role (the +0.2 Overall bonus band).
const COMP_STRONG_ADJ = 9

function summarizeGroup(label, rows) {
  const adj = rows.map((r) => r.salary_adj_city).filter(Number.isFinite)
  const anchors = rows.map((r) => r.disclosed).filter(Boolean)
  const anchorEur = anchors.map((d) => d.annualEur).filter(Number.isFinite)
  return {
    label,
    count: rows.length,
    // PROXY: savings-power distribution.
    adjN: adj.length,
    adjMean: adj.length ? round2(mean(adj)) : null,
    adjMedian: adj.length ? round1(median(adj)) : null,
    compWeakShare: adj.length
      ? Math.round((adj.filter((v) => v <= COMP_WEAK_ADJ).length / adj.length) * 100)
      : 0,
    compStrongShare: adj.length
      ? Math.round((adj.filter((v) => v >= COMP_STRONG_ADJ).length / adj.length) * 100)
      : 0,
    // ANCHORS: disclosed annual EUR, when any exist in the group.
    anchorCount: anchorEur.length,
    anchorMedianEur: anchorEur.length ? Math.round(median(anchorEur)) : null,
    anchorMinEur: anchorEur.length ? Math.min(...anchorEur) : null,
    anchorMaxEur: anchorEur.length ? Math.max(...anchorEur) : null,
  }
}

/**
 * Benchmark the salary_adj proxy + disclosed anchors per archetype.
 * @param {Array} rows enriched, scored rows
 * @param {object} [opts] { minRoles = 3 }  groups smaller than this are dropped
 *   from the ranked output (too few to be more than noise) but still counted.
 */
export function benchmarkByArchetype(rows, { minRoles = 3 } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const a = normalizeArchetype(r.archetype)
    if (!groups.has(a)) groups.set(a, [])
    groups.get(a).push(r)
  }
  return [...groups.entries()]
    .map(([a, rs]) => summarizeGroup(a, rs))
    .filter((g) => g.count >= minRoles && g.adjN > 0)
    // Best comp competitiveness first (highest median savings-power).
    .sort((a, b) => (b.adjMedian ?? 0) - (a.adjMedian ?? 0) || b.count - a.count)
}

/**
 * Benchmark the salary_adj proxy + disclosed anchors per city.
 * @param {object} [opts] { minRoles = 3 }
 */
export function benchmarkByCity(rows, { minRoles = 3 } = {}) {
  const groups = new Map()
  for (const r of rows) {
    const c = r.city
    if (!c) continue
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c).push(r)
  }
  return [...groups.entries()]
    .map(([c, rs]) => summarizeGroup(c, rs))
    .filter((g) => g.count >= minRoles && g.adjN > 0)
    .sort((a, b) => (b.adjMedian ?? 0) - (a.adjMedian ?? 0) || b.count - a.count)
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAYER 3 — Target-vs-landscape drift  (the headline finding)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The honest comparison the user wants: "is my stated target band realistic for
 * what this landscape actually pays?" We answer it on the only euros we have —
 * the disclosed ANCHORS — split by employment type, because comparing an
 * intern-stipend landscape to a full-time target band would be nonsense.
 *
 * Why split intern vs full-time: a target_range that spans both intern and
 * entry-level full-time (as a profile.yml band often does) mixes them. Intern
 * stipends annualize far below the FT floor by
 * design, so we benchmark FT anchors against the band's UPPER reach and report
 * intern anchors separately rather than letting €9K stipends drag the median
 * "below target".
 */

/** Bucket a row's employment type into 'intern' | 'fulltime' | 'other'. */
export function employmentBucket(raw) {
  const s = String(raw || '').toLowerCase()
  if (/intern|working[- ]?student|trainee|stage|placement|curricular/.test(s)) return 'intern'
  if (/full|permanent|graduate|contract/.test(s)) return 'fulltime'
  return 'other'
}

/**
 * Compare disclosed anchors against the parsed target.
 *
 * @param {Array} rows    enriched, scored rows
 * @param {object} target parseCompTarget() result
 * @returns {{
 *   target, anchorsTotal, byType: { fulltime, intern, other },
 *   drift: { verdict, deltaEur, basis, note } | null
 * }}
 *   `drift` is null when there aren't enough FT anchors to say anything honest.
 */
export function targetDrift(rows, target) {
  const buckets = { fulltime: [], intern: [], other: [] }
  for (const r of rows) {
    if (!r.disclosed) continue
    buckets[employmentBucket(r.employment_type)].push(r.disclosed.annualEur)
  }
  const summarize = (eurs) => eurs.length
    ? {
        count: eurs.length,
        medianEur: Math.round(median(eurs)),
        minEur: Math.min(...eurs),
        maxEur: Math.max(...eurs),
      }
    : { count: 0, medianEur: null, minEur: null, maxEur: null }

  const byType = {
    fulltime: summarize(buckets.fulltime),
    intern: summarize(buckets.intern),
    other: summarize(buckets.other),
  }
  const anchorsTotal = buckets.fulltime.length + buckets.intern.length + buckets.other.length

  // Drift verdict rests on FULL-TIME anchors vs the target band — the
  // apples-to-apples comparison. Need at least MIN_FT_ANCHORS or we say nothing.
  const MIN_FT_ANCHORS = 2
  let drift = null
  const ft = byType.fulltime
  if (ft.count >= MIN_FT_ANCHORS && (target.targetLow != null || target.targetHigh != null)) {
    const landscapeMid = ft.medianEur
    // Compare against the target band: below low → "above market" (your floor
    // exceeds what's disclosed); above high → "below market" (you're underasking).
    const lo = target.targetLow
    const hi = target.targetHigh
    let verdict, deltaEur, note
    if (lo != null && landscapeMid < lo) {
      verdict = 'target-above-landscape'
      deltaEur = lo - landscapeMid
      note = `Your target floor (€${fmtK(lo)}) sits €${fmtK(deltaEur)} above the median disclosed full-time comp in your evaluated landscape (€${fmtK(landscapeMid)}). Either you're targeting a tier the roles you evaluate don't pay, or the disclosed sample skews low — widen sourcing toward higher-band companies or revisit the floor.`
    } else if (hi != null && landscapeMid > hi) {
      verdict = 'target-below-landscape'
      deltaEur = landscapeMid - hi
      note = `The median disclosed full-time comp in your landscape (€${fmtK(landscapeMid)}) sits €${fmtK(deltaEur)} above your target ceiling (€${fmtK(hi)}). You may be under-asking — the roles you evaluate disclose more than your stated upper bound.`
    } else {
      verdict = 'aligned'
      deltaEur = 0
      note = `Your target band (€${fmtK(lo)}–${fmtK(hi)}) brackets the median disclosed full-time comp in your landscape (€${fmtK(landscapeMid)}). No drift — your expectations match what these roles actually pay.`
    }
    drift = {
      verdict,
      deltaEur,
      basis: `${ft.count} disclosed full-time salar${ft.count === 1 ? 'y' : 'ies'} (median €${fmtK(landscapeMid)})`,
      note,
    }
  }

  return { target, anchorsTotal, byType, drift }
}

/** Format an annual EUR figure compactly: 42000 → "42K", 9500 → "9.5K". */
export function fmtK(eur) {
  if (eur == null || !Number.isFinite(eur)) return '—'
  const k = eur / 1000
  const r = Math.round(k * 10) / 10
  return `${r}K`
}

/* ════════════════════════════════════════════════════════════════════════════
 * Floor-risk scan — roles whose comp would actively penalize their Overall
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The savings-power proxy connects straight to the scoring engine: a role with
 * salary_adj_city ≤ 4 takes a −0.4 Overall hit (non-intern). So a NON-intern
 * role evaluated with adj ≤ 4 is one where comp is dragging the score — worth
 * surfacing distinctly from interns (whose stipends are break-even by design and
 * exempt from the modifier).
 */
export function compFloorRisks(rows, { adjFloor = COMP_WEAK_ADJ, limit = 12 } = {}) {
  return rows
    .filter((r) => Number.isFinite(r.salary_adj_city) && r.salary_adj_city <= adjFloor)
    .filter((r) => employmentBucket(r.employment_type) !== 'intern')
    .map((r) => ({
      company: r.company,
      role: r.role,
      archetype: normalizeArchetype(r.archetype),
      city: r.city,
      salaryAdj: r.salary_adj_city,
      overall: Number.isFinite(r.overall) ? r.overall : null,
      disclosedEur: r.disclosed ? r.disclosed.annualEur : null,
    }))
    .sort((a, b) => a.salaryAdj - b.salaryAdj || (a.overall ?? 99) - (b.overall ?? 99))
    .slice(0, limit)
}

/* ════════════════════════════════════════════════════════════════════════════
 * Recommendations — translate the benchmark into concrete comp moves
 * ════════════════════════════════════════════════════════════════════════════ */

export function compRecommendations({ archetypes, cities, drift, floorRisks }) {
  const recs = []

  // 1. The headline drift finding, if we could compute one.
  if (drift?.drift) {
    const d = drift.drift
    if (d.verdict === 'target-above-landscape') {
      recs.push({
        action: `Reconcile your comp floor with the landscape — target floor is €${fmtK(drift.target.targetLow)} but disclosed FT median is €${fmtK(drift.byType.fulltime.medianEur)}`,
        reasoning: d.note,
        impact: 'high',
      })
    } else if (d.verdict === 'target-below-landscape') {
      recs.push({
        action: `You may be under-asking — disclosed FT median (€${fmtK(drift.byType.fulltime.medianEur)}) exceeds your target ceiling (€${fmtK(drift.target.targetHigh)})`,
        reasoning: d.note,
        impact: 'high',
      })
    } else {
      recs.push({
        action: `Comp expectations are calibrated — target band brackets the disclosed FT median`,
        reasoning: d.note,
        impact: 'low',
      })
    }
  }

  // 2. Highest- and lowest-comp archetype (proxy), when we have ranked groups.
  if (archetypes.length >= 2) {
    const top = archetypes[0]
    const bottom = archetypes[archetypes.length - 1]
    if (top.adjMedian != null && bottom.adjMedian != null && top.adjMedian - bottom.adjMedian >= 1.5) {
      recs.push({
        action: `Comp competitiveness varies by archetype — "${top.label}" runs strongest (median savings-power ${top.adjMedian}/10), "${bottom.label}" weakest (${bottom.adjMedian}/10)`,
        reasoning: `If comp is a priority, weight sourcing toward "${top.label}" roles; "${bottom.label}" roles in your landscape more often score in the comp-weak band (${bottom.compWeakShare}% at savings-power ≤ ${COMP_WEAK_ADJ}).`,
        impact: 'medium',
      })
    }
  }

  // 3. Best-comp cities (proxy) — where savings-power clusters high.
  const strongCities = cities.filter((c) => c.adjMedian != null && c.adjMedian >= 7).slice(0, 3)
  if (strongCities.length) {
    recs.push({
      action: `Best savings-power cities in your landscape: ${strongCities.map((c) => `${c.label} (${c.adjMedian}/10)`).join(', ')}`,
      reasoning: `These cities pair the roles you evaluate with the strongest after-cost-of-living savings. If comp/savings is a priority, they deserve sourcing weight.`,
      impact: 'medium',
    })
  }

  // 4. Comp-floor drag — non-intern roles whose comp actively penalizes Overall.
  if (floorRisks.length >= 3) {
    recs.push({
      action: `${floorRisks.length} non-intern role${floorRisks.length === 1 ? '' : 's'} you evaluated score in the comp-weak band (savings-power ≤ ${COMP_WEAK_ADJ}) — each takes a −0.4 Overall penalty`,
      reasoning: `These roles' comp is actively dragging their score. Either they're in expensive cities relative to pay, or genuinely low-paying. Filter them earlier or weight toward the stronger-comp cities/archetypes above.`,
      impact: 'medium',
    })
  }

  // 5. Thin-disclosure caveat — keep the user honest about the sample.
  if ((drift?.anchorsTotal ?? 0) < 5) {
    recs.push({
      action: `Disclosed-comp sample is thin (${drift?.anchorsTotal ?? 0} parseable salaries) — the savings-power proxy is the trustworthy signal here`,
      reasoning: `Most roles you evaluate don't disclose pay. The salary-adjusted (savings-power) benchmark above covers every scored role and is the reliable read; the euro figures are anchors, not a full picture. Capturing comp in more evaluations (Levels.fyi, Glassdoor, the JD) would sharpen this.`,
      impact: 'low',
    })
  }

  return recs
}

/* ════════════════════════════════════════════════════════════════════════════
 * Top-level bundle — everything the comp-bench mode reads off
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * @param {Array}  scoredRows  rows from parseScoreHistory, filtered to finite overall
 * @param {object} comp        the profile.yml compensation block (raw strings)
 * @param {object} [opts]      { minRoles = 3, gbpToEur = DEFAULT_GBP_TO_EUR }
 */
export function benchmarkComp(scoredRows, comp = {}, opts = {}) {
  const { minRoles = 3, gbpToEur = DEFAULT_GBP_TO_EUR } = opts
  if (!scoredRows || scoredRows.length === 0) {
    return { error: 'No scored evaluations found in score-history.tsv. Evaluate some roles first (scouting), then re-run.' }
  }

  const enriched = enrichRows(scoredRows, { gbpToEur })
  const target = parseCompTarget(comp, { gbpToEur })
  const archetypes = benchmarkByArchetype(enriched, { minRoles })
  const cities = benchmarkByCity(enriched, { minRoles })
  const drift = targetDrift(enriched, target)
  const floorRisks = compFloorRisks(enriched)

  const allAdj = enriched.map((r) => r.salary_adj_city).filter(Number.isFinite)
  const landscapeAdjMedian = allAdj.length ? round1(median(allAdj)) : null
  const landscapeAdjMean = allAdj.length ? round2(mean(allAdj)) : null

  const recommendations = compRecommendations({ archetypes, cities, drift, floorRisks })

  const dates = enriched.map((r) => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: enriched.length,
      withSalaryAdj: allAdj.length,
      disclosedAnchors: drift.anchorsTotal,
      minRoles,
      gbpToEur,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
    },
    landscape: {
      adjMedian: landscapeAdjMedian,
      adjMean: landscapeAdjMean,
    },
    target,
    drift,
    byArchetype: archetypes,
    byCity: cities,
    floorRisks,
    recommendations,
  }
}
