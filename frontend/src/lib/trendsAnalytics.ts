// Pure aggregation logic behind the Trends view. Extracted out of
// TrendsView.tsx so the math is unit-testable in isolation (the component
// kept only chart config + JSX). Nothing here imports React.
//
// Two design rules carried over from the rest of lib/:
//   • the time-window filter takes an injectable `now` (defaulting to the
//     real clock) so tests pin an exact cutoff — same pattern as
//     lib/profileStats.ts and lib/scanHistory.ts;
//   • the "is this a real, scored evaluation" guard (`overall > 0`, noise
//     labels) lives in one place so the distribution, top-X panels, and any
//     future view agree on what counts.

import type { ScoreEntry, ApplicationEntry, AppStatus } from '@/types'
import { scoreColor } from '@/lib/tier'

// ─── Time range ──────────────────────────────────────────────────────────────

export type TimeRange = 'all' | '1y' | '6m' | '1m'

export const TIME_RANGE_DAYS: Record<TimeRange, number | null> = {
  all: null, '1y': 365, '6m': 182, '1m': 30,
}

export const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time', '1y': '1y', '6m': '6mo', '1m': '1mo',
}

// Filter any dated rows to a trailing window. `all` returns the input
// untouched (same reference, no copy). The cutoff is computed at UTC-ish
// local midnight minus N days and compared as an ISO date prefix — score-
// history and applications both store `YYYY-MM-DD`, so a string compare is
// correct and TZ-stable. Rows with no date sort below any cutoff (dropped).
export function filterByDateWindow<T extends { date?: string | null }>(
  rows: T[],
  range: TimeRange,
  now: Date = new Date(),
): T[] {
  const days = TIME_RANGE_DAYS[range]
  if (days == null) return rows
  const cutoff = new Date(now)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffIso = cutoff.toISOString().slice(0, 10)
  return rows.filter(r => (r.date ?? '') >= cutoffIso)
}

// ─── Basic stats ─────────────────────────────────────────────────────────────

export function avg(rows: ScoreEntry[], field: keyof ScoreEntry): number {
  let sum = 0, n = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number') { sum += v; n++ }
  }
  return n === 0 ? 0 : sum / n
}

// Median is the honest "typical" figure for a skewed score corpus — the
// mean gets dragged by a cluster of T1 hits or a long T4 tail, the median
// doesn't. Shown alongside the distribution as a one-number summary.
export function median(rows: ScoreEntry[], field: keyof ScoreEntry): number {
  const xs = rows
    .map(r => r[field])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]
}

// ─── Time-series (one bucket per calendar day) ───────────────────────────────

export interface DateBucket {
  label: string; count: number
  avg_overall: number; avg_current_fit: number; avg_aspirational_fit: number
  avg_skills_match: number; avg_brand_value: number
  avg_growth: number; avg_wlb: number
}

export function buildByDate(rows: ScoreEntry[]): DateBucket[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const s of rows) {
    if (!s.date) continue
    const date = s.date.slice(0, 10)
    const list = map.get(date)
    if (list) list.push(s)
    else map.set(date, [s])
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({
      label: date,
      count: entries.length,
      avg_overall:          avg(entries, 'overall'),
      avg_current_fit:      avg(entries, 'current_fit'),
      avg_aspirational_fit: avg(entries, 'aspirational_fit'),
      avg_skills_match:     avg(entries, 'skills_match'),
      avg_brand_value:      avg(entries, 'brand_value'),
      avg_growth:           avg(entries, 'growth_mobility'),
      avg_wlb:              avg(entries, 'work_life_balance'),
    }))
}

// ─── Top-X ranking ───────────────────────────────────────────────────────────

export interface TopRow { label: string; count: number; avgScore: number }

// Skip useless labels — the score-history TSV uses "n/d" for unstated values
// and most files have a few legacy rows with empty / dash entries.
export const isNoiseLabel = (s: string): boolean => {
  const t = s.trim().toLowerCase()
  return !t || t === 'n/d' || t === '—' || t === '-' || t === 'unknown'
}

