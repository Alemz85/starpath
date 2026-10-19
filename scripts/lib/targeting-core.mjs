// targeting-core.mjs — pure targeting-intelligence math over score-history.tsv.
//
// The rejection-pattern analyzer (analyze-patterns.mjs) reasons about
// *outcomes* in data/applications.md (Applied → Rejected → Offer …). But that
// signal only exists AFTER the user has applied to things and heard back. Early
// in a search — which is most of the time — applications.md is nearly empty and
// the outcome funnel says nothing.
//
// What IS rich from day one is data/score-history.tsv: every scouting
// evaluation logs an archetype, the eligibility gate result, the ten v2
// dimensions, Want, Ease, Priority and the verdict (docs/scoring-v2.md §8.1).
// That landscape tells the user where they're consistently finding actionable
// matches (verdict go / stretch / solid), which dimension keeps dragging scores
// down (a *targeting* blocker, distinct from an *outcome* blocker), which
// eligibility check keeps blocking listings, and where evaluation effort is
// being spent on roles that land in `skip`.
//
// Blocked rows (eligibility red) carry empty score cells. They are excluded
// from every score aggregate here (never read as 0) and counted only in the
// eligibility breakdown.
//
// All functions here are pure (no I/O, no mutation, no globals) so they're
// trivially testable. The thin file/CLI wrapper lives in analyze-patterns.mjs.

import { SCORE_HISTORY_HEADER } from './profile-core.mjs'
import {
  assignVerdict, computePriority, VERDICT_ORDER, VERDICT_TIERS,
  MOTIVATOR_DIMS, HYGIENE_DIMS, EASE_DIMS,
} from './score-bands.mjs'
import { DIM_LABELS } from './explain-score.mjs'

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
 * score-history.tsv is tab-separated with a v2 header row (spec §8.1). We parse
 * by header name. Empty numeric cells (Blocked rows) become NaN so callers can
 * filter; they are never coerced to 0.
 */

const HEADER_FALLBACK = SCORE_HISTORY_HEADER.split('\t')

/** The numeric score-history columns (spec §8.1). */
export const NUMERIC_COLUMNS = Object.freeze([
  ...EASE_DIMS, 'ease', ...MOTIVATOR_DIMS, ...HYGIENE_DIMS, 'want', 'priority',
])

/** Verdicts that count as "worth applying to" for share metrics. */
export const ACTIONABLE_VERDICTS = Object.freeze(['go', 'stretch', 'solid'])

/**
 * Parse an `eligibility_flags` cell (`check:status:reason` joined by `;`)
 * into [{ check, status, reason }]. The reason may itself contain colons.
 */
export function parseEligibilityFlags(cell) {
  const out = []
  for (const part of String(cell ?? '').split(';')) {
    const t = part.trim()
    if (!t) continue
    const i = t.indexOf(':')
    const j = i >= 0 ? t.indexOf(':', i + 1) : -1
    if (i < 0) { out.push({ check: t, status: 'unknown', reason: '' }); continue }
    const check = t.slice(0, i).trim()
    const status = (j < 0 ? t.slice(i + 1) : t.slice(i + 1, j)).trim().toLowerCase()
    const reason = j < 0 ? '' : t.slice(j + 1).trim()
    out.push({ check, status, reason })
  }
  return out
}

/**
 * Parse the raw TSV text into row objects keyed by the header. Skips the
 * header line and blank lines. Numeric columns are numbers (NaN when empty).
 * Adds:
 *   eligibility       'green' | 'amber' | 'red' | '' (lower-cased)
 *   eligibilityFlags  parsed eligibility_flags
 *   verdict           the stored verdict, or derived from want/ease/eligibility
 *                     through assignVerdict when the cell is empty
 *   tier              stored, else from the verdict
 *   priority          stored, else √(want·ease) when both are finite
 *   blocked           true for eligibility red / verdict blocked
 */
