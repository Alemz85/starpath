// targeting-core.mjs — pure targeting-intelligence math over score-history.tsv.
//
// The rejection-pattern analyzer (analyze-patterns.mjs) reasons about
// *outcomes* in data/applications.md (Applied → Rejected → Offer …). But that
// signal only exists AFTER the user has applied to things and heard back. Early
// in a search — which is most of the time — applications.md is nearly empty and
// the outcome funnel says nothing.
//
// What IS rich from day one is data/score-history.tsv: every scouting
// evaluation logs an archetype + the full 6-dimension fingerprint + an overall
// score. That landscape tells the user where they're consistently finding
// strong matches, which dimension keeps dragging scores down (a *targeting*
// blocker, distinct from an *outcome* blocker), and where evaluation effort is
// being spent on roles that score too low to ever be worth applying to.
//
// All functions here are pure (no I/O, no mutation, no globals) so they're
// trivially testable. The thin file/CLI wrapper lives in analyze-patterns.mjs.

/* ───── Archetype label normalization ──────────────────────────────────────
 *
 * The log accumulates spelling/spacing drift for the same archetype:
 *   "Business / Data Analyst" vs "Business/Data Analyst"
 *   "Tech Sales / Solutions Consultant" vs "Tech Sales"
 * Collapsing these is what makes per-archetype aggregates meaningful instead
 * of scattering one archetype across three near-duplicate buckets.
 */
export function normalizeArchetype(raw) {
  if (!raw) return 'Unknown'
  let s = String(raw).trim()
  if (!s) return 'Unknown'
  // Collapse whitespace and normalize separators (slash with optional spaces,
  // " + ", " & ") to a single canonical " / " so spacing variants merge.
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/\s*\/\s*/g, ' / ')
  return s
}

/* ───── Row parsing ─────────────────────────────────────────────────────────
 *
 * score-history.tsv is tab-separated with a header row. We parse defensively:
 * older rows suffer from a column-shift bug (the `tier` column sometimes holds
 * `short`/`growth`/`full`/`skip` from the `duration`/`mode` columns), so we
 * never trust positional `tier` — we recompute the band from `overall`.
 */
const HEADER_FALLBACK = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
]

/**
 * Parse the raw TSV text into row objects keyed by the header. Skips the
 * header line and any blank/short lines. Numeric dimension fields are coerced
 * to numbers (NaN when absent/garbage, so callers can filter).
 */
export function parseScoreHistory(tsvText) {
  if (!tsvText) return []
  const lines = tsvText.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return []

  // Detect & honor a header row; fall back to the canonical column order.
  const first = lines[0].split('\t')
  const hasHeader = first[0] === 'date' && first.includes('archetype')
  const header = hasHeader ? first : HEADER_FALLBACK
  const dataLines = hasHeader ? lines.slice(1) : lines

  const numericCols = new Set([
    'skills_match', 'ease_of_entry', 'strategic_fit', 'current_fit',
    'growth_mobility', 'optionality_exit', 'brand_value', 'sales_trap_risk',
    'aspirational_fit', 'overall', 'salary_adj_city', 'work_life_balance',
  ])

  const rows = []
  for (const line of dataLines) {
    const cells = line.split('\t')
    if (cells.length < 12) continue // too short to carry the score block
    const row = {}
    header.forEach((key, i) => {
      const val = cells[i] !== undefined ? cells[i].trim() : ''
      row[key] = numericCols.has(key) ? toNum(val) : val
    })
    row.archetype = normalizeArchetype(row.archetype)
    rows.push(row)
  }
  return rows
}