export function buildTopBy(rows: ScoreEntry[], key: (e: ScoreEntry) => string, limit: number): TopRow[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const e of rows) {
    const k = (key(e) ?? '').trim()
    if (isNoiseLabel(k)) continue
    const list = map.get(k)
    if (list) list.push(e)
    else map.set(k, [e])
  }
  return [...map.entries()]
    .map(([label, entries]) => ({ label, count: entries.length, avgScore: avg(entries, 'overall') }))
    // Rank by avg score primarily — the user wants "what scored high",
    // not "what showed up the most." Count is the tiebreaker.
    .filter(r => r.avgScore > 0)
    .sort((a, b) => b.avgScore - a.avgScore || b.count - a.count)
    .slice(0, limit)
}

// ─── Score distribution ──────────────────────────────────────────────────────
//
// Five bands matched 1:1 to the documented score-interpretation scale and the
// `scoreColor()` ordinal palette (lib/tier.ts): everything ≥7.0 is the brand-
// violet "apply-worthy" group, below that fades to slate. Coloring each band
// by scoreColor(midpoint) keeps the histogram in lockstep with the same number
// → color mapping used by the Database dial and the top-X panels.

export interface ScoreBand {
  key: string
  label: string
  range: string
  lo: number          // inclusive lower bound
  hi: number          // exclusive upper bound (Infinity for the top band)
  color: string
  applyWorthy: boolean
}

export const SCORE_BANDS: ScoreBand[] = [
  { key: 'subfloor', label: 'Sub-floor', range: '< 5', lo: -Infinity, hi: 5,        color: scoreColor(4),   applyWorthy: false },
  { key: 'belowbar', label: 'Below bar', range: '5–7', lo: 5,         hi: 7,        color: scoreColor(6),   applyWorthy: false },
  { key: 'decent',   label: 'Decent',    range: '7–8', lo: 7,         hi: 8,        color: scoreColor(7.5), applyWorthy: true },
  { key: 'good',     label: 'Good',      range: '8–9', lo: 8,         hi: 9,        color: scoreColor(8.5), applyWorthy: true },
  { key: 'stellar',  label: 'Stellar',   range: '≥ 9', lo: 9,         hi: Infinity, color: scoreColor(9.5), applyWorthy: true },
]

export interface Distribution {
  bands: Array<ScoreBand & { count: number }>
  total: number       // count of scored rows (overall > 0)
  max: number         // tallest band, for bar scaling (min 1 to avoid /0)
  applyPct: number    // % of scored rows in an apply-worthy band
  median: number
}

export function buildDistribution(rows: ScoreEntry[]): Distribution {
  const counts = SCORE_BANDS.map(() => 0)
  const scored: ScoreEntry[] = []
  for (const r of rows) {
    const v = r.overall
    // Mirror the top-X panels' `avgScore > 0` rule — score-history carries a
    // few legacy rows with 0 / n-d overalls that aren't real evaluations.
    if (typeof v !== 'number' || v <= 0) continue
    const idx = SCORE_BANDS.findIndex(b => v >= b.lo && v < b.hi)
    if (idx >= 0) { counts[idx]++; scored.push(r) }
  }
  const bands = SCORE_BANDS.map((b, i) => ({ ...b, count: counts[i] }))
  const applyWorthy = bands.reduce((s, b) => s + (b.applyWorthy ? b.count : 0), 0)
  return {
    bands,
    total: scored.length,
    max: Math.max(1, ...counts),
    applyPct: scored.length ? Math.round((applyWorthy / scored.length) * 100) : 0,
    median: median(scored, 'overall'),
  }
}

