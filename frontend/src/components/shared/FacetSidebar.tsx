'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type Liveness = 'active' | 'stale' | 'closed'

export interface FacetFilters {
  companies: Set<string>
  locations: Set<string>
  archetypes: Set<string>
  tiers: Set<string>
  employmentTypes: Set<string>
  liveness: Set<Liveness>
  scoreMin: number
  scoreMax: number
}

// Default filter shows only Active listings — stale/closed are kept on disk
// for historical knowledge but hidden from the day-to-day applying view.
export const EMPTY_FILTERS: FacetFilters = {
  companies: new Set(),
  locations: new Set(),
  archetypes: new Set(),
  tiers: new Set(),
  employmentTypes: new Set(),
  liveness: new Set<Liveness>(['active']),
  scoreMin: 0,
  scoreMax: 10,
}

export function hasActiveFilters(f: FacetFilters): boolean {
  return (
    f.companies.size > 0 ||
    f.locations.size > 0 ||
    f.archetypes.size > 0 ||
    f.tiers.size > 0 ||
    f.employmentTypes.size > 0 ||
    f.liveness.size !== 1 || !f.liveness.has('active') ||
    f.scoreMin > 0 ||
    f.scoreMax < 10
  )
}

// Per-option entity counts, keyed by option value. Optional — when omitted
// (e.g. a future consumer that hasn't wired counts) the groups render exactly
// as before. Counts are faceted: each map already reflects the other active
// filters, computed by the caller.
export interface FacetCounts {
  companies: Record<string, number>
  locations: Record<string, number>
  archetypes: Record<string, number>
  tiers: Record<string, number>
  employmentTypes: Record<string, number>
  liveness: Record<string, number>
}

interface FacetSidebarProps {
  filters: FacetFilters
  onChange: (f: FacetFilters) => void
  options: {
    companies: string[]
    locations: string[]
    archetypes: string[]
    tiers: string[]
    employmentTypes: string[]
  }
  counts?: FacetCounts
}

export function FacetSidebar({ filters, onChange, options, counts }: FacetSidebarProps) {
  const toggle = (key: keyof Pick<FacetFilters, 'companies' | 'locations' | 'archetypes' | 'tiers' | 'employmentTypes'>, val: string) => {
    const next = new Set(filters[key])
    if (next.has(val)) next.delete(val)
    else next.add(val)
    onChange({ ...filters, [key]: next })
  }

  const clearAll = () => onChange({ ...EMPTY_FILTERS })

  const activeCount =
    filters.companies.size + filters.locations.size + filters.archetypes.size +
    filters.tiers.size + filters.employmentTypes.size +
    (filters.scoreMin > 0 || filters.scoreMax < 10 ? 1 : 0)

  return (
    <div className="w-52 shrink-0 border-r border-border-default flex flex-col bg-bg-chrome overflow-y-auto">
      <div className="flex items-center justify-between px-3 h-10 shrink-0 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase">Filters</span>
        {activeCount > 0 ? (
          <button onClick={clearAll} className="flex items-center gap-1 text-label text-text-3 hover:text-danger transition-colors">
            <X size={11} />
            Clear {activeCount}
          </button>
        ) : (
          <span aria-hidden />
        )}
      </div>

      <div className="flex-1 p-2 space-y-1">
        <FacetGroup
          label="Liveness"
          items={['active', 'stale', 'closed']}
          selected={filters.liveness as Set<string>}
          counts={counts?.liveness}
          onToggle={v => {
            const next = new Set(filters.liveness)
            const lv = v as Liveness
            if (next.has(lv)) next.delete(lv); else next.add(lv)
            // Don't allow zero-selection — fall back to active only.
            if (next.size === 0) next.add('active')
            onChange({ ...filters, liveness: next })
          }}
          renderItem={lv => <LivenessChip liveness={lv as Liveness} />}
        />
        <FacetGroup
          label="Tier"
          items={['T1', 'T2', 'T3', 'T4']}
          selected={filters.tiers}
          counts={counts?.tiers}
          onToggle={v => toggle('tiers', v)}
          renderItem={tier => <TierChip tier={tier} />}
        />
        <FacetGroup
          label="Company"
          items={options.companies}
          selected={filters.companies}
          counts={counts?.companies}
          onToggle={v => toggle('companies', v)}
          maxShow={8}
        />
        <FacetGroup
          label="Location"
          items={options.locations}
          selected={filters.locations}
          counts={counts?.locations}
          onToggle={v => toggle('locations', v)}
          maxShow={6}
        />
        <FacetGroup
          label="Archetype"
          items={options.archetypes}
          selected={filters.archetypes}
          counts={counts?.archetypes}
          onToggle={v => toggle('archetypes', v)}
          maxShow={6}
        />
        <FacetGroup
          label="Employment type"
          items={options.employmentTypes}
          selected={filters.employmentTypes}
          counts={counts?.employmentTypes}
          onToggle={v => toggle('employmentTypes', v)}
        />
        <ScoreRangeGroup
          min={filters.scoreMin}
          max={filters.scoreMax}
          onChange={(min, max) => onChange({ ...filters, scoreMin: min, scoreMax: max })}
        />
      </div>
    </div>
  )
}