function toNum(v) {
  if (v === '' || v == null) return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/* ───── Score band (recomputed, never trusted from the polluted column) ─────
 *
 * A coarse band derived purely from `overall`, used to bucket the landscape:
 *   strong  ≥ 7.5   — worth prioritizing
 *   solid   7.0–7.49 — apply if pipeline is thin
 *   pass    6.0–6.99 — growth target / borderline
 *   weak    < 6.0    — likely wasted evaluation effort
 */
export function overallBand(overall) {
  if (!Number.isFinite(overall)) return 'unknown'
  if (overall >= 7.5) return 'strong'
  if (overall >= 7.0) return 'solid'
  if (overall >= 6.0) return 'pass'
  return 'weak'
}

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ───── The six Current/Aspirational Fit dimensions ───────────────────────── */
export const DIMENSIONS = [
  { key: 'skills_match', label: 'Skills Match' },
  { key: 'ease_of_entry', label: 'Ease of Entry' },
  { key: 'strategic_fit', label: 'Strategic Fit' },
  { key: 'growth_mobility', label: 'Growth / Mobility' },
  { key: 'optionality_exit', label: 'Optionality / Exit' },
  { key: 'brand_value', label: 'Brand Value' },
]

/* ───── Archetype performance ───────────────────────────────────────────────
 *
 * Per archetype: how many roles, the average/median Overall, and the band mix.
 * This answers "where is the landscape actually offering me strong matches?" —
 * the single most useful targeting question before any outcomes exist.
 */
export function archetypePerformance(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!Number.isFinite(r.overall)) continue
    if (!map.has(r.archetype)) {
      map.set(r.archetype, { archetype: r.archetype, overalls: [], bands: {} })
    }
    const e = map.get(r.archetype)
    e.overalls.push(r.overall)
    const b = overallBand(r.overall)
    e.bands[b] = (e.bands[b] || 0) + 1
  }
  const total = [...map.values()].reduce((a, e) => a + e.overalls.length, 0)
  return [...map.values()]
    .map(e => {
      const strong = (e.bands.strong || 0) + (e.bands.solid || 0)
      return {
        archetype: e.archetype,
        count: e.overalls.length,
        avgOverall: round2(mean(e.overalls)),
        medianOverall: round2(median(e.overalls)),
        maxOverall: round2(Math.max(...e.overalls)),
        // Share of THIS archetype's roles that land in strong/solid bands.
        strongRate: Math.round((strong / e.overalls.length) * 100),
        // Share of the whole evaluated landscape spent on this archetype.
        share: total ? Math.round((e.overalls.length / total) * 100) : 0,
        bands: e.bands,
      }
    })
    .sort((a, b) => b.avgOverall - a.avgOverall || b.count - a.count)
}

/* ───── Dimension drag ──────────────────────────────────────────────────────
 *
 * For each of the six dimensions, its average across the landscape. The
 * LOWEST-averaging dimensions are the systemic targeting blockers — the thing
 * that most consistently keeps Overall down across the roles the user evaluates.
 * A persistently low Ease of Entry, for example, says the user keeps evaluating
 * roles they're underqualified for; a low Skills Match says a stack/skill gap.
 */
export function dimensionDrag(rows) {
  const out = DIMENSIONS.map(({ key, label }) => {
    const vals = rows.map(r => r[key]).filter(Number.isFinite)
    return {
      key,
      label,
      avg: round2(mean(vals)),
      median: round2(median(vals)),
      count: vals.length,
      // How often this dim scores in the bottom range (≤ 4) — the share of
      // evaluations where it's an active drag rather than just below average.
      lowShare: vals.length
        ? Math.round((vals.filter(v => v <= 4).length / vals.length) * 100)
        : 0,
    }
  }).filter(d => d.count > 0)
  // Sort weakest first — the top of the list is what to fix in targeting.
  return out.sort((a, b) => a.avg - b.avg)
}

/* ───── Landscape band mix + wasted-effort estimate ─────────────────────── */
export function landscapeSummary(rows) {
  const overalls = rows.map(r => r.overall).filter(Number.isFinite)
  const bands = { strong: 0, solid: 0, pass: 0, weak: 0 }
  for (const o of overalls) bands[overallBand(o)]++
  const evaluated = overalls.length
  const weak = bands.weak
  return {
    evaluated,
    avgOverall: round2(mean(overalls)),
    medianOverall: round2(median(overalls)),
    bands,
    // Share of evaluation effort spent on roles too weak to be worth applying.
    wastedShare: evaluated ? Math.round((weak / evaluated) * 100) : 0,
  }
}

/**
 * Normalize a location token to a bare city: strip a trailing country code
 * ("Madrid ES" → "Madrid"), collapse whitespace, drop the "n/d" sentinel and
 * pure-remote markers (those aren't a city to weight sourcing toward).
 */
function normalizeCity(s) {
  if (!s) return ''
  let c = s.trim().replace(/\s+/g, ' ')
  if (/^n\/?d$/i.test(c) || /^remote/i.test(c)) return ''
  // Strip a trailing 2-letter uppercase country code: "Madrid ES" → "Madrid".
  c = c.replace(/\s+[A-Z]{2}$/, '')
  return c
}

/* ───── City exposure ───────────────────────────────────────────────────────
 *
 * Where the strong matches geographically cluster. Prefers the `location`
 * column (the actual posting city) and falls back to `best_cities`; we split
 * and tally only the cities attached to strong/solid roles, so the output
 * answers "which cities should I weight my sourcing toward?".
 */
/**
 * Reject tokens that aren't plausibly a city name. Guards against the
 * column-shift bug that leaks numeric scores ("10.0", "8") and the "n/d"
 * sentinel into best_cities, and against stray empties. A real city has at
 * least one letter and no leading digit.
 */
function isLikelyCity(s) {
  if (!s) return false
  const t = s.trim()
  if (t.length < 2) return false         // single-char fragment ("n", "d")
  if (/^n\/?d$/i.test(t)) return false
  if (/^[\d.\s]+$/.test(t)) return false // pure number / decimal
  if (!/[a-zA-Z]/.test(t)) return false  // must contain a letter
  if (/^\d/.test(t)) return false        // don't start with a digit
  return true
}

