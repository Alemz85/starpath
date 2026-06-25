// Pure logic behind the Reports grid: score-band classification, the
// search/band filter, the multi-key sort, the facet counts, and the
// report→score-entry matcher. Extracted out of ReportsView.tsx so the
// banding rules and the fuzzy company/role match are unit-testable without
// rendering the view. Nothing here imports React.
//
// The matcher mirrors the same exact→prefix→best-overall fallback the view
// used inline, so a report card resolves to the same score entry it always
// did — just now with a test pinning each tier of the fallback.

import type { ScoreEntry } from '@/types'

// ─── Score bands ─────────────────────────────────────────────────────────────

export type ScoreBand = 'stellar' | 'strong' | 'decent' | 'pass' | 'skip'

// Stable display order, high → low. The chip row and facet counts both walk
// this so the bands always render in the same order.
export const ALL_BANDS: readonly ScoreBand[] = ['stellar', 'strong', 'decent', 'pass', 'skip'] as const

export const BAND_DETAILS: Record<ScoreBand, { label: string; color: string; bg: string; text: string; border: string }> = {
  stellar: { label: 'Stellar (≥9.0)', color: '#2EB8A8', bg: 'bg-[#2EB8A8]/12', text: 'text-[#2EB8A8]', border: 'border-[#2EB8A8]/35' },
  strong:  { label: 'Strong (8.0-8.9)', color: '#3D2BB5', bg: 'bg-[#3D2BB5]/12', text: 'text-[#3D2BB5]', border: 'border-[#3D2BB5]/35' },
  decent:  { label: 'Decent (7.0-7.9)', color: '#7C5CFF', bg: 'bg-[#7C5CFF]/12', text: 'text-[#7C5CFF]', border: 'border-[#7C5CFF]/35' },
  pass:    { label: 'Pass (<7.0)', color: '#A89CD9', bg: 'bg-[#A89CD9]/12', text: 'text-[#A89CD9]', border: 'border-[#A89CD9]/35' },
  skip:    { label: 'Skip', color: '#94A3B8', bg: 'bg-[#94A3B8]/12', text: 'text-[#94A3B8]', border: 'border-[#94A3B8]/35' },
}

// Classify a report by its Overall score, falling back to its tier when the
// score is missing/zero (T3/T4 listings often have no scored overall on disk).
export function getScoreBand(overall: number | null | undefined, tier: string): ScoreBand {
  if (overall !== null && overall !== undefined && overall > 0) {
    if (overall >= 9.0) return 'stellar'
    if (overall >= 8.0) return 'strong'
    if (overall >= 7.0) return 'decent'
    if (overall >= 5.0) return 'pass'
    return 'skip'
  }
  // Fallback to tier mapping
  const t = tier.toUpperCase()
  if (t === 'T1') return 'stellar'
  if (t === 'T2-HIGH') return 'strong'
  if (t === 'T2') return 'decent'
  if (t === 'T3') return 'pass'
  return 'skip'
}

// ─── Fixability / near-miss ──────────────────────────────────────────────────
//
// The Reports list answers "where should I spend effort?" by ranking reports on
// how cheaply they could cross into a better tier. Two ingredients:
//
//   1. distance to the next band up (purely from the Overall score), and
//   2. whether the report's own Why-this-score block names a concrete lever.
//
// A T3 sitting at 6.9 with a named lever is the canonical "easiest near-miss":
// one tenth from the next band AND the engine already told us which dimension
// to raise. We surface those first.

// Lower edge of each band (inclusive) on the 0–10 Overall scale. Mirrors the
// thresholds in getScoreBand so the two never drift.
const BAND_FLOOR: Record<ScoreBand, number> = {
  stellar: 9.0, strong: 8.0, decent: 7.0, pass: 5.0, skip: 0,
}

// The band immediately above each band (the upgrade target). `stellar` is the
// ceiling — nothing above it.
const NEXT_BAND_UP: Record<ScoreBand, ScoreBand | null> = {
  skip: 'pass', pass: 'decent', decent: 'strong', strong: 'stellar', stellar: null,
}

