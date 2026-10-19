'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { claudeEvalArgs, refreshCvSummary, top5ReportsPrompt } from '@/lib/evalSpawn'
import { ipc, type DbReportRow } from '@/lib/ipc'
import {
  Search, FileText, X, ExternalLink, Sparkles, Square,
  Copy, Check, ArrowUp, ArrowDown, ArrowUpRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ReportFile, ScoreEntry } from '@/types'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { Button, Panel, PageHeader, TierChip } from '@/components/ui'
import { ReportSlideOver } from './ReportSlideOver'
import {
  getScoreBand, BAND_DETAILS, type ScoreBand,
  filterReportRows, sortReportRows,
  corpusBands as computeCorpusBands, bandCounts as computeBandCounts,
  buildScoreIndex, matchScore,
  isNearMiss, reportEngineLever,
  type FixabilityRow,
} from '@/lib/reportsList'
import { leverSentence } from '@/lib/tierLevers'
import {
  normalizeEligibility, normalizeTier, normalizeVerdict, parseEligibilityFlags, verdictOf, VERDICT_LABELS,
} from '@/lib/scoreBands'
import { WantEase } from '@/components/shared/WantEase'
import { EligibilityChip, VerdictChip } from '@/components/shared/EligibilityChip'
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

// Sort keys for the toolbar's segmented control. `score` sorts by Priority
// (√(Want × Ease)) — a sort key only, never shown as a number. `fixable` ranks
// by "easiest near-miss to upgrade": the cheapest single change into a better
// verdict cell first.
const SORT_OPTIONS = [
  { field: 'score' as const,   label: 'Priority' },
  { field: 'date' as const,    label: 'Date' },
  { field: 'tier' as const,    label: 'Tier' },
  { field: 'fixable' as const, label: 'Fixability' },
]

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

  // "Easiest near-miss to upgrade" filter — keeps only reports one change
  // away from a better verdict cell.
  const [nearMissOnly, setNearMissOnly] = useState(false)

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

  // Decorate each list row with its resolved score-history entry, so the
  // near-miss / lever logic (lib/tierLevers § reportFixability, via
  // reportsList) runs the SAME engine math the Database uses. Reports no
  // longer carry a Why-this-score block, so there is no body parse here.
  const rowsWithFix = useMemo<Array<DbReportRow & FixabilityRow>>(
    () => reportRows.map(r => ({
      ...r,
      scoreEntry: matchScore(scoreIndex, r),
    })),
    [reportRows, scoreIndex],
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

  // Verdict bands present anywhere in the corpus — the stable chip set.
  // T3/T4 listings rarely get a full report, so 'skip'/'blocked' typically
  // don't appear; computing this from the data keeps the chip row
  // honest instead of always rendering seven chips, most of which match zero.
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

  const shownReports = showAllHistory ? positioningReports : positioningReports.slice(0, 6)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Reports"
        meta={loaded ? `${filteredFiles.length} of ${reportRows.length}` : '…'}
        actions={
          // Generate top 5 spawns the deep-template run: "5 deep, defensible
          // reports beats 8 shallow ones". Live progress on the Activity tab.
          <Button
            tone={top5Running ? 'stop' : 'tinted'}
            size="sm"
            icon={top5Running ? <Square size={11} className="fill-current" /> : <Sparkles size={13} />}
            onClick={handleGenerateTop5}
            disabled={!repoPath}
            title={top5Running
              ? 'Stop the run (live log on the Activity tab)'
              : 'Filter the pipeline → score survivors → write deep reports for the 5 highest-Priority (√(Want × Ease)) entries. Uses Claude tokens; live log on the Activity tab.'}
          >
            {top5Running ? 'Stop' : 'Generate top 5 reports'}
          </Button>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
        {/* Career positioning: past cross-cutting audits as a row of tiles,
            with the run action in the panel heading. */}
        <Panel
          title="Career positioning"
          meta="Cross-cutting audit of your landscape and goals"
          action={
            <span className="flex items-center gap-1.5">
              {positioningReports.length > 3 && (
                <Button tone="ghost" size="xs" onClick={() => setShowAllHistory(!showAllHistory)}>
                  {showAllHistory ? 'Show recent' : `All (${positioningReports.length})`}
                </Button>
              )}
              <Button
                tone={positioningRunning ? 'stop' : 'tinted'}
                size="sm"
                icon={positioningRunning ? <Square size={11} className="fill-current" /> : <Sparkles size={13} />}
                onClick={handleAnalyzeTrajectory}
                disabled={!repoPath}
                title={positioningRunning
                  ? 'Stop the run (live log on the Activity tab)'
                  : 'Run /career-ops positioning across the full corpus. Uses Claude tokens; live log on the Activity tab.'}
              >
                {positioningRunning ? 'Stop' : 'Analyze trajectory'}
              </Button>
            </span>
          }
        >
          <div className="flex gap-3 overflow-x-auto pb-0.5">
            {loadingPositioning && positioningReports.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="shrink-0 w-[200px] h-14 shimmer rounded-lg" />
              ))
            ) : positioningReports.length === 0 ? (
              <div className="flex-1 h-14 rounded-lg border border-dashed border-border-default flex items-center justify-center text-center px-4">
                <span className="text-label text-text-3">
                  No positioning reports yet. Run <span className="font-medium text-text-2">Analyze trajectory</span> to generate the baseline.
                </span>
              </div>
            ) : (
              shownReports.map((rep) => (
                // Tile carries the date + analyzed count; the focus path is
                // the hover title here and the subtitle inside the modal.
                <button
                  key={rep.filename}
                  onClick={() => setSelectedPositioning(rep)}
                  title={rep.focusPath}
                  className="card shrink-0 w-[200px] h-14 px-3 flex items-center gap-2.5 text-left transition-colors duration-150 ease-quart hover:border-border-strong hover:bg-bg-elevated"
                >
                  <Sparkles size={14} className="shrink-0 text-text-4" aria-hidden />
                  <span className="min-w-0 flex flex-col">
                    <span className="text-body font-medium text-text-1 leading-tight truncate">{rep.dateStr}</span>
                    <span className="text-label text-text-4 truncate">{rep.evalCount} analyzed</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </Panel>

        {/* Toolbar: search · sort · band and near-miss filters. */}
        <div className="h-10 shrink-0 flex items-center gap-4">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none" aria-hidden />
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
              className="input input-sm pl-7 pr-8"
            />
            {query ? (
              <button
                onClick={() => setQuery('')}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded text-text-4 hover:text-text-1 hover:bg-bg-elevated transition-colors"
              >
                <X size={12} />
              </button>
            ) : (
              <kbd className="kbd absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none">/</kbd>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="label">Sort</span>
            <div className="flex items-center gap-0.5">
              {SORT_OPTIONS.map(({ field, label }) => {
                const on = sortBy === field
                return (
                  <Button
                    key={field}
                    tone={on ? 'tinted' : 'ghost'}
                    size="xs"
                    onClick={() => {
                      if (sortBy === field) {
                        setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortBy(field)
                        setSortOrder('desc')
                      }
                    }}
                    title={field === 'fixable'
                      ? 'Rank by easiest near-miss to upgrade — cheapest change into a better verdict first'
                      : field === 'score'
                        ? 'Rank by √(Want × Ease); blocked and unscored reports last'
                        : undefined}
                    trailing={on
                      ? (sortOrder === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)
                      : undefined}
                  >
                    {label}
                  </Button>
                )
              })}
            </div>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            {/* Near-miss toggle: only reports one change (one dimension step,
                or one amber check resolved) from a better verdict. Hidden when
                nothing qualifies (and the toggle isn't already on) so it never
                sits at 0. */}
            {(nearMissCount > 0 || nearMissOnly) && (
              <button
                onClick={() => setNearMissOnly(v => !v)}
                title="Show only reports one change away from a better verdict"
                className={cn(
                  'chip chip-md transition-colors duration-150',
                  nearMissOnly ? 'chip-accent' : 'hover:border-border-strong hover:text-text-1',
                )}
              >
                <ArrowUpRight size={13} className="shrink-0" aria-hidden />
                Near-miss
                <span className="text-text-4 tabular-nums">{nearMissCount}</span>
              </button>
            )}

            {/* Verdict filters: only verdicts that actually have reports. T3/T4
                listings get a short report or none, so Skip / Blocked rarely
                show. */}
            {corpusBands.map(band => {
              const details = BAND_DETAILS[band]
              const active = selectedBands.has(band)
              const count = bandCounts[band]
              // Grey out bands the current search excludes: still clickable,
              // but selecting it adds nothing right now. Never mute an active one.
              const muted = count === 0 && !active
              return (
                <button
                  key={band}
                  onClick={() => toggleBand(band)}
                  title={`${details.label} · ${count} report${count === 1 ? '' : 's'}`}
                  className={cn(
                    'chip chip-md transition-colors duration-150',
                    active ? 'chip-accent' : 'hover:border-border-strong hover:text-text-1',
                    muted && 'opacity-40',
                  )}
                >
                  {details.label}
                  <span className="text-text-4 tabular-nums">{count}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* List */}
        {!loaded ? (
          <div className="card divide-y divide-border-default overflow-hidden shrink-0" aria-hidden>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-14 px-4 flex items-center gap-3">
                <div className="w-7 h-7 rounded shimmer shrink-0" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="h-3 w-40 rounded-sm shimmer" />
                  <div className="h-2.5 w-64 rounded-sm shimmer" />
                </div>
              </div>
            ))}
          </div>
        ) : reportRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16">
            <FileText size={24} className="text-text-4" aria-hidden />
            <p className="text-section text-text-1">No reports yet</p>
            <p className="text-label text-text-3 max-w-sm">
              Reports get written when you run <span className="font-medium text-text-2">Generate top 5 reports</span> or
              promote a listing from the Database. They&apos;ll show up here as a scannable list.
            </p>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16">
            <FileText size={24} className="text-text-4" aria-hidden />
            <p className="text-section text-text-1">No matching reports</p>
            <p className="text-label text-text-3 max-w-sm">
              No reports match {query.trim()
                ? <>“<span className="text-text-2">{query.trim()}</span>”</>
                : 'your filters'}.
            </p>
            {hasActiveFilters && (
              <Button tone="ghost" size="sm" icon={<X size={13} />} onClick={clearFilters} className="mt-1">
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="card divide-y divide-border-default overflow-hidden shrink-0">
            {filteredFiles.map(report => {
              const score = report.scoreEntry ?? scoreFor(report)
              const url = report.url || score?.url || ''
              return (
                <ReportRow
                  key={report.path}
                  report={report}
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
              : match.tier === 'T2' ? 'tier-2'
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
          scoreEntry={orphanScoreEntry(selected)}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Positioning report slide-over */}
      {selectedPositioning && (
        <PositioningModal
          report={selectedPositioning}
          onClose={() => setSelectedPositioning(null)}
        />
      )}
    </div>
  )
}

// A report with no score-history row (orphan) still opens the slide-over:
// a blank v2 entry — every score null, never 0 — keyed on its folder tier.
function orphanScoreEntry(r: ReportFile): ScoreEntry {
  return {
    date: '', archetype: '',
    skills_match: null, experience_bar: null, competition: null, ease: null,
    growth_mobility: null, optionality_exit: null, brand_value: null, role_content: null,
    best_cities: null, salary_adj_city: null, work_life_balance: null,
    want: null, priority: null, eligibility: null, eligibility_flags: '', verdict: null,
    best_fit_roles: '', mode: 'scouting',
    company: r.company, role: r.role,
    tier: normalizeTier(r.tier) ?? '',
    source: '', location: '', employment_type: '', duration: '', salary_raw: '',
    url: r.url ?? '',
  }
}

// One 56px list row: logo · company / role · upgrade caption · verdict ·
// eligibility + Want · Ease · posting link. The main button opens the report slide-over; the
// link button is a sibling so the two never nest.
function ReportRow({
  report,
  scoreEntry,
  url,
  isSelected,
  onClick,
}: {
  report: DbReportRow & FixabilityRow
  scoreEntry: ScoreEntry | null
  url: string | null
  isSelected: boolean
  onClick: () => void
}) {
  // Scores come from the joined report row (latest evaluation for the URL);
  // the resolved score-history entry fills a gap.
  const eligibility = normalizeEligibility(report.eligibility) ?? scoreEntry?.eligibility ?? null
  const blocked = eligibility === 'red' || report.verdict === 'blocked'
  const want = report.want ?? scoreEntry?.want ?? null
  const ease = report.ease ?? scoreEntry?.ease ?? null
  const flags = parseEligibilityFlags(report.eligibility_flags ?? scoreEntry?.eligibility_flags ?? '')
  const red = flags.find(f => f.status === 'red')
  const amberReasons = flags.filter(f => f.status === 'amber').map(f => f.reason).filter(Boolean).join('; ')
  // The row's verdict: stored, else replayed from Want · Ease. An orphan
  // report (no evaluation behind it) has none and falls back to its folder
  // tier chip rather than a made-up verdict.
  const verdict = verdictOf({
    verdict: normalizeVerdict(report.verdict) ?? scoreEntry?.verdict ?? null,
    want, ease, eligibility,
  })
  // A row earns the upgrade caption when it's a genuine near-miss — the
  // engine's one-step rule (lib/reportsList § isNearMiss), identical to the
  // Database "Near upgrade". `go`, blocked and unscored rows stay clean.
  const row = { ...report, scoreEntry }
  const nearMiss = isNearMiss(row)
  const engineLever = nearMiss ? reportEngineLever(row) : null
  // "One change from Stretch · Skills match 6 → 7 → Stretch".
  const fixText = engineLever
    ? `One change from ${VERDICT_LABELS[engineLever.toVerdict]} · ${leverSentence(engineLever)}`
    : null
  return (
    <div className={cn(
      'flex items-center pr-3 transition-colors duration-150 ease-quart',
      isSelected ? 'bg-accent-soft' : 'hover:bg-bg-elevated',
    )}>
      <button
        onClick={onClick}
        className="flex-1 min-w-0 h-14 pl-4 pr-3 flex items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <CompanyLogo company={report.company} size={28} className="shrink-0" />
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-body font-semibold text-text-1 leading-tight truncate">{report.company}</span>
          <span className="text-label text-text-3 truncate">{report.role}</span>
        </span>
        {fixText && (
          <span className="min-w-0 max-w-[40%] truncate text-label text-text-3 text-right" title={fixText}>
            {fixText}
          </span>
        )}
        {verdict
          ? <VerdictChip verdict={verdict} className="shrink-0" />
          : <TierChip tier={normalizeTier(report.tier) ?? report.tier} className="shrink-0" />}
        <span className="w-[150px] shrink-0 flex items-center justify-end gap-1.5 min-w-0">
          <EligibilityChip status={eligibility} reason={red?.reason ?? (amberReasons || null)} compact className="shrink-0" />
          <WantEase
            want={want}
            ease={ease}
            blockedReason={blocked ? (red?.reason || 'Blocked') : null}
            size="sm"
            className="min-w-0"
          />
        </span>
      </button>
      {url ? (
        <Button
          tone="ghost"
          size="xs"
          iconOnly
          icon={<ExternalLink size={12} />}
          onClick={(e) => { e.stopPropagation(); ipc.openExternal(url) }}
          title="Open job posting"
          aria-label="Open job posting"
        />
      ) : (
        <span className="w-6 shrink-0" aria-hidden />
      )}
    </div>
  )
}

/* ───── Positioning report: dossier slide-over with section nav and TL;DR ───── */

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

// Stable slug shared by the h2 `id` attribute and the section-nav `onClick`
// scroll target — so each nav link scrolls to its corresponding section.
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
  // top of the report. The title is already expressed in the header; the
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

  // Track which section is currently in view so the nav link stays in
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

  const subtitle = [
    report.dateStr,
    report.evalCount !== 'n/d' ? `${report.evalCount} evaluations analyzed` : null,
    report.focusPath && report.focusPath !== 'n/d' ? `Focus: ${report.focusPath}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity duration-200 ease-quart',
          active ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      {/* Panel: the same dossier shell as the per-listing report slide-over,
          a touch wider because positioning content carries denser tables. */}
      <div className={cn(
        'fixed right-0 top-0 bottom-0 z-40 w-[840px] max-w-full bg-bg-base border-l border-border-default shadow-lift flex flex-col',
        'transition-[transform,opacity] duration-200 ease-quart',
        active ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
      )}>
        {/* Drag region for the macOS window. */}
        <div className="titlebar-drag h-11 shrink-0" />

        {/* Header */}
        <div className="flex items-start gap-4 px-6 pt-2 pb-4 border-b border-border-default shrink-0">
          <div className="shrink-0 w-10 h-10 rounded-lg bg-accent-soft flex items-center justify-center" aria-hidden>
            <Sparkles size={18} className="text-accent-text" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-page text-text-1">Career positioning</h2>
            <p className="text-label text-text-3 mt-1 line-clamp-2" title={report.focusPath !== 'n/d' ? report.focusPath : undefined}>
              {subtitle}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              tone="secondary"
              size="sm"
              icon={copied ? <Check size={13} /> : <Copy size={13} />}
              onClick={handleCopyTldr}
              disabled={!parsed.tldr}
              title={parsed.tldr ? 'Copy the TL;DR block to clipboard' : 'No TL;DR section detected in this report'}
            >
              {copied ? 'Copied' : 'Copy TL;DR'}
            </Button>
            <Button tone="ghost" size="sm" onClick={handleRevealFile} title="Reveal the markdown file in Finder">
              Reveal file
            </Button>
            <Button
              tone="ghost"
              size="sm"
              iconOnly
              icon={<X size={14} />}
              onClick={handleClose}
              title="Close (Esc)"
              aria-label="Close"
            />
          </div>
        </div>

        {/* Section nav: plain text links, the active one underlined. Stays in
            view while the body scrolls. */}
        {parsed.toc.length > 1 && (
          <nav className="h-9 shrink-0 flex items-stretch gap-4 px-6 border-b border-border-default overflow-x-auto">
            {parsed.toc.map((item) => {
              const on = activeSection === item.slug
              return (
                <button
                  key={item.slug}
                  onClick={() => scrollToSlug(item.slug)}
                  className={cn(
                    'relative shrink-0 inline-flex items-center text-label transition-colors duration-150',
                    on ? 'text-text-1 font-medium' : 'text-text-3 hover:text-text-1',
                  )}
                  title={item.label}
                >
                  {item.label.length > 28 ? item.label.slice(0, 26) + '…' : item.label}
                  {on && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" aria-hidden />}
                </button>
              )
            })}
          </nav>
        )}

        {/* Body: the TL;DR card, then the report prose. The observer above
            watches every [data-slug] element here to keep the nav in sync. */}
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

// Featured card for the TL;DR section: the user should be able to act on the
// TL;DR alone, so it sits apart from the prose in an accent-washed card. The
// markdown inside keeps the source's bold labels (Focus path / Do next / …).
function TldrCard({ markdown }: { markdown: string }) {
  return (
    <section data-slug="tldr" className="card bg-accent/[0.04] border-accent/20 p-5 mb-6">
      <h2 className="text-section text-text-1 mb-2">TL;DR</h2>
      <div className="prose-report [&>:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS_TLDR}>
          {markdown}
        </ReactMarkdown>
      </div>
    </section>
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

// Markdown overrides for the positioning body. `.prose-report` in globals.css
// styles every element; the h2 override only adds the anchor the section nav
// and the scroll observer target, and strips the "1. " admin prefix. Wide
// tables get a horizontal scroller so they never push the panel wider.
const MD_COMPONENTS = {
  h2: ({ children }: { children?: React.ReactNode }) => {
    const text = flattenChildrenText(children)
    const slug = slugify(text)
    return (
      <h2 data-slug={slug} id={slug} className="scroll-mt-4">
        {cleanHeading(text)}
      </h2>
    )
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
}

// TL;DR card overrides: same set, but an h2 inside the TL;DR (rare) renders
// as a plain bold line so it doesn't become a second nav anchor.
const MD_COMPONENTS_TLDR = {
  ...MD_COMPONENTS,
  h2: ({ children }: { children?: React.ReactNode }) => (
    <p className="font-semibold text-text-1">{children}</p>
  ),
}