export function cityExposure(rows, { minBand = 'solid' } = {}) {
  const rank = { strong: 3, solid: 2, pass: 1, weak: 0, unknown: -1 }
  const floor = rank[minBand] ?? 2
  const counts = new Map()
  for (const r of rows) {
    if ((rank[overallBand(r.overall)] ?? -1) < floor) continue
    // location is the clean posting city; best_cities is a noisier fallback.
    const raw = (r.location && isLikelyCity(r.location)) ? r.location : (r.best_cities || '')
    // Reject the "n/d" sentinel before splitting — otherwise the "/" split
    // would shred it into bogus "n" and "d" tokens.
    if (/^n\s*\/?\s*d$/i.test(raw.trim())) continue
    for (const part of raw.split(/[;,/]| and /i)) {
      if (!isLikelyCity(part)) continue
      const city = normalizeCity(part)
      if (!city) continue
      counts.set(city, (counts.get(city) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count)
}

/* ───── Recommendations ─────────────────────────────────────────────────────
 *
 * Translate the aggregates into a few concrete targeting moves. Deliberately
 * conservative: only fires a recommendation when the underlying bucket has
 * enough rows to be more than noise (minRoles), so we don't tell the user to
 * "double down" on an archetype seen twice.
 */
export function targetingRecommendations(rows, { minRoles = 4 } = {}) {
  const recs = []
  const perf = archetypePerformance(rows)
  const drag = dimensionDrag(rows)
  const land = landscapeSummary(rows)

  // 1. Best archetype to lean into.
  const best = perf.filter(a => a.count >= minRoles)[0]
  if (best && best.avgOverall >= 7.0) {
    recs.push({
      action: `Lean into "${best.archetype}" — strongest landscape (avg ${best.avgOverall}, ${best.strongRate}% strong/solid across ${best.count} roles)`,
      reasoning: `This archetype consistently scores well, so sourcing more of it raises the average quality of what you evaluate.`,
      impact: 'high',
    })
  }

  // 2. Worst-performing archetype that's eating real effort.
  const worst = [...perf]
    .filter(a => a.count >= minRoles)
    .sort((a, b) => a.avgOverall - b.avgOverall)[0]
  if (worst && worst.avgOverall < 6.5 && worst.archetype !== best?.archetype) {
    recs.push({
      action: `Pull back on "${worst.archetype}" — weak landscape (avg ${worst.avgOverall} across ${worst.count} roles, ${worst.share}% of all evaluations)`,
      reasoning: `These roles rarely clear the apply bar, so the evaluation time is largely wasted. Narrow the scan keywords that surface them.`,
      impact: worst.share >= 15 ? 'high' : 'medium',
    })
  }

  // 3. Systemic dimension drag — the single weakest dimension.
  const weakestDim = drag[0]
  if (weakestDim && (weakestDim.avg < 6.0 || weakestDim.lowShare >= 25)) {
    const fixHint = {
      ease_of_entry: 'you keep evaluating roles you may be underqualified for — tighten seniority/keyword filters or invest in a credential',
      skills_match: 'a recurring skill/stack gap — either filter these roles out or close the gap',
      strategic_fit: 'these roles drift from your North Star — re-check your scan keywords against your target archetypes',
      brand_value: 'the companies surfacing are weak on brand — add stronger target companies to user/portals.yml',
      growth_mobility: 'these roles offer limited progression — weight sourcing toward higher-growth companies',
      optionality_exit: 'narrow exit optionality — favor roles/companies with broader downstream paths',
    }[weakestDim.key] || 'this dimension consistently drags your scores down'
    recs.push({
      action: `Address the "${weakestDim.label}" drag (avg ${weakestDim.avg}, low in ${weakestDim.lowShare}% of evals)`,
      reasoning: `${weakestDim.label} is the dimension most often holding your Overall down — ${fixHint}.`,
      impact: 'high',
    })
  }

  // 4. Wasted-effort warning.
  if (land.wastedShare >= 25) {
    recs.push({
      action: `${land.wastedShare}% of evaluations land below 6.0 (weak) — raise the bar before evaluating`,
      reasoning: `${land.bands.weak} of ${land.evaluated} evaluated roles are too weak to apply to. A pre-evaluation filter on scan results would reclaim that effort.`,
      impact: 'medium',
    })
  }

  return recs
}

/* ───── Top-level analysis object (consumed by the CLI/mode) ──────────────── */
export function analyzeScouting(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = rows.filter(r => Number.isFinite(r.overall))
  if (scored.length === 0) {
    return { error: 'No rows with a valid Overall score in score-history.tsv.' }
  }
  const dates = scored.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
    },
    landscape: landscapeSummary(scored),
    archetypePerformance: archetypePerformance(scored),
    dimensionDrag: dimensionDrag(scored),
    cityExposure: cityExposure(scored).slice(0, 12),
    recommendations: targetingRecommendations(scored, opts),
  }
}
