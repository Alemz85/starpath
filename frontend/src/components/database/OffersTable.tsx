'use client'

import { Fragment, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Search, ExternalLink, ChevronRight, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry, AppStatus } from '@/types'
import { STATUS_COLORS, ENGAGED_STATUSES } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { parseCities } from '@/lib/entityId'
import { livenessKey } from '@/lib/scanHistory'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { canonicalizeArchetype } from '@/lib/archetype'
import { scoreColor, scoreColorLight } from '@/lib/tier'
import { useId } from 'react'

interface OffersTableProps {
  rows: ScoreEntry[]
  onRowClick: (entry: ScoreEntry, evt: React.MouseEvent) => void
  onOpenReport: (entry: ScoreEntry) => void
  selectedId: string | null
}

const col = createColumnHelper<ScoreEntry>()

// Score dial — galaxy tier palette via shared util in `lib/tier.ts`.

function ScoreDial({ value }: { value: number }) {
  const reactId = useId().replace(/[:]/g, '')
  if (value <= 0) {
    return <span className="text-[11px] font-mono text-text-4 tabular-nums">—</span>
  }
  const size = 34
  const stroke = 2.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, value / 10))
  const dash = c * pct
  const color = scoreColor(value)
  const colorLight = scoreColorLight(value)
  const isT1 = value >= 8.5
  const gradId = `sd-grad-${reactId}`
  const glowId = `sd-glow-${reactId}`
  return (
    <div
      className="relative inline-flex"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Score ${value.toFixed(1)} out of 10`}
    >
      <svg width={size} height={size} className="-rotate-90 absolute inset-0" aria-hidden>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor={color} />
            <stop offset="100%" stopColor={colorLight} />
          </linearGradient>
          {isT1 && (
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.1" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          )}
        </defs>
        <circle cx={size/2} cy={size/2} r={r} stroke="#DEE3E9" strokeWidth={stroke} fill="none" />
        <circle
          cx={size/2}
          cy={size/2}
          r={r}
          stroke={`url(#${gradId})`}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          filter={isT1 ? `url(#${glowId})` : undefined}
          style={{ transition: 'stroke-dasharray 220ms cubic-bezier(0.25, 1, 0.5, 1)' }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono font-semibold tabular-nums"
        style={{ fontSize: 10.5, color: '#1C2B33' }}
        aria-hidden
      >
        {value.toFixed(1)}
      </span>
    </div>
  )
}

// ─── CF / AF stacked numeric block ──────────────────────────────────────────

function CfAfBlock({ cf, af }: { cf: number; af: number }) {
  const hasCf = cf > 0
  const hasAf = af > 0
  if (!hasCf && !hasAf) return <span className="text-[10.5px] font-mono text-text-4">—</span>
  return (
    <div className="font-mono tabular-nums leading-[1.15] text-[11px]">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[9px] uppercase text-text-4 tracking-wider w-4">CF</span>
        <span className="text-text-2 font-semibold">{hasCf ? cf.toFixed(1) : '—'}</span>
      </div>
      <div className="flex items-baseline gap-1.5 mt-[3px]">
        <span className="text-[9px] uppercase text-text-4 tracking-wider w-4">AF</span>
        <span className="text-text-2 font-semibold">{hasAf ? af.toFixed(1) : '—'}</span>
      </div>
    </div>
  )
}

// ─── Application-status badge ───────────────────────────────────────────────
//
// A small pill on a listing the user has already engaged (applied / heard back
// / interviewing / offer / rejected). Colour comes from the shared
// STATUS_COLORS map so it reads the same as the Applying-tab statuses. Sits
// next to the role so the Database doubles as an "what have I already chased?"
// view, not just a scored inventory.
function StatusBadge({ status }: { status: AppStatus }) {
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-pill border border-border-default bg-bg-elevated',
        'text-[9px] font-mono font-semibold uppercase tracking-[0.06em]',
        STATUS_COLORS[status],
      )}
    >
      {status}
    </span>
  )
}

// ─── Relative date ──────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days < 0) return 'soon'
  if (days === 0) return 'today'
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

// ─── Inline row breakdown ───────────────────────────────────────────────────
//
// Click the chevron on a row → that row expands inline, revealing the
// 10-dimensional breakdown directly below. Acts like a database expand
// caret — multiple rows can be open at once. The chevron rotates 90° to
// signal open state.

