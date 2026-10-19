'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
// clsx, not cn(): twMerge reads the custom `text-label` / `text-body` sizes as
// colours and would drop them next to a `text-text-*` class.
import { clsx } from 'clsx'
import { Button, Chip, TierChip } from '@/components/ui'
import type { Eligibility, Verdict } from '@/types'
import { EligibilityChip, VerdictChip } from '@/components/shared/EligibilityChip'

export type Liveness = 'active' | 'stale' | 'closed'

export interface FacetFilters {
  companies: Set<string>
  locations: Set<string>
  archetypes: Set<string>
  tiers: Set<string>
  /** Verdict keys (scoring v2). */
  verdicts: Set<string>
  /** green / amber / red. */
  eligibilities: Set<string>
  employmentTypes: Set<string>
  liveness: Set<Liveness>
  /** Per-axis ranges — v2 has no Overall. */
  wantMin: number
  wantMax: number
  easeMin: number
  easeMax: number
}

// Default filter shows only Active listings — stale/closed are kept on disk
// for historical knowledge but hidden from the day-to-day applying view.
export const EMPTY_FILTERS: FacetFilters = {
  companies: new Set(),
  locations: new Set(),
  archetypes: new Set(),
  tiers: new Set(),
  verdicts: new Set(),
  eligibilities: new Set(),
  employmentTypes: new Set(),
  liveness: new Set<Liveness>(['active']),
  wantMin: 0,
  wantMax: 10,
  easeMin: 0,
  easeMax: 10,
}

const rangeOn = (min: number, max: number) => min > 0 || max < 10

export function hasActiveFilters(f: FacetFilters): boolean {
  return (
    f.companies.size > 0 ||
    f.locations.size > 0 ||
    f.archetypes.size > 0 ||
    f.tiers.size > 0 ||
    f.verdicts.size > 0 ||
    f.eligibilities.size > 0 ||
    f.employmentTypes.size > 0 ||
    f.liveness.size !== 1 || !f.liveness.has('active') ||
    rangeOn(f.wantMin, f.wantMax) ||
    rangeOn(f.easeMin, f.easeMax)
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
  verdicts: Record<string, number>
  eligibilities: Record<string, number>
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
    verdicts: string[]
    eligibilities: string[]
    employmentTypes: string[]
  }
  counts?: FacetCounts
}

export function FacetSidebar({ filters, onChange, options, counts }: FacetSidebarProps) {
  const toggle = (key: keyof Pick<FacetFilters, 'companies' | 'locations' | 'archetypes' | 'tiers' | 'verdicts' | 'eligibilities' | 'employmentTypes'>, val: string) => {
    const next = new Set(filters[key])
    if (next.has(val)) next.delete(val)
    else next.add(val)
    onChange({ ...filters, [key]: next })
  }

  const clearAll = () => onChange({ ...EMPTY_FILTERS })

  const activeCount =
    filters.companies.size + filters.locations.size + filters.archetypes.size +
    filters.tiers.size + filters.verdicts.size + filters.eligibilities.size +
    filters.employmentTypes.size +
    (rangeOn(filters.wantMin, filters.wantMax) ? 1 : 0) +
    (rangeOn(filters.easeMin, filters.easeMax) ? 1 : 0)

  return (
    <div className="w-[200px] shrink-0 border-r border-border-default/70 flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-2 pl-3 pr-2 h-9 shrink-0 border-b border-border-default">
        <span className="label">Filters</span>
        {activeCount > 0 ? (
          <Button tone="ghost" size="xs" onClick={clearAll} icon={<X size={12} aria-hidden />}>
            Clear {activeCount}
          </Button>
        ) : (
          <span aria-hidden />
        )}
      </div>

      <div className="flex-1 px-1.5 py-2 space-y-2">
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
          renderItem={lv => <LivenessLabel liveness={lv as Liveness} />}
        />
        <FacetGroup
          label="Eligibility"
          items={options.eligibilities}
          selected={filters.eligibilities}
          counts={counts?.eligibilities}
          onToggle={v => toggle('eligibilities', v)}
          renderItem={e => <EligibilityChip status={e as Eligibility} />}
        />
        <FacetGroup
          label="Verdict"
          items={options.verdicts}
          selected={filters.verdicts}
          counts={counts?.verdicts}
          onToggle={v => toggle('verdicts', v)}
          renderItem={v => <VerdictChip verdict={v as Verdict} />}
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
          label="Want range"
          min={filters.wantMin}
          max={filters.wantMax}
          onChange={(min, max) => onChange({ ...filters, wantMin: min, wantMax: max })}
        />
        <ScoreRangeGroup
          label="Ease range"
          min={filters.easeMin}
          max={filters.easeMax}
          onChange={(min, max) => onChange({ ...filters, easeMin: min, easeMax: max })}
        />
      </div>
    </div>
  )
}

