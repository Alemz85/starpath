// Database row pipeline — the pure dedupe → filter → group → faceted-count
// derivations behind DatabaseView.
//
// Extracted from the component so the Database's correctness-critical core (it
// drives the app's universal lens) is testable in isolation. Every function is
// pure: the view owns the zustand/IPC wiring and passes plain data in. Partners
// the already-extracted lib/databaseQuery.ts (the token matcher) — both go
// through `matchesTokenQuery` so the visible rows and the facet counts can
// never disagree about what a query selects.
//
// Filter/count shapes are declared locally (structurally compatible with
// FacetSidebar's FacetFilters / FacetCounts) so the dependency arrow stays
// lib → lib, never lib → component.

import type { ScoreEntry, ApplicationEntry } from '@/types'
import { ENGAGED_STATUSES } from '@/types'
import { canonicalizeArchetype } from './archetype'
import { parseCities, entityId, locationFacetValues, variantGroupKey } from './entityId'
import { matchesTokenQuery, type TokenFilters } from './databaseQuery'
import { livenessKey, type Liveness } from './scanHistory'
import { isBlocked, isScored, priorityOf, verdictOf } from './scoreBands'

export interface DbFilters {
  companies: Set<string>
  locations: Set<string>
  archetypes: Set<string>
  tiers: Set<string>
  /** Verdict keys (go / stretch / … / blocked). */
  verdicts: Set<string>
  /** green / amber / red. */
  eligibilities: Set<string>
  employmentTypes: Set<string>
  liveness: Set<Liveness>
  /** Per-axis ranges (scoring v2 has no Overall). A narrowed range keeps
   *  scored rows only — a blocked row has no Match/Ease to range over. */
  matchMin: number
  matchMax: number
  easeMin: number
  easeMax: number
}

export interface DbFacetOptions {
  companies: string[]
  locations: string[]
  archetypes: string[]
  tiers: string[]
  verdicts: string[]
  eligibilities: string[]
  employmentTypes: string[]
}

export interface DbFacetCounts {
  companies: Record<string, number>
  locations: Record<string, number>
  archetypes: Record<string, number>
  tiers: Record<string, number>
  verdicts: Record<string, number>
  eligibilities: Record<string, number>
  employmentTypes: Record<string, number>
  liveness: Record<string, number>
}

/** Verdict facet order: best cell first, Blocked last. */
export const VERDICT_FACET_ORDER = ['go', 'stretch', 'solid', 'growth', 'thin', 'skip', 'blocked']
export const ELIGIBILITY_FACET_ORDER = ['green', 'amber', 'red']

/** True when a range filter is narrowed from its 0–10 default. */
export function rangeActive(f: Pick<DbFilters, 'matchMin' | 'matchMax' | 'easeMin' | 'easeMax'>): boolean {
  return f.matchMin > 0 || f.matchMax < 10 || f.easeMin > 0 || f.easeMax < 10
}

function inRanges(r: ScoreEntry, f: DbFilters): boolean {
  if (!rangeActive(f)) return true
  if (!isScored(r)) return false
  const w = r.match as number
  const e = r.ease as number
  return w >= f.matchMin && w <= f.matchMax && e >= f.easeMin && e <= f.easeMax
}

/** A real evaluation: scored, or blocked (shown with its reason). Rows with
 *  neither (placeholders) are hidden unless the zero-score toggle is on. */
export function isEvaluated(r: ScoreEntry): boolean {
  return isScored(r) || isBlocked(r)
}

const verdictKey = (r: ScoreEntry): string => verdictOf(r) ?? ''
const eligKey = (r: ScoreEntry): string => r.eligibility ?? ''

// Global constraints that gate every facet dimension AND the rendered rows:
// the search tokens, free text, unevaluated-row toggle, Match/Ease ranges
// (inside `filters`), and the raw company|role → liveness map. `liveness` is
// resolved per row via livenessOf (defaulting to 'active' for unseen listings).
export interface DbGlobalContext {
  filters: DbFilters
  tokenFilters: TokenFilters
  freeText: string
  showClosed: boolean
  liveness: Record<string, Liveness>
}

// The full context adds the "Untapped only" lens (the set of already-engaged
// company|role keys + the toggle). It gates both the rendered rows AND the
// facet counts, so the two stay consistent.
export interface DbFilterContext extends DbGlobalContext {
  untappedOnly: boolean
  actedKeys: Set<string>
}

// Liveness of a single row, defaulting to 'active' when the listing was never
// seen in a scan — identical to the view's `livenessOf`.
export function livenessOf(e: ScoreEntry, liveness: Record<string, Liveness>): Liveness {
  return liveness[livenessKey(e.company, e.role)] ?? 'active'
}

