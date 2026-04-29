'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { ipc, type DbReportRow } from '@/lib/ipc'
import { Search, FileText, X, ExternalLink, Sparkles, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import type { ReportFile, ScoreEntry } from '@/types'
import { ReportSlideOver } from './ReportSlideOver'

const TOP5_SPAWN_ID = 'reports-top5'

// Prompt for the "Generate top 5 reports" button. Selective + deeper:
// only 5 reports, but each one is the FULL T1 template depth (Role
// Summary + Recommendation + Career Path Impact) regardless of the
// listing's actual tier. The trade-off — fewer reports, more effort
// per report, more precision in scoring — is the explicit philosophy
// shift the user wanted.
const TOP5_PROMPT =
  '/career-ops pipeline — TOP 5 REPORTS mode (deep). ' +
  '(1) Fetch each pending URL\'s JD, apply user/portals.yml title filters, dedup against data/dedup-index.tsv. ' +
  '(2) **Run modes/pipeline.md Step 2c — Relevance gate**. Discard off-archetype / wrong-seniority / geo-locked / excluded-domain / visa-locked / poverty-wage listings into the Filtered Out section. Do NOT score discarded entries. ' +
  '(3) For SURVIVING entries — run the FULL DIMENSIONAL SCORING per modes/scouting.md (all 10 dimensions, each reasoning cell meeting the modes/_shared.md § Reasoning column quality bar — verbatim JD quote OR named calibration adjustment OR explicit [no gate stated]; no platitudes). Write scouting.md + score-history.tsv rows for ALL survivors. ' +
  '(4) Identify the **5 highest-scoring** entries by Overall. ' +
  '(5) For those 5 ONLY — write the full per-listing prose report under reports/tier-N/{Company} - {Role}.md using the **FULL Tier-1 template** from modes/scouting.md (Header + A) Role summary + B) Dimensional scoring + C) Recommendation [2-3 lines] + D) Career path impact [4 structured lines]) regardless of the entry\'s actual tier. The user has chosen quality over quantity here — use the deeper template even if a listing would normally land at T2/T3. ' +
  '(6) Remaining surviving entries stay scored in scouting.md with no prose report — the user can promote individual ones later via the Database "Generate report" action. ' +
  '(7) Mark all scored URLs as [x] in pipeline.md. ' +
  'Goal: 5 deep, defensible reports the user can act on, instead of 8 shallow ones.'

export function ReportsView() {
  const { scoreHistory, loaded, refresh } = useDataStore()
  const generateReportModel = useAppStore(s => s.models.generateReport)
  const top5Spawn = useSpawnsStore(s => s.spawns[TOP5_SPAWN_ID])
  const startSpawn = useSpawnsStore(s => s.start)
  const killSpawn  = useSpawnsStore(s => s.kill)
  const clearSpawn = useSpawnsStore(s => s.clear)
  const repoPath = useAppStore(s => s.repoPath)

  const top5Running = top5Spawn?.status === 'running'

  const handleGenerateTop5 = () => {
    if (top5Running) { killSpawn(TOP5_SPAWN_ID); return }
    if (top5Spawn) clearSpawn(TOP5_SPAWN_ID)
    startSpawn(TOP5_SPAWN_ID, 'Generate top 5 reports', 'claude', claudeArgs(TOP5_PROMPT, generateReportModel))
  }
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

  // When the top-5 spawn finishes, force a data refresh so the new
  // reports show up without having to switch tabs / restart.
  useEffect(() => {
    if (top5Spawn?.status === 'done') {
      void refresh()
    }
  }, [top5Spawn?.status, refresh])

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

  // Pre-compute fast lookups so resolving each report's score is O(1) rather
  // than three sequential .find() over the whole array. Without this, large
  // report sets caused a visible flicker on tab switch (~50 reports × 350
  // score rows × 3 finds = ~50k ops on every render).
  const scoreIndex = useMemo(() => {
    const byExact   = new Map<string, ScoreEntry>()
    const byCompany = new Map<string, ScoreEntry[]>()
    for (const s of scoreHistory) {
      const c  = s.company.trim().toLowerCase()
      const ro = s.role.trim().toLowerCase()
      byExact.set(`${c}|${ro}`, s)
      const list = byCompany.get(c)
      if (list) list.push(s)
      else byCompany.set(c, [s])
    }
    return { byExact, byCompany }
  }, [scoreHistory])

  // Match strategy: exact key → company-only prefix match → highest-overall
  // for that company. Better a stale score than a blank badge.
  const scoreFor = (r: { company: string; role: string }): ScoreEntry | null => {
    const c  = r.company.trim().toLowerCase()
    const ro = r.role.trim().toLowerCase()
    const exact = scoreIndex.byExact.get(`${c}|${ro}`)
    if (exact) return exact
    const list = scoreIndex.byCompany.get(c)
    if (!list || list.length === 0) return null
    const prefix = list.find(s => {
      const sr = s.role.trim().toLowerCase()
      return sr.startsWith(ro) || ro.startsWith(sr)
    })
    if (prefix) return prefix
    let best: ScoreEntry | null = null
    for (const s of list) {
      if (!best || s.overall > best.overall) best = s
    }
    return best
  }

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
        {/* Search — borderless, no focus halo. Just an icon + input that
            blends with the chrome row. */}
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search size={13} className="text-text-4 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search company or role…"
            className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-text-4 hover:text-text-2 shrink-0">
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

        <div className="flex-1" />

        {/* Right-aligned actions. Generate Top 5 spawns the deep-template
            top-5 run — the philosophy shift is "5 deep, defensible reports
            beats 8 shallow ones". Live progress in the Activity tab. */}
        <button
          onClick={handleGenerateTop5}
          disabled={!repoPath}
          title={top5Running
            ? 'Stop the run (live log on the Activity tab)'
            : 'Filter the pipeline → score survivors → write deep reports for the 5 highest-scoring entries. Uses Claude tokens; live log on the Activity tab.'}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label border transition-colors',
            top5Running
              ? 'bg-danger/10 border-danger/40 text-danger hover:bg-danger/15'
              : 'bg-accent/15 border-accent/35 text-accent-text hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {top5Running ? <Square size={11} className="fill-current" /> : <Sparkles size={12} />}
          {top5Running ? 'Stop' : 'Generate top 5 reports'}
        </button>
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
            {filteredFiles.map(report => {
              const score = scoreFor(report)
              // Prefer the SQL join's overall (already keyed to this report
              // file's exact path); fall back to the in-memory score lookup
              // for orphan rows where the join returned null.
              const overall = report.overall ?? score?.overall ?? null
              // Prefer the URL stored on the report (parsed from its
              // markdown body at sync time); fall back to the score row's
              // url for orphans whose report file lacks a header URL.
              const url = report.url || score?.url || ''
              return (
                <ReportCard
                  key={report.path}
                  report={report}
                  overall={overall}
                  url={url && /^https?:\/\//i.test(url) ? url : null}
                  isSelected={selected?.path === report.path}
                  onClick={() => setSelected({
                    path: report.path,
                    company: report.company,
                    role: report.role,
                    tier: report.tier,
                    url: report.url ?? '',
                  })}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Slide-over */}
      {selected && selectedScore && (
        <ReportSlideOver
          company={selected.company}
          role={selected.role}
          scoreEntry={selectedScore}
          onSwitchEntity={(targetCompany, targetRole) => {
            const match = [...scoreHistory]
              .filter(r => r.company === targetCompany && r.role === targetRole)
              .sort((a, b) => b.date.localeCompare(a.date))[0]
            if (!match) return
            // Map back to a ReportFile-shaped Selected: derive tier dir
            // from the score's tier string (T1→tier-1, T2/T2-high→tier-2,
            // T3→tier-3, T4→tier-4) and synthesize a path. The actual
            // file lookup happens inside the slide-over via fileExists.
            const tierDir = match.tier === 'T1' ? 'tier-1'
              : (match.tier === 'T2' || match.tier === 'T2-high') ? 'tier-2'
              : match.tier === 'T3' ? 'tier-3' : 'tier-4'
            setSelected({
              path:    `reports/${tierDir}/${match.company} - ${match.role}.md`,
              company: match.company,
              role:    match.role,
              tier:    tierDir,
              url:     match.url ?? '',
            })
          }}
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

// Score → galaxy color, matching the tier scale used by the Database table.
// Kept inline because importing from OffersTable would pull react-table
// machinery into the Reports bundle.
function scoreColor(v: number): string {
  if (v >= 8.5) return '#3D2BB5'   // T1 — deep galaxy indigo
  if (v >= 7)   return '#7C5CFF'   // T2 — galaxy violet
  if (v >= 5)   return '#A89CD9'   // T3 — muted lavender
  return '#94A3B8'                  // T4 — faded slate
}

function ScoreBadge({ value }: { value: number }) {
  const color = scoreColor(value)
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 py-0.5 rounded font-mono font-semibold tabular-nums text-[11px] shrink-0"
      style={{
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
      }}
    >
      {value.toFixed(1)}
    </span>
  )
}

function ReportCard({
  report,
  overall,
  url,
  isSelected,
  onClick,
}: {
  report: { path: string; company: string; role: string; tier: string }
  overall: number | null
  url: string | null
  isSelected: boolean
  onClick: () => void
}) {
  return (
    <div className="relative">
      <button
        onClick={onClick}
        className={cn(
          'w-full text-left p-3 rounded-lg border transition-colors group',
          isSelected
            ? 'bg-accent/10 border-accent/40'
            : 'bg-bg-panel border-border-default hover:border-border-strong hover:bg-bg-elevated',
        )}
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <CompanyLogo company={report.company} size={26} className="mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[13px] text-text-1 font-semibold leading-snug truncate min-w-0">{report.company}</div>
              {overall != null && overall > 0 && <ScoreBadge value={overall} />}
            </div>
            {/* Reserve room for the absolute-positioned URL button on the
                bottom-right (6px + 24px + a hair). Without this padding the
                role string runs under the button. */}
            <div className={cn(
              'text-[12px] text-text-3 truncate mt-1 leading-snug',
              url ? 'pr-9' : 'pr-1',
            )}>
              {report.role}
            </div>
          </div>
        </div>
      </button>
      {url && (
        <button
          onClick={(e) => { e.stopPropagation(); ipc.openExternal(url) }}
          title="Open job posting"
          aria-label="Open job posting"
          className="absolute bottom-1.5 right-1.5 inline-flex items-center justify-center w-6 h-6 rounded-md text-text-4 opacity-60 hover:opacity-100 hover:text-accent hover:bg-accent/15 transition-all"
        >
          <ExternalLink size={11} />
        </button>
      )}
    </div>
  )
}