// ─── Dimension profile ───────────────────────────────────────────────────────
//
// The time-series plots each dimension over time and the top-X panels rank
// companies/locations — but neither answers "across everything I've evaluated,
// which scoring dimensions are my market's strengths, and which actually
// separate an apply-worthy role from a dud?".
//
// For each of the 7 dimensions we compute two averages over the scored corpus
// (overall > 0): the average across ALL scored rows, and the average across the
// apply-worthy subset (overall >= 7.0). The DELTA between them is the signal —
// a dimension with a large positive delta is one that high-scoring roles have
// and low-scoring roles lack, i.e. a *driver* of fit. A dimension that's flat
// across both groups doesn't discriminate (it's noise for targeting), and a
// negative delta means apply-worthy roles are actually WEAKER on it (a tradeoff
// the user accepts to land the win). Ranking by delta turns the raw score
// columns into a targeting cheat-sheet: chase roles strong on the high-delta
// dimensions.

// The dimensions in display order. `field` is the ScoreEntry column; `label`
// is the human name (matches the Trends time-series legend so the two views
// speak the same language).
export interface DimensionDef { field: keyof ScoreEntry; label: string }

export const PROFILE_DIMENSIONS: DimensionDef[] = [
  { field: 'current_fit',       label: 'Current Fit'      },
  { field: 'aspirational_fit',  label: 'Aspirational Fit' },
  { field: 'skills_match',      label: 'Skills Match'     },
  { field: 'brand_value',       label: 'Brand Value'      },
  { field: 'growth_mobility',   label: 'Growth'           },
  { field: 'work_life_balance', label: 'Work-Life'        },
]

// The overall score that splits "apply-worthy" from the rest — mirrors the
// 7.0 apply threshold used by SCORE_BANDS / `_shared.md` § Score interpretation.
export const APPLY_THRESHOLD = 7.0

export interface DimensionStat {
  field: keyof ScoreEntry
  label: string
  avgAll: number        // mean over every scored row
  avgWinners: number    // mean over the apply-worthy subset (overall >= 7)
  delta: number         // avgWinners - avgAll; the discriminating signal
}

export interface DimensionProfile {
  dims: DimensionStat[]      // sorted by delta desc (strongest driver first)
  scoredCount: number        // rows with overall > 0
  winnerCount: number        // rows with overall >= APPLY_THRESHOLD
  /** True when there aren't enough winners to make the delta meaningful.
   *  The component greys the delta column and shows a hint instead of
   *  reading noise as signal. */
  lowSignal: boolean
}

// Minimum apply-worthy rows before the winners-vs-all delta is worth trusting.
// Below this the split is too small to separate signal from sampling noise, so
// the profile reports `lowSignal` and the view falls back to plain averages.
export const MIN_WINNERS_FOR_DELTA = 4

export function buildDimensionProfile(rows: ScoreEntry[]): DimensionProfile {
  const scored = rows.filter(r => typeof r.overall === 'number' && r.overall > 0)
  const winners = scored.filter(r => r.overall >= APPLY_THRESHOLD)

  const dims: DimensionStat[] = PROFILE_DIMENSIONS.map(({ field, label }) => {
    const avgAll = avg(scored, field)
    const avgWinners = avg(winners, field)
    return { field, label, avgAll, avgWinners, delta: avgWinners - avgAll }
  })

  // Rank by discriminating power (delta) when we have enough winners to trust
  // it; otherwise fall back to ranking by raw average so the panel still leads
  // with the corpus's strongest dimension instead of a noisy delta.
  const lowSignal = winners.length < MIN_WINNERS_FOR_DELTA
  dims.sort((a, b) =>
    lowSignal
      ? b.avgAll - a.avgAll
      : b.delta - a.delta || b.avgWinners - a.avgWinners,
  )

  return { dims, scoredCount: scored.length, winnerCount: winners.length, lowSignal }
}

