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
import { parseTokenQuery } from '@/lib/databaseQuery'
import {
  dedupeEntities,
  buildFacetOptions,
  buildActedKeys,
  filterAndGroupEntities,
  computeFacetCounts,
  flattenForExport,
} from '@/lib/databaseRows'
import { livenessKey } from '@/lib/scanHistory'
import { filterNearUpgrades } from '@/lib/tierLevers'
import { TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry } from '@/types'

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

  // "Near upgrade only" — keep just the rows one modest single-dimension bump
  // from a better tier (lib/tierLevers § isNearUpgrade). A fast "what's cheap
  // to upgrade?" lens layered on top of the facet filters. Local UI state like
  // untappedOnly — transient, reset on relaunch.
  const [nearUpgradeOnly, setNearUpgradeOnly] = useState(false)

  // Drop tombstoned rows up-front. The tombstone set is keyed by
  // livenessKey(company, role) — identical to the key used for the
  // liveness lookup, so the popover's "Mark not interested" click hides
  // every sibling row of the same listing in one shot. Memo only on the
  // two inputs so unrelated re-renders don't re-walk the array.
  const scoreHistory = useMemo(
    () => discarded.size === 0
      ? scoreHistoryRaw
      : scoreHistoryRaw.filter(r => !discarded.has(livenessKey(r.company, r.role))),
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

  // Facet options, the engaged-key set, and the deduped entity universe —
  // all pure derivations now living in lib/databaseRows. Multi-city entities
  // surface under every listed city; archetypes are bucketed via
  // canonicalizeArchetype so the chips stay readable.
  const options   = useMemo(() => buildFacetOptions(scoreHistory), [scoreHistory])
  const actedKeys = useMemo(() => buildActedKeys(applications),     [applications])
  const entities  = useMemo(() => dedupeEntities(scoreHistory),     [scoreHistory])

  // Parse token query
  const { tokenFilters, freeText } = useMemo(() => parseTokenQuery(query), [query])

  // Apply all filters and group siblings into parent rows (one row per
  // company+role-canonical; liveness applied at the group level so a group
  // shows if ANY sibling matches the chip set). See lib/databaseRows.
  const filtered = useMemo(
    () => filterAndGroupEntities(entities, {
      filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness,
    }),
    [entities, filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness],
  )

  // Per-option facet counts (Amazon-style): each dimension counted with every
  // OTHER active facet applied but its own selection ignored. Shares the token
  // matcher AND the untapped-only lens with `filtered` so counts can't disagree
  // with the visible rows.
  const facetCounts = useMemo(
    () => computeFacetCounts(entities, {
      filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness,
    }),
    [entities, filters, tokenFilters, freeText, showClosed, untappedOnly, actedKeys, liveness],
  )

  // Apply the "Near upgrade only" lens on top of the grouped rows. Grouping
  // already picked each row's primary (best active sibling), whose dims drive
  // the lever — so filtering at the group level matches what the chip shows.
  const visibleRows = useMemo(
    () => filterNearUpgrades(filtered, nearUpgradeOnly),
    [filtered, nearUpgradeOnly],
  )

  // Flatten grouped rows to one entity per line for export (every evaluated
  // city carries its own score, with livenessState resolved per sibling).
  const exportRows = useMemo(() => flattenForExport(visibleRows, liveness), [visibleRows, liveness])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-col h-full min-h-0">
        {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
        <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
          <h1 className="text-body text-text-1 font-medium">Database</h1>
          <span className="text-label text-text-4 font-mono">{loaded ? `${visibleRows.length} / ${scoreHistory.length}` : '…'}</span>
          <div className="flex-1" />
          {/* "Near upgrade" quick-filter — one nudge from a better tier. */}
          <button
            type="button"
            onClick={() => setNearUpgradeOnly(v => !v)}
            title="Show only listings one modest single-dimension bump from a better tier"
            aria-pressed={nearUpgradeOnly}
            className={cn(
              'titlebar-no-drag inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-label font-medium transition-colors',
              nearUpgradeOnly
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'text-text-3 border border-transparent hover:bg-bg-elevated hover:text-text-2',
            )}
          >
            <TrendingUp size={12} aria-hidden />
            Near upgrade
          </button>
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
                rows={visibleRows}
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

