// Pure aggregation logic behind the Trends view. Extracted out of
// TrendsView.tsx so the math is unit-testable in isolation (the component
// kept only chart config + JSX). Nothing here imports React.
//
// Two design rules carried over from the rest of lib/:
//   • the time-window filter takes an injectable `now` (defaulting to the
//     real clock) so tests pin an exact cutoff — same pattern as
//     lib/profileStats.ts and lib/scanHistory.ts;
//   • the "is this a real, scored evaluation" guard (`isScored` — Match and
//     Ease present, not blocked — plus noise labels) lives in one place so the
//     time chart, top-X panels, and any future view agree on what counts.
//
// Scoring v2 (docs/scoring-v2.md §9): there is no Overall. Score analytics
// are stated on Match and Ease separately; bands come from the VERDICT, never
// from cut-offs on a number; blocked (red) rows are excluded from every score
// analytic (averages, medians, the Match line) but counted as listings.

import type { ScoreEntry, ApplicationEntry, AppStatus, Verdict } from '@/types'
import { GATES, NOISE_FLOORS } from '@/lib/scoringStats'
import { MATCH_HIGH, isScored, priorityOf, verdictOf } from '@/lib/scoreBands'
import { parseCities } from '@/lib/entityId'

/** Rows a score analytic may use: Match and Ease present, not blocked. */
export function scoredOnly(rows: ScoreEntry[]): ScoreEntry[] {
  return rows.filter(isScored)
}

/** Verdicts the ethical-use rule allows applying to (spec §4) — the v2
 *  "apply-worthy" set that replaces v1's Overall ≥ 7.0. */
export const APPLY_WORTHY_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(['go', 'stretch', 'solid'])

export function isApplyWorthy(e: ScoreEntry): boolean {
  const v = verdictOf(e)
  return v != null && APPLY_WORTHY_VERDICTS.has(v)
}

/** Mean Priority (the sort key) over rows that have one. */
function avgPriority(rows: ScoreEntry[]): number {
  let sum = 0, n = 0
  for (const r of rows) { const p = priorityOf(r); if (p != null) { sum += p; n++ } }
  return n === 0 ? 0 : sum / n
}

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
// doesn't. The momentum card compares per-half medians.
export function median(rows: ScoreEntry[], field: keyof ScoreEntry): number {
  const xs = rows
    .map(r => r[field])
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]
}

// ─── Listings per period (week or month) ─────────────────────────────────────
//
// The time chart answers one question: when do listings get posted, and how
// many of them are strong matches? Bars, so hiring cycles show as peaks and
// troughs, each split into the strong matches and the rest. Only counts: a tally
// is not a score claim, so nothing here is gated
// (docs/scoring-statistical-design.md § 3.6).
//
// Counting rules:
//   • a listing counts ONCE, in the period it was POSTED: its posting date
//     (scan-history's, else the report's; the caller resolves it with
//     `pickPostedDate` and passes `postedDate`), else the period it was first
//     evaluated — a re-evaluation is not a new listing
//     (key: URL, else company|role);
//   • "strong match" = the high-Match row of the verdict grid (docs/scoring-v2.md
//     §4): Match ≥ MATCH_HIGH and not blocked, i.e. a Go, Stretch or Growth
//     target verdict, on the listing's latest evaluation;
//   • each bucket says how many listings it placed by posting date and how
//     many by first evaluation, so a bar of fallbacks isn't read as a hiring
//     cycle;
//   • blocked listings (eligibility red) count in the bars and in `blocked`,
//     never in `strongMatch` — they have no Match (docs/scoring-v2.md §9);
//   • empty periods between the first and last are kept as zero bars, so a
//     quiet stretch reads as a gap rather than disappearing.

export type PeriodGranularity = 'week' | 'month'