// ─── Targeting momentum (recent vs earlier) ──────────────────────────────────
//
// The time-series chart plots raw per-day averages — honest but noisy: a single
// n=1 day swings the line, and the eye can't separate "my targeting is getting
// sharper" from day-to-day sampling jitter. The dimension profile and the funnel
// are both *static* snapshots over the whole window. Neither answers the question
// the tool actually exists to push on (TODO § directive: optimize toward
// outcomes): **as I refine what I evaluate, is the quality of what I evaluate
// trending up?**
//
// This splits the date-windowed, scored corpus in chronological order into two
// consecutive halves — an EARLIER half and a RECENT half — and contrasts them on
// the metrics that define "good targeting": the typical (median) overall score,
// the share that clears the apply bar, and the per-dimension averages. A rising
// recent half means the user is finding better-fit roles than they used to; a
// falling one is an early warning that the funnel is drifting (broader keywords,
// staler sources, scope creep) before it shows up as rejections downstream.
//
// Honesty rules carried over from buildDimensionProfile:
//   • split is by chronological order, not by a calendar midpoint — so two
//     lopsided bursts of activity still produce balanced-n halves (each half is
//     a real sample, not "the 3 rows from a quiet month vs the 40 from a busy
//     one");
//   • below a per-half floor the comparison is sampling noise, so we report
//     `lowSignal` and the card shows a "keep evaluating" hint instead of a
//     verdict;
//   • the verdict has a deadband (`MOMENTUM_DEADBAND`) so a trivial wobble reads
//     as "steady", not a trend.

// Minimum scored rows IN EACH HALF before the recent-vs-earlier delta is worth a
// verdict. Same spirit as MIN_WINNERS_FOR_DELTA — under this the split is too
// small to separate a real shift from who-happened-to-get-evaluated-when. With
// 3 per side (6 total) a median is at least a 3-point sample rather than a coin
// flip on one or two listings.
export const MIN_PER_HALF_FOR_MOMENTUM = 3

// A median-overall swing smaller than this (on the 0–10 scale) reads as flat —
// scoring is dimension-summed and rounded, so sub-0.3 wobble between two small
// samples is noise, not a trend. Above it in either direction earns a verdict.
export const MOMENTUM_DEADBAND = 0.3

export type MomentumDirection = 'improving' | 'steady' | 'declining'

export interface MomentumHalf {
  count: number
  medianOverall: number
  avgOverall: number
  applyPct: number       // % of this half clearing APPLY_THRESHOLD
  dateFrom: string       // earliest dated row in the half ('' if none dated)
  dateTo: string         // latest dated row in the half
}

export interface MomentumDimShift {
  field: keyof ScoreEntry
  label: string
  earlier: number        // mean over the earlier half
  recent: number         // mean over the recent half
  delta: number          // recent - earlier
}

export interface TargetingMomentum {
  earlier: MomentumHalf
  recent: MomentumHalf
  /** recent.medianOverall - earlier.medianOverall — the headline movement. */
  medianDelta: number
  /** recent.applyPct - earlier.applyPct, in percentage points. */
  applyPctDelta: number
  direction: MomentumDirection
  /** Per-dimension recent-minus-earlier means, sorted by |delta| desc so the
   *  biggest movers (good or bad) lead. Only meaningful when !lowSignal. */
  dimShifts: MomentumDimShift[]
  scoredCount: number    // total scored rows feeding the split
  /** True when either half is under MIN_PER_HALF_FOR_MOMENTUM — the view then
   *  shows a hint instead of reading noise as a trend. */
  lowSignal: boolean
}

function summarizeHalf(rows: ScoreEntry[]): MomentumHalf {
  const dated = rows.map(r => r.date?.slice(0, 10) ?? '').filter(Boolean).sort()
  const winners = rows.filter(r => r.overall >= APPLY_THRESHOLD).length
  return {
    count: rows.length,
    medianOverall: median(rows, 'overall'),
    avgOverall: avg(rows, 'overall'),
    applyPct: rows.length ? Math.round((winners / rows.length) * 100) : 0,
    dateFrom: dated[0] ?? '',
    dateTo: dated[dated.length - 1] ?? '',
  }
}