export function parseScoreHistory(tsvText) {
  if (!tsvText) return []
  const lines = tsvText.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return []

  const first = lines[0].split('\t').map(c => c.trim())
  const hasHeader = first[0] === 'date' && first.includes('archetype')
  const header = hasHeader ? first : HEADER_FALLBACK
  const dataLines = hasHeader ? lines.slice(1) : lines
  const numericCols = new Set(NUMERIC_COLUMNS)

  const rows = []
  for (const line of dataLines) {
    const cells = line.split('\t')
    if (cells.length < 3) continue
    const row = {}
    header.forEach((key, i) => {
      const val = cells[i] !== undefined ? cells[i].trim() : ''
      row[key] = numericCols.has(key) ? toNum(val) : val
    })
    row.archetype = normalizeArchetype(row.archetype)
    row.eligibility = String(row.eligibility ?? '').toLowerCase()
    row.eligibilityFlags = parseEligibilityFlags(row.eligibility_flags)
    row.verdict = String(row.verdict ?? '').trim().toLowerCase()
    if (!VERDICT_ORDER.includes(row.verdict)) {
      if (row.eligibility === 'red') row.verdict = 'blocked'
      else if (Number.isFinite(row.want) && Number.isFinite(row.ease)) {
        row.verdict = assignVerdict({ want: row.want, ease: row.ease, eligibility: row.eligibility || 'green' }).verdict
      } else row.verdict = ''
    }
    row.blocked = row.verdict === 'blocked' || row.eligibility === 'red'
    if (row.blocked) {
      // Spec §8.1: a Blocked row has no scores, whatever the cells hold.
      row.want = NaN; row.ease = NaN; row.priority = NaN
    } else if (!Number.isFinite(row.priority)) {
      const p = computePriority(row.want, row.ease)
      row.priority = p == null ? NaN : p
    }
    if (!/^T[1-4]$/.test(row.tier ?? '') && row.verdict) row.tier = VERDICT_TIERS[row.verdict] ?? row.tier
    rows.push(row)
  }
  return rows
}

function toNum(v) {
  if (v === '' || v == null) return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** True when the row is Blocked (eligibility red). */
export function isBlocked(row) {
  return row?.blocked === true || row?.verdict === 'blocked' || row?.eligibility === 'red'
}

/** True when the row carries a finite Want and Ease (and isn't Blocked). */
export function isScored(row) {
  return !isBlocked(row) && Number.isFinite(row?.want) && Number.isFinite(row?.ease)
}

/** The rows score analytics may use: non-blocked, finite Want and Ease. */
export function scoredRows(rows) {
  return (rows || []).filter(isScored)
}

/** True for go / stretch / solid. */
export function isActionable(verdict) {
  return ACTIONABLE_VERDICTS.includes(verdict)
}

const round2 = (n) => Math.round(n * 100) / 100
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const median = (arr) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)

/** Zeroed verdict tally for scored rows (blocked is counted separately). */
function emptyVerdicts() {
  return { go: 0, stretch: 0, solid: 0, thin: 0, growth: 0, skip: 0 }
}

/* ───── The ten v2 dimensions ────────────────────────────────────────────── */
// group: 'motivator' | 'hygiene' (both feed Want) | 'ease'.
export const DIMENSIONS = Object.freeze([
  ...MOTIVATOR_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'motivator', rollup: 'want' })),
  ...HYGIENE_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'hygiene', rollup: 'want' })),
  ...EASE_DIMS.map(key => ({ key, label: DIM_LABELS[key], group: 'ease', rollup: 'ease' })),
].map(Object.freeze))

/* ───── Archetype performance ───────────────────────────────────────────────
 *
 * Per archetype: how many scored roles, average/median Want and Ease, the
 * verdict mix and the actionable rate. This answers "where is the landscape
 * actually offering me matches worth applying to?". Blocked rows are counted
 * per archetype as `blocked` but never enter the score aggregates.
 */
