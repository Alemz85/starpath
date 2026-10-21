// Pure logic behind the Reports grid: verdict-band classification, the
// search/band filter, the multi-key sort, the facet counts, and the
// report→score-entry matcher. Extracted out of ReportsView.tsx so the
// banding rules and the fuzzy company/role match are unit-testable without
// rendering the view. Nothing here imports React.
//
// Scoring v2 (docs/scoring-v2.md §9): bands for display and sorting come
// from the VERDICT, never from thresholds on a number. The v1 Overall bands
// (Stellar / Strong / Decent / Pass) are retired with Overall itself.

import type { Eligibility, ScoreEntry, Verdict } from '@/types'
import { TIER_COLORS } from '@/types'
import { reportFixability, type Lever } from '@/lib/tierLevers'
import { assignVerdict, normalizeEligibility, normalizeVerdict, priorityOf, VERDICT_LABELS, VERDICT_RANK, VERDICT_TIER } from '@/lib/scoreBands'
import { tierColor } from '@/lib/tier'
import { reportKey } from '@/lib/reportMatch'

// ─── Verdict bands ───────────────────────────────────────────────────────────

export type ScoreBand = Verdict

// Stable display order, best → worst (spec §7 better-cell order, reversed).
// The chip row and facet counts both walk this.
export const ALL_BANDS: readonly ScoreBand[] = ['go', 'stretch', 'solid', 'growth', 'thin', 'skip', 'blocked'] as const

// Band chip styling: every verdict borrows its storage tier's tokens (spec §4
// verdict → tier). A verdict never gets a colour of its own (DESIGN-meta §
// Tier and Status Sections).
export const BAND_DETAILS: Record<ScoreBand, { label: string; color: string; bg: string; text: string; border: string }> =
  Object.fromEntries(ALL_BANDS.map(v => {
    const tier = VERDICT_TIER[v]
    return [v, { label: VERDICT_LABELS[v], color: tierColor(tier), ...TIER_COLORS[tier] }]
  })) as Record<ScoreBand, { label: string; color: string; bg: string; text: string; border: string }>

/** The verdict-carrying fields of a report row (DbReportRow satisfies it). */
export interface VerdictLike {
  tier: string
  match?: number | null
  ease?: number | null
  verdict?: string | null
  eligibility?: string | null
}

// A report's band: its stored verdict, else the grid replay of its Match/Ease
// (red eligibility → blocked), else — for an orphan report with no matching
// evaluation — the folder tier's representative cell (T1 go, T2 solid, T3
// growth, T4 skip). T2 holds three cells; `solid` is the neutral middle.
export function getScoreBand(row: VerdictLike): ScoreBand {
  const stored = normalizeVerdict(row.verdict)
  if (stored) return stored
  const elig = normalizeEligibility(row.eligibility)
  const replayed = assignVerdict({ match: row.match, ease: row.ease, eligibility: elig })
  if (replayed) return replayed.verdict
  const t = (row.tier ?? '').toUpperCase()
  if (t === 'T1') return 'go'
  if (t === 'T2') return 'solid'
  if (t === 'T3') return 'growth'
  return 'skip'
}

// ─── Fixability / near-miss ──────────────────────────────────────────────────
//
// The Reports list answers "where should I spend effort?" by ranking reports
// on how cheaply they could cross into a better verdict cell — the engine's
// cheapest single-change lever (tierLevers § reportFixability), run on the
// score-history entry the report resolves to.

export interface FixabilityRow extends ReportRowLike {
  /** The score-history entry this report resolved to (lib § matchScore), when
   *  one matched. When it carries every v2 dim, the near-miss / lever /
   *  ranking run through the SAME engine the Database uses. */
  scoreEntry?: ScoreEntry | null
}

export function reportRowFixability(row: FixabilityRow) {
  return reportFixability({ scoreEntry: row.scoreEntry })
}

// A 0–1 "how worth upgrading is this" score. Higher = cheaper, more actionable.
export function fixabilityScore(row: FixabilityRow): number {
  return reportRowFixability(row).fixabilityScore
}

// "Near-miss" predicate for the filter chip: the engine's one-step rule.
// `go`, blocked and unscored reports never qualify.
export function isNearMiss(row: FixabilityRow): boolean {
  if (getScoreBand(row) === 'go') return false
  return reportRowFixability(row).nearMiss
}

// The structured engine lever for a report row, or null.
export function reportEngineLever(row: FixabilityRow): Lever | null {
  return reportRowFixability(row).engineLever
}

// The next better band up the grid (for the "→ Stretch" hint), or null at
// the top / for blocked rows (no score change fixes eligibility).
export function nextBandUp(band: ScoreBand): ScoreBand | null {
  if (band === 'go' || band === 'blocked') return null
  const rank = VERDICT_RANK[band]
  const up = (Object.keys(VERDICT_RANK) as ScoreBand[])
    .filter(v => VERDICT_RANK[v] === rank + 1)[0]
  return up ?? null
}

// ─── Filtering / sorting ─────────────────────────────────────────────────────

// The fields the Reports grid actually reads — DbReportRow satisfies this, but
// keeping the lib's surface minimal means the tests don't have to build a full
// 9-field DbReportRow just to assert a sort.
export interface ReportRowLike extends VerdictLike {
  company: string
  role: string
  tier: string
  match: number | null
  ease: number | null
  priority?: number | null
  eligibility?: string | null
  mtime?: number
}