// Dedupe score-history → one entity per (company, role, city); latest
// evaluation wins (max date; on a same-day tie the later row in the history,
// i.e. the newer re-score, wins — input arrives in file order). The unit every
// downstream derivation counts and renders, so options/counts/rows all agree
// on what "one listing" means.
export function dedupeEntities(scoreHistory: ScoreEntry[]): ScoreEntry[] {
  const m = new Map<string, ScoreEntry>()
  for (const r of scoreHistory) {
    const id = entityId(r.company, r.role, parseCities(r.location))
    const prev = m.get(id)
    if (!prev || r.date.localeCompare(prev.date) >= 0) m.set(id, r)
  }
  return [...m.values()]
}

// Facet option lists, built from raw score-history (pre-dedupe — the option
// universe is "every value that exists", independent of the current filter).
// Archetypes are bucketed via canonicalizeArchetype so the chips stay readable;
// multi-city listings surface under every one of their cities.
export function buildFacetOptions(scoreHistory: ScoreEntry[]): DbFacetOptions {
  return {
    companies:       [...new Set(scoreHistory.map(s => s.company))].sort(),
    locations:       [...new Set(scoreHistory.flatMap(s => locationFacetValues(s.location)))].sort(),
    archetypes:      [...new Set(scoreHistory.map(s => canonicalizeArchetype(s.archetype)).filter(Boolean))].sort(),
    tiers:           ['T1', 'T2', 'T3', 'T4'],
    verdicts:        VERDICT_FACET_ORDER,
    eligibilities:   ELIGIBILITY_FACET_ORDER,
    employmentTypes: [...new Set(scoreHistory.map(s => s.employment_type).filter(Boolean))].sort(),
  }
}

// Keys (company|role) of listings already engaged (Applied / Interview /
// Rejected …), for the "Untapped only" lens. Lowercased via livenessKey to
// match the entity rows.
export function buildActedKeys(applications: ApplicationEntry[]): Set<string> {
  const s = new Set<string>()
  for (const a of applications) {
    if (ENGAGED_STATUSES.has(a.status)) s.add(livenessKey(a.company, a.role))
  }
  return s
}

// Apply every entity-level filter and group siblings into parent rows. Output
// is one row per (company, role-canonical) group; each parent carries its
// `siblings` array (undefined when the group is a single entity) and its
// resolved `livenessState`, sorted by Priority desc (the v2 sort key; blocked
// rows have none and sort last). Liveness is applied at the
// GROUP level — a group is visible if ANY sibling's state is in the filter set
// — so a role with one closed and one active city still shows.
export function filterAndGroupEntities(entities: ScoreEntry[], ctx: DbFilterContext): ScoreEntry[] {
  const { filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness } = ctx
  const lvOf = (e: ScoreEntry) => livenessOf(e, liveness)

  let rows: ScoreEntry[] = entities

  if (!showClosed) rows = rows.filter(isEvaluated)
  if (untappedOnly) rows = rows.filter(r => !actedKeys.has(livenessKey(r.company, r.role)))
  if (filters.companies.size) rows = rows.filter(r => filters.companies.has(r.company))
  if (filters.locations.size) {
    rows = rows.filter(r => {
      const places = locationFacetValues(r.location)
      if (places.length === 0) return filters.locations.has(r.location)
      return places.some(c => filters.locations.has(c))
    })
  }
  if (filters.archetypes.size) rows = rows.filter(r => filters.archetypes.has(canonicalizeArchetype(r.archetype)))
  if (filters.tiers.size) rows = rows.filter(r => filters.tiers.has(r.tier))
  if (filters.verdicts.size) rows = rows.filter(r => filters.verdicts.has(verdictKey(r)))
  if (filters.eligibilities.size) rows = rows.filter(r => filters.eligibilities.has(eligKey(r)))
  if (filters.employmentTypes.size) rows = rows.filter(r => filters.employmentTypes.has(r.employment_type))
  rows = rows.filter(r => inRanges(r, filters))
  // Token search + free text via the shared matcher so this and the facet-count
  // predicate can't drift.
  rows = rows.filter(r => matchesTokenQuery(r, tokenFilters, freeText))

  // Group surviving entities into variant groups: the same role at one
  // company, differing only by location or language/market ("– Lyon, France"
  // vs "– Nantes, France", "– French Market" vs "– Polish Market"). Each
  // variant keeps its own entity; the group is one row with the rest nested.
  const groups = new Map<string, ScoreEntry[]>()
  for (const e of rows) {
    const roleKey = variantGroupKey(e.company, e.role, e.location)
    if (!groups.has(roleKey)) groups.set(roleKey, [])
    groups.get(roleKey)!.push(e)
  }

  const grouped: ScoreEntry[] = []
  for (const members of groups.values()) {
    const visible = members.some(m => filters.liveness.has(lvOf(m)))
    if (!visible) continue

    // Primary = best active sibling (highest Priority). If no active
    // siblings, fall back to most recent historical.
    const active = members.filter(m => lvOf(m) === 'active')
    const primary = active.length > 0
      ? [...active].sort((a, b) => prio(b) - prio(a))[0]
      : [...members].sort((a, b) => b.date.localeCompare(a.date))[0]

    const others = members.filter(m => m !== primary)
    grouped.push({
      ...primary,
      siblings: others.length > 0 ? others : undefined,
      livenessState: lvOf(primary),
    })
  }

  return grouped.sort((a, b) => prio(b) - prio(a))
}