// Pre-sort the scored corpus by date ascending, then split at the midpoint so
// the two halves carry equal n (the earlier half takes the extra row on an odd
// count). Rows are scored-only (overall > 0, mirroring the distribution/profile
// guard). Undated rows can't be placed on the timeline, so they're dropped from
// the split rather than silently anchored to one end.
export function buildTargetingMomentum(rows: ScoreEntry[]): TargetingMomentum {
  const scored = rows
    .filter(r => typeof r.overall === 'number' && r.overall > 0 && !!r.date)
    .slice()
    .sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))

  const mid = Math.ceil(scored.length / 2)
  const earlierRows = scored.slice(0, mid)
  const recentRows = scored.slice(mid)

  const earlier = summarizeHalf(earlierRows)
  const recent = summarizeHalf(recentRows)

  const lowSignal =
    earlierRows.length < MIN_PER_HALF_FOR_MOMENTUM ||
    recentRows.length < MIN_PER_HALF_FOR_MOMENTUM

  const medianDelta = recent.medianOverall - earlier.medianOverall
  const applyPctDelta = recent.applyPct - earlier.applyPct

  // Verdict off the median (robust to a single outlier listing), with a
  // deadband so noise reads as steady. Forced to 'steady' under low signal so
  // a thin corpus never asserts a direction it can't support.
  let direction: MomentumDirection = 'steady'
  if (!lowSignal) {
    if (medianDelta >= MOMENTUM_DEADBAND) direction = 'improving'
    else if (medianDelta <= -MOMENTUM_DEADBAND) direction = 'declining'
  }

  const dimShifts: MomentumDimShift[] = PROFILE_DIMENSIONS.map(({ field, label }) => {
    const earlierAvg = avg(earlierRows, field)
    const recentAvg = avg(recentRows, field)
    return { field, label, earlier: earlierAvg, recent: recentAvg, delta: recentAvg - earlierAvg }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return {
    earlier, recent,
    medianDelta, applyPctDelta, direction, dimShifts,
    scoredCount: scored.length, lowSignal,
  }
}

// ─── Archetype mix over time ─────────────────────────────────────────────────
//
// Every panel above answers a question about *quality*: the time-series plots
// averages, the distribution shows the quality shape, the dimension profile
// explains what drives a high score, and targeting momentum tracks whether
// quality is rising. None of them answer the orthogonal question — *where is my
// evaluation effort actually going, and is that allocation drifting?*
//
// A job search is a portfolio-allocation problem as much as a quality one: a
// user who spreads attention thinly across nine archetypes is unfocused; one who
// has quietly drifted from a high-scoring archetype toward a low-scoring one is
// chasing volume over fit without noticing. This panel makes the *composition*
// of the corpus legible by canonical archetype, and — crucially — contrasts how
// that composition looked in the EARLIER half of the window vs the RECENT half,
// so a shift in focus shows up as a signed change in share-of-attention.
//
// Honesty rules carried over from the rest of this file:
//   • canonicalization is injected (the rules live in lib/archetype.ts, which is
//     UI-adjacent), so this module stays React-free and the math is testable in
//     isolation with a trivial stub — same pattern as the `now`-injection above;
//   • only real scored rows count (overall > 0), and noise archetype labels are
//     dropped via the shared `isNoiseLabel` guard;
//   • the earlier/recent split is chronological (equal-n halves), mirroring
//     buildTargetingMomentum, so two lopsided activity bursts still produce
//     balanced samples rather than "a quiet month vs a busy one";
//   • below a per-half floor the split is sampling noise, so `lowSignal` flips
//     and the share-shift column is suppressed — the panel still shows the
//     overall mix, it just doesn't assert a drift it can't support.

// Minimum scored rows IN EACH HALF before the earlier-vs-recent share shift is
// trustworthy. Same spirit as MIN_PER_HALF_FOR_MOMENTUM — under this the split
// reflects who-got-evaluated-when, not a real change in focus.
export const MIN_PER_HALF_FOR_MIX = 3

export interface ArchetypeSlice {
  /** Canonical archetype label (already run through the injected canonicalizer). */
  label: string
  count: number          // scored rows in this archetype over the whole window
  sharePct: number       // count / total scored, 0–100 (rounded for display)
  avgScore: number       // mean overall for this archetype
  earlierCount: number   // scored rows in the earlier (chronological) half
  recentCount: number    // scored rows in the recent half
  earlierSharePct: number // share of the earlier half (0–100, rounded)
  recentSharePct: number  // share of the recent half (0–100, rounded)
  /** recentSharePct - earlierSharePct, in percentage points. Positive = the
   *  archetype is taking a growing slice of attention; negative = fading.
   *  Only meaningful when !lowSignal. */
  shareShift: number
}

export interface ArchetypeMix {
  /** Slices sorted by overall count desc (biggest focus first), then avgScore. */
  slices: ArchetypeSlice[]
  scoredCount: number    // total scored rows feeding the mix
  distinct: number       // number of distinct archetypes (concentration cue)
  /** Herfindahl-style concentration of attention: sum of squared shares (as
   *  fractions), 0–1. 1 = all eggs in one archetype; →0 = spread evenly across
   *  many. A one-number "how focused is my search" read. */
  concentration: number
  earlierTotal: number   // scored rows in the earlier half
  recentTotal: number    // scored rows in the recent half
  /** True when either half is under MIN_PER_HALF_FOR_MIX — the view then shows
   *  the static mix but hides the earlier→recent share-shift column. */
  lowSignal: boolean
}

// Canonicalizer signature — injected so this module never imports the UI-side
// archetype rules. The default is identity (trims only), which keeps the pure
// math testable; the component passes `canonicalizeArchetype` from lib/archetype.
export type ArchetypeKeyFn = (raw: string) => string

export function buildArchetypeMix(
  rows: ScoreEntry[],
  canon: ArchetypeKeyFn = (s) => s.trim(),
): ArchetypeMix {
  // Scored, dated-or-not but timeline-placeable rows. We need a date to assign a
  // row to the earlier/recent half; undated rows still count toward the static
  // mix but can't carry a share-shift, so — to keep the two halves honest — we
  // split only the dated subset and let undated rows ride in the overall totals.
  const scored = rows.filter(r => typeof r.overall === 'number' && r.overall > 0)

  // Chronological split of the *dated* scored rows (equal-n halves, earlier
  // takes the extra on odd n) — identical scheme to buildTargetingMomentum so
  // the two panels agree on what "recent" means.
  const dated = scored
    .filter(r => !!r.date)
    .slice()
    .sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))
  const mid = Math.ceil(dated.length / 2)
  const earlierRows = dated.slice(0, mid)
  const recentRows = dated.slice(mid)

  // Bucket every scored row by canonical archetype, tracking the three counts.
  interface Bucket { entries: ScoreEntry[]; earlier: number; recent: number }
  const buckets = new Map<string, Bucket>()
  const bump = (label: string, get: (b: Bucket) => void) => {
    let b = buckets.get(label)
    if (!b) { b = { entries: [], earlier: 0, recent: 0 }; buckets.set(label, b) }
    get(b)
  }
  const labelOf = (e: ScoreEntry): string | null => {
    const k = canon(e.archetype ?? '').trim()
    return isNoiseLabel(k) ? null : k
  }
  for (const e of scored) {
    const label = labelOf(e)
    if (label) bump(label, b => b.entries.push(e))
  }
  for (const e of earlierRows) {
    const label = labelOf(e)
    if (label) bump(label, b => { b.earlier++ })
  }
  for (const e of recentRows) {
    const label = labelOf(e)
    if (label) bump(label, b => { b.recent++ })
  }

  const total = [...buckets.values()].reduce((s, b) => s + b.entries.length, 0)
  const earlierTotal = earlierRows.length
  const recentTotal = recentRows.length

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)
  // Unrounded fractions for the concentration index, so it doesn't drift from
  // rounding the displayed percentages.
  const concentration = total
    ? [...buckets.values()].reduce((s, b) => {
        const frac = b.entries.length / total
        return s + frac * frac
      }, 0)
    : 0

  const lowSignal =
    earlierRows.length < MIN_PER_HALF_FOR_MIX ||
    recentRows.length < MIN_PER_HALF_FOR_MIX

  const slices: ArchetypeSlice[] = [...buckets.entries()].map(([label, b]) => {
    const earlierSharePct = pct(b.earlier, earlierTotal)
    const recentSharePct = pct(b.recent, recentTotal)
    return {
      label,
      count: b.entries.length,
      sharePct: pct(b.entries.length, total),
      avgScore: avg(b.entries, 'overall'),
      earlierCount: b.earlier,
      recentCount: b.recent,
      earlierSharePct,
      recentSharePct,
      shareShift: lowSignal ? 0 : recentSharePct - earlierSharePct,
    }
  })
  // Biggest focus first; ties broken by quality so a high-scoring archetype
  // leads a same-count low-scoring one.
  slices.sort((a, b) => b.count - a.count || b.avgScore - a.avgScore || a.label.localeCompare(b.label))

  return {
    slices,
    scoredCount: total,
    distinct: buckets.size,
    concentration,
    earlierTotal,
    recentTotal,
    lowSignal,
  }
}

