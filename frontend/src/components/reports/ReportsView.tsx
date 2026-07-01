'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { claudeEvalArgs, refreshCvSummary, top5ReportsPrompt } from '@/lib/evalSpawn'
import { ipc, type DbReportRow } from '@/lib/ipc'
import {
  Search, FileText, X, ExternalLink, Sparkles, Square,
  ClipboardList, Lightbulb, Coins, CheckCircle2, TrendingUp, Target,
  Copy, Folder, Check, Compass, Wrench, ArrowUpRight, Gauge
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import type { ReportFile, ScoreEntry } from '@/types'
import { ReportSlideOver } from './ReportSlideOver'
import { scoreColor } from '@/lib/tier'
import {
  getScoreBand, BAND_DETAILS, type ScoreBand,
  filterReportRows, sortReportRows,
  corpusBands as computeCorpusBands, bandCounts as computeBandCounts,
  buildScoreIndex, matchScore,
  distanceToNextBand, isNearMiss, reportRowFixability,
  type Fixability, type FixabilityRow,
} from '@/lib/reportsList'
import { parseWhyThisScore } from '@/lib/reportMarkdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const TOP5_SPAWN_ID = 'reports-top5'
const POSITIONING_SPAWN_ID = 'reports-positioning'

// Prompt for the "Generate top 5 reports" button — lives in
// lib/evalSpawn.top5ReportsPrompt and rides the compact eval bundle
// (batch/batch-prompt.md via claudeEvalArgs) instead of the `/career-ops
// pipeline` slash command, so the worker doesn't re-read CLAUDE.md + modes/*
// (token-cost lever 3). Selective + deeper: only 5 reports, but each one is
// the FULL T1 template depth regardless of the listing's actual tier — fewer
// reports, more effort per report, is the explicit philosophy shift the
// user wanted.

// Score-band classification + the filter/sort/match logic now live in the
// pure, unit-tested `@/lib/reportsList`. Re-exported here for API stability —
// nothing external imports them today, but the view's public surface stays put.
export { getScoreBand, BAND_DETAILS }
export type { ScoreBand }

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
  const searchRef = useRef<HTMLInputElement>(null)
  
  // Positioning Hub State
  const [positioningReports, setPositioningReports] = useState<PositioningReportInfo[]>([])
  const [loadingPositioning, setLoadingPositioning] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [selectedPositioning, setSelectedPositioning] = useState<PositioningReportInfo | null>(null)

  // Sort State
  const [sortBy, setSortBy] = useState<'score' | 'date' | 'tier' | 'fixable'>('score')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  // "Easiest near-miss to upgrade" filter — keeps only reports one cheap lever
  // / a small gap from the next tier up.
  const [nearMissOnly, setNearMissOnly] = useState(false)

  // Per-report fixability, keyed by report path. The list rows from db.reports()
  // carry the Overall score but NOT the report body, so the binding-constraint
  // and cheapest-lever signals must be parsed from each report's `## Why this
  // score` block on disk. We fetch lazily, parse once, and cache — the badge +
  // the "fixable" sort/filter read from this map. Paths that resolve to a body
  // with no Why block parse to `{ hasLever: false }` and are still cached so we
  // don't re-fetch them every render.
  const [fixByPath, setFixByPath] = useState<Record<string, Fixability>>({})

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

  // Parse the `## Why this score` block for every report we haven't seen yet.
  // Bounded concurrency keeps the disk reads from stampeding when the corpus is
  // large; results land in `fixByPath` incrementally so cards light up their
  // badges as soon as each parse completes rather than waiting for the batch.
  // Re-runs when reportRows changes but only fetches paths not already cached,
  // so a sync (new report on disk) costs one read, not a full re-scan.
  useEffect(() => {
    let cancelled = false
    const pending = reportRows.map(r => r.path).filter(p => !(p in fixByPath))
    if (pending.length === 0) return

    const run = async () => {
      const CONCURRENCY = 6
      for (let i = 0; i < pending.length; i += CONCURRENCY) {
        if (cancelled) return
        const slice = pending.slice(i, i + CONCURRENCY)
        const parsed = await Promise.all(slice.map(async (path): Promise<[string, Fixability]> => {
          try {
            const text = await ipc.readFile(path)
            if (!text) return [path, { hasLever: false }]
            const why = parseWhyThisScore(text)
            return [path, {
              hasLever: why.lever !== null,
              bindingConstraint: why.bindingConstraint,
              lever: why.lever,
            }]
          } catch {
            return [path, { hasLever: false }]
          }
        }))
        if (cancelled) return
        setFixByPath(prev => {
          const next = { ...prev }
          for (const [path, fix] of parsed) next[path] = fix
          return next
        })
      }
    }
    void run()
    return () => { cancelled = true }
    // fixByPath intentionally omitted — including it would re-fire the effect on
    // every incremental setState. We snapshot it for the `pending` diff; new
    // paths from a reportRows change are still picked up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportRows])

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
    // Fire-and-forget CV-summary refresh — ms-fast; the bundle falls back to
    // user/cv.md when the artifact is missing.
    void refreshCvSummary()
    startSpawn(TOP5_SPAWN_ID, 'Generate top 5 reports', 'claude', claudeEvalArgs(top5ReportsPrompt(), generateReportModel))
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

  // Report → score-history matcher. Built once per scoreHistory change; the
  // resolved entry carries the six dims that let the unified fixability logic
  // run the engine path (see rowsWithFix). Declared here (above rowsWithFix)
  // because that memo now depends on it.
  const scoreIndex = useMemo(() => buildScoreIndex(scoreHistory), [scoreHistory])

  const scoreFor = (r: { company: string; role: string }): ScoreEntry | null =>
    matchScore(scoreIndex, r)

  // Decorate each list row with its parsed fixability AND its resolved
  // score-history entry, so the unified near-miss/lever logic (lib/tierLevers §
  // reportFixability, via reportsList) can run the SAME engine math the
  // Database uses whenever the report matches an entry carrying real dims —
  // falling back to the parsed `## Why this score` lever only for orphan
  // reports. `DbReportRow & { fixability, scoreEntry }` satisfies FixabilityRow.
  const rowsWithFix = useMemo<Array<DbReportRow & FixabilityRow>>(
    () => reportRows.map(r => ({
      ...r,
      fixability: fixByPath[r.path] ?? null,
      scoreEntry: matchScore(scoreIndex, r),
    })),
    [reportRows, fixByPath, scoreIndex],
  )

  const filteredFiles = useMemo(
    () => sortReportRows(
      filterReportRows(rowsWithFix, { query, bands: selectedBands, nearMissOnly }),
      sortBy, sortOrder,
    ),
    [rowsWithFix, query, selectedBands, nearMissOnly, sortBy, sortOrder],
  )

  // Count of near-miss reports for the toggle's badge — computed on the same
  // fixability-decorated rows but before the toggle itself, so it shows how many
  // the filter would surface regardless of whether it's currently on. Uses the
  // SAME unified predicate (lib/reportsList § isNearMiss) the nearMissOnly
  // filter uses, so the badge count can never disagree with the rows shown.
  const nearMissCount = useMemo(
    () => filterReportRows(rowsWithFix, { query, bands: selectedBands }).filter(isNearMiss).length,
    [rowsWithFix, query, selectedBands],
  )

  const toggleBand = (band: ScoreBand) => {
    const next = new Set(selectedBands)
    if (next.has(band)) { next.delete(band) } else { next.add(band) }
    setSelectedBands(next)
  }

  // Bands present anywhere in the corpus — this is the stable chip set.
  // T3/T4 listings never get a report written to disk, so 'pass'/'skip'
  // typically don't appear; computing this from the data keeps the chip row
  // honest instead of always rendering five chips, three of which match zero.
  const corpusBands = useMemo(() => computeCorpusBands(reportRows), [reportRows])

  // Per-band report counts under the active search query but BEFORE the band
  // selection itself — bands are an OR multi-select, so each chip's count
  // shows how many reports it would add given the current search. This is the
  // same facet-count rule the Database filter sidebar uses (count a dimension
  // with every OTHER active filter applied, but not its own selection).
  const bandCounts = useMemo(() => computeBandCounts(reportRows, query), [reportRows, query])

  const hasActiveFilters = query.trim() !== '' || selectedBands.size > 0 || nearMissOnly

  const clearFilters = () => {
    setQuery('')
    setSelectedBands(new Set())
    setNearMissOnly(false)
  }

  // `/` focuses the search box from anywhere in the view (matching the kbd
  // hint), as long as the user isn't already typing into a field. This makes
  // the Database FilterBar's `/` affordance real here too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      const typing = el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selectedScore = selected ? scoreFor(selected) : null

  // Rotate all three space icons across consecutive months. (Was `% 2`, which
  // only ever yielded 0 or 1 — NebulaIcon was unreachable.)
  const renderPositioningIcon = (month: number) => {
    const i = month % 3
    if (i === 0) return <PulsarIcon />
    if (i === 1) return <ConstellationIcon />
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
            ref={searchRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (query) setQuery('')
                else e.currentTarget.blur()
              }
            }}
            placeholder="Search company or role…"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none text-label text-text-1 placeholder:text-text-4 min-w-0"
          />
          {query ? (
            <button onClick={() => setQuery('')} className="text-text-4 hover:text-text-2 shrink-0">
              <X size={11} />
            </button>
          ) : (
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-mono text-text-4 bg-bg-base border border-border-default shrink-0">
              /
            </kbd>
          )}
        </div>

        {/* Sort Controls. `fixable` ranks by "easiest near-miss to upgrade" —
            cheapest tier-crossing first (a T3 at 6.9 with a named lever beats a
            T3 at 5.2 with none). Labelled "Fixability" so it reads as effort-to-
            convert, not a raw score. */}
        <div className="flex items-center gap-1.5 border-l border-border-default pl-3">
          <span className="text-[10px] text-text-4 font-bold uppercase tracking-wider">Sort:</span>
          {([
            { field: 'score' as const,   label: 'score' },
            { field: 'date' as const,    label: 'date' },
            { field: 'tier' as const,    label: 'tier' },
            { field: 'fixable' as const, label: 'fixability' },
          ]).map(({ field, label }) => (
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
              title={field === 'fixable'
                ? 'Rank by easiest near-miss to upgrade — cheapest tier-crossing first'
                : undefined}
              className={cn(
                'px-2 py-0.5 text-micro font-mono rounded border transition-colors inline-flex items-center gap-1 uppercase tracking-wider',
                sortBy === field
                  ? 'bg-accent/10 text-accent border-accent/35 font-semibold'
                  : 'text-text-4 border-border-default hover:border-border-strong bg-transparent'
              )}
            >
              {field === 'fixable' && <Wrench size={9} className="shrink-0" />}
              <span>{label}</span>
              {sortBy === field && (
                <span className="text-[9px] font-bold">
                  {sortOrder === 'asc' ? '▲' : '▼'}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Near-miss toggle — surfaces only reports one cheap lever / a small
            gap from the next tier up. The count tells the user how many would
            survive before they commit to the filter. Hidden when nothing
            qualifies (and the toggle isn't already on) so it never sits at "0".
            "Where effort converts" is the whole point of this view. */}
        {(nearMissCount > 0 || nearMissOnly) && (
          <button
            onClick={() => setNearMissOnly(v => !v)}
            title="Show only reports one cheap lever / a small gap from the next tier up"
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-0.5 text-micro font-medium rounded-full border transition-all duration-200 uppercase tracking-wider mr-1',
              nearMissOnly
                ? 'bg-accent/15 text-accent-text border-accent/40 font-bold'
                : 'text-text-3 border-border-default hover:border-border-strong hover:bg-bg-elevated',
            )}
          >
            <ArrowUpRight size={11} className="shrink-0" />
            <span>Near-miss</span>
            <span className="text-[10px] font-mono tabular-nums text-text-4">{nearMissCount}</span>
          </button>
        )}

        {/* Score band filter chips — only render bands that actually have reports.
            Reports for T3/T4 listings aren't written to disk by the pipeline,
            so showing 'Pass'/'Skip' chips here always yields zero matches. */}
        <div className="flex items-center gap-1.5">
          {corpusBands.map(band => {
            const details = BAND_DETAILS[band]
            const active = selectedBands.has(band)
            const count = bandCounts[band]
            // Grey out bands the current search excludes — still clickable, but
            // signals "selecting this adds nothing right now". Never mute the
            // active chip (the user explicitly turned it on).
            const muted = count === 0 && !active
            return (
              <button
                key={band}
                onClick={() => toggleBand(band)}
                title={`${details.label} · ${count} report${count === 1 ? '' : 's'}`}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-0.5 text-micro font-medium rounded-full border transition-all duration-200 uppercase tracking-wider',
                  active
                    ? `${details.bg} ${details.text} ${details.border} font-bold`
                    : 'text-text-3 border-border-default hover:border-border-strong hover:bg-bg-elevated',
                  muted && 'opacity-40',
                )}
              >
                <span>{details.label.split(' ')[0]}</span>
                <span className="text-[10px] font-mono tabular-nums text-text-4">{count}</span>
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
        ) : reportRows.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <div className="galaxy-bg rounded-xl px-10 py-12 flex flex-col items-center gap-3 max-w-sm text-center">
              <FileText size={32} className="text-accent opacity-80" />
              <p className="text-label text-text-2 font-medium">No reports yet</p>
              <p className="text-[12px] text-text-3 leading-relaxed">
                Reports get written when you run <span className="text-text-2 font-semibold">Generate top 5 reports</span> or
                promote a listing from the Database. They&apos;ll show up here as a scannable grid.
              </p>
            </div>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <div className="galaxy-bg rounded-xl px-10 py-12 flex flex-col items-center gap-3 max-w-sm text-center">
              <FileText size={32} className="text-accent opacity-80" />
              <p className="text-label text-text-3">
                No reports match {query.trim()
                  ? <>“<span className="text-text-2">{query.trim()}</span>”</>
                  : 'your filters'}.
              </p>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
                >
                  <X size={11} />
                  Clear filters
                </button>
              )}
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
                  fixability={fixByPath[report.path] ?? null}
                  scoreEntry={score}
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

// "T3 → T2 in +0.1" style upgrade label. The next-band target uses the same
// thresholds the banding logic uses; we phrase the gap in points-to-go so the
// user reads effort, not a raw score. Null when there's no upgrade target
// (top-band) or no usable score.
function upgradeHint(overall: number | null, tier: string): { label: string; gap: number } | null {
  const gap = distanceToNextBand(overall, tier)
  if (gap === null) return null
  const band = getScoreBand(overall, tier)
  const nextLabel =
    band === 'skip'   ? 'Pass' :
    band === 'pass'   ? 'Decent' :
    band === 'decent' ? 'Strong' :
    band === 'strong' ? 'Stellar' : null
  if (!nextLabel) return null
  return { label: nextLabel, gap }
}

function ReportCard({
  report,
  overall,
  fixability,
  scoreEntry,
  url,
  isSelected,
  onClick,
}: {
  report: { path: string; company: string; role: string; tier: string }
  overall: number | null
  fixability: Fixability | null
  scoreEntry: ScoreEntry | null
  url: string | null
  isSelected: boolean
  onClick: () => void
}) {
  const hint = upgradeHint(overall, report.tier)
  const lever = fixability?.lever ?? null
  const binding = fixability?.bindingConstraint ?? null
  // A card earns the fixability footer when it's a genuine near-miss. The
  // verdict comes from the ONE unified authority (lib/reportsList §
  // reportRowFixability → tierLevers § reportFixability): the engine's
  // lift-≤-threshold rule when this report resolved to real dims (identical to
  // the Database "Near upgrade"), else the Overall-gap + parsed-lever fallback.
  // Cards with no upgrade target (top-band) or no signal stay clean — no chrome.
  const showFixability = reportRowFixability({
    company: report.company, role: report.role, tier: report.tier,
    overall, fixability, scoreEntry,
  }).nearMiss && hint !== null
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

            {/* Fixability footer — only for near-misses. The upgrade pill shows
                the cheapest band-crossing target ("→ Strong +0.2"); the lever
                line (when the engine found one) names the single dimension to
                raise. This is the "spend effort where it converts" surface: a
                glanceable answer to "is this report worth upgrading, and how?".
                Binding constraint is the fallback caption when no lever exists
                but the gap is still small. */}
            {showFixability && (
              <div className="mt-2 flex flex-col gap-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {hint && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tabular-nums bg-accent/12 text-accent-text border border-accent/30"
                      title={`One band from ${hint.label} — needs +${hint.gap.toFixed(1)} on Overall`}
                    >
                      <ArrowUpRight size={9} className="shrink-0" />
                      {hint.label}
                      <span className="text-text-4">+{hint.gap.toFixed(1)}</span>
                    </span>
                  )}
                  {lever && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#2EB8A8]/12 text-[#2EB8A8] border border-[#2EB8A8]/30">
                      <Wrench size={9} className="shrink-0" />
                      lever
                    </span>
                  )}
                </div>
                {(lever || binding) && (
                  <div
                    className="flex items-start gap-1 text-[11px] leading-snug text-text-3 line-clamp-2"
                    title={lever ?? binding ?? undefined}
                  >
                    {lever
                      ? <Wrench size={10} className="shrink-0 mt-0.5 text-[#2EB8A8]" aria-hidden />
                      : <Gauge size={10} className="shrink-0 mt-0.5 text-text-4" aria-hidden />}
                    <span className="min-w-0">{lever ?? binding}</span>
                  </div>
                )}
              </div>
            )}
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
