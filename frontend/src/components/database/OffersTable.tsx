'use client'

import { useMemo, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { useDataStore } from '@/store/data'

interface OffersTableProps {
  rows: ScoreEntry[]
  onRowClick: (entry: ScoreEntry, evt: React.MouseEvent) => void
  selectedId: string | null
}

const col = createColumnHelper<ScoreEntry>()

// ─── Score dial ─────────────────────────────────────────────────────────────
// Radial progress ring. Color shifts from danger → warning → galaxy → success
// as the score climbs. Replaces the old horizontal bar — at a glance the table
// reads as a constellation of stronger and weaker matches.

function scoreColor(v: number): string {
  if (v >= 8)   return '#22C55E'   // success
  if (v >= 6.5) return '#7C5CFF'   // galaxy violet
  if (v >= 4.5) return '#F7B928'   // warning amber
  return '#EF4444'                  // danger red
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

// ─── Tier badge — pill with tier-tinted body ────────────────────────────────

const TIER_BADGE: Record<string, { bg: string; text: string; border: string; ring?: string }> = {
  'T1':      { bg: 'bg-tier-1/15',  text: 'text-tier-1',  border: 'border-tier-1/45',
               ring: 'shadow-[0_0_0_2px_rgba(201,149,24,0.10)]' },
  'T2-high': { bg: 'bg-success/15', text: 'text-success', border: 'border-success/40' },
  'T2':     { bg: 'bg-tier-2/15',   text: 'text-tier-2',  border: 'border-tier-2/35' },
  'T3':     { bg: 'bg-tier-3/12',   text: 'text-tier-3',  border: 'border-tier-3/35' },
  'T4':     { bg: 'bg-tier-4/10',   text: 'text-tier-4',  border: 'border-tier-4/30' },
}

function TierBadge({ tier }: { tier: string }) {
  const cfg = TIER_BADGE[tier] ?? TIER_BADGE['T4']
  const label = tier === 'T2-high' ? 'T2+' : tier
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center min-w-[34px] px-2 py-[3px] rounded-pill border font-mono font-bold tabular-nums',
        'text-[10px] tracking-wide',
        cfg.bg, cfg.text, cfg.border, cfg.ring,
      )}
    >
      {label}
    </span>
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

// ─── Table ──────────────────────────────────────────────────────────────────

export function OffersTable({ rows, onRowClick, selectedId }: OffersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'overall', desc: true }])
  const liveness = useDataStore(s => s.liveness)

  const columns = useMemo(() => [
    col.accessor('tier', {
      header: 'Tier',
      size: 56,
      cell: info => <TierBadge tier={info.getValue()} />,
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
        <span className="text-[11.5px] text-text-3 truncate block max-w-[108px]">
          {info.getValue() || '—'}
        </span>
      ),
    }),
    col.accessor('archetype', {
      header: 'Archetype',
      size: 130,
      cell: info => {
        const v = info.getValue()
        if (!v) return <span className="text-[11px] text-text-4">—</span>
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-pill bg-bg-elevated border border-border-default text-[10.5px] text-text-3 truncate max-w-[118px]">
            {v}
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
  ], [])

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left" style={{ minWidth: 840 }}>
        <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(header => {
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
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
                    <div className="flex items-center gap-1">
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
            const lvKey = `${entry.company.trim().toLowerCase()}|${entry.role.trim().toLowerCase()}`
            const lv = liveness[lvKey] ?? 'closed'
            // T4 = "don't apply" — keep visually quiet alongside stale/closed listings.
            const dim = lv === 'stale' || lv === 'closed' || entry.tier === 'T4'
            return (
              <tr
                key={row.id}
                onClick={(evt) => onRowClick(entry, evt)}
                className={cn(
                  dim && 'opacity-65',
                  'border-b border-border-default/30 cursor-pointer',
                  'transition-colors duration-150',
                  isSelected
                    ? 'bg-accent/10'
                    : 'hover:bg-accent/[0.04]',
                )}
              >
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} className="px-3 py-3 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
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