// ─── Conversion funnel ───────────────────────────────────────────────────────
//
// Cumulative application funnel from current statuses. A status implies every
// earlier stage was reached (you can't be Interviewing without having Applied),
// so we count "reached at least stage X". Rejected counts as having Applied
// but — conservatively — NOT as having got a real response, since most
// rejections are pre-interview auto-replies; surfacing it separately keeps the
// response rate honest rather than inflating it.

const REACHED_APPLIED   = new Set<AppStatus>(['Applied', 'Responded', 'Interview', 'Offer', 'Rejected'])
const REACHED_RESPONDED = new Set<AppStatus>(['Responded', 'Interview', 'Offer'])
const REACHED_INTERVIEW = new Set<AppStatus>(['Interview', 'Offer'])
const REACHED_OFFER     = new Set<AppStatus>(['Offer'])

export interface Funnel {
  sent: number
  responded: number
  interview: number
  offer: number
  rejected: number
}

export function buildFunnel(apps: ApplicationEntry[]): Funnel {
  let sent = 0, responded = 0, interview = 0, offer = 0, rejected = 0
  for (const a of apps) {
    if (REACHED_APPLIED.has(a.status))   sent++
    if (REACHED_RESPONDED.has(a.status)) responded++
    if (REACHED_INTERVIEW.has(a.status)) interview++
    if (REACHED_OFFER.has(a.status))     offer++
    if (a.status === 'Rejected')         rejected++
  }
  return { sent, responded, interview, offer, rejected }
}