// Points an Overall score must gain to reach the next band's floor. Null when
// already in the top band (stellar) — no upgrade target exists. Returns null
// for reports with no usable overall (can't measure a distance).
export function distanceToNextBand(overall: number | null | undefined, tier: string): number | null {
  if (overall === null || overall === undefined || overall <= 0) return null
  const band = getScoreBand(overall, tier)
  const next = NEXT_BAND_UP[band]
  if (!next) return null
  return Math.max(0, +(BAND_FLOOR[next] - overall).toFixed(2))
}

// The optional fixability signal a report carries once its body has been parsed
// (the list rows themselves don't include the body — see ReportsView). Only the
// fields the ranking needs.
export interface Fixability {
  /** A concrete cheapest-lever sentence exists in the report's Why block. */
  hasLever: boolean
  /** The binding-constraint sentence, when present (for the badge). */
  bindingConstraint?: string | null
  /** The lever sentence, when present (for the badge). */
  lever?: string | null
}

export interface FixabilityRow extends ReportRowLike {
  fixability?: Fixability | null
}

// A 0–1 "how worth upgrading is this" score. Higher = cheaper, more actionable.
//   • Distance to the next band drives the base: 0 points away → ~1.0, a full
//     band away (1.0) → ~0.0, linearly. Already-top / unscored → 0.
//   • A named lever multiplies confidence: the engine found a single dimension
//     that crosses the band, so we weight those well above mere proximity.
// Reports with no upgrade target (stellar) or no overall score score 0 — they
// don't belong in a "near-miss to upgrade" ranking.
export function fixabilityScore(row: FixabilityRow): number {
  const dist = distanceToNextBand(row.overall, row.tier)
  if (dist === null) return 0
  // Map distance → proximity in [0,1]. Bands are ≤1.0 wide for pass/decent/
  // strong; clamp so anything ≥1.0 away contributes nothing.
  const proximity = Math.max(0, 1 - dist)
  const hasLever = row.fixability?.hasLever ?? false
  // Lever present: proximity dominates but a real lever guarantees a strong
  // floor (0.55) so a clearly-actionable report never sinks below a barely-
  // closer one with no lever. No lever: proximity alone, dampened to 0.6 so
  // lever-backed near-misses always outrank lever-less ones at equal distance.
  return hasLever
    ? 0.55 + 0.45 * proximity
    : 0.6 * proximity
}

// "Near-miss" predicate for the filter chip: a report within `maxDistance`
// (default 0.5) of the next band up, OR any report that carries a concrete
// lever (the engine says one dimension crosses — actionable regardless of the
// raw gap). Stellar / unscored reports are never near-misses.
export function isNearMiss(row: FixabilityRow, maxDistance = 0.5): boolean {
  const dist = distanceToNextBand(row.overall, row.tier)
  if (dist === null) return false
  if (row.fixability?.hasLever) return true
  return dist <= maxDistance
}

// ─── Filtering / sorting ─────────────────────────────────────────────────────

// The fields the Reports grid actually reads — DbReportRow satisfies this, but
// keeping the lib's surface minimal means the tests don't have to build a full
// 9-field DbReportRow just to assert a sort.
export interface ReportRowLike {
  company: string
  role: string
  tier: string
  overall: number | null
  mtime?: number
}

export type ReportSortBy = 'score' | 'date' | 'tier' | 'fixable'
export type SortOrder = 'asc' | 'desc'

const matchesQuery = (r: { company: string; role: string }, q: string): boolean =>
  r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)

// Apply the search query + band multi-select (OR within bands) + the optional
// near-miss filter. An empty band set means "all bands"; an empty query means
// "no text filter"; `nearMissOnly` keeps only reports one cheap lever / a small
// gap from the next band up.
export function filterReportRows<T extends FixabilityRow>(
  rows: T[],
  opts: { query?: string; bands?: ReadonlySet<ScoreBand>; nearMissOnly?: boolean },
): T[] {
  const bands = opts.bands
  const q = (opts.query ?? '').trim().toLowerCase()
  let out = rows
  if (bands && bands.size > 0) {
    out = out.filter(r => bands.has(getScoreBand(r.overall, r.tier)))
  }
  if (q) {
    out = out.filter(r => matchesQuery(r, q))
  }
  if (opts.nearMissOnly) {
    out = out.filter(r => isNearMiss(r))
  }
  return out
}