export interface PeriodBucket {
  /** ISO date the period starts on (Monday for weeks, the 1st for months). */
  start: string
  /** Axis label: "Sep 7" (week) or "Sep 2026" (month). */
  label: string
  /** Tooltip heading: "Week of Sep 7, 2026" or "September 2026". */
  title: string
  /** Distinct listings posted in the period (else first evaluated in it),
   *  blocked included. */
  listings: number
  /** Of those, placed by their posting date. */
  posted: number
  /** Of those, placed by their first evaluation (no posting date on file). */
  evaluated: number
  /** Of those, strong matches: Match ≥ MATCH_HIGH and not blocked (`isStrongMatch`). */
  strongMatch: number
  /** Of those, blocked (eligibility red) on their latest evaluation. */
  blocked: number
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Dates are YYYY-MM-DD (or an ISO timestamp); parse the day part as UTC so the
// period math is TZ-stable.
function parseDay(iso: string): Date | null {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

function periodStart(d: Date, g: PeriodGranularity): Date {
  if (g === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const back = (d.getUTCDay() + 6) % 7   // days since Monday
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
}

function nextPeriod(d: Date, g: PeriodGranularity): Date {
  return g === 'month'
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7))
}

function periodLabels(d: Date, g: PeriodGranularity): { label: string; title: string } {
  const m = d.getUTCMonth(), y = d.getUTCFullYear()
  return g === 'month'
    ? { label: `${MONTH_SHORT[m]} ${y}`, title: `${MONTH_LONG[m]} ${y}` }
    : { label: `${MONTH_SHORT[m]} ${d.getUTCDate()}`, title: `Week of ${MONTH_SHORT[m]} ${d.getUTCDate()}, ${y}` }
}

/** The key one listing's evaluations share: its URL, else company|role. */
export function listingKey(e: Pick<ScoreEntry, 'url' | 'company' | 'role'>): string {
  const url = (e.url ?? '').trim()
  return url ? url : `${(e.company ?? '').trim().toLowerCase()}|${(e.role ?? '').trim().toLowerCase()}`
}

/** A strong match: the high-Match row of the verdict grid (Go,
 *  Stretch, Growth target): Match ≥ MATCH_HIGH and not blocked. */
export function isStrongMatch(e: Pick<ScoreEntry, 'match' | 'eligibility'>): boolean {
  return e.eligibility !== 'red' && e.match != null && Number.isFinite(e.match) && e.match >= MATCH_HIGH
}

export interface ByPeriodOptions {
  /** The listing's posting date (ISO day) when known; the listing is then
   *  placed in the period it was posted rather than first evaluated. */
  postedDate?: (e: ScoreEntry) => string | null | undefined
}

export function buildByPeriod(rows: ScoreEntry[], granularity: PeriodGranularity, opts: ByPeriodOptions = {}): PeriodBucket[] {
  // One entry per listing: its first evaluation date and its latest row. On a
  // same-day tie the later row in the file wins (it was written last).
  const listings = new Map<string, { first: string; latest: ScoreEntry }>()
  for (const r of rows) {
    if (!r.date || !parseDay(r.date)) continue
    const day = r.date.slice(0, 10)
    const key = listingKey(r)
    const seen = listings.get(key)
    if (!seen) { listings.set(key, { first: day, latest: r }); continue }
    if (day < seen.first) seen.first = day
    if (day >= seen.latest.date.slice(0, 10)) seen.latest = r
  }
  if (listings.size === 0) return []

  const groups = new Map<string, Array<{ e: ScoreEntry; posted: boolean }>>()
  for (const { first, latest } of listings.values()) {
    const postedRaw = opts.postedDate?.(latest)
    const postedOn = postedRaw ? parseDay(postedRaw) : null
    const start = isoDay(periodStart(postedOn ?? parseDay(first)!, granularity))
    const item = { e: latest, posted: postedOn != null }
    const list = groups.get(start)
    if (list) list.push(item)
    else groups.set(start, [item])
  }

  const starts = [...groups.keys()].sort()
  const last = starts[starts.length - 1]
  const out: PeriodBucket[] = []
  for (let d = parseDay(starts[0])!; isoDay(d) <= last; d = nextPeriod(d, granularity)) {
    const start = isoDay(d)
    const items = groups.get(start) ?? []
    const entries = items.map(i => i.e)
    const posted = items.filter(i => i.posted).length
    out.push({
      start,
      ...periodLabels(d, granularity),
      listings: entries.length,
      posted,
      evaluated: entries.length - posted,
      strongMatch: entries.filter(isStrongMatch).length,
      blocked: entries.filter(e => e.eligibility === 'red').length,
    })
  }
  return out
}

/** Weeks while the listings span at most MAX_WEEKS_FOR_WEEKLY weeks (a
 *  readable number of bars), months beyond. */
export const MAX_WEEKS_FOR_WEEKLY = 16

export function pickGranularity(rows: ScoreEntry[], opts: ByPeriodOptions = {}): PeriodGranularity {
  return buildByPeriod(rows, 'week', opts).length <= MAX_WEEKS_FOR_WEEKLY ? 'week' : 'month'
}

// ─── Top-X ranking ───────────────────────────────────────────────────────────
//
// "Top companies by Ease", "Top locations by Match", "Top archetypes by Ease":
// every list ranks on ONE named axis (v2 never folds Match and Ease into one
// number) and shows both, so the axis it is not ranked on is still visible.
// Each listing counts once, at its latest evaluation, so a re-evaluated role
// doesn't count twice. The averages are descriptive, stated with their n.

export type RankAxis = 'match' | 'ease'

export interface TopRow { label: string; count: number; avgMatch: number; avgEase: number }

// Skip useless labels — the score-history TSV uses "n/d" for unstated values
// and most files have a few legacy rows with empty / dash entries.
export const isNoiseLabel = (s: string): boolean => {
  const t = s.trim().toLowerCase()
  return !t || t === 'n/d' || t === '—' || t === '-' || t === 'unknown'
}

// A multi-city listing lists its places "; "-separated, the scored city first
// (modes/scouting.md), and Match's City score is computed for that city. So a
// listing's location for grouping is its FIRST listed place, with its country
// when that place named one: "Lyon, France; Vienna, Austria" → "Lyon, France",
// grouped with a plain "Lyon, France". The first segment is taken here, not
// via parseCities' primary, so the rule doesn't depend on its known-city list.
// Unusable fields ("Remote", "n/d") fall through unchanged.
export function primaryPlace(location: string): string {
  const raw = location ?? ''
  const first = raw
    .replace(/\([^)]*\)/g, '')
    .split(/\s*(?:;|\||·|•|\/)\s*/)
    .map(t => t.trim())
    .find(t => t && !/^remote$/i.test(t))
  if (!first) return raw.trim()
  const p = parseCities(first)
  const city = p.cities[0]
  if (!city) return raw.trim()
  return !p.isMulti && p.country && city !== p.country ? `${city}, ${p.country}` : city
}