/** Priority as a sort number; blocked/unscored rows sort below every score. */
function prio(e: ScoreEntry): number {
  return priorityOf(e) ?? -1
}

// Per-option facet counts (Amazon-style): each dimension is counted with every
// OTHER active facet applied but its own selection ignored, so a count answers
// "if I toggle this option, how many entities land?". Counted at the entity
// level to match the option universe. Global constraints (search tokens, free
// text, unevaluated toggle, Match/Ease ranges) gate every dimension.
//
// The "Untapped only" lens gates these counts too — like every faceted-search
// UI, a count must agree with the rows the user actually sees, so an already-
// engaged listing the row list hides is also excluded from the counts. (It's a
// global gate, not a per-dimension one — toggling it shrinks every facet
// equally rather than answering a what-if for one dimension.)
export function computeFacetCounts(entities: ScoreEntry[], ctx: DbFilterContext): DbFacetCounts {
  const { filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness } = ctx
  const lvOf = (e: ScoreEntry) => livenessOf(e, liveness)

  const passGlobal = (r: ScoreEntry): boolean => {
    if (!showClosed && !isEvaluated(r)) return false
    if (untappedOnly && actedKeys.has(livenessKey(r.company, r.role))) return false
    if (!inRanges(r, filters)) return false
    return matchesTokenQuery(r, tokenFilters, freeText)
  }

  // One predicate + one bucketing per facet dimension. A dimension's count is
  // taken with every OTHER dimension's selection applied, its own ignored.
  type Dim = { pass: (r: ScoreEntry) => boolean; keys: (r: ScoreEntry) => string[]; out: Record<string, number> }
  const set = (sel: Set<string>, k: string) => !sel.size || sel.has(k)
  const dims: Record<keyof DbFacetCounts, Dim> = {
    companies: { pass: r => set(filters.companies, r.company), keys: r => [r.company], out: {} },
    locations: {
      pass: r => {
        if (!filters.locations.size) return true
        const places = locationFacetValues(r.location)
        return places.length === 0 ? filters.locations.has(r.location) : places.some(c => filters.locations.has(c))
      },
      keys: r => { const c = locationFacetValues(r.location); return c.length ? c : [r.location] },
      out: {},
    },
    archetypes: { pass: r => set(filters.archetypes, canonicalizeArchetype(r.archetype)), keys: r => [canonicalizeArchetype(r.archetype)], out: {} },
    tiers: { pass: r => set(filters.tiers, r.tier), keys: r => [r.tier], out: {} },
    verdicts: { pass: r => set(filters.verdicts, verdictKey(r)), keys: r => [verdictKey(r)], out: {} },
    eligibilities: { pass: r => set(filters.eligibilities, eligKey(r)), keys: r => [eligKey(r)], out: {} },
    employmentTypes: { pass: r => set(filters.employmentTypes, r.employment_type), keys: r => [r.employment_type], out: {} },
    liveness: { pass: r => (filters.liveness as Set<string>).has(lvOf(r)), keys: r => [lvOf(r)], out: {} },
  }
  const names = Object.keys(dims) as Array<keyof DbFacetCounts>

  for (const r of entities) {
    if (!passGlobal(r)) continue
    const passes = names.map(n => dims[n].pass(r))
    names.forEach((n, i) => {
      if (!passes.every((p, j) => j === i || p)) return
      for (const k of dims[n].keys(r)) if (k) dims[n].out[k] = (dims[n].out[k] ?? 0) + 1
    })
  }
  return Object.fromEntries(names.map(n => [n, dims[n].out])) as unknown as DbFacetCounts
}

// Flatten grouped rows back to one entity per line for export — the table
// collapses a role's cities into a single parent, but a CSV should carry every
// evaluated city with its own score. Resolves each sibling's livenessState.
export function flattenForExport(grouped: ScoreEntry[], liveness: Record<string, Liveness>): ScoreEntry[] {
  const out: ScoreEntry[] = []
  for (const group of grouped) {
    out.push(group)
    for (const sib of group.siblings ?? []) {
      out.push(sib.livenessState ? sib : { ...sib, livenessState: livenessOf(sib, liveness) })
    }
  }
  return out
}
