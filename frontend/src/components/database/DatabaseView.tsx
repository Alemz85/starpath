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
import { TrendingUp, EyeOff } from 'lucide-react'
import { Button, PageHeader } from '@/components/ui'
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
        <PageHeader
          title="Database"
          meta={loaded ? `${visibleRows.length} of ${scoreHistory.length} listings` : 'Loading…'}
          actions={
            <>
              {/* "Untapped only" — hide roles already in the pipeline. */}
              <Button
                tone={untappedOnly ? 'tinted' : 'ghost'}
                size="sm"
                icon={<EyeOff size={13} aria-hidden />}
                onClick={() => setUntappedOnly(v => !v)}
                title="Hide listings you've already applied to, are interviewing at, or rejected — shows only scored-but-not-yet-pursued roles"
                aria-pressed={untappedOnly}
              >
                Untapped
              </Button>
              {/* "Near upgrade" quick-filter — one nudge from a better tier. */}
              <Button
                tone={nearUpgradeOnly ? 'tinted' : 'ghost'}
                size="sm"
                icon={<TrendingUp size={13} aria-hidden />}
                onClick={() => setNearUpgradeOnly(v => !v)}
                title="Show only listings one modest single-dimension bump from a better tier"
                aria-pressed={nearUpgradeOnly}
              >
                Near upgrade
              </Button>
              <ExportMenu rows={exportRows} />
              <span className="w-px h-4 bg-border-default" aria-hidden />
              <label className="flex items-center gap-1.5 pl-1 text-label text-text-3 hover:text-text-2 cursor-pointer select-none transition-colors duration-150">
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={e => setShowClosed(e.target.checked)}
                  className="w-[13px] h-[13px] accent-accent cursor-pointer"
                />
                Show unscored
              </label>
            </>
          }
        />

        {/* Search row */}
        <div className="h-14 flex items-center px-4 shrink-0">
          <FilterBar value={query} onChange={setQuery} />
        </div>

        {/* Main area */}
        <div className="flex flex-1 min-h-0 gap-3 px-4 pb-4">
          {/* Facet sidebar */}
          {facetExpanded && (
            <FacetSidebar filters={filters} onChange={setFilters} options={options} counts={facetCounts} />
          )}

          {/* Table */}
          <div className="flex-1 min-w-0 overflow-hidden card">
            {loaded ? (
              <DatabaseTable
                rows={visibleRows}
                setPopoverState={setPopoverState}
                setSelectedEntry={setSelectedEntry}
                popoverState={popoverState}
                selectedEntry={selectedEntry}
              />
            ) : (
              <TableSkeleton />
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

// ─── Loading skeleton ────────────────────────────────────────────────────────
//
// Shimmer rows in the table's own shape (header strip, 40px rows with a logo,
// two text lines and the numeric columns) so the layout doesn't jump when the
// data lands. `.shimmer` stops animating under prefers-reduced-motion.

const SKELETON_ROWS = 12

function TableSkeleton() {
  return (
    <div className="h-full overflow-hidden" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading database…</span>
      <div className="h-10 border-b border-border-default" aria-hidden />
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div
          key={i}
          className="h-[52px] flex items-center gap-2.5 pl-9 pr-4 border-b border-border-default/50"
          style={{ opacity: 1 - i * 0.06 }}
          aria-hidden
        >
          <div className="shimmer w-7 h-7 rounded shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="shimmer h-2.5 rounded-sm" style={{ width: `${32 + ((i * 17) % 28)}%` }} />
            <div className="shimmer h-2 rounded-sm" style={{ width: `${44 + ((i * 23) % 30)}%` }} />
          </div>
          <div className="shimmer h-3 w-8 rounded-sm shrink-0" />
          <div className="shimmer h-2.5 w-14 rounded-sm shrink-0 ml-6" />
          <div className="shimmer h-2.5 w-16 rounded-sm shrink-0 ml-6" />
          <div className="shimmer h-2.5 w-20 rounded-sm shrink-0 ml-6" />
        </div>
      ))}
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

