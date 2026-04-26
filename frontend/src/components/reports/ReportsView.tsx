'use client'

import { useState, useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { ipc } from '@/lib/ipc'
import { Search, FileText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import type { ReportFile } from '@/types'
import { ReportSlideOver } from './ReportSlideOver'
import type { ScoreEntry } from '@/types'

export function ReportsView() {
  const { reports: reportFiles, scoreHistory, loaded } = useDataStore()
  const [query, setQuery] = useState('')
  const [selectedTiers, setSelectedTiers] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<ReportFile | null>(null)

  const filteredFiles = useMemo(() => {
    let rows = reportFiles
    if (selectedTiers.size > 0) rows = rows.filter(r => selectedTiers.has(r.tier))
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(r =>
        r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)
      )
    }
    return rows.sort((a, b) => {
      const tierOrder = ['tier-1', 'tier-2', 'tier-3', 'tier-4']
      return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier)
    })
  }, [reportFiles, query, selectedTiers])

  const toggleTier = (tier: string) => {
    const next = new Set(selectedTiers)
    if (next.has(tier)) { next.delete(tier) } else { next.add(tier) }
    setSelectedTiers(next)
  }

  // Find matching ScoreEntry for a report file
  const scoreFor = (r: ReportFile): ScoreEntry | null =>
    scoreHistory.find(s => s.company === r.company && s.role === r.role) ?? null

  const selectedScore = selected ? scoreFor(selected) : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="titlebar-drag h-11 shrink-0 border-b border-border-default" />

      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <h1 className="text-body text-text-1 font-medium">Reports</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${filteredFiles.length} / ${reportFiles.length}` : '…'}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        {/* Search */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border-default bg-bg-elevated flex-1 max-w-sm">
          <Search size={13} className="text-text-4 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search company or role…"
            className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-text-4 hover:text-text-2">
              <X size={11} />
            </button>
          )}
        </div>

        {/* Tier filter chips */}
        <div className="flex items-center gap-1.5">
          {(['tier-1', 'tier-2', 'tier-3', 'tier-4'] as const).map(tier => {
            const tierKey = tier.replace('tier-', 'T') as TierKey
            const adjusted = tierKey === 'T2' ? 'T2' : tierKey
            const colors = TIER_COLORS[adjusted as TierKey] ?? TIER_COLORS['T4']
            const active = selectedTiers.has(tier)
            const label = { 'tier-1': 'T1', 'tier-2': 'T2', 'tier-3': 'T3', 'tier-4': 'T4' }[tier]
            return (
              <button
                key={tier}
                onClick={() => toggleTier(tier)}
                className={cn(
                  'px-2 py-0.5 text-micro font-mono rounded border transition-colors',
                  active ? cn(colors.bg, colors.text, colors.border) : 'text-text-4 border-border-default hover:border-border-strong',
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {!loaded ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-24 shimmer rounded-lg" />
            ))}
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-text-4 gap-3">
            <FileText size={32} className="opacity-30" />
            <p className="text-label">No reports match your search.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {filteredFiles.map(report => (
              <ReportCard
                key={report.path}
                report={report}
                score={scoreFor(report)}
                isSelected={selected?.path === report.path}
                onClick={() => setSelected(report)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Slide-over */}
      {selected && selectedScore && (
        <ReportSlideOver
          company={selected.company}
          role={selected.role}
          scoreEntry={selectedScore}
          onClose={() => setSelected(null)}
        />
      )}
      {selected && !selectedScore && (
        <ReportSlideOver
          company={selected.company}
          role={selected.role}
          scoreEntry={{
            company: selected.company,
            role: selected.role,
            tier: selected.tier.replace('tier-', 'T') as TierKey,
            overall: 0,
            current_fit: 0,
            aspirational_fit: 0,
          } as ScoreEntry}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function ReportCard({
  report,
  score,
  isSelected,
  onClick,
}: {
  report: ReportFile
  score: ScoreEntry | null
  isSelected: boolean
  onClick: () => void
}) {
  const tierKey = (report.tier.replace('tier-', 'T') as TierKey) in TIER_COLORS
    ? (report.tier.replace('tier-', 'T') as TierKey)
    : 'T4'
  const { text: tierText, border, bg } = TIER_COLORS[tierKey]
  const label = { 'T1': 'T1', 'T2-high': 'T2+', 'T2': 'T2', 'T3': 'T3', 'T4': 'T4' }[tierKey] ?? tierKey

  return (
    <button
      onClick={onClick}
      className={cn(
        'text-left p-3 rounded-lg border transition-colors group',
        isSelected
          ? 'bg-accent/10 border-accent/40'
          : 'bg-bg-panel border-border-default hover:border-border-strong hover:bg-bg-elevated',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className={cn('px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border', bg, tierText, border)}>
          {label}
        </span>
        {score && (
          <span className="text-micro font-mono text-text-4">{score.overall.toFixed(1)}</span>
        )}
      </div>
      <div className="text-label text-text-1 font-medium leading-snug truncate">{report.company}</div>
      <div className="text-label text-text-3 truncate mt-0.5">{report.role}</div>
    </button>
  )
}