export function archetypePerformance(rows) {
  const map = new Map()
  const get = (a) => {
    if (!map.has(a)) map.set(a, { archetype: a, wants: [], eases: [], prios: [], verdicts: emptyVerdicts(), blocked: 0 })
    return map.get(a)
  }
  for (const r of rows) {
    if (isBlocked(r)) { get(r.archetype).blocked++; continue }
    if (!isScored(r)) continue
    const e = get(r.archetype)
    e.wants.push(r.want)
    e.eases.push(r.ease)
    if (Number.isFinite(r.priority)) e.prios.push(r.priority)
    if (r.verdict in e.verdicts) e.verdicts[r.verdict]++
  }
  const total = [...map.values()].reduce((a, e) => a + e.wants.length, 0)
  return [...map.values()]
    .filter(e => e.wants.length > 0)
    .map(e => {
      const n = e.wants.length
      const actionable = ACTIONABLE_VERDICTS.reduce((a, v) => a + e.verdicts[v], 0)
      return {
        archetype: e.archetype,
        count: n,
        avgWant: round2(mean(e.wants)),
        medianWant: round2(median(e.wants)),
        avgEase: round2(mean(e.eases)),
        medianEase: round2(median(e.eases)),
        avgPriority: round2(mean(e.prios)),
        maxPriority: e.prios.length ? round2(Math.max(...e.prios)) : 0,
        verdicts: e.verdicts,
        // Share of THIS archetype's scored roles whose verdict is go/stretch/solid.
        actionableRate: pct(actionable, n),
        // Share of the whole scored landscape spent on this archetype.
        share: pct(n, total),
        blocked: e.blocked,
      }
    })
    .sort((a, b) => b.actionableRate - a.actionableRate || b.avgPriority - a.avgPriority || b.count - a.count)
}

/* ───── Dimension drag ──────────────────────────────────────────────────────
 *
 * For each v2 dimension, its average across the scored landscape. The
 * LOWEST-averaging dimensions are the systemic targeting blockers. A
 * persistently low Experience bar says the user keeps evaluating roles that
 * ask for more years than they have; a low Skills Match says a stack gap; a
 * low Role content says the scan keeps surfacing sales/ops-heavy roles.
 */
export function dimensionDrag(rows) {
  const scored = rows.filter(r => !isBlocked(r))
  const out = DIMENSIONS.map(({ key, label, group, rollup }) => {
    const vals = scored.map(r => r[key]).filter(Number.isFinite)
    return {
      key,
      label,
      group,
      rollup,
      avg: round2(mean(vals)),
      median: round2(median(vals)),
      count: vals.length,
      // How often this dim scores in the bottom range (≤ 4) — the share of
      // evaluations where it's an active drag rather than just below average.
      lowShare: pct(vals.filter(v => v <= 4).length, vals.length),
    }
  }).filter(d => d.count > 0)
  return out.sort((a, b) => a.avg - b.avg)
}

/* ───── Landscape verdict mix + wasted-effort estimate ──────────────────── */
export function landscapeSummary(rows) {
  const scored = scoredRows(rows)
  const blocked = rows.filter(isBlocked).length
  const verdicts = emptyVerdicts()
  for (const r of scored) if (r.verdict in verdicts) verdicts[r.verdict]++
  const evaluated = scored.length
  const actionable = ACTIONABLE_VERDICTS.reduce((a, v) => a + verdicts[v], 0)
  const wants = scored.map(r => r.want)
  const eases = scored.map(r => r.ease)
  return {
    evaluated,
    blocked,
    avgWant: round2(mean(wants)),
    medianWant: round2(median(wants)),
    avgEase: round2(mean(eases)),
    medianEase: round2(median(eases)),
    verdicts,
    actionableShare: pct(actionable, evaluated),
    // Share of scored evaluation effort spent on roles the grid says to skip.
    wastedShare: pct(verdicts.skip, evaluated),
    // Share of ALL listings (scored + blocked) stopped by the eligibility gate.
    blockedShare: pct(blocked, evaluated + blocked),
  }
}