function FacetGroup({
  label, items, selected, onToggle, maxShow = 20, renderItem, counts,
}: {
  label: string
  items: string[]
  selected: Set<string>
  onToggle: (v: string) => void
  maxShow?: number
  renderItem?: (v: string) => React.ReactNode
  counts?: Record<string, number>
}) {
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)

  // Groups with a fixed semantic order (Tier T1→T4, Liveness active→closed,
  // flagged by having a renderItem) keep their given order. Free-form value
  // lists (companies, locations…) sort by count desc when counts are present,
  // so the maxShow truncation surfaces the most-populated options instead of
  // an alphabetical head.
  const ordered = counts && !renderItem
    ? [...items].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b))
    : items
  const visible = showAll ? ordered : ordered.slice(0, maxShow)
  const activeInGroup = items.filter(i => selected.has(i)).length

  if (items.length === 0) return null

  return (
    <div className="rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-bg-elevated rounded-md transition-colors group"
      >
        <div className="flex items-center gap-1.5">
          <span className={cn('text-label font-medium transition-colors',
            activeInGroup > 0 ? 'text-text-1' : 'text-text-2')}>{label}</span>
          {activeInGroup > 0 && (
            <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-pill bg-accent/15 text-accent text-[9.5px] font-mono font-semibold">
              {activeInGroup}
            </span>
          )}
        </div>
        {expanded
          ? <ChevronDown size={12} className="text-text-4 group-hover:text-text-2 transition-colors" />
          : <ChevronRight size={12} className="text-text-4 group-hover:text-text-2 transition-colors" />}
      </button>

      {expanded && (
        <div className="space-y-0.5 pb-1">
          {visible.map(item => {
            const isOn = selected.has(item)
            const count = counts?.[item]
            // Grey options that would yield nothing under the current filters,
            // but keep them clickable (and never grey a selected one).
            const muted = count === 0 && !isOn
            return (
              <label
                key={item}
                className={cn(
                  'flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer transition-colors',
                  isOn ? 'bg-accent/8' : 'hover:bg-bg-elevated',
                  muted && 'opacity-45',
                )}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(item)}
                  className="w-3 h-3 accent-accent cursor-pointer shrink-0"
                />
                <span className="flex-1 min-w-0 truncate">
                  {renderItem ? renderItem(item) : (
                    <span className="text-label text-text-2">{item}</span>
                  )}
                </span>
                {counts && (
                  <span className="shrink-0 text-[10px] font-mono tabular-nums text-text-4">
                    {count ?? 0}
                  </span>
                )}
              </label>
            )
          })}
          {!showAll && items.length > maxShow && (
            <button
              onClick={() => setShowAll(true)}
              className="text-label text-text-4 hover:text-accent-text px-2 py-0.5 transition-colors"
            >
              +{items.length - maxShow} more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ScoreRangeGroup({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const [expanded, setExpanded] = useState(true)
  const active = min > 0 || max < 10

  return (
    <div className="rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-bg-elevated rounded-md transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-label text-text-2 font-medium">Score range</span>
          {active && <span className="px-1 py-0.5 text-[10px] bg-accent/20 text-accent-text rounded font-mono">1</span>}
        </div>
        {expanded ? <ChevronDown size={12} className="text-text-4" /> : <ChevronRight size={12} className="text-text-4" />}
      </button>
      {expanded && (
        <div className="px-2 pb-3 pt-1 space-y-3">
          {/* Value labels */}
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="font-mono text-[11px] text-text-2 tabular-nums">
              {min.toFixed(1)}
            </span>
            <span className="font-mono text-[11px] text-text-2 tabular-nums">
              {max.toFixed(1)}
            </span>
          </div>

          {/* Dual-handle slider */}
          <div className="relative h-4">
            {/* Inactive track */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-border-default rounded-pill" />
            {/* Active fill between handles */}
            <div
              className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent rounded-pill"
              style={{
                left:  `${(min / 10) * 100}%`,
                right: `${(1 - max / 10) * 100}%`,
              }}
            />
            {/* Two native ranges, transparent track + styled thumbs */}
            <input
              type="range" min={0} max={10} step={0.5} value={min}
              onChange={e => {
                const v = parseFloat(e.target.value)
                onChange(v, Math.max(v, max))
              }}
              className="range-overlay"
              style={{ zIndex: min > 9.5 ? 3 : 2 }}
              aria-label="Minimum score"
            />
            <input
              type="range" min={0} max={10} step={0.5} value={max}
              onChange={e => {
                const v = parseFloat(e.target.value)
                onChange(Math.min(min, v), v)
              }}
              className="range-overlay"
              style={{ zIndex: 2 }}
              aria-label="Maximum score"
            />
          </div>

          {/* Endpoint ticks */}
          <div className="flex justify-between text-[10px] text-text-4 font-mono px-1">
            <span>0</span>
            <span>10</span>
          </div>
        </div>
      )}
    </div>
  )
}

function TierChip({ tier }: { tier: string }) {
  return (
    <span className="text-label font-mono text-text-2">
      {tier === 'T2-high' ? 'T2+' : tier}
    </span>
  )
}

function LivenessChip({ liveness }: { liveness: Liveness }) {
  const dot = liveness === 'active' ? 'bg-success'
            : liveness === 'stale'  ? 'bg-warning' : 'bg-text-4'
  const text = liveness === 'active' ? 'text-text-1'
            : liveness === 'stale'  ? 'text-text-2' : 'text-text-3'
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('inline-block w-1.5 h-1.5 rounded-full', dot)}
        style={{ boxShadow: liveness === 'active' ? '0 0 0 2px rgba(34,197,94,0.18)' : undefined }}
        aria-hidden
      />
      <span className={cn('text-label capitalize', text)}>{liveness}</span>
    </span>
  )
}
