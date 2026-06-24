'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useDatabaseFilters } from '@/store/databaseFilters'
import { FacetSidebar } from '@/components/shared/FacetSidebar'
import { FilterBar } from './FilterBar'
import { OffersTable } from './OffersTable'
import { ExportMenu } from './ExportMenu'
import { ReportSlideOver } from '../reports/ReportSlideOver'
import { RowActionPopover } from '@/components/shared/RowActionPopover'
import { canonicalizeArchetype } from '@/lib/archetype'
import { parseCities, entityId } from '@/lib/entityId'
import { parseTokenQuery, matchesTokenQuery } from '@/lib/databaseQuery'
import type { ScoreEntry } from '@/types'
import { ENGAGED_STATUSES } from '@/types'

export function DatabaseView() {
  const scoreHistoryRaw = useDataStore(s => s.scoreHistory)
  const liveness = useDataStore(s => s.liveness)
  const loaded = useDataStore(s => s.loaded)
  const discarded = useDataStore(s => s.discarded)
  const applications = useDataStore(s => s.applications)
  const databaseFilter = useNavStore(s => s.databaseFilter)

  // "Untapped only" — hide listings already engaged (applied / interviewing /
  // rejected …) so the table shows only scored-but-not-yet-pursued roles.
  // Local UI state (not persisted like the facet store) — it's a transient
  // "help me find what's left to chase" lens, reset on relaunch.
  const [untappedOnly, setUntappedOnly] = useState(false)

  // Drop tombstoned rows up-front. The tombstone set is keyed by
  // livenessKey(company, role) — identical to the key used for the
  // liveness lookup, so the popover's "Mark not interested" click hides
  // every sibling row of the same listing in one shot. Memo only on the
  // two inputs so unrelated re-renders don't re-walk the array.
  const scoreHistory = useMemo(
    () => discarded.size === 0
      ? scoreHistoryRaw
      : scoreHistoryRaw.filter(r => !discarded.has(`${r.company.trim().toLowerCase()}|${r.role.trim().toLowerCase()}`)),
    [scoreHistoryRaw, discarded],
  )

  // Filter state lives in a Zustand store (useDatabaseFilters) so the
  // user's chip / search / show-closed selections survive tab switches.
  const filters       = useDatabaseFilters(s => s.filters)
  const setFilters    = useDatabaseFilters(s => s.setFilters)
  const query         = useDatabaseFilters(s => s.query)
  const setQuery      = useDatabaseFilters(s => s.setQuery)
  const showClosed    = useDatabaseFilters(s => s.showClosed)
  const setShowClosed = useDatabaseFilters(s => s.setShowClosed)
  const applyCommandKFilter = useDatabaseFilters(s => s.applyCommandKFilter)

  // CmdK / nav-store hop: when the user navigates here with a
  // databaseFilter (e.g., clicks a company in CmdK or "View in Database"
  // from a slide-over), we apply that company filter once. Without the
  // guard, the effect would keep re-applying on every render and stomp
  // any subsequent user edits.
  useEffect(() => {
    if (databaseFilter) applyCommandKFilter(databaseFilter)
  }, [databaseFilter, applyCommandKFilter])

  const [selectedEntry, setSelectedEntry] = useState<ScoreEntry | null>(null)
  const [popoverState, setPopoverState] = useState<{ entry: ScoreEntry; anchor: { x: number; y: number } } | null>(null)
  const [facetExpanded] = useState(true)

  // Build facet options from data. Archetypes are bucketed via
  // canonicalizeArchetype — backend modes keep verbose strings (useful for
  // the AI agents); the database UI groups them into common roles so the
  // chips stay readable and the filter is meaningful.
  // Multi-city entities (one URL listing multiple cities, e.g. Rev-celerator
  // listing Berlin/Paris/London/Lisbon) need to surface under EVERY listed
  // city in the location facet — filtering by any one of them must still
  // include the entity. parseCities is the single source of truth for that
  // expansion, used here for the facet options and again below for the
  // filter predicate.
  const options = useMemo(() => ({
    companies:       [...new Set(scoreHistory.map(s => s.company))].sort(),
    locations:       [...new Set(
                       scoreHistory.flatMap(s => parseCities(s.location).cities)
                     )].sort(),
    archetypes:      [...new Set(
                       scoreHistory.map(s => canonicalizeArchetype(s.archetype)).filter(Boolean)
                     )].sort(),
    tiers:           ['T1', 'T2-high', 'T2', 'T3', 'T4'],
    employmentTypes: [...new Set(scoreHistory.map(s => s.employment_type).filter(Boolean))].sort(),
  }), [scoreHistory])

  // Parse token query
  const { tokenFilters, freeText } = useMemo(() => parseTokenQuery(query), [query])

  // Liveness lookup helper, applied identically by the filter, the
  // group's primary picker, and the historical-greying renderer.
  const livenessOf = useCallback((e: ScoreEntry): 'active' | 'stale' | 'closed' => {
    const key = `${e.company.trim().toLowerCase()}|${e.role.trim().toLowerCase()}`
    return liveness[key] ?? 'active'
  }, [liveness])

  // Keys (company|role) of listings already engaged — feeds the "Untapped
  // only" filter below. Built from applications.md, lowercased to match the
  // entity rows (same keying as the liveness / discard maps).
  const actedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const a of applications) {
      if (ENGAGED_STATUSES.has(a.status)) s.add(`${a.company.trim().toLowerCase()}|${a.role.trim().toLowerCase()}`)
    }
    return s
  }, [applications])

  // Dedupe scoreHistory → one entity per (company, role, city), latest
  // evaluation wins (max date). Lifted out of the `filtered` memo so the
  // faceted counts below count the same units the table renders, without
  // re-walking scoreHistory twice.
  const entities = useMemo(() => {
    const m = new Map<string, ScoreEntry>()
    for (const r of scoreHistory) {
      const id = entityId(r.company, r.role, parseCities(r.location))
      const prev = m.get(id)
      if (!prev || r.date.localeCompare(prev.date) > 0) m.set(id, r)
    }
    return [...m.values()]
  }, [scoreHistory])

  // Apply all filters and group siblings into parent rows. The output
  // is one row per (company, role-canonical) group; each row carries
  // a `siblings` array for the OffersTable's expansion to render. A
  // group with only one entity falls through as a flat row (siblings
  // empty), looking exactly like the pre-grouping table.
  const filtered = useMemo(() => {
    let rows: ScoreEntry[] = entities

    // 2. Apply entity-level filters (everything except liveness, which
    //    is applied at the GROUP level below so a group is visible if
    //    ANY of its siblings matches the liveness chip set).
    if (!showClosed) rows = rows.filter(r => r.overall > 0)
    if (untappedOnly) rows = rows.filter(r => !actedKeys.has(`${r.company.trim().toLowerCase()}|${r.role.trim().toLowerCase()}`))
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
    // Token search (`company:…`, `tier:…`, `min-score:…`) + free text, via the
    // shared matcher so this and the facet-count predicate can't drift.
    rows = rows.filter(r => matchesTokenQuery(r, tokenFilters, freeText))

    // 3. Group surviving entities by roleKey (entity_id minus the
    //    `::city` suffix) so PwC Data & AI Consultant - Roma + Milano
    //    fall into the same bucket.
    const groups = new Map<string, ScoreEntry[]>()
    for (const e of rows) {
      const id = entityId(e.company, e.role, parseCities(e.location))
      const roleKey = id.split('::').slice(0, 2).join('::')
      if (!groups.has(roleKey)) groups.set(roleKey, [])
      groups.get(roleKey)!.push(e)
    }

    // 4. For each group: filter by liveness (group visible if any
    //    sibling's liveness state is in filters.liveness), pick the
    //    primary, attach the siblings list.
    const grouped: ScoreEntry[] = []
    for (const members of groups.values()) {
      const visible = members.some(m => filters.liveness.has(livenessOf(m)))
      if (!visible) continue

      // Primary = best active sibling (highest overall). If no active
      // siblings, fall back to most recent historical. This matches
      // the user's "show parent as if it were the best one" intent
      // and keeps the parent row stable across re-renders.
      const active = members.filter(m => livenessOf(m) === 'active')
      const primary = active.length > 0
        ? [...active].sort((a, b) => b.overall - a.overall)[0]
        : [...members].sort((a, b) => b.date.localeCompare(a.date))[0]

      const others = members.filter(m => m !== primary)
      grouped.push({
        ...primary,
        siblings: others.length > 0 ? others : undefined,
        livenessState: livenessOf(primary),
      })
    }

    // 5. Sort by overall desc — same as the pre-grouping table.
    return grouped.sort((a, b) => b.overall - a.overall)
  }, [entities, livenessOf, filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys])

  // Per-option facet counts (Amazon-style): each dimension is counted with
  // every OTHER active facet applied but its own selection ignored, so a
  // count answers "if I toggle this option, how many entities land?" rather
  // than a static total that ignores the filters already in play. Counted at
  // the entity level (one row per company+role+city) to match the units the
  // facet options are built from. The global constraints (search tokens, free
  // text, zero-score toggle, score range) gate every dimension.
  const facetCounts = useMemo(() => {
    const passGlobal = (r: ScoreEntry): boolean => {
      if (!showClosed && !(r.overall > 0)) return false
      if (r.overall < filters.scoreMin || r.overall > filters.scoreMax) return false
      // Same shared matcher the table uses, so the counts can't disagree with
      // the rows the user ends up seeing.
      return matchesTokenQuery(r, tokenFilters, freeText)
    }

    // Per-dimension predicates — mirror the filter logic in `filtered`.
    const passCompany   = (r: ScoreEntry) => !filters.companies.size || filters.companies.has(r.company)
    const passLocation  = (r: ScoreEntry) => {
      if (!filters.locations.size) return true
      const cities = parseCities(r.location).cities
      return cities.length === 0 ? filters.locations.has(r.location) : cities.some(c => filters.locations.has(c))
    }
    const passArchetype = (r: ScoreEntry) => !filters.archetypes.size || filters.archetypes.has(canonicalizeArchetype(r.archetype))
    const passTier      = (r: ScoreEntry) => !filters.tiers.size || filters.tiers.has(r.tier) || (r.tier === 'T2-high' && filters.tiers.has('T2'))
    const passType      = (r: ScoreEntry) => !filters.employmentTypes.size || filters.employmentTypes.has(r.employment_type)
    const passLiveness  = (r: ScoreEntry) => filters.liveness.has(livenessOf(r))

    const companies: Record<string, number> = {}
    const locations: Record<string, number> = {}
    const archetypes: Record<string, number> = {}
    const tiers: Record<string, number> = {}
    const employmentTypes: Record<string, number> = {}
    const liveness: Record<string, number> = {}
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
      if (passCompany(r) && passLocation(r) && passArchetype(r) && passTier(r) && passType(r)) bump(liveness, livenessOf(r))
    }
    return { companies, locations, archetypes, tiers, employmentTypes, liveness }
  }, [entities, livenessOf, filters, tokenFilters, freeText, showClosed])

  // Flatten the grouped rows back to one entity per line for export — the
  // table collapses a role's cities into a single parent, but the CSV
  // should carry every evaluated city listing with its own score. The
  // primary already has livenessState; resolve it for each sibling too.
  const exportRows = useMemo(() => {
    const out: ScoreEntry[] = []
    for (const group of filtered) {
      out.push(group)
      for (const sib of group.siblings ?? []) {
        out.push(sib.livenessState ? sib : { ...sib, livenessState: livenessOf(sib) })
      }
    }
    return out
  }, [filtered, livenessOf])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-col h-full min-h-0">
        {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
        <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
          <h1 className="text-body text-text-1 font-medium">Database</h1>
          <span className="text-label text-text-4 font-mono">{loaded ? `${filtered.length} / ${scoreHistory.length}` : '…'}</span>
          <div className="flex-1" />
          <ExportMenu rows={exportRows} />
          <label className="titlebar-no-drag flex items-center gap-1.5 text-label text-text-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={e => setShowClosed(e.target.checked)}
              className="accent-accent"
            />
            Show zero-score
          </label>
        </div>

        {/* Search bar */}
        <div className="px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
          <FilterBar value={query} onChange={setQuery} />
        </div>

        {/* Main area */}
        <div className="flex flex-1 min-h-0">
          {/* Facet sidebar */}
          {facetExpanded && (
            <FacetSidebar filters={filters} onChange={setFilters} options={options} counts={facetCounts} />
          )}

          {/* Table */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {loaded ? (
              <DatabaseTable
                rows={filtered}
                setPopoverState={setPopoverState}
                setSelectedEntry={setSelectedEntry}
                popoverState={popoverState}
                selectedEntry={selectedEntry}
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-label text-text-4">Loading…</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action popover (primary row click) */}
      {popoverState && (
        <RowActionPopover
          entry={popoverState.entry}
          anchor={popoverState.anchor}
          onClose={() => setPopoverState(null)}
          onViewReport={() => setSelectedEntry(popoverState.entry)}
        />
      )}

      {/* Report slide-over (opened from popover or report-indicator icon).
          We're already on the Database tab, so the "View in Database"
          shortcut is redundant — hide it. */}
      {selectedEntry && (
        <ReportSlideOver
          company={selectedEntry.company}
          role={selectedEntry.role}
          scoreEntry={selectedEntry}
          hideDatabaseLink
          onSwitchEntity={(targetCompany, targetRole) => {
            // Find the latest matching score-history row for the
            // sibling and swap selectedEntry to it. Fall back to the
            // current entry if not found (shouldn't happen since
            // siblings are derived from the same scoreHistory).
            const match = [...scoreHistory]
              .filter(r => r.company === targetCompany && r.role === targetRole)
              .sort((a, b) => b.date.localeCompare(a.date))[0]
            if (match) setSelectedEntry(match)
          }}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  )
}

// ─── Stable-callback wrapper ─────────────────────────────────────────────────
//
// OffersTable's columns useMemo depends on `onOpenReport`. If that callback
// is recreated on every parent render (which inline arrow funcs do), the
// columns array gets a new reference and tanstack-table treats it as a
// structural change, recomputing every row's layout. This wrapper holds
// stable useCallback handlers that mutate the parent state via setters
// from props — so clicking a row doesn't make the table reflow.

function DatabaseTable({
  rows, setPopoverState, setSelectedEntry, popoverState, selectedEntry,
}: {
  rows: ScoreEntry[]
  setPopoverState: React.Dispatch<React.SetStateAction<{ entry: ScoreEntry; anchor: { x: number; y: number } } | null>>
  setSelectedEntry: React.Dispatch<React.SetStateAction<ScoreEntry | null>>
  popoverState: { entry: ScoreEntry; anchor: { x: number; y: number } } | null
  selectedEntry: ScoreEntry | null
}) {
  const onRowClick = useCallback(
    (entry: ScoreEntry, evt: React.MouseEvent) => {
      setPopoverState({ entry, anchor: { x: evt.clientX, y: evt.clientY } })
    },
    [setPopoverState],
  )
  const onOpenReport = useCallback(
    (entry: ScoreEntry) => setSelectedEntry(entry),
    [setSelectedEntry],
  )
  const selectedId = popoverState
    ? `${popoverState.entry.company}-${popoverState.entry.role}`
    : selectedEntry
      ? `${selectedEntry.company}-${selectedEntry.role}`
      : null
  return (
    <OffersTable
      rows={rows}
      onRowClick={onRowClick}
      onOpenReport={onOpenReport}
      selectedId={selectedId}
    />
  )
}

