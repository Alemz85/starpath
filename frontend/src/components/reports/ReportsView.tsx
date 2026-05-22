'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { ipc, type DbReportRow } from '@/lib/ipc'
import {
  Search, FileText, X, ExternalLink, Sparkles, Square,
  ClipboardList, Lightbulb, Coins, CheckCircle2, TrendingUp, Target,
  Copy, Folder, Check, Compass
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import type { ReportFile, ScoreEntry } from '@/types'
import { ReportSlideOver } from './ReportSlideOver'
import { scoreColor } from '@/lib/tier'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const TOP5_SPAWN_ID = 'reports-top5'
const POSITIONING_SPAWN_ID = 'reports-positioning'

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

export type ScoreBand = 'stellar' | 'strong' | 'decent' | 'pass' | 'skip'

export const BAND_DETAILS: Record<ScoreBand, { label: string; color: string; bg: string; text: string; border: string }> = {
  stellar: { label: 'Stellar (≥9.0)', color: '#2EB8A8', bg: 'bg-[#2EB8A8]/12', text: 'text-[#2EB8A8]', border: 'border-[#2EB8A8]/35' },
  strong:  { label: 'Strong (8.0-8.9)', color: '#3D2BB5', bg: 'bg-[#3D2BB5]/12', text: 'text-[#3D2BB5]', border: 'border-[#3D2BB5]/35' },
  decent:  { label: 'Decent (7.0-7.9)', color: '#7C5CFF', bg: 'bg-[#7C5CFF]/12', text: 'text-[#7C5CFF]', border: 'border-[#7C5CFF]/35' },
  pass:    { label: 'Pass (<7.0)', color: '#A89CD9', bg: 'bg-[#A89CD9]/12', text: 'text-[#A89CD9]', border: 'border-[#A89CD9]/35' },
  skip:    { label: 'Skip', color: '#94A3B8', bg: 'bg-[#94A3B8]/12', text: 'text-[#94A3B8]', border: 'border-[#94A3B8]/35' },
}

export function getScoreBand(overall: number | null, tier: string): ScoreBand {
  if (overall !== null && overall !== undefined && overall > 0) {
    if (overall >= 9.0) return 'stellar'
    if (overall >= 8.0) return 'strong'
    if (overall >= 7.0) return 'decent'
    if (overall >= 5.0) return 'pass'
    return 'skip'
  }
  
  // Fallback to tier mapping
  const t = tier.toUpperCase()
  if (t === 'T1') return 'stellar'
  if (t === 'T2-HIGH') return 'strong'
  if (t === 'T2') return 'decent'
  if (t === 'T3') return 'pass'
  return 'skip'
}

interface PositioningReportInfo {
  filename: string
  path: string
  dateStr: string
  year: number
  month: number
  focusPath: string
  evalCount: string
  content: string
}

/* ───── Custom Micro-Animated Space Icons ───── */

const PulsarIcon = () => (
  <svg className="w-10 h-10" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <style>{`
      @keyframes pulsar-scale {
        0% { transform: scale(0.65); opacity: 0.85; }
        50% { transform: scale(1.05); opacity: 0.25; }
        100% { transform: scale(0.65); opacity: 0.85; }
      }
      .pulsar-ring {
        transform-origin: center;
        animation: pulsar-scale 4s ease-in-out infinite;
      }
      .pulsar-ring-delayed {
        transform-origin: center;
        animation: pulsar-scale 4s ease-in-out infinite 2s;
      }
    `}</style>
    <circle cx="50" cy="50" r="11" fill="#7C5CFF" fillOpacity="0.2" stroke="#7C5CFF" strokeWidth="2" />
    <circle className="pulsar-ring" cx="50" cy="50" r="23" stroke="#5B3FE8" strokeWidth="1.5" strokeDasharray="3 3" />
    <circle className="pulsar-ring-delayed" cx="50" cy="50" r="35" stroke="#3D2BB5" strokeWidth="1" />
  </svg>
)

const ConstellationIcon = () => (
  <svg className="w-10 h-10" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <style>{`
      @keyframes constellation-glow {
        0%, 100% { opacity: 0.45; }
        50% { opacity: 1; }
      }
      .star {
        animation: constellation-glow 3s ease-in-out infinite;
      }
      .star-1 { animation-delay: 0s; }
      .star-2 { animation-delay: 0.8s; }
      .star-3 { animation-delay: 1.6s; }
    `}</style>
    <path d="M25 45 L50 25 L75 55 L50 75 Z" stroke="#7C5CFF" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
    <path d="M50 25 L50 75" stroke="#B5A3FF" strokeWidth="0.75" opacity="0.3" />
    <path d="M25 45 L75 55" stroke="#B5A3FF" strokeWidth="0.75" opacity="0.3" />
    
    <circle className="star star-1" cx="50" cy="25" r="4.5" fill="#7C5CFF" />
    <circle className="star star-2" cx="75" cy="55" r="3.5" fill="#3D2BB5" />
    <circle className="star star-3" cx="50" cy="75" r="4.5" fill="#7C5CFF" />
    <circle className="star star-2" cx="25" cy="45" r="3.5" fill="#5B3FE8" />
  </svg>
)

const NebulaIcon = () => (
  <svg className="w-10 h-10" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <style>{`
      @keyframes nebula-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .nebula-halo {
        transform-origin: center;
        animation: nebula-spin 25s linear infinite;
      }
    `}</style>
    <defs>
      <radialGradient id="nebulaGrad" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#7C5CFF" stopOpacity="0.35" />
        <stop offset="60%" stopColor="#5B3FE8" stopOpacity="0.12" />
        <stop offset="100%" stopColor="#0A0820" stopOpacity="0" />
      </radialGradient>
    </defs>
    <circle cx="50" cy="50" r="45" fill="url(#nebulaGrad)" />
    <g className="nebula-halo">
      <path d="M50 18 A32 32 0 0 1 82 50" stroke="#7C5CFF" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
      <path d="M50 82 A32 32 0 0 1 18 50" stroke="#3D2BB5" strokeWidth="1.25" strokeLinecap="round" opacity="0.5" />
      <circle cx="82" cy="50" r="2.5" fill="#B5A3FF" />
      <circle cx="18" cy="50" r="2" fill="#B5A3FF" />
    </g>
  </svg>
)

export function ReportsView() {
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const generateReportModel = useAppStore(s => s.models.generateReport)
  
  const top5Spawn = useSpawnsStore(s => s.spawns[TOP5_SPAWN_ID])
  const positioningSpawn = useSpawnsStore(s => s.spawns[POSITIONING_SPAWN_ID])
  
  const startSpawn = useSpawnsStore(s => s.start)
  const killSpawn  = useSpawnsStore(s => s.kill)
  const clearSpawn = useSpawnsStore(s => s.clear)
  const repoPath = useAppStore(s => s.repoPath)

  const top5Running = top5Spawn?.status === 'running'
  const positioningRunning = positioningSpawn?.status === 'running'

  const [reportRows, setReportRows] = useState<DbReportRow[]>([])
  const [query, setQuery] = useState('')
  const [selectedBands, setSelectedBands] = useState<Set<ScoreBand>>(new Set())
  const [selected, setSelected] = useState<ReportFile | null>(null)
  
  // Positioning Hub State
  const [positioningReports, setPositioningReports] = useState<PositioningReportInfo[]>([])
  const [loadingPositioning, setLoadingPositioning] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [selectedPositioning, setSelectedPositioning] = useState<PositioningReportInfo | null>(null)

  // Sort State
  const [sortBy, setSortBy] = useState<'score' | 'date' | 'tier'>('score')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const loadPositioningReports = async () => {
    try {
      setLoadingPositioning(true)
      const exists = await ipc.fileExists('reports/positioning')
      if (!exists) {
        setPositioningReports([])
        return
      }
      const files = await ipc.listDir('reports/positioning')
      const mdFiles = files.filter(f => f.startsWith('positioning-') && f.endsWith('.md'))
      
      const parsed: PositioningReportInfo[] = []
      
      for (const file of mdFiles) {
        const path = `reports/positioning/${file}`
        const content = await ipc.readFile(path)
        if (content) {
          const match = file.match(/positioning-(\d{2})-(\d{2})\.md/)
          let dateStr = 'Unknown'
          let year = 0
          let month = 0
          if (match) {
            year = 2000 + parseInt(match[1], 10)
            month = parseInt(match[2], 10)
            const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
            dateStr = `${MONTHS[month - 1]} ${year}`
          }
          
          const focusMatch = content.match(/\*\*Focus path:\*\*\s*(.+)$/mi) || content.match(/\*\*Priority path:\*\*\s*(.+)$/mi)
          // Strip markdown bold markers and trailing prose after an em-dash
          // or comma so the chip caption stays short.
          const focusPath = focusMatch
            ? focusMatch[1]
                .replace(/\*\*/g, '')
                .split(/\s+[—–-]\s+|,\s+/)[0]
                .trim()
            : 'n/d'
          
          const evalMatch = content.match(/\*\*Evaluations analyzed:\*\*\s*(.+)$/mi)
          // The full line ("151 score-history rows (...) · 2 active-tracker
          // entries · 0 previous positioning reports") doesn't fit anywhere
          // we'd want to show it. Pull the first integer for a compact
          // "{N} analyzed" stat usable in tight surfaces.
          const evalCountLong = evalMatch ? evalMatch[1].trim() : 'n/d'
          const firstNum = evalCountLong.match(/\d[\d,]*/)
          const evalCount = firstNum ? firstNum[0] : 'n/d'
          
          parsed.push({
            filename: file,
            path,
            dateStr,
            year,
            month,
            focusPath,
            evalCount,
            content
          })
        }
      }
      
      parsed.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year
        return b.month - a.month
      })
      
      setPositioningReports(parsed)
    } catch (error) {
      console.error('Error loading positioning reports:', error)
    } finally {
      setLoadingPositioning(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    ipc.db.reports().then(rs => { if (!cancelled) setReportRows(rs ?? []) }).catch(() => {})
    return () => { cancelled = true }
  }, [scoreHistory.length])

  useEffect(() => {
    loadPositioningReports()
  }, [])

  useEffect(() => {
    if (top5Spawn?.status === 'done') {
      void refresh()
    }
  }, [top5Spawn?.status, refresh])

  useEffect(() => {
    if (positioningSpawn?.status === 'done') {
      loadPositioningReports()
      void refresh()
    }
  }, [positioningSpawn?.status])

  const handleGenerateTop5 = () => {
    if (top5Running) { killSpawn(TOP5_SPAWN_ID); return }
    if (top5Spawn) clearSpawn(TOP5_SPAWN_ID)
    startSpawn(TOP5_SPAWN_ID, 'Generate top 5 reports', 'claude', claudeArgs(TOP5_PROMPT, generateReportModel))
  }

  const handleAnalyzeTrajectory = () => {
    if (positioningRunning) { killSpawn(POSITIONING_SPAWN_ID); return }
    if (positioningSpawn) clearSpawn(POSITIONING_SPAWN_ID)
    startSpawn(
      POSITIONING_SPAWN_ID,
      'Analyze Career Trajectory',
      'claude',
      claudeArgs('/career-ops positioning', generateReportModel)
    )
  }

  const filteredFiles = useMemo(() => {
    let rows = reportRows
    
    if (selectedBands.size > 0) {
      rows = rows.filter(r => selectedBands.has(getScoreBand(r.overall, r.tier)))
    }
    
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter(r =>
        r.company.toLowerCase().includes(q) || r.role.toLowerCase().includes(q)
      )
    }
    
    const tierOrder = ['T1', 'T2-high', 'T2', 'T3', 'T4']
    
    return [...rows].sort((a, b) => {
      let comp = 0
      if (sortBy === 'score') {
        const sa = a.overall ?? 0
        const sb = b.overall ?? 0
        comp = sb - sa
      } else if (sortBy === 'date') {
        const da = a.mtime ?? 0
        const db = b.mtime ?? 0
        comp = db - da
      } else if (sortBy === 'tier') {
        const ai = tierOrder.indexOf(a.tier)
        const bi = tierOrder.indexOf(b.tier)
        const idxA = ai === -1 ? 99 : ai
        const idxB = bi === -1 ? 99 : bi
        comp = idxA - idxB
      }
      
      return sortOrder === 'asc' ? -comp : comp
    })
  }, [reportRows, query, selectedBands, sortBy, sortOrder])

  const toggleBand = (band: ScoreBand) => {
    const next = new Set(selectedBands)
    if (next.has(band)) { next.delete(band) } else { next.add(band) }
    setSelectedBands(next)
  }

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

  const renderPositioningIcon = (month: number) => {
    if (month % 2 === 0) return <PulsarIcon />
    if (month % 2 === 1) return <ConstellationIcon />
    return <NebulaIcon />
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Reports</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${filteredFiles.length} / ${reportRows.length}` : '…'}
        </span>
      </div>

      {/* Career Positioning Hub — header row carries the CTA so the
          report cards below get the full width as a horizontal strip. */}
      <div className="px-4 pt-3 pb-3 border-b border-border-default bg-bg-cosmos shrink-0">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1.5 shrink-0">
                <Sparkles size={11} className="text-accent animate-pulse" />
                Career Positioning Hub
              </h2>
              <span className="text-[10px] text-text-4 truncate">
                Cross-cutting audit of your active landscape &amp; goals.
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {positioningReports.length > 3 && (
                <button
                  onClick={() => setShowAllHistory(!showAllHistory)}
                  className="text-micro text-accent font-semibold hover:underline bg-transparent"
                >
                  {showAllHistory ? 'Show recent' : `All (${positioningReports.length})`}
                </button>
              )}
              <button
                onClick={handleAnalyzeTrajectory}
                disabled={!repoPath}
                title={positioningRunning
                  ? 'Stop the run (live log on the Activity tab)'
                  : 'Run /career-ops positioning across the full corpus. Uses Claude tokens; live log on the Activity tab.'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-label border transition-colors',
                  positioningRunning
                    ? 'bg-danger/10 border-danger/40 text-danger hover:bg-danger/15'
                    : 'bg-accent/15 border-accent/35 text-accent-text hover:bg-accent/25 disabled:opacity-40 disabled:cursor-not-allowed',
                )}
              >
                {positioningRunning ? <Square size={11} className="fill-current" /> : <Sparkles size={12} />}
                {positioningRunning ? 'Stop' : 'Analyze Trajectory'}
              </button>
            </div>
          </div>

          {/* Horizontal scrollable strip of past reports. Auto-height
              accommodates longer focus-path captions without truncation;
              fixed min-width keeps cards readable when many exist. */}
          <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
            {loadingPositioning && positioningReports.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="shrink-0 w-[220px] h-[72px] shimmer rounded-xl" />
              ))
            ) : positioningReports.length === 0 ? (
              <div className="flex-1 min-h-[72px] rounded-xl border border-dashed border-border-default flex items-center justify-center text-center px-4 py-3">
                <span className="text-[11px] text-text-3">
                  No positioning reports yet. Click <span className="font-semibold text-text-2">Analyze Trajectory</span> to generate the baseline.
                </span>
              </div>
            ) : (
              (showAllHistory ? positioningReports : positioningReports.slice(0, 6)).map((rep) => (
                <button
                  key={rep.filename}
                  onClick={() => setSelectedPositioning(rep)}
                  className="shrink-0 w-[220px] p-3 rounded-xl bg-bg-base border border-border-default hover:border-accent-soft hover:shadow-subtle text-left flex items-center gap-3 transition-all duration-300 group"
                  title={rep.focusPath}
                >
                  <div className="shrink-0 transition-transform duration-300 group-hover:scale-105">
                    {renderPositioningIcon(rep.month)}
                  </div>
                  {/* Card content is just the date + a compact analyzed-
                      count stat. The focus-path caption is dropped — at
                      220px there isn't enough room for a real one, and a
                      generic placeholder would just be visual chrome.
                      Hover the card to see the full focus path; click to
                      open the modal where the focus path renders as a
                      real subtitle. */}
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <span className="text-[13px] font-bold text-text-1 group-hover:text-accent transition-colors duration-150 leading-tight">
                      {rep.dateStr}
                    </span>
                    <span className="text-[10.5px] text-text-4 font-mono tabular-nums">
                      {rep.evalCount} analyzed
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        {/* Search — borderless, no focus halo. Just an icon + input that
            blends with the chrome row. */}
        <div className="flex items-center gap-2 flex-1 max-w-xs">
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

        {/* Sort Controls */}
        <div className="flex items-center gap-1.5 border-l border-border-default pl-3">
          <span className="text-[10px] text-text-4 font-bold uppercase tracking-wider">Sort:</span>
          {(['score', 'date', 'tier'] as const).map(field => (
            <button
              key={field}
              onClick={() => {
                if (sortBy === field) {
                  setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
                } else {
                  setSortBy(field)
                  setSortOrder('desc')
                }
              }}
              className={cn(
                'px-2 py-0.5 text-micro font-mono rounded border transition-colors inline-flex items-center gap-1 uppercase tracking-wider',
                sortBy === field
                  ? 'bg-accent/10 text-accent border-accent/35 font-semibold'
                  : 'text-text-4 border-border-default hover:border-border-strong bg-transparent'
              )}
            >
              <span>{field}</span>
              {sortBy === field && (
                <span className="text-[9px] font-bold">
                  {sortOrder === 'asc' ? '▲' : '▼'}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Score band filter chips — only render bands that actually have reports.
            Reports for T3/T4 listings aren't written to disk by the pipeline,
            so showing 'Pass'/'Skip' chips here always yields zero matches. */}
        <div className="flex items-center gap-1.5">
          {(['stellar', 'strong', 'decent', 'pass', 'skip'] as const)
            .filter(band => reportRows.some(r => getScoreBand(r.overall, r.tier) === band))
            .map(band => {
              const details = BAND_DETAILS[band]
              const active = selectedBands.has(band)
              return (
                <button
                  key={band}
                  onClick={() => toggleBand(band)}
                  className={cn(
                    'px-2.5 py-0.5 text-micro font-medium rounded-full border transition-all duration-200 uppercase tracking-wider',
                    active
                      ? `${details.bg} ${details.text} ${details.border} font-bold`
                      : 'text-text-3 border-border-default hover:border-border-strong hover:bg-bg-elevated'
                  )}
                >
                  {details.label.split(' ')[0]}
                </button>
              )
            })}
        </div>

        <div className="w-px h-4 bg-border-default" />

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
              <p className="text-label text-text-3">No reports match your filters.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {filteredFiles.map(report => {
              const score = scoreFor(report)
              const overall = report.overall ?? score?.overall ?? null
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

      {/* Slide-over for opportunity evaluation report */}
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

      {/* Full-screen positioning report modal */}
      {selectedPositioning && (
        <PositioningModal
          report={selectedPositioning}
          onClose={() => setSelectedPositioning(null)}
        />
      )}
    </div>
  )
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

/* ───── Positioning Modal — slide-over with hero, TOC, featured TL;DR ───── */

interface TocItem {
  slug: string
  label: string
}

interface ParsedPositioningReport {
  /** Body of the `## TL;DR` section (without the heading) — null if absent. */
  tldr: string | null
  /** The full markdown with the TL;DR section stripped, so the main render
   *  doesn't double up after the featured card. The Y/M preamble stays. */
  body: string
  /** Table of contents — one entry per top-level `##` heading (plus a synthetic
   *  TL;DR entry if a TL;DR card will render). Order matches the document. */
  toc: TocItem[]
}