const TIER_SORT_ORDER = ['T1', 'T2-high', 'T2', 'T3', 'T4']

// Stable multi-key sort. `desc` is the natural reading for every key (highest
// score / newest / best tier first), so `asc` simply flips the comparator.
// Returns a new array; never mutates the input.
export function sortReportRows<T extends FixabilityRow>(
  rows: T[],
  sortBy: ReportSortBy,
  sortOrder: SortOrder,
): T[] {
  const sorted = [...rows].sort((a, b) => {
    let comp = 0
    if (sortBy === 'score') {
      comp = (b.overall ?? 0) - (a.overall ?? 0)
    } else if (sortBy === 'date') {
      comp = (b.mtime ?? 0) - (a.mtime ?? 0)
    } else if (sortBy === 'tier') {
      const ai = TIER_SORT_ORDER.indexOf(a.tier)
      const bi = TIER_SORT_ORDER.indexOf(b.tier)
      comp = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    } else if (sortBy === 'fixable') {
      // Primary: fixability score (cheapest upgrade first under `desc`).
      // Tie-break on raw overall so two equally-fixable rows keep a stable,
      // meaningful order rather than falling back to array position.
      comp = fixabilityScore(b) - fixabilityScore(a)
      if (comp === 0) comp = (b.overall ?? 0) - (a.overall ?? 0)
    }
    return sortOrder === 'asc' ? -comp : comp
  })
  return sorted
}

// Which bands are present anywhere in the corpus — the stable chip set, so the
// view never renders a band chip that matches zero reports on disk.
export function corpusBands(rows: ReportRowLike[]): ScoreBand[] {
  const present = new Set<ScoreBand>()
  for (const r of rows) present.add(getScoreBand(r.overall, r.tier))
  return ALL_BANDS.filter(b => present.has(b))
}

// Per-band counts under the active search query but BEFORE the band selection
// itself (bands are an OR multi-select, so each chip's count shows how many
// reports it would add). Same facet-count rule the Database sidebar uses.
export function bandCounts(rows: ReportRowLike[], query = ''): Record<ScoreBand, number> {
  const q = query.trim().toLowerCase()
  const counts: Record<ScoreBand, number> = { stellar: 0, strong: 0, decent: 0, pass: 0, skip: 0 }
  for (const r of rows) {
    if (q && !matchesQuery(r, q)) continue
    counts[getScoreBand(r.overall, r.tier)]++
  }
  return counts
}

// ─── Report → score-entry matching ───────────────────────────────────────────

export interface ScoreIndex {
  byExact: Map<string, ScoreEntry>
  byCompany: Map<string, ScoreEntry[]>
}

export function buildScoreIndex(scoreHistory: ScoreEntry[]): ScoreIndex {
  const byExact = new Map<string, ScoreEntry>()
  const byCompany = new Map<string, ScoreEntry[]>()
  for (const s of scoreHistory) {
    const c  = s.company.trim().toLowerCase()
    const ro = s.role.trim().toLowerCase()
    byExact.set(`${c}|${ro}`, s)
    const list = byCompany.get(c)
    if (list) list.push(s)
    else byCompany.set(c, [s])
  }
  return { byExact, byCompany }
}

// Resolve a report file to its score entry. Three-tier fallback: exact
// company|role, then a role that is a prefix of (or prefixed by) the report's
// role within the same company, then the company's highest-overall entry.
// Returns null when the company isn't in score-history at all.
export function matchScore(index: ScoreIndex, r: { company: string; role: string }): ScoreEntry | null {
  const c  = r.company.trim().toLowerCase()
  const ro = r.role.trim().toLowerCase()
  const exact = index.byExact.get(`${c}|${ro}`)
  if (exact) return exact
  const list = index.byCompany.get(c)
  if (!list || list.length === 0) return null
  const prefix = list.find(s => {
    const sr = s.role.trim().toLowerCase()
    return sr.startsWith(ro) || ro.startsWith(sr)
  })
  if (prefix) return prefix
  let best: ScoreEntry | null = null
  for (const s of list) {
    if (!best || s.overall > best.overall) best = s
  }
  return best
}