/** One row per listing: its latest evaluation (undated rows rank oldest; a
 *  same-day tie goes to the later row in the file). */
export function latestPerListing(rows: ScoreEntry[]): ScoreEntry[] {
  const latest = new Map<string, ScoreEntry>()
  for (const r of rows) {
    const key = listingKey(r)
    const seen = latest.get(key)
    if (!seen || (r.date ?? '').slice(0, 10) >= (seen.date ?? '').slice(0, 10)) latest.set(key, r)
  }
  return [...latest.values()]
}

export function buildTopBy(
  rows: ScoreEntry[],
  key: (e: ScoreEntry) => string,
  rankBy: RankAxis,
  limit: number,
): TopRow[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const e of scoredOnly(latestPerListing(rows))) {
    const k = (key(e) ?? '').trim()
    if (isNoiseLabel(k)) continue
    const list = map.get(k)
    if (list) list.push(e)
    else map.set(k, [e])
  }
  const other: RankAxis = rankBy === 'match' ? 'ease' : 'match'
  const metric = (r: TopRow, axis: RankAxis) => (axis === 'match' ? r.avgMatch : r.avgEase)
  return [...map.entries()]
    .map(([label, entries]) => ({
      label,
      count: entries.length,
      avgMatch: avg(entries, 'match'),
      avgEase: avg(entries, 'ease'),
    }))
    // The named axis first; then the better-evidenced group, then the other axis.
    .sort((a, b) =>
      metric(b, rankBy) - metric(a, rankBy)
      || b.count - a.count
      || metric(b, other) - metric(a, other)
      || a.label.localeCompare(b.label))
    .slice(0, limit)
}

