'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FacetFilters {
  companies: Set<string>
  locations: Set<string>
  archetypes: Set<string>
  tiers: Set<string>
  employmentTypes: Set<string>
  scoreMin: number
  scoreMax: number
}

export const EMPTY_FILTERS: FacetFilters = {
  companies: new Set(),
  locations: new Set(),
  archetypes: new Set(),
  tiers: new Set(),
  employmentTypes: new Set(),
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
    f.scoreMin > 0 ||
    f.scoreMax < 10
  )
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
}

export function FacetSidebar({ filters, onChange, options }: FacetSidebarProps) {
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
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase">Filters</span>
        {activeCount > 0 && (
          <button onClick={clearAll} className="flex items-center gap-1 text-label text-text-3 hover:text-danger transition-colors">
            <X size={11} />
            Clear {activeCount}
          </button>
        )}
      </div>

      <div className="flex-1 p-2 space-y-1">
        <FacetGroup
          label="Tier"
          items={['T1', 'T2-high', 'T2', 'T3', 'T4']}
          selected={filters.tiers}
          onToggle={v => toggle('tiers', v)}
          renderItem={tier => <TierChip tier={tier} />}
        />
        <FacetGroup
          label="Company"
          items={options.companies}
          selected={filters.companies}
          onToggle={v => toggle('companies', v)}
          maxShow={8}
        />
        <FacetGroup
          label="Location"
          items={options.locations}
          selected={filters.locations}
          onToggle={v => toggle('locations', v)}
          maxShow={6}
        />
        <FacetGroup
          label="Archetype"
          items={options.archetypes}
          selected={filters.archetypes}
          onToggle={v => toggle('archetypes', v)}
          maxShow={6}
        />
        <FacetGroup
          label="Employment type"
          items={options.employmentTypes}
          selected={filters.employmentTypes}
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
  label, items, selected, onToggle, maxShow = 20, renderItem,
}: {
  label: string
  items: string[]
  selected: Set<string>
  onToggle: (v: string) => void
  maxShow?: number
  renderItem?: (v: string) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? items : items.slice(0, maxShow)
  const activeInGroup = items.filter(i => selected.has(i)).length

  if (items.length === 0) return null

  return (
    <div className="rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-bg-elevated rounded-md transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-label text-text-2 font-medium">{label}</span>
          {activeInGroup > 0 && (
            <span className="px-1 py-0.5 text-[10px] bg-accent/20 text-accent-text rounded font-mono">{activeInGroup}</span>
          )}
        </div>
        {expanded ? <ChevronDown size={12} className="text-text-4" /> : <ChevronRight size={12} className="text-text-4" />}
      </button>

      {expanded && (
        <div className="space-y-0.5 pb-1">
          {visible.map(item => (
            <label
              key={item}
              className="flex items-center gap-2 px-2 py-1 rounded-md cursor-pointer hover:bg-bg-elevated transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(item)}
                onChange={() => onToggle(item)}
                className="w-3 h-3 accent-[#0064E0] cursor-pointer"
              />
              {renderItem ? renderItem(item) : (
                <span className="text-label text-text-2 truncate">{item}</span>
              )}
            </label>
          ))}
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
        <div className="px-2 pb-2 space-y-1.5">
          <div className="flex justify-between text-label text-text-3 font-mono">
            <span>{min.toFixed(1)}</span>
            <span>{max.toFixed(1)}</span>
          </div>
          <input
            type="range" min={0} max={10} step={0.5} value={min}
            onChange={e => onChange(parseFloat(e.target.value), Math.max(parseFloat(e.target.value), max))}
            className="w-full accent-[#0064E0]"
          />
          <input
            type="range" min={0} max={10} step={0.5} value={max}
            onChange={e => onChange(Math.min(min, parseFloat(e.target.value)), parseFloat(e.target.value))}
            className="w-full accent-[#0064E0]"
          />
        </div>
      )}
    </div>
  )
}

function TierChip({ tier }: { tier: string }) {
  const colorMap: Record<string, string> = {
    'T1':     'text-tier-1',
    'T2-high':'text-success',
    'T2':     'text-tier-2',
    'T3':     'text-tier-3',
    'T4':     'text-tier-4',
  }
  return (
    <span className={cn('text-label font-mono font-medium', colorMap[tier] ?? 'text-text-2')}>
      {tier === 'T2-high' ? 'T2+' : tier}
    </span>
  )
}