// Stable slug shared by the h2 `id` attribute and the TOC pill `onClick`
// scroll target — so each pill scrolls to its corresponding section.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[1-9]\.?\s+/, '')         // strip "1. " / "2. " admin prefix
    .replace(/[—–]/g, '-')               // em/en-dash → hyphen
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

// Strip the same admin prefix the h2 renderer strips, so TOC labels match
// what's visible on the section header.
function cleanHeading(s: string): string {
  return s.replace(/^[1-9]\.?\s+/, '').trim()
}

function parsePositioningReport(content: string): ParsedPositioningReport {
  // Strip the H1 title + the `**Evaluations analyzed:** ... · ... · ...`
  // / `**Primary archetypes considered:** ...` admin metadata block at the
  // top of the report. The title is already expressed in the hero; the
  // metadata lines were rendering as a long overflowing paragraph in the
  // body. Also drop the leading `---` rule that separates the metadata
  // block from the first section in the canonical template.
  let working = content
    .replace(/^#\s+[^\n]+\n+/, '')                                  // H1 title
    .replace(/^(?:\*\*[^*]+:\*\*[^\n]*\n+)+/, '')                   // **Key:** value lines
    .replace(/^---\s*\n+/, '')                                      // separator rule
    .trimStart()

  // Pull the TL;DR block: heading line + everything up to the next `## `
  // heading or a horizontal rule. The whole match is removed from the body
  // so the featured card and the main render don't duplicate it.
  const tldrRe = /^##\s+TL[;:]?\s*DR[ \t]*\n([\s\S]*?)(?=\n##\s+|\n---\s*$|\n---\s*\n|$)/im
  const m = tldrRe.exec(working)
  const tldr = m ? m[1].trim() : null
  let body = working
  if (m) {
    body = (working.slice(0, m.index) + working.slice(m.index + m[0].length))
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // TOC = TL;DR (if any) + every `## ` heading in the remaining body. We
  // skip the appendix sub-headings (### A. / ### B. …) — only top-level
  // sections become nav targets so the strip stays scannable.
  const toc: TocItem[] = []
  if (tldr) toc.push({ slug: 'tldr', label: 'TL;DR' })
  const headingRe = /^##\s+(.+)$/gm
  let h: RegExpExecArray | null
  while ((h = headingRe.exec(body)) !== null) {
    const raw = h[1].trim()
    toc.push({ slug: slugify(raw), label: cleanHeading(raw) })
  }

  return { tldr, body, toc }
}

function PositioningModal({
  report,
  onClose,
}: {
  report: PositioningReportInfo
  onClose: () => void
}) {
  const [active, setActive] = useState(false)
  const [copied, setCopied] = useState(false)
  const [activeSection, setActiveSection] = useState<string>('tldr')
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)

  // Parse once per report change — the regex passes are cheap but the
  // modal re-renders frequently during the open/close animation.
  const parsed = useMemo(() => parsePositioningReport(report.content), [report.content])

  useEffect(() => {
    const t = setTimeout(() => setActive(true), 20)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = () => {
    setActive(false)
    setTimeout(onClose, 260)
  }

  const handleCopyTldr = async () => {
    if (!parsed.tldr) return
    try {
      await navigator.clipboard.writeText(parsed.tldr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard API can fail in non-secure contexts — silently noop.
    }
  }

  const handleRevealFile = () => {
    void ipc.revealFile(report.path)
  }

  // Smooth-scroll the body to a slug. The TL;DR card has id="tldr"; every
  // h2 in the markdown gets id={slug} via MD_COMPONENTS below. We compute
  // the target's offset relative to the scroll container so the header
  // chrome doesn't cover it.
  const scrollToSlug = (slug: string) => {
    if (!scrollEl) return
    const target = scrollEl.querySelector<HTMLElement>(`[data-slug="${slug}"]`)
    if (!target) return
    const containerTop = scrollEl.getBoundingClientRect().top
    const targetTop = target.getBoundingClientRect().top
    const offset = targetTop - containerTop + scrollEl.scrollTop - 12
    scrollEl.scrollTo({ top: offset, behavior: 'smooth' })
    setActiveSection(slug)
  }

  // Track which section is currently in view so the TOC pill stays in
  // sync with the user's scroll position. IntersectionObserver fires on
  // each anchored heading as it crosses the top band of the container.
  useEffect(() => {
    if (!scrollEl) return
    const targets = scrollEl.querySelectorAll<HTMLElement>('[data-slug]')
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) {
          const slug = visible.target.getAttribute('data-slug')
          if (slug) setActiveSection(slug)
        }
      },
      {
        root: scrollEl,
        rootMargin: '0px 0px -75% 0px',
        threshold: [0, 1],
      }
    )
    targets.forEach(t => observer.observe(t))
    return () => observer.disconnect()
  }, [scrollEl, parsed])

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity duration-[260ms]',
          active ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      {/* Panel — matches ReportSlideOver's shell so positioning reports
          read as first-class siblings of per-listing reports, not as a
          weaker centered modal. 860px is a touch wider than the listing
          slide-over (720px) because positioning content carries denser
          tables and longer paragraphs. */}
      <div className={cn(
        'fixed right-0 top-0 bottom-0 z-40 w-[860px] max-w-full bg-bg-panel border-l border-border-strong flex flex-col shadow-cosmos-lift',
        'transition-[transform,opacity] duration-[260ms] ease-out',
        active ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
      )}>
        {/* Drag region — h-11 gives macOS a real area to grab without
            clobbering the chrome below. */}
        <div className="titlebar-drag h-11 shrink-0" />

        {/* Accent-tinted hero stripe — positioning reports get the accent
            gradient (where per-listing reports get a tier-colored one). */}
        <div
          className="relative h-2 shrink-0"
          aria-hidden
          style={{
            background: 'linear-gradient(90deg, #7C5CFF 0%, #7C5CFF66 60%, transparent 100%)',
          }}
        />

        {/* Editorial header — same hierarchy as ReportSlideOver
            (eyebrow → page-size title → meta row) so the two modals read
            as one design system. */}
        <div className="flex items-start gap-4 px-6 pt-5 pb-4 border-b border-border-default shrink-0">
          <div
            className="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center mt-0.5"
            style={{
              background: '#7C5CFF1F',
              border: '1px solid #7C5CFF40',
            }}
            aria-hidden
          >
            <Sparkles size={20} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-micro text-text-4 uppercase tracking-[0.08em] mb-0.5">
              Positioning Snapshot
            </div>
            <h2 className="text-page text-text-1 leading-tight tracking-[-0.01em]">
              Career Positioning — {report.dateStr}
            </h2>
            {/* The modal hero has room for a real focus-path subtitle —
                show it (line-clamp-2) so the user sees this run's verdict
                without opening the body. The strip card upstream drops
                this because 220px isn't enough; the modal is. */}
            {report.focusPath && report.focusPath !== 'n/d' && (
              <p
                className="text-label text-text-3 leading-snug mt-1.5 line-clamp-2"
                title={report.focusPath}
              >
                <span className="text-text-4 font-medium">Focus · </span>
                {report.focusPath}
              </p>
            )}
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Action pills — mirrors ReportSlideOver's pattern. Copy TL;DR is
            the primary action (the whole point of TL;DR is portability);
            Reveal in Finder gives users a path back to the raw file. */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-default shrink-0 flex-wrap">
          <button
            onClick={handleCopyTldr}
            disabled={!parsed.tldr}
            title={parsed.tldr ? 'Copy the TL;DR block to clipboard' : 'No TL;DR section detected in this report'}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border text-[12px] transition-colors',
              parsed.tldr
                ? 'border-accent/35 bg-accent/10 text-accent-text hover:bg-accent/15'
                : 'border-border-default bg-bg-elevated text-text-4 opacity-60 cursor-not-allowed',
            )}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy TL;DR'}
          </button>
          <button
            onClick={handleRevealFile}
            title="Reveal the markdown file in Finder"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
          >
            <Folder size={11} />
            Reveal file
          </button>
        </div>

        {/* Sticky section nav — horizontal pill row. Stays in view as the
            body scrolls so jumping between TL;DR ↔ §3 Recommendation ↔
            Appendix is one click in a 280-line report. */}
        {parsed.toc.length > 1 && (
          <div className="flex items-center gap-1.5 px-5 py-2 border-b border-border-default shrink-0 overflow-x-auto">
            <Compass size={11} className="text-text-4 shrink-0" />
            {parsed.toc.map((item) => (
              <button
                key={item.slug}
                onClick={() => scrollToSlug(item.slug)}
                className={cn(
                  'shrink-0 px-2.5 py-0.5 text-micro font-medium rounded-full border transition-all duration-150 uppercase tracking-wider',
                  activeSection === item.slug
                    ? 'bg-accent/15 border-accent/40 text-accent-text font-bold'
                    : 'text-text-3 border-border-default hover:border-border-strong hover:bg-bg-elevated',
                )}
                title={item.label}
              >
                {item.label.length > 28 ? item.label.slice(0, 26) + '…' : item.label}
              </button>
            ))}
          </div>
        )}

        {/* Body — scroll container hosts the featured TL;DR card and the
            markdown render. IntersectionObserver above watches every
            [data-slug] element here so the nav pill highlights track the
            user's scroll. */}
        <div
          ref={setScrollEl}
          className="flex-1 overflow-y-auto px-6 py-5"
        >
          {parsed.tldr && <TldrCard markdown={parsed.tldr} />}

          {parsed.body && (
            <div className="prose-report">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {parsed.body}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// Featured card for the TL;DR section. The whole point of a positioning
// report is that the user should be able to act on the TL;DR alone — so
// it gets a distinct accent-tinted card at the top of the body, separate
// from the rest of the prose. The markdown inside still flows through the
// same MD_COMPONENTS so labels (Focus path / Do next / Stop doing /
// Highest-leverage cheap fix) retain their bold treatment from the source.
function TldrCard({ markdown }: { markdown: string }) {
  return (
    <div
      data-slug="tldr"
      className="mb-7 rounded-xl p-5 border"
      style={{
        background: 'linear-gradient(135deg, #7C5CFF14 0%, #7C5CFF08 100%)',
        borderColor: '#7C5CFF40',
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={13} className="text-accent" />
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-accent-text">
          TL;DR — the punchline
        </span>
      </div>
      <div className="prose-report prose-report--tldr">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS_TLDR}>
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function flattenChildrenText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenChildrenText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return flattenChildrenText((node as { props?: { children?: React.ReactNode } }).props?.children)
  }
  return ''
}

function sectionIcon(label: string): React.ElementType | null {
  const l = label.toLowerCase()
  if (l.includes('tl;dr') || l.includes('tldr'))                          return Sparkles
  if (l.includes('where you stand') || l.includes('rollup') || l === 'summary') return ClipboardList
  if (l.includes('per-archetype') || l.includes('per archetype') || l.includes('archetype'))     return Target
  if (l.includes('priority') || l.includes('recommendation') || l.includes('verdict'))           return CheckCircle2
  if (l.includes('trajectory') || l.includes('horizon'))                  return TrendingUp
  if (l.includes('appendix') || l.includes('supporting data') || l.includes('data sources'))     return Lightbulb
  if (l.includes('gap') || l.includes('bottleneck'))                      return Lightbulb
  if (l.includes('comp') || l.includes('salary') || l.includes('opportunity') || l.includes('demand'))  return Coins
  if (l.includes('analysis') || l.includes('coverage') || l.includes('standing'))                return Compass
  return null
}

// Shared markdown components used by the main positioning body. The h2
// renderer carries a data-slug attribute that the TOC pills + scroll
// observer use to navigate the report.
const MD_COMPONENTS = {
  h2: ({ children, ...rest }: { children?: React.ReactNode }) => {
    const text = flattenChildrenText(children)
    const stripped = cleanHeading(text)
    const slug = slugify(text)
    const Icon = sectionIcon(stripped)
    return (
      <h2
        data-slug={slug}
        id={slug}
        className="scroll-mt-4 flex items-center gap-2 text-page font-semibold text-text-1 border-b border-border-default pb-2.5 mt-8 mb-4"
        {...rest}
      >
        {Icon && (
          <Icon
            size={16}
            className="shrink-0 text-accent"
            aria-hidden
          />
        )}
        <span>{stripped}</span>
      </h2>
    )
  },
  h3: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return (
      <h3 className="text-section font-bold text-text-2 mt-6 mb-2" {...rest}>
        {children}
      </h3>
    )
  },
  p: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return (
      <p className="text-body text-text-2 leading-relaxed mb-4" {...rest}>
        {children}
      </p>
    )
  },
  table: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return (
      <div className="overflow-x-auto my-6 border border-border-default rounded-xl">
        <table className="w-full border-collapse text-left text-body" {...rest}>
          {children}
        </table>
      </div>
    )
  },
  thead: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <thead className="bg-bg-elevated/60 border-b border-border-default" {...rest}>{children}</thead>
  },
  tbody: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <tbody className="divide-y divide-border-default" {...rest}>{children}</tbody>
  },
  th: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <th className="px-4 py-2.5 text-[11px] font-semibold text-text-3 uppercase tracking-[0.06em]" {...rest}>{children}</th>
  },
  td: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <td className="px-4 py-2.5 text-[12.5px] text-text-2 leading-snug" {...rest}>{children}</td>
  },
  ul: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <ul className="list-disc pl-5 mb-4 space-y-1.5 text-body text-text-2" {...rest}>{children}</ul>
  },
  ol: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <ol className="list-decimal pl-5 mb-4 space-y-1.5 text-body text-text-2" {...rest}>{children}</ol>
  },
  li: ({ children, ...rest }: { children?: React.ReactNode }) => {
    return <li className="leading-relaxed" {...rest}>{children}</li>
  },
}

// Compact markdown components for the TL;DR card. Same component set,
// but with tighter spacing and no h2 chrome — the TL;DR is a single
// stretch of bold-labeled paragraphs plus one ordered list, not a
// document with its own sub-sections.
const MD_COMPONENTS_TLDR = {
  ...MD_COMPONENTS,
  h2: ({ children }: { children?: React.ReactNode }) => (
    // TL;DR shouldn't contain h2s, but if it does, render them lightly so
    // the card doesn't grow chrome that belongs to the main body.
    <div className="text-[13px] font-semibold text-text-1 mt-3 mb-2">{children}</div>
  ),
  p: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <p className="text-[13.5px] text-text-2 leading-relaxed mb-3 last:mb-0" {...rest}>{children}</p>
  ),
  ol: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1 text-[13.5px] text-text-2" {...rest}>{children}</ol>
  ),
  ul: ({ children, ...rest }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-5 mb-3 space-y-1 text-[13.5px] text-text-2" {...rest}>{children}</ul>
  ),
}