// ─── Scoring dimensions ──────────────────────────────────────────────────────
//
// The dimensions the momentum card reports shifts on, in display order.
// `field` is the ScoreEntry column; `label` is the human name.

export interface DimensionDef { field: keyof ScoreEntry; label: string }

export const PROFILE_DIMENSIONS: DimensionDef[] = [
  { field: 'match',              label: 'Match'           },
  { field: 'ease',              label: 'Ease'           },
  { field: 'skills_match',      label: 'Skills Match'   },
  { field: 'experience_bar',    label: 'Experience bar' },
  { field: 'brand_value',       label: 'Brand Value'    },
  { field: 'growth_mobility',   label: 'Growth'         },
  { field: 'role_content',      label: 'Role content'   },
  { field: 'work_life_balance', label: 'Work-Life'      },
]

// ─── Targeting momentum (recent vs earlier) ──────────────────────────────────
//
// The time chart plots a gated mean Match per period, which shows the level but
// not a verdict, and the funnel is a *static* snapshot over the whole window.
// Neither answers the question
// the tool actually exists to push on (TODO § directive: optimize toward
// outcomes): **as I refine what I evaluate, is the quality of what I evaluate
// trending up?**
//
// This splits the date-windowed, scored corpus in chronological order into two
// consecutive halves — an EARLIER half and a RECENT half — and contrasts them on
// the metrics that define "good targeting": the typical (median) Match and Ease,
// the share with an apply-worthy verdict, and the per-dimension averages. A rising
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
//   • a corpus whose scored rows all share one date has no timeline at all —
//     the chronological sort is a no-op and any "earlier" / "recent" split is
//     an arbitrary partition of same-day rows — so fewer than 2 distinct dates
//     is also `lowSignal`, however many rows there are;
//   • each metric's direction has a deadband (its v2 noise floor) so a trivial
//     wobble reads as "steady", not a trend.

// Minimum scored rows IN EACH HALF before the recent-vs-earlier delta is worth
// a verdict. This surface is declared in docs/scoring-statistical-design.md
// § 3.5 and its gate lives in the shared contract table — the median-based
// derivation (order-statistic breakdown, not the mean-based k ≥ 10 window
// rule) is argued there, not here. Re-exported under the local name so the
// card and its tests keep one import site.
export const MIN_PER_HALF_FOR_MOMENTUM = GATES.momentumMinPerHalf

// A median swing smaller than the metric's noise floor reads as flat — a
// sub-floor wobble between two small samples is noise, not a trend. Match and
// Ease each use their own floor (docs/scoring-v2.md §9).
export const MOMENTUM_DEADBANDS = { match: NOISE_FLOORS.match, ease: NOISE_FLOORS.ease } as const

export type MomentumDirection = 'improving' | 'steady' | 'declining'

export interface MomentumHalf {
  count: number
  medianMatch: number
  medianEase: number
  avgMatch: number
  avgEase: number
  applyPct: number       // % of this half with an apply-worthy verdict
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
  /** recent − earlier median Match / Ease — the two headline movements. */
  matchMedianDelta: number
  easeMedianDelta: number
  /** recent.applyPct - earlier.applyPct, in percentage points. */
  applyPctDelta: number
  matchDirection: MomentumDirection
  easeDirection: MomentumDirection
  /** Per-dimension recent-minus-earlier means, sorted by |delta| desc so the
   *  biggest movers (good or bad) lead. Only meaningful when !lowSignal. */
  dimShifts: MomentumDimShift[]
  scoredCount: number    // total scored rows feeding the split
  /** True when either half is under MIN_PER_HALF_FOR_MOMENTUM, or when the
   *  scored rows span fewer than 2 distinct dates (a same-day corpus has no
   *  "earlier" and "recent" half) — the view then shows a hint instead of
   *  reading noise as a trend. */
  lowSignal: boolean
}