/** Priority for sorting (spec §5 — a sort key, never a headline). */
function rowPriority(r: ReportRowLike): number {
  const elig = normalizeEligibility(r.eligibility) as Eligibility | null
  return priorityOf({ priority: r.priority ?? null, match: r.match, ease: r.ease, eligibility: elig }) ?? -1
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
    out = out.filter(r => bands.has(getScoreBand(r)))
  }
  if (q) {
    out = out.filter(r => matchesQuery(r, q))
  }
  if (opts.nearMissOnly) {
    out = out.filter(r => isNearMiss(r))
  }
  return out
}

const TIER_SORT_ORDER = ['T1', 'T2', 'T3', 'T4']

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
      // Priority (sqrt(Match × Ease)); blocked/unscored rows sort last.
      comp = rowPriority(b) - rowPriority(a)
    } else if (sortBy === 'date') {
      comp = (b.mtime ?? 0) - (a.mtime ?? 0)
    } else if (sortBy === 'tier') {
      const ai = TIER_SORT_ORDER.indexOf(a.tier)
      const bi = TIER_SORT_ORDER.indexOf(b.tier)
      comp = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      // Within a tier, the better verdict cell first (T2 holds three cells).
      if (comp === 0) comp = VERDICT_RANK[getScoreBand(b)] - VERDICT_RANK[getScoreBand(a)]
    } else if (sortBy === 'fixable') {
      // Primary: fixability score (cheapest upgrade first under `desc`).
      // Tie-break on priority so two equally-fixable rows keep a stable,
      // meaningful order rather than falling back to array position.
      comp = fixabilityScore(b) - fixabilityScore(a)
      if (comp === 0) comp = rowPriority(b) - rowPriority(a)
    }
    return sortOrder === 'asc' ? -comp : comp
  })
  return sorted
}

// Which bands are present anywhere in the corpus — the stable chip set, so the
// view never renders a band chip that matches zero reports on disk.
export function corpusBands(rows: ReportRowLike[]): ScoreBand[] {
  const present = new Set<ScoreBand>()
  for (const r of rows) present.add(getScoreBand(r))
  return ALL_BANDS.filter(b => present.has(b))
}

// Per-band counts under the active search query but BEFORE the band selection
// itself (bands are an OR multi-select, so each chip's count shows how many
// reports it would add). Same facet-count rule the Database sidebar uses.
export function bandCounts(rows: ReportRowLike[], query = ''): Record<ScoreBand, number> {
  const q = query.trim().toLowerCase()
  const counts = Object.fromEntries(ALL_BANDS.map(b => [b, 0])) as Record<ScoreBand, number>
  for (const r of rows) {
    if (q && !matchesQuery(r, q)) continue
    counts[getScoreBand(r)]++
  }
  return counts
}

// ─── Report → score-entry matching ───────────────────────────────────────────

export interface ScoreIndex {
  byExact: Map<string, ScoreEntry>
  /** Keyed by the report file-name rule (lib/reportMatch § reportKey). */
  byKey: Map<string, ScoreEntry>
  /** Company (file-name rule) → its distinct role keys, in first-seen order. */
  byCompany: Map<string, string[]>
}

const companyKeyOf = (company: string) => reportKey(company, '').split('|')[0]

export function buildScoreIndex(scoreHistory: ScoreEntry[]): ScoreIndex {
  const byExact = new Map<string, ScoreEntry>()
  const byKey = new Map<string, ScoreEntry>()
  const byCompany = new Map<string, string[]>()
  for (const s of scoreHistory) {
    const c  = s.company.trim().toLowerCase()
    const ro = s.role.trim().toLowerCase()
    byExact.set(`${c}|${ro}`, s)
    const key = reportKey(s.company, s.role)
    byKey.set(key, s)
    const ck = companyKeyOf(s.company)
    const list = byCompany.get(ck)
    if (!list) byCompany.set(ck, [key])
    else if (!list.includes(key)) list.push(key)
  }
  return { byExact, byKey, byCompany }
}

// Resolve a report file to its score entry: exact company|role, then the same
// listing under the file-name rule (a report saved as "… Lyon" for the role
// "… (Lyon)"), then a role that is a prefix of (or prefixed by) the report's
// role at the same company — only when exactly one listing there fits. Never
// another listing's entry: an ambiguous or unknown report stays unscored (null).
export function matchScore(index: ScoreIndex, r: { company: string; role: string }): ScoreEntry | null {
  const c  = r.company.trim().toLowerCase()
  const ro = r.role.trim().toLowerCase()
  const exact = index.byExact.get(`${c}|${ro}`)
  if (exact) return exact
  const key = reportKey(r.company, r.role)
  const same = index.byKey.get(key)
  if (same) return same
  const ck = companyKeyOf(r.company)
  const roleKey = key.slice(ck.length + 1)
  if (!roleKey) return null
  const fits = (index.byCompany.get(ck) ?? []).filter(k => {
    const sr = k.slice(ck.length + 1)
    return sr.startsWith(roleKey) || roleKey.startsWith(sr)
  })
  return fits.length === 1 ? index.byKey.get(fits[0]) ?? null : null
}
