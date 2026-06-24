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
import { parseCities, entityId } from './entityId'
import { matchesTokenQuery, type TokenFilters } from './databaseQuery'
import { livenessKey, type Liveness } from './scanHistory'

export interface DbFilters {
  companies: Set<string>
  locations: Set<string>
  archetypes: Set<string>
  tiers: Set<string>
  employmentTypes: Set<string>
  liveness: Set<Liveness>
  scoreMin: number
  scoreMax: number
}

export interface DbFacetOptions {
  companies: string[]
  locations: string[]
  archetypes: string[]
  tiers: string[]
  employmentTypes: string[]
}

export interface DbFacetCounts {
  companies: Record<string, number>
  locations: Record<string, number>
  archetypes: Record<string, number>
  tiers: Record<string, number>
  employmentTypes: Record<string, number>
  liveness: Record<string, number>
}

// Global constraints that gate every facet dimension AND the rendered rows:
// the search tokens, free text, zero-score toggle, score range (inside
// `filters`), and the raw company|role → liveness map. `liveness` is resolved
// per row via livenessOf (defaulting to 'active' for unseen listings).
export interface DbGlobalContext {
  filters: DbFilters
  tokenFilters: TokenFilters
  freeText: string
  showClosed: boolean
  liveness: Record<string, Liveness>
}

