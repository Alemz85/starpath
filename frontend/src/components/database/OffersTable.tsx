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
import type { ScoreEntry } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { canonicalizeArchetype } from '@/lib/archetype'

interface OffersTableProps {
  rows: ScoreEntry[]
  onRowClick: (entry: ScoreEntry, evt: React.MouseEvent) => void
  onOpenReport: (entry: ScoreEntry) => void
  selectedId: string | null
}

const col = createColumnHelper<ScoreEntry>()

// ─── Score dial — galaxy palette, matches the tier scale ────────────────────
//
// T1 (≥8.5) deep galaxy indigo · T2 (≥7) violet · T3 (≥5) lavender ·
// T4 (<5) faded slate. Same palette is used by the tier badges so the dial
// color and the row's tier read as one coherent signal.

function scoreColor(v: number): string {
  if (v >= 8.5) return '#3D2BB5'   // tier-1 — deep galaxy indigo
  if (v >= 7)   return '#7C5CFF'   // tier-2 — galaxy violet
  if (v >= 5)   return '#A89CD9'   // tier-3 — muted lavender
  return '#94A3B8'                  // tier-4 — faded slate
}

function ScoreDial({ value }: { value: number }) {
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
  return (
    <div className="relative inline-flex" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 absolute inset-0">
        <circle cx={size/2} cy={size/2} r={r} stroke="#DEE3E9" strokeWidth={stroke} fill="none" />
        <circle
          cx={size/2}
          cy={size/2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 360ms ease-out' }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono font-semibold tabular-nums"
        style={{ fontSize: 10.5, color: '#1C2B33' }}
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

function BreakdownRow({ entry, colSpan }: { entry: ScoreEntry; colSpan: number }) {
  return (
    <tr className="bg-bg-elevated/40 border-b border-border-default/30">
      {/* Indent the content past the chevron + logo so dimension labels sit
          slightly right of the company-name column above. The 64px left
          padding lines the breakdown up just inside where "Listing"'s text
          begins, giving a clear parent→child visual relationship. */}
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
      </td>
    </tr>
  )
}

// ─── Table ──────────────────────────────────────────────────────────────────

// Stable per-entry key for both selection and the expanded-row Set.
const entryKey = (e: ScoreEntry) => `${e.company}|${e.role}`

export function OffersTable({ rows, onRowClick, onOpenReport, selectedId }: OffersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'overall', desc: true }])
  const liveness = useDataStore(s => s.liveness)
  const reports = useDataStore(s => s.reports)
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
      byPair.add(`${r.company.trim().toLowerCase()}|${r.role.trim().toLowerCase()}`)
    }
    return { byUrl, byPair }
  }, [reports])

  const hasReport = (entry: ScoreEntry): boolean => {
    if (entry.url && reportSet.byUrl.has(entry.url)) return true
    return reportSet.byPair.has(`${entry.company.trim().toLowerCase()}|${entry.role.trim().toLowerCase()}`)
  }

  const columns = useMemo(() => [
    col.display({
      id: 'breakdown',
      header: '',
      size: 28,
      cell: info => {
        const entry = info.row.original
        const isOpen = expandedRef.current.has(entryKey(entry))
        return (
          <button
            onClick={(e) => { e.stopPropagation(); toggleExpandedRef.current(entry) }}
            title={isOpen ? 'Hide score breakdown' : 'Show score breakdown'}
            aria-label={isOpen ? 'Hide score breakdown' : 'Show score breakdown'}
            aria-expanded={isOpen}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-4 hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <ChevronRight
              size={14}
              className="transition-transform duration-150"
              style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
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
        const role = info.row.original.role
        return (
          <div className="flex items-center gap-3 min-w-0">
            <CompanyLogo company={company} size={28} className="shrink-0" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[13px] text-text-1 font-semibold truncate">{company}</div>
              <div className="text-[11.5px] text-text-3 truncate mt-0.5">{role}</div>
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
      cell: info => (
        <div className="flex items-center justify-center">
          <span className="text-[11.5px] text-text-3 truncate block max-w-[108px] text-center">
            {info.getValue() || '—'}
          </span>
        </div>
      ),
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
  ], [reportSet, onOpenReport])

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
            const lvKey = `${entry.company.trim().toLowerCase()}|${entry.role.trim().toLowerCase()}`
            const lv = liveness[lvKey] ?? 'closed'
            // T4 = "don't apply" — keep visually quiet alongside stale/closed listings.
            const dim = lv === 'stale' || lv === 'closed' || entry.tier === 'T4'
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={(evt) => onRowClick(entry, evt)}
                  className={cn(
                    dim && 'opacity-65',
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
                {isExpanded && <BreakdownRow entry={entry} colSpan={row.getVisibleCells().length} />}
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
