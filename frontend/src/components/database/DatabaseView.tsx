'use client'

import { useCallback, useEffect, useState, useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useDatabaseFilters } from '@/store/databaseFilters'
import { FacetSidebar } from '@/components/shared/FacetSidebar'
import { FilterBar } from './FilterBar'
import { OffersTable } from './OffersTable'
import { ReportSlideOver } from '../reports/ReportSlideOver'
import { RowActionPopover } from '@/components/shared/RowActionPopover'
import { canonicalizeArchetype } from '@/lib/archetype'
import { parseCities } from '@/lib/entityId'
import type { ScoreEntry } from '@/types'

export function DatabaseView() {
  const { scoreHistory, liveness, loaded } = useDataStore()
  const databaseFilter = useNavStore(s => s.databaseFilter)

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

  // Apply all filters
  const filtered = useMemo(() => {
    let rows = scoreHistory

    if (!showClosed) rows = rows.filter(r => r.overall > 0)

    // Facet filters
    if (filters.companies.size) rows = rows.filter(r => filters.companies.has(r.company))
    // Location filter expands multi-city rows: an entity listed in
    // Hong Kong + EU matches when EITHER city is selected.
    if (filters.locations.size) {
      rows = rows.filter(r => {
        const cities = parseCities(r.location).cities
        if (cities.length === 0) return filters.locations.has(r.location)
        return cities.some(c => filters.locations.has(c))
      })
    }
    if (filters.archetypes.size) rows = rows.filter(r => filters.archetypes.has(canonicalizeArchetype(r.archetype)))
    if (filters.tiers.size) {
      // T2+ (T2-high) rolls up under T2 in the facet — there's no separate chip.
      rows = rows.filter(r => filters.tiers.has(r.tier) || (r.tier === 'T2-high' && filters.tiers.has('T2')))
    }
    if (filters.employmentTypes.size) rows = rows.filter(r => filters.employmentTypes.has(r.employment_type))
    if (filters.scoreMin > 0 || filters.scoreMax < 10) {
      rows = rows.filter(r => r.overall >= filters.scoreMin && r.overall <= filters.scoreMax)
    }
    // Liveness facet — entries with no liveness signal default to 'closed'
    // (no recent scan-history match), so the default 'active'-only filter
    // hides them too. Toggle 'closed' chip on to see them.
    rows = rows.filter(r => {
      const key = `${r.company.trim().toLowerCase()}|${r.role.trim().toLowerCase()}`
      const lv = liveness[key] ?? 'closed'
      return filters.liveness.has(lv)
    })

    // Token filters from search bar
    if (tokenFilters.company)   rows = rows.filter(r => r.company.toLowerCase().includes(tokenFilters.company!.toLowerCase()))
    if (tokenFilters.tier)      rows = rows.filter(r => r.tier.toLowerCase() === tokenFilters.tier!.toLowerCase())
    if (tokenFilters.archetype) rows = rows.filter(r => {
      const ta = tokenFilters.archetype!.toLowerCase()
      return r.archetype.toLowerCase().includes(ta) ||
             canonicalizeArchetype(r.archetype).toLowerCase().includes(ta)
    })
    if (tokenFilters.location) {
      const needle = tokenFilters.location!.toLowerCase()
      rows = rows.filter(r => {
        if (r.location.toLowerCase().includes(needle)) return true
        const cities = parseCities(r.location).cities
        return cities.some(c => c.toLowerCase().includes(needle))
      })
    }
    if (tokenFilters.type)      rows = rows.filter(r => r.employment_type.toLowerCase().includes(tokenFilters.type!.toLowerCase()))
    if (tokenFilters.minScore)  rows = rows.filter(r => r.overall >= tokenFilters.minScore!)

    // Free text fuzzy match on company + role
    if (freeText) {
      const q = freeText.toLowerCase()
      rows = rows.filter(r =>
        r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)
      )
    }

    // Default sort: overall descending
    return [...rows].sort((a, b) => b.overall - a.overall)
  }, [scoreHistory, liveness, filters, tokenFilters, freeText, showClosed])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-col h-full min-h-0">
        {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
        <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
          <h1 className="text-body text-text-1 font-medium">Database</h1>
          <span className="text-label text-text-4 font-mono">{loaded ? `${filtered.length} / ${scoreHistory.length}` : '…'}</span>
          <div className="flex-1" />
          <label className="titlebar-no-drag flex items-center gap-1.5 text-label text-text-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={e => setShowClosed(e.target.checked)}
              className="accent-[#7C5CFF]"
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
            <FacetSidebar filters={filters} onChange={setFilters} options={options} />
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

// ─── Token query parser ───────────────────────────────────────────────────────

interface TokenFilters {
  company?: string
  tier?: string
  archetype?: string
  location?: string
  type?: string
  minScore?: number
}

function parseTokenQuery(q: string): { tokenFilters: TokenFilters; freeText: string } {
  const tokenFilters: TokenFilters = {}
  const tokenRe = /(\w+):([^\s]+)/g
  let freeText = q
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(q)) !== null) {
    const [full, key, val] = match
    freeText = freeText.replace(full, '').trim()
    switch (key.toLowerCase()) {
      case 'company':    tokenFilters.company   = val; break
      case 'tier':       tokenFilters.tier      = val; break
      case 'archetype':  tokenFilters.archetype = val; break
      case 'location':   tokenFilters.location  = val; break
      case 'type':       tokenFilters.type      = val; break
      case 'min-score':
      case 'minscore':   tokenFilters.minScore  = parseFloat(val); break
    }
  }

  return { tokenFilters, freeText: freeText.trim() }
}