function summarizeHalf(rows: ScoreEntry[]): MomentumHalf {
  const dated = rows.map(r => r.date?.slice(0, 10) ?? '').filter(Boolean).sort()
  const winners = rows.filter(isApplyWorthy).length
  return {
    count: rows.length,
    medianMatch: median(rows, 'match'),
    medianEase: median(rows, 'ease'),
    avgMatch: avg(rows, 'match'),
    avgEase: avg(rows, 'ease'),
    applyPct: rows.length ? Math.round((winners / rows.length) * 100) : 0,
    dateFrom: dated[0] ?? '',
    dateTo: dated[dated.length - 1] ?? '',
  }
}

// Pre-sort the scored corpus by date ascending, then split at the midpoint so
// the two halves carry equal n (the earlier half takes the extra row on an odd
// count). Rows are scored-only (blocked excluded, mirroring the
// time chart and top lists). Undated rows can't be placed on the timeline, so they're dropped from
// the split rather than silently anchored to one end.
export function buildTargetingMomentum(rows: ScoreEntry[]): TargetingMomentum {
  const scored = scoredOnly(rows)
    .filter(r => !!r.date)
    .slice()
    .sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)))

  const mid = Math.ceil(scored.length / 2)
  const earlierRows = scored.slice(0, mid)
  const recentRows = scored.slice(mid)

  const earlier = summarizeHalf(earlierRows)
  const recent = summarizeHalf(recentRows)

  // Same-day guard: with every scored row on one date the sort above is a
  // no-op, so the two halves are an arbitrary partition, not a timeline.
  const distinctDates = new Set(scored.map(r => r.date.slice(0, 10))).size

  const lowSignal =
    distinctDates < 2 ||
    earlierRows.length < MIN_PER_HALF_FOR_MOMENTUM ||
    recentRows.length < MIN_PER_HALF_FOR_MOMENTUM

  const matchMedianDelta = recent.medianMatch - earlier.medianMatch
  const easeMedianDelta = recent.medianEase - earlier.medianEase
  const applyPctDelta = recent.applyPct - earlier.applyPct

  // Direction off the median (robust to a single outlier listing), with the
  // metric's deadband so noise reads as steady. Forced to 'steady' under low
  // signal so a thin corpus never asserts a direction it can't support.
  const directionOf = (delta: number, band: number): MomentumDirection => {
    if (lowSignal) return 'steady'
    if (delta >= band) return 'improving'
    if (delta <= -band) return 'declining'
    return 'steady'
  }

  const dimShifts: MomentumDimShift[] = PROFILE_DIMENSIONS.map(({ field, label }) => {
    const earlierAvg = avg(earlierRows, field)
    const recentAvg = avg(recentRows, field)
    return { field, label, earlier: earlierAvg, recent: recentAvg, delta: recentAvg - earlierAvg }
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return {
    earlier, recent,
    matchMedianDelta, easeMedianDelta, applyPctDelta,
    matchDirection: directionOf(matchMedianDelta, MOMENTUM_DEADBANDS.match),
    easeDirection: directionOf(easeMedianDelta, MOMENTUM_DEADBANDS.ease),
    dimShifts,
    scoredCount: scored.length, lowSignal,
  }
}

// ─── Archetype mix over time ─────────────────────────────────────────────────
//
// The top lists rank archetypes by score and targeting momentum tracks whether
// quality is rising. Neither answers the orthogonal question — *where is my
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
//   • only real scored rows count (blocked excluded), and noise archetype labels are
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
  avgMatch: number        // mean Match for this archetype
  avgEase: number        // mean Ease for this archetype
  avgPriority: number    // mean Priority — the sort key
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
  /** Slices sorted by count desc (biggest focus first), then avgPriority. */
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
  // split only the dated subset and let undated rows ride in the totals.
  const scored = scoredOnly(rows)

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
      avgMatch: avg(b.entries, 'match'),
      avgEase: avg(b.entries, 'ease'),
      avgPriority: avgPriority(b.entries),
      earlierCount: b.earlier,
      recentCount: b.recent,
      earlierSharePct,
      recentSharePct,
      shareShift: lowSignal ? 0 : recentSharePct - earlierSharePct,
    }
  })
  // Biggest focus first; ties broken by quality so a high-scoring archetype
  // leads a same-count low-scoring one.
  slices.sort((a, b) => b.count - a.count || b.avgPriority - a.avgPriority || a.label.localeCompare(b.label))

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
