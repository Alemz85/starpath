'use client'

import { useMemo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { useState } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry } from '@/types'
import { TIER_COLORS, TIER_LABELS, type TierKey } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'

interface OffersTableProps {
  rows: ScoreEntry[]
  onSelect: (entry: ScoreEntry) => void
  selectedId: string | null
}

const col = createColumnHelper<ScoreEntry>()

function ScoreBar({ value }: { value: number }) {
  const pct = Math.min(100, (value / 10) * 100)
  const color =
    value >= 8 ? 'bg-success' :
    value >= 6 ? 'bg-accent' :
    value >= 4 ? 'bg-warning' : 'bg-danger'

  return (
    <div className="flex items-center gap-2">
      <div className="score-bar-track w-16 h-1.5 rounded-full overflow-hidden">
        <div className={cn('score-bar-fill h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-label font-mono text-text-2 w-8 text-right">{value.toFixed(1)}</span>
    </div>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const key = (tier as TierKey) in TIER_COLORS ? (tier as TierKey) : 'T4'
  const { bg, text, border } = TIER_COLORS[key]
  const label = key in TIER_LABELS ? TIER_LABELS[key] : tier
  return (
    <span className={cn('px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border', bg, text, border)}>
      {label}
    </span>
  )
}

export function OffersTable({ rows, onSelect, selectedId }: OffersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'overall', desc: true }])

  const columns = useMemo(() => [
    col.accessor('tier', {
      header: 'Tier',
      size: 64,
      cell: info => <TierBadge tier={info.getValue()} />,
    }),
    col.accessor('company', {
      header: 'Company',
      size: 180,
      cell: info => (
        <div className="flex items-center gap-2 max-w-[168px]">
          <CompanyLogo company={info.getValue()} size={16} />
          <span className="text-label text-text-1 font-medium truncate">{info.getValue()}</span>
        </div>
      ),
    }),
    col.accessor('role', {
      header: 'Role',
      size: 220,
      cell: info => (
        <span className="text-label text-text-2 truncate block max-w-[208px]">{info.getValue()}</span>
      ),
    }),
    col.accessor('overall', {
      header: 'Score',
      size: 120,
      cell: info => <ScoreBar value={info.getValue()} />,
    }),
    col.accessor('current_fit', {
      header: 'CF',
      size: 56,
      cell: info => <span className="text-label font-mono text-text-3">{info.getValue().toFixed(1)}</span>,
    }),
    col.accessor('aspirational_fit', {
      header: 'AF',
      size: 56,
      cell: info => <span className="text-label font-mono text-text-3">{info.getValue().toFixed(1)}</span>,
    }),
    col.accessor('location', {
      header: 'Location',
      size: 120,
      cell: info => (
        <span className="text-label text-text-4 truncate block max-w-[108px]">{info.getValue() || '—'}</span>
      ),
    }),
    col.accessor('archetype', {
      header: 'Archetype',
      size: 140,
      cell: info => (
        <span className="text-label text-text-4 truncate block max-w-[128px]">{info.getValue() || '—'}</span>
      ),
    }),
    col.accessor('date', {
      header: 'Date',
      size: 96,
      cell: info => <span className="text-label font-mono text-text-4">{info.getValue() || '—'}</span>,
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

  const tierRowClass = (tier: string) => {
    switch (tier) {
      case 'T1':     return 'row-tier-1'
      case 'T2-high':return 'row-tier-2'
      case 'T2':     return 'row-tier-2'
      case 'T3':     return 'row-tier-3'
      default:       return 'row-tier-4'
    }
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-left" style={{ minWidth: 900 }}>
        <thead className="sticky top-0 z-10 bg-bg-chrome border-b border-border-default">
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
                      'px-3 py-2 text-micro text-text-4 uppercase font-medium whitespace-nowrap select-none',
                      canSort && 'cursor-pointer hover:text-text-2 transition-colors',
                    )}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className="text-text-4">
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
            return (
              <tr
                key={row.id}
                onClick={() => onSelect(entry)}
                className={cn(
                  tierRowClass(entry.tier),
                  'border-b border-border-default/40 cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-accent/10'
                    : 'hover:bg-bg-elevated',
                )}
              >
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-12 text-center text-label text-text-4">
                No offers match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