// Group title row: sentence-case title, an accent count when the group has a
// selection, chevron on the right. Shared by the value groups and the slider.
function GroupHeader({
  label, activeCount, expanded, onToggle,
}: {
  label: string
  activeCount: number
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group w-full h-7 flex items-center justify-between gap-2 px-2 rounded hover:bg-bg-elevated transition-colors duration-150"
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-body font-medium text-text-1 truncate">{label}</span>
        {activeCount > 0 && <Chip tone="accent" pill>{activeCount}</Chip>}
      </span>
      {expanded
        ? <ChevronDown size={14} className="shrink-0 text-text-4 group-hover:text-text-2 transition-colors" aria-hidden />
        : <ChevronRight size={14} className="shrink-0 text-text-4 group-hover:text-text-2 transition-colors" aria-hidden />}
    </button>
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
    <div>
      <GroupHeader
        label={label}
        activeCount={activeInGroup}
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
      />

      {expanded && (
        <div className="pt-0.5">
          {visible.map(item => {
            const isOn = selected.has(item)
            const count = counts?.[item]
            // Grey options that would yield nothing under the current filters,
            // but keep them clickable (and never grey a selected one).
            const muted = count === 0 && !isOn
            return (
              <label
                key={item}
                className={clsx(
                  'h-7 flex items-center gap-2 px-2 rounded cursor-pointer hover:bg-bg-elevated transition-colors duration-150',
                  muted && 'opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(item)}
                  className="w-[13px] h-[13px] accent-accent cursor-pointer shrink-0"
                />
                <span className="flex-1 min-w-0 flex items-center">
                  {renderItem ? renderItem(item) : (
                    <span className={clsx('text-label truncate', isOn ? 'text-text-1' : 'text-text-2')} title={item}>
                      {item}
                    </span>
                  )}
                </span>
                {counts && (
                  <span className="shrink-0 text-label text-text-4 tabular-nums text-right">
                    {count ?? 0}
                  </span>
                )}
              </label>
            )
          })}
          {!showAll && items.length > maxShow && (
            <Button tone="ghost" size="xs" onClick={() => setShowAll(true)} className="ml-5">
              +{items.length - maxShow} more
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// A narrowed range keeps scored rows only — a blocked listing has no Want or
// Ease to range over (lib/databaseRows § inRanges).
function ScoreRangeGroup({ label, min, max, onChange }: { label: string; min: number; max: number; onChange: (min: number, max: number) => void }) {
  const [expanded, setExpanded] = useState(true)
  const active = min > 0 || max < 10

  return (
    <div>
      <GroupHeader
        label={label}
        activeCount={active ? 1 : 0}
        expanded={expanded}
        onToggle={() => setExpanded(e => !e)}
      />
      {expanded && (
        <div className="px-2 pb-3 pt-1.5 space-y-2.5">
          {/* Value labels */}
          <div className="flex items-center justify-between gap-2 px-1 text-label text-text-2 tabular-nums">
            <span>{min.toFixed(1)}</span>
            <span>{max.toFixed(1)}</span>
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
              aria-label={`Minimum ${label.toLowerCase()}`}
            />
            <input
              type="range" min={0} max={10} step={0.5} value={max}
              onChange={e => {
                const v = parseFloat(e.target.value)
                onChange(Math.min(min, v), v)
              }}
              className="range-overlay"
              style={{ zIndex: 2 }}
              aria-label={`Maximum ${label.toLowerCase()}`}
            />
          </div>

          {/* Endpoint ticks */}
          <div className="flex justify-between px-1 text-micro font-normal text-text-4 tabular-nums">
            <span>0</span>
            <span>10</span>
          </div>
        </div>
      )}
    </div>
  )
}

const LIVENESS_LABEL: Record<Liveness, string> = {
  active: 'Active',
  stale:  'Stale',
  closed: 'Closed',
}

// Liveness option: a small state dot (green live / amber stale / muted closed)
// and a sentence-case label. No glow — the dot is enough.
function LivenessLabel({ liveness }: { liveness: Liveness }) {
  const dot = liveness === 'active' ? 'bg-success'
            : liveness === 'stale'  ? 'bg-warning' : 'bg-text-4'
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className={clsx('inline-block w-1.5 h-1.5 rounded-full shrink-0', dot)} aria-hidden />
      <span className="text-label text-text-2 truncate">{LIVENESS_LABEL[liveness]}</span>
    </span>
  )
}