const BREAKDOWN_DIMS: Array<{ key: keyof ScoreEntry; label: string }> = [
  { key: 'skills_match',       label: 'Skills Match'     },
  { key: 'ease_of_entry',      label: 'Ease of Entry'    },
  { key: 'strategic_fit',      label: 'Strategic Fit'    },
  { key: 'current_fit',        label: 'Current Fit'      },
  { key: 'growth_mobility',    label: 'Growth / Mobility'},
  { key: 'optionality_exit',   label: 'Optionality'      },
  { key: 'brand_value',        label: 'Brand Value'      },
  { key: 'sales_trap_risk',    label: 'Sales-Trap Risk'  },
  { key: 'aspirational_fit',   label: 'Aspirational Fit' },
  { key: 'work_life_balance',  label: 'Work / Life'      },
]

function BreakdownRow({
  entry, colSpan, onSelectSibling,
}: {
  entry: ScoreEntry
  colSpan: number
  onSelectSibling: (sibling: ScoreEntry, evt: React.MouseEvent) => void
}) {
  // Parent representation: dim bars for the parent (this row) + a
  // Cities sub-list when sibling entities exist in the same group
  // (PwC Roma + Milano shape). Each sibling sub-row is clickable —
  // opens its own slide-over rather than the parent's.
  const siblings = entry.siblings ?? []
  // Show the parent in the city list too so the user sees explicitly
  // "the row above is this one". Sort: active first (best to worst),
  // historical last (in their own greyed visual treatment).
  const allCities = [entry, ...siblings]
  const cityRows = [...allCities].sort((a, b) => {
    const liveA = a.livenessState ?? 'active'
    const liveB = b.livenessState ?? 'active'
    const isHistA = liveA !== 'active' ? 1 : 0
    const isHistB = liveB !== 'active' ? 1 : 0
    if (isHistA !== isHistB) return isHistA - isHistB
    return b.overall - a.overall
  })
  const showCityList = siblings.length > 0

  return (
    <tr className="bg-bg-elevated/40 border-b border-border-default/30">
      <td colSpan={colSpan} className="pl-16 pr-6 py-3">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 max-w-[720px]">
          {BREAKDOWN_DIMS.map(({ key, label }) => {
            const raw = entry[key]
            const val = typeof raw === 'number' ? raw : 0
            const pct = Math.min(100, (val / 10) * 100)
            const c = scoreColor(val)
            return (
              <div key={key as string} className="flex items-center gap-2.5">
                <span className="text-[10.5px] text-text-3 w-[110px] shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                  <div
                    className="h-full rounded-pill"
                    style={{ width: `${pct}%`, background: c, transition: 'width 320ms ease' }}
                  />
                </div>
                <span className="text-[10px] font-mono tabular-nums w-[28px] text-right" style={{ color: c }}>
                  {val > 0 ? val.toFixed(1) : '—'}
                </span>
              </div>
            )
          })}
        </div>

        {showCityList && (
          <div className="mt-4 pt-3 border-t border-border-default/40 max-w-[720px]">
            <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-text-4 mb-2">
              Cities ({allCities.length})
            </div>
            <div className="space-y-1">
              {cityRows.map(s => {
                const isPrimary = s === entry
                const isHistorical = (s.livenessState ?? 'active') !== 'active'
                return (
                  <button
                    key={`${s.company}|${s.role}`}
                    onClick={(evt) => onSelectSibling(s, evt)}
                    className={cn(
                      'w-full flex items-center gap-3 px-2 py-1.5 rounded text-left transition-colors',
                      'hover:bg-bg-elevated',
                      isHistorical && 'opacity-55',
                    )}
                  >
                    <span className={cn(
                      'text-[11px] flex-1 min-w-0 truncate',
                      isPrimary ? 'text-text-1 font-medium' : 'text-text-2',
                    )}>
                      {s.location || s.role}
                      {isPrimary && <span className="ml-2 text-[9.5px] font-mono uppercase tracking-[0.08em] text-accent">primary</span>}
                    </span>
                    <span className="text-[10px] font-mono text-text-3">{s.tier === 'T2-high' ? 'T2+' : (s.tier || '—')}</span>
                    <span className="text-[10px] font-mono tabular-nums text-text-2 w-[34px] text-right" style={{ color: scoreColor(s.overall) }}>
                      {s.overall > 0 ? s.overall.toFixed(1) : '—'}
                    </span>
                    <span className={cn(
                      'text-[9.5px] font-mono uppercase tracking-[0.08em] w-[44px] text-right',
                      isHistorical ? 'text-text-4' : 'text-success',
                    )}>
                      {s.livenessState ?? 'active'}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </td>
    </tr>
  )
}

// ─── Table ──────────────────────────────────────────────────────────────────

// Stable per-entry key for both selection and the expanded-row Set.
const entryKey = (e: ScoreEntry) => `${e.company}|${e.role}`

export function OffersTable({ rows, onRowClick, onOpenReport, selectedId }: OffersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'overall', desc: true }])
  // (liveness was used for the row-fading rule that's now gone — kept the
  // store unsubscribed since nothing in this table needs it anymore.)
  const reports = useDataStore(s => s.reports)
  const applications = useDataStore(s => s.applications)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Refs that always mirror the latest state so the column-cell closures
  // can read fresh values without `expanded` / `toggleExpanded` being in
  // the columns useMemo deps. Without this, every chevron toggle would
  // rebuild the columns array, causing tanstack-table to recompute the
  // entire table layout — that's the source of the visible flicker on
  // expand. With the refs the columns array stays stable; the cell
  // function is called fresh each render and reads current state.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const toggleExpanded = (entry: ScoreEntry) => {
    const k = entryKey(entry)
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  const toggleExpandedRef = useRef(toggleExpanded)
  toggleExpandedRef.current = toggleExpanded

  // Fast lookup: which entries already have a report file on disk?
  // Match on URL primarily — that's the stable join key when both the
  // score-history row and the report markdown have one. Fall back to
  // (company, role) for legacy reports written before URL tracking.
  const reportSet = useMemo(() => {
    const byUrl  = new Set<string>()
    const byPair = new Set<string>()
    for (const r of reports) {
      if (r.url) byUrl.add(r.url)
      byPair.add(livenessKey(r.company, r.role))
    }
    return { byUrl, byPair }
  }, [reports])

  const hasReport = (entry: ScoreEntry): boolean => {
    if (entry.url && reportSet.byUrl.has(entry.url)) return true
    return reportSet.byPair.has(livenessKey(entry.company, entry.role))
  }

  // Listing → application status, keyed company|role (same key the liveness /
  // discard maps use). Drives the per-row StatusBadge. Last row wins if the
  // same listing somehow appears twice in applications.md.
  const statusByKey = useMemo(() => {
    const m = new Map<string, AppStatus>()
    for (const a of applications) {
      m.set(livenessKey(a.company, a.role), a.status)
    }
    return m
  }, [applications])

  const columns = useMemo(() => [
    col.display({
      id: 'breakdown',
      header: '',
      size: 36,
      cell: info => {
        const entry = info.row.original
        const isOpen = expandedRef.current.has(entryKey(entry))
        const sibCount = entry.siblings?.length ?? 0
        const titleSuffix = sibCount > 0 ? ` · ${sibCount} more in this group` : ''
        return (
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpandedRef.current(entry) }}
            title={(isOpen ? 'Hide score breakdown' : 'Show score breakdown') + titleSuffix}
            aria-label={(isOpen ? 'Hide score breakdown' : 'Show score breakdown') + titleSuffix}
            aria-expanded={isOpen}
            className="inline-flex items-center gap-1 justify-center px-1 h-6 rounded-md text-text-4 hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <ChevronRight
              size={14}
              className="transition-transform duration-150 shrink-0"
              style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
            {sibCount > 0 && (
              <span className="text-[9px] font-mono font-semibold text-accent tabular-nums leading-none">
                +{sibCount}
              </span>
            )}
          </button>
        )
      },
      enableSorting: false,
    }),
    col.accessor('company', {
      header: 'Listing',
      size: 320,
      cell: info => {
        const company = info.getValue()
        const entry = info.row.original
        const role = entry.role
        const status = statusByKey.get(livenessKey(entry.company, entry.role))
        return (
          <div className="flex items-center gap-3 min-w-0">
            <CompanyLogo company={company} size={28} className="shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[13px] text-text-1 font-semibold truncate block">
                {company}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                <span className="text-[11.5px] text-text-3 truncate">{role}</span>
                {status != null && ENGAGED_STATUSES.has(status) && <StatusBadge status={status} />}
              </div>
            </div>
          </div>
        )
      },
    }),
    col.display({
      id: 'report',
      header: '',
      size: 24,
      cell: info => {
        const entry = info.row.original
        if (!hasReport(entry)) return <span className="block w-5 h-5" aria-hidden />
        return (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenReport(entry) }}
            title="Open report"
            aria-label="Open report"
            className="inline-flex items-center justify-center w-5 h-5 rounded text-text-4 opacity-70 hover:opacity-100 hover:text-accent hover:bg-accent/10 transition-all"
          >
            <FileText size={11} />
          </button>
        )
      },
      enableSorting: false,
    }),
    col.accessor('overall', {
      header: 'Score',
      size: 64,
      cell: info => <ScoreDial value={info.getValue()} />,
    }),
    col.accessor('current_fit', {
      header: 'CF / AF',
      size: 84,
      cell: info => <CfAfBlock cf={info.getValue()} af={info.row.original.aspirational_fit} />,
    }),
    col.accessor('location', {
      header: 'Location',
      size: 120,
      cell: info => {
        const raw = info.getValue() || ''
        // Single-URL multi-city listings (e.g., Rev-celerator across 4
        // cities) collapse to a compact "City · +N" pill — the row is
        // ONE entity, not N siblings, so it gets one cell. Hover shows
        // the full list. Single-city rows render the city verbatim.
        const parsed = parseCities(raw)
        if (parsed.isMulti && parsed.cities.length > 1) {
          const primary = parsed.primary ?? parsed.cities[0]
          const others  = parsed.cities.length - 1
          return (
            <div className="flex items-center justify-center" title={parsed.cities.join(' · ')}>
              <span className="text-[11.5px] text-text-3 truncate block max-w-[108px] text-center">
                {primary} · +{others}
              </span>
            </div>
          )
        }
        return (
          <div className="flex items-center justify-center">
            <span className="text-[11.5px] text-text-3 truncate block max-w-[108px] text-center">
              {raw || '—'}
            </span>
          </div>
        )
      },
    }),
    col.accessor('archetype', {
      header: 'Archetype',
      size: 130,
      cell: info => {
        const v = info.getValue()
        const display = canonicalizeArchetype(v)
        if (!display) return <span className="text-[11px] text-text-4">—</span>
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-bg-elevated border border-border-default text-[10.5px] text-text-3 truncate max-w-[118px]">
            {display}
          </span>
        )
      },
    }),
    col.accessor('date', {
      header: 'Added',
      size: 60,
      cell: info => {
        const v = info.getValue()
        return (
          <span className="text-[11px] font-mono text-text-4 tabular-nums" title={v || undefined}>
            {relativeTime(v)}
          </span>
        )
      },
    }),
    col.accessor('url', {
      header: '',
      size: 32,
      enableSorting: false,
      cell: info => {
        const url = info.getValue()
        if (!url || !/^https?:\/\//i.test(url)) {
          return <span className="block w-6 h-6" aria-hidden />
        }
        return (
          <button
            onClick={(e) => { e.stopPropagation(); ipc.openExternal(url) }}
            title="Open job posting"
            aria-label="Open job posting"
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-4 opacity-60 hover:opacity-100 hover:text-accent hover:bg-accent/10 transition-all"
          >
            <ExternalLink size={12} />
          </button>
        )
      },
    }),
  ], [reportSet, onOpenReport, statusByKey])

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="h-full overflow-auto relative">
      <table className="w-full border-collapse text-left" style={{ minWidth: 840 }}>
        <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(header => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const headerStr = header.column.columnDef.header as string
                const isCentered = headerStr === 'Location'
                return (
                  <th
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className={cn(
                      'px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-4 whitespace-nowrap select-none',
                      'bg-bg-base/80 backdrop-blur-md border-b border-border-default',
                      canSort && 'cursor-pointer hover:text-text-2 transition-colors',
                    )}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <div className={cn('flex items-center gap-1', isCentered && 'justify-center')}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className={sorted ? 'text-accent' : 'text-text-4'}>
                          {sorted === 'asc' ? <ArrowUp size={10} /> :
                           sorted === 'desc' ? <ArrowDown size={10} /> :
                           <ArrowUpDown size={10} className="opacity-40" />}
                        </span>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => {
            const entry = row.original
            const id = `${entry.company}-${entry.role}`
            const isSelected = id === selectedId
            const isExpanded = expanded.has(entryKey(entry))
            // The tier-color in the score dial / chevron / breakdown bars
            // already fades on its own when the score is low (per the
            // galaxy palette), so the row itself stays at full opacity —
            // company name and role should always be cleanly readable. The
            // earlier `opacity-65` on T4 / stale rows greyed everything,
            // including the things the user is trying to scan.
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={(evt) => onRowClick(entry, evt)}
                  className={cn(
                    'border-b border-border-default/30 cursor-pointer',
                    'transition-colors duration-150',
                    isSelected
                      ? 'bg-accent/10'
                      : isExpanded
                        ? 'bg-bg-elevated/40'
                        : 'hover:bg-accent/[0.04]',
                  )}
                >
                  {row.getVisibleCells().map(cell => (
                    <td key={cell.id} className="px-3 py-3 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
                {isExpanded && (
                  <BreakdownRow
                    entry={entry}
                    colSpan={row.getVisibleCells().length}
                    onSelectSibling={onRowClick}
                  />
                )}
              </Fragment>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="py-20 px-6 flex flex-col items-center justify-center gap-4">
                  <div className="w-14 h-14 rounded-full galaxy-bg border border-border-default flex items-center justify-center">
                    <Search size={22} className="text-accent opacity-80" />
                  </div>
                  <div className="text-center max-w-sm">
                    <p className="text-[15px] text-text-1 font-medium">No matches</p>
                    <p className="text-[12px] text-text-3 mt-1 leading-snug">
                      Try relaxing a filter, searching a different keyword, or toggling
                      the Liveness chips to see stale or closed listings.
                    </p>
                  </div>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