// ─── Location → country flag ─────────────────────────────────────────────────
//
// Score-history `location` strings vary: "Dublin, Ireland (on-site)",
// "Madrid", "Multi-location (UK, UAE, ...)", "Remote / multi-hub (London /
// Barcelona)". Best-effort: match the first recognized city or country in
// the string, fall back to no flag if nothing matches.

const CITY_TO_ISO: Record<string, string> = {
  // Ireland
  'dublin': 'IE', 'cork': 'IE', 'galway': 'IE',
  // UK
  'london': 'GB', 'manchester': 'GB', 'edinburgh': 'GB', 'birmingham': 'GB', 'cambridge': 'GB',
  // Spain
  'madrid': 'ES', 'barcelona': 'ES', 'valencia': 'ES', 'seville': 'ES', 'bilbao': 'ES', 'malaga': 'ES',
  // Italy
  'milan': 'IT', 'milano': 'IT', 'rome': 'IT', 'roma': 'IT', 'turin': 'IT', 'torino': 'IT', 'florence': 'IT', 'naples': 'IT',
  // Netherlands
  'amsterdam': 'NL', 'rotterdam': 'NL', 'utrecht': 'NL', 'the hague': 'NL', 'eindhoven': 'NL',
  // Germany
  'berlin': 'DE', 'munich': 'DE', 'münchen': 'DE', 'frankfurt': 'DE', 'hamburg': 'DE', 'cologne': 'DE', 'köln': 'DE', 'düsseldorf': 'DE', 'stuttgart': 'DE',
  // France
  'paris': 'FR', 'lyon': 'FR', 'marseille': 'FR', 'toulouse': 'FR',
  // Austria
  'vienna': 'AT', 'wien': 'AT', 'salzburg': 'AT', 'graz': 'AT',
  // Portugal
  'lisbon': 'PT', 'lisboa': 'PT', 'porto': 'PT',
  // Switzerland
  'zurich': 'CH', 'zürich': 'CH', 'geneva': 'CH', 'bern': 'CH', 'basel': 'CH', 'lausanne': 'CH',
  // Belgium
  'brussels': 'BE', 'antwerp': 'BE', 'ghent': 'BE',
  // Nordics
  'copenhagen': 'DK', 'aarhus': 'DK',
  'stockholm': 'SE', 'gothenburg': 'SE', 'malmö': 'SE',
  'oslo': 'NO', 'bergen': 'NO',
  'helsinki': 'FI', 'espoo': 'FI', 'tampere': 'FI',
  'reykjavik': 'IS',
  // Eastern Europe
  'warsaw': 'PL', 'krakow': 'PL', 'kraków': 'PL', 'wroclaw': 'PL',
  'prague': 'CZ', 'brno': 'CZ',
  'budapest': 'HU',
  'bucharest': 'RO',
  // North America
  'new york': 'US', 'nyc': 'US', 'san francisco': 'US', 'sf': 'US', 'boston': 'US',
  'los angeles': 'US', 'la': 'US', 'austin': 'US', 'seattle': 'US', 'chicago': 'US', 'denver': 'US', 'atlanta': 'US',
  'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA',
  // LATAM
  'mexico city': 'MX', 'cdmx': 'MX',
  'são paulo': 'BR', 'sao paulo': 'BR', 'rio de janeiro': 'BR',
  'buenos aires': 'AR',
  'heredia': 'CR', 'san josé': 'CR', 'san jose': 'CR',
  // Asia + Oceania
  'singapore': 'SG',
  'tokyo': 'JP', 'osaka': 'JP',
  'hong kong': 'HK',
  'sydney': 'AU', 'melbourne': 'AU',
  'bangalore': 'IN', 'bengaluru': 'IN', 'mumbai': 'IN', 'delhi': 'IN',
  // Middle East
  'dubai': 'AE', 'abu dhabi': 'AE',
}

const COUNTRY_TO_ISO: Record<string, string> = {
  ireland: 'IE',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', 'great britain': 'GB',
  spain: 'ES', italy: 'IT', netherlands: 'NL', germany: 'DE', france: 'FR',
  austria: 'AT', portugal: 'PT', switzerland: 'CH', belgium: 'BE',
  denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI', iceland: 'IS',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', hungary: 'HU', romania: 'RO',
  'united states': 'US', usa: 'US', us: 'US', america: 'US',
  canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR', 'costa rica': 'CR',
  singapore: 'SG', japan: 'JP', 'hong kong': 'HK',
  australia: 'AU', india: 'IN', uae: 'AE',
}

// ISO 3166-1 alpha-2 → flag emoji via regional indicator code points.
export const isoToFlag = (iso: string): string =>
  iso.replace(/[A-Z]/g, c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)))

export function locationFlag(location: string): string | null {
  const lower = location.toLowerCase()
  for (const [city, iso] of Object.entries(CITY_TO_ISO)) {
    if (lower.includes(city)) return isoToFlag(iso)
  }
  for (const [country, iso] of Object.entries(COUNTRY_TO_ISO)) {
    if (lower.includes(country)) return isoToFlag(iso)
  }
  return null
}
