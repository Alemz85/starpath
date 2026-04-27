'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { ipc, type DbReportRow } from '@/lib/ipc'
import { Search, FileText, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import type { ReportFile, ScoreEntry } from '@/types'
import { ReportSlideOver } from './ReportSlideOver'

export function ReportsView() {
  const { scoreHistory, loaded } = useDataStore()
  // Pulls from the SQL join in db.reports() so each card already carries its
  // matching overall score. The slide-over still looks up the full
  // ScoreEntry in memory (one find per click is fine at this volume).
  const [reportRows, setReportRows] = useState<DbReportRow[]>([])
  const [query, setQuery] = useState('')
  const [selectedTiers, setSelectedTiers] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<ReportFile | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc.db.reports().then(rs => { if (!cancelled) setReportRows(rs ?? []) }).catch(() => {})
    return () => { cancelled = true }
  }, [scoreHistory.length])

  const filteredFiles = useMemo(() => {
    let rows = reportRows
    if (selectedTiers.size > 0) rows = rows.filter(r => selectedTiers.has(r.tier))
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(r =>
        r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)
      )
    }
    const tierOrder = ['T1', 'T2-high', 'T2', 'T3', 'T4']
    return [...rows].sort((a, b) => {
      const ai = tierOrder.indexOf(a.tier); const bi = tierOrder.indexOf(b.tier)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
  }, [reportRows, query, selectedTiers])

  const toggleTier = (tier: string) => {
    const next = new Set(selectedTiers)
    if (next.has(tier)) { next.delete(tier) } else { next.add(tier) }
    setSelectedTiers(next)
  }

  // Slide-over needs the full ScoreEntry (all scoring dimensions), not just
  // the overall — pulled from the in-memory store on click.
  const scoreFor = (r: { company: string; role: string }): ScoreEntry | null =>
    scoreHistory.find(s => s.company === r.company && s.role === r.role) ?? null

  const selectedScore = selected ? scoreFor(selected) : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Reports</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${filteredFiles.length} / ${reportRows.length}` : '…'}
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

        {/* Tier filter chips. Values match `report.tier` ('T1'/'T2'/'T3'/'T4')
            so `selectedTiers.has(r.tier)` matches directly — earlier code
            stored 'tier-1'/etc. and never matched. */}
        <div className="flex items-center gap-1.5">
          {(['T1', 'T2', 'T3', 'T4'] as const).map(tier => {
            const colors = TIER_COLORS[tier] ?? TIER_COLORS['T4']
            const active = selectedTiers.has(tier)
            return (
              <button
                key={tier}
                onClick={() => toggleTier(tier)}
                className={cn(
                  'px-2 py-0.5 text-micro font-mono rounded border transition-colors',
                  active ? cn(colors.bg, colors.text, colors.border) : 'text-text-4 border-border-default hover:border-border-strong',
                )}
              >
                {tier}
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
          <div className="flex items-center justify-center py-10">
            <div className="galaxy-bg rounded-xl px-10 py-12 flex flex-col items-center gap-3 max-w-sm">
              <FileText size={32} className="text-accent opacity-80" />
              <p className="text-label text-text-3">No reports match your search.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {filteredFiles.map(report => (
              <ReportCard
                key={report.path}
                report={report}
                overall={report.overall}
                isSelected={selected?.path === report.path}
                onClick={() => setSelected({
                  path: report.path,
                  company: report.company,
                  role: report.role,
                  tier: report.tier,
                })}
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
  overall,
  isSelected,
  onClick,
}: {
  report: { path: string; company: string; role: string; tier: string }
  overall: number | null
  isSelected: boolean
  onClick: () => void
}) {
  const rawKey = report.tier as TierKey
  const tierKey: TierKey = (rawKey in TIER_COLORS) ? rawKey : 'T4'
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
      <div className="flex items-start gap-2 min-w-0">
        <CompanyLogo company={report.company} size={24} className="mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-0.5">
            <span className={cn('px-1.5 py-px text-[9.5px] font-mono font-semibold rounded border shrink-0', bg, tierText, border)}>
              {label}
            </span>
            {overall != null && overall > 0 && (
              <span className="text-micro font-mono text-text-4 shrink-0">{overall.toFixed(1)}</span>
            )}
          </div>
          <div className="text-label text-text-1 font-medium leading-snug truncate">{report.company}</div>
          <div className="text-label text-text-3 truncate mt-0.5 leading-snug">{report.role}</div>
        </div>
      </div>
    </button>
  )
}