/* ───── Eligibility breakdown ───────────────────────────────────────────────
 *
 * Counts every row, Blocked ones included (spec §9: blocked rows are counted
 * in eligibility analytics). Per check, how many listings it made red and how
 * many amber, from the `eligibility_flags` column. Shares are of all listings
 * with a known eligibility status.
 */
export function eligibilityBreakdown(rows) {
  const status = { green: 0, amber: 0, red: 0, unknown: 0 }
  const byCheck = new Map()
  for (const r of rows || []) {
    const s = ['green', 'amber', 'red'].includes(r.eligibility) ? r.eligibility
      : isBlocked(r) ? 'red' : 'unknown'
    status[s]++
    const seen = new Set()
    for (const f of r.eligibilityFlags ?? parseEligibilityFlags(r.eligibility_flags)) {
      if (f.status !== 'red' && f.status !== 'amber') continue
      const key = `${f.check}:${f.status}`
      if (seen.has(key)) continue // one listing counts once per check+status
      seen.add(key)
      if (!byCheck.has(f.check)) byCheck.set(f.check, { check: f.check, red: 0, amber: 0, reasons: new Map() })
      const e = byCheck.get(f.check)
      e[f.status]++
      if (f.reason) e.reasons.set(f.reason, (e.reasons.get(f.reason) || 0) + 1)
    }
  }
  const total = status.green + status.amber + status.red
  return {
    total,
    status,
    redShare: pct(status.red, total),
    amberShare: pct(status.amber, total),
    byCheck: [...byCheck.values()]
      .map(e => ({
        check: e.check,
        red: e.red,
        amber: e.amber,
        redShare: pct(e.red, total),
        amberShare: pct(e.amber, total),
        topReasons: [...e.reasons.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([reason, count]) => ({ reason, count })),
      }))
      .sort((a, b) => b.red - a.red || b.amber - a.amber || a.check.localeCompare(b.check)),
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
 * Where the actionable matches (verdict go / stretch / solid by default)
 * geographically cluster, from the `location` column, so the output answers
 * "which cities should I weight my sourcing toward?".
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

export function cityExposure(rows, { verdicts = ACTIONABLE_VERDICTS } = {}) {
  const counts = new Map()
  for (const r of rows) {
    if (!isScored(r) || !verdicts.includes(r.verdict)) continue
    // v2: best_cities is a numeric score, so the posting city comes from
    // `location` only.
    const raw = r.location && isLikelyCity(r.location) ? r.location : ''
    if (!raw || /^n\s*\/?\s*d$/i.test(raw.trim())) continue
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
  const perf = archetypePerformance(rows).filter(a => a.count >= minRoles)
  const drag = dimensionDrag(rows)
  const land = landscapeSummary(rows)
  const elig = eligibilityBreakdown(rows)

  // 1. Best archetype to lean into (verdict-based: share of go/stretch/solid).
  const best = perf[0]
  if (best && best.actionableRate >= 40) {
    recs.push({
      action: `Lean into "${best.archetype}" — strongest landscape (${best.actionableRate}% go/stretch/solid across ${best.count} roles; avg Want ${best.avgWant}, Ease ${best.avgEase})`,
      reasoning: `This archetype consistently lands in apply-worthy verdict cells, so sourcing more of it raises the quality of what you evaluate.`,
      impact: 'high',
    })
  }

  // 2. Worst-performing archetype that's eating real effort.
  const worst = [...perf].sort((a, b) => a.actionableRate - b.actionableRate || a.avgPriority - b.avgPriority)[0]
  if (worst && worst.actionableRate <= 15 && worst.archetype !== best?.archetype) {
    recs.push({
      action: `Pull back on "${worst.archetype}" — weak landscape (${worst.actionableRate}% go/stretch/solid across ${worst.count} roles, ${worst.share}% of all evaluations)`,
      reasoning: `These roles rarely land in an apply-worthy cell, so the evaluation time is largely wasted. Narrow the scan keywords that surface them.`,
      impact: worst.share >= 15 ? 'high' : 'medium',
    })
  }

  // 3. Systemic dimension drag — the single weakest dimension.
  const weakestDim = drag[0]
  if (weakestDim && (weakestDim.avg < 6.0 || weakestDim.lowShare >= 25)) {
    const fixHint = {
      experience_bar: 'you keep evaluating roles that ask for more experience than you have — tighten seniority/keyword filters',
      skills_match: 'a recurring skill/stack gap — either filter these roles out or close the gap',
      competition: 'the pools you target are very selective — add companies where your profile stands out, or build referral paths',
      role_content: 'the day-to-day work drifts from what you want (quota/ops-heavy roles) — re-check your scan keywords against your target archetypes',
      brand_value: 'the companies surfacing are weak on brand — add stronger target companies to user/portals.yml',
      growth_mobility: 'these roles offer limited progression — weight sourcing toward higher-growth companies',
      optionality_exit: 'narrow exit optionality — favor roles/companies with broader downstream paths',
      best_cities: 'the roles surfacing are outside your preferred cities — tighten the location filters',
      salary_adj_city: 'pay vs. cost of living is weak in what you evaluate — check your target cities and comp filters',
      work_life_balance: 'the roles surfacing have poor work-life balance — weight sourcing toward calmer employers',
    }[weakestDim.key] || 'this dimension consistently drags your scores down'
    const rollup = weakestDim.rollup === 'ease' ? 'Ease' : 'Want'
    recs.push({
      action: `Address the "${weakestDim.label}" drag (avg ${weakestDim.avg}, low in ${weakestDim.lowShare}% of evals)`,
      reasoning: `${weakestDim.label} is the dimension most often holding your ${rollup} down — ${fixHint}.`,
      impact: 'high',
    })
  }

  // 4. Wasted-effort warning.
  if (land.wastedShare >= 25) {
    recs.push({
      action: `${land.wastedShare}% of scored evaluations land in Skip — raise the bar before evaluating`,
      reasoning: `${land.verdicts.skip} of ${land.evaluated} scored roles aren't worth applying to. A pre-evaluation filter on scan results would reclaim that effort.`,
      impact: 'medium',
    })
  }

  // 5. An eligibility check that keeps blocking listings.
  const topRed = elig.byCheck.find(c => c.red > 0)
  if (topRed && topRed.red >= minRoles && topRed.redShare >= 20) {
    const reason = topRed.topReasons[0]?.reason
    recs.push({
      action: `"${topRed.check}" blocks ${topRed.redShare}% of listings (${topRed.red} of ${elig.total}) — filter them out before evaluating`,
      reasoning: `Blocked listings never get scored, so each one is evaluation effort with no upside${reason ? ` (most common reason: ${reason})` : ''}. A scan-time filter (keywords, location, language) would catch most of them.`,
      impact: topRed.redShare >= 35 ? 'high' : 'medium',
    })
  }

  return recs
}

/* ───── Top-level analysis object (consumed by the CLI/mode) ──────────────── */
export function analyzeScouting(rows, opts = {}) {
  if (!rows || rows.length === 0) {
    return { error: 'No scouting evaluations found in score-history.tsv.' }
  }
  const scored = scoredRows(rows)
  const eligibility = eligibilityBreakdown(rows)
  if (scored.length === 0) {
    return { error: 'No scored (non-blocked) rows with Want and Ease in score-history.tsv.', eligibility }
  }
  const dates = rows.map(r => r.date).filter(Boolean).sort()
  return {
    metadata: {
      evaluated: scored.length,
      blocked: rows.filter(isBlocked).length,
      total: rows.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      analysisDate: new Date().toISOString().split('T')[0],
    },
    landscape: landscapeSummary(rows),
    archetypePerformance: archetypePerformance(rows),
    dimensionDrag: dimensionDrag(scored),
    eligibility,
    cityExposure: cityExposure(scored).slice(0, 12),
    recommendations: targetingRecommendations(rows, opts),
  }
}