// The full row context adds the "Untapped only" lens, which gates the rendered
// rows but NOT the facet counts (see computeFacetCounts).
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
// evaluation wins (max date). The unit every downstream derivation counts and
// renders, so options/counts/rows all agree on what "one listing" means.
export function dedupeEntities(scoreHistory: ScoreEntry[]): ScoreEntry[] {
  const m = new Map<string, ScoreEntry>()
  for (const r of scoreHistory) {
    const id = entityId(r.company, r.role, parseCities(r.location))
    const prev = m.get(id)
    if (!prev || r.date.localeCompare(prev.date) > 0) m.set(id, r)
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
    locations:       [...new Set(scoreHistory.flatMap(s => parseCities(s.location).cities))].sort(),
    archetypes:      [...new Set(scoreHistory.map(s => canonicalizeArchetype(s.archetype)).filter(Boolean))].sort(),
    tiers:           ['T1', 'T2-high', 'T2', 'T3', 'T4'],
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
// resolved `livenessState`, sorted by overall desc. Liveness is applied at the
// GROUP level — a group is visible if ANY sibling's state is in the filter set
// — so a role with one closed and one active city still shows.
export function filterAndGroupEntities(entities: ScoreEntry[], ctx: DbFilterContext): ScoreEntry[] {
  const { filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness } = ctx
  const lvOf = (e: ScoreEntry) => livenessOf(e, liveness)

  let rows: ScoreEntry[] = entities

  if (!showClosed) rows = rows.filter(r => r.overall > 0)
  if (untappedOnly) rows = rows.filter(r => !actedKeys.has(livenessKey(r.company, r.role)))
  if (filters.companies.size) rows = rows.filter(r => filters.companies.has(r.company))
  if (filters.locations.size) {
    rows = rows.filter(r => {
      const cities = parseCities(r.location).cities
      if (cities.length === 0) return filters.locations.has(r.location)
      return cities.some(c => filters.locations.has(c))
    })
  }
  if (filters.archetypes.size) rows = rows.filter(r => filters.archetypes.has(canonicalizeArchetype(r.archetype)))
  if (filters.tiers.size) {
    rows = rows.filter(r => filters.tiers.has(r.tier) || (r.tier === 'T2-high' && filters.tiers.has('T2')))
  }
  if (filters.employmentTypes.size) rows = rows.filter(r => filters.employmentTypes.has(r.employment_type))
  if (filters.scoreMin > 0 || filters.scoreMax < 10) {
    rows = rows.filter(r => r.overall >= filters.scoreMin && r.overall <= filters.scoreMax)
  }
  // Token search + free text via the shared matcher so this and the facet-count
  // predicate can't drift.
  rows = rows.filter(r => matchesTokenQuery(r, tokenFilters, freeText))

  // Group surviving entities by roleKey (entity_id minus the `::city` suffix)
  // so the same role across multiple cities falls into one bucket.
  const groups = new Map<string, ScoreEntry[]>()
  for (const e of rows) {
    const id = entityId(e.company, e.role, parseCities(e.location))
    const roleKey = id.split('::').slice(0, 2).join('::')
    if (!groups.has(roleKey)) groups.set(roleKey, [])
    groups.get(roleKey)!.push(e)
  }

  const grouped: ScoreEntry[] = []
  for (const members of groups.values()) {
    const visible = members.some(m => filters.liveness.has(lvOf(m)))
    if (!visible) continue

    // Primary = best active sibling (highest overall). If no active siblings,
    // fall back to most recent historical.
    const active = members.filter(m => lvOf(m) === 'active')
    const primary = active.length > 0
      ? [...active].sort((a, b) => b.overall - a.overall)[0]
      : [...members].sort((a, b) => b.date.localeCompare(a.date))[0]

    const others = members.filter(m => m !== primary)
    grouped.push({
      ...primary,
      siblings: others.length > 0 ? others : undefined,
      livenessState: lvOf(primary),
    })
  }

  return grouped.sort((a, b) => b.overall - a.overall)
}

// Per-option facet counts (Amazon-style): each dimension is counted with every
// OTHER active facet applied but its own selection ignored, so a count answers
// "if I toggle this option, how many entities land?". Counted at the entity
// level to match the option universe. Global constraints (search tokens, free
// text, zero-score toggle, score range) gate every dimension.
//
// NB (preserved from the component): the "Untapped only" lens does NOT gate
// these counts — only the rendered rows. So with that lens on, a facet count
// can exceed the visible row count. Intentional carry-over, not a fix target
// for this extraction.
export function computeFacetCounts(entities: ScoreEntry[], ctx: DbGlobalContext): DbFacetCounts {
  const { filters, tokenFilters, freeText, showClosed, liveness } = ctx
  const lvOf = (e: ScoreEntry) => livenessOf(e, liveness)

  const passGlobal = (r: ScoreEntry): boolean => {
    if (!showClosed && !(r.overall > 0)) return false
    if (r.overall < filters.scoreMin || r.overall > filters.scoreMax) return false
    return matchesTokenQuery(r, tokenFilters, freeText)
  }

  const passCompany   = (r: ScoreEntry) => !filters.companies.size || filters.companies.has(r.company)
  const passLocation  = (r: ScoreEntry) => {
    if (!filters.locations.size) return true
    const cities = parseCities(r.location).cities
    return cities.length === 0 ? filters.locations.has(r.location) : cities.some(c => filters.locations.has(c))
  }
  const passArchetype = (r: ScoreEntry) => !filters.archetypes.size || filters.archetypes.has(canonicalizeArchetype(r.archetype))
  const passTier      = (r: ScoreEntry) => !filters.tiers.size || filters.tiers.has(r.tier) || (r.tier === 'T2-high' && filters.tiers.has('T2'))
  const passType      = (r: ScoreEntry) => !filters.employmentTypes.size || filters.employmentTypes.has(r.employment_type)
  const passLiveness  = (r: ScoreEntry) => filters.liveness.has(lvOf(r))

  const companies: Record<string, number> = {}
  const locations: Record<string, number> = {}
  const archetypes: Record<string, number> = {}
  const tiers: Record<string, number> = {}
  const employmentTypes: Record<string, number> = {}
  const liv: Record<string, number> = {}
  const bump = (m: Record<string, number>, k: string) => { if (k) m[k] = (m[k] ?? 0) + 1 }

  for (const r of entities) {
    if (!passGlobal(r)) continue
    if (passLocation(r) && passArchetype(r) && passTier(r) && passType(r) && passLiveness(r)) bump(companies, r.company)
    if (passCompany(r) && passArchetype(r) && passTier(r) && passType(r) && passLiveness(r)) {
      const cities = parseCities(r.location).cities
      for (const c of (cities.length ? cities : [r.location])) bump(locations, c)
    }
    if (passCompany(r) && passLocation(r) && passTier(r) && passType(r) && passLiveness(r)) bump(archetypes, canonicalizeArchetype(r.archetype))
    if (passCompany(r) && passLocation(r) && passArchetype(r) && passType(r) && passLiveness(r)) bump(tiers, r.tier === 'T2-high' ? 'T2' : r.tier)
    if (passCompany(r) && passLocation(r) && passArchetype(r) && passTier(r) && passLiveness(r)) bump(employmentTypes, r.employment_type)
    if (passCompany(r) && passLocation(r) && passArchetype(r) && passTier(r) && passType(r)) bump(liv, lvOf(r))
  }
  return { companies, locations, archetypes, tiers, employmentTypes, liveness: liv }
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
