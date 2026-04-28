'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, isAnyRunning, claudeArgs, type SpawnRecord } from '@/store/spawns'
import { useNavStore } from '@/store/nav'
import { ClaudeLogo } from '@/components/shared/Logos'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { StatCard } from './StatCard'
import {
  BarChart2, Inbox, Target, Radar, Calendar,
  Play, Zap, FileOutput, Filter, Sparkles, FileStack, Square, ArrowRight,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry } from '@/types'

const FULL_SCAN_ID       = 'cmd-full-scan'
const API_SCAN_ID        = 'cmd-api-scan'
const PIPELINE_FILTER_ID = 'cmd-pipeline-filter'
const PIPELINE_TOP_ID    = 'cmd-pipeline-top'
const PIPELINE_ALL_ID    = 'cmd-pipeline-all'

// Three pipeline-mode prompts. All share `/career-ops pipeline` as the slash
// command (so the skill router still loads modes/pipeline.md), but the
// per-button qualifier in the body changes Claude's behaviour: just filter,
// top-N reports, or full reports for everything.
// Three pipeline-mode prompts that share `/career-ops pipeline` (so the skill
// router still loads modes/pipeline.md) but trade off depth-vs-cost via the
// per-button qualifier in the body. Cost rough order:
//   FILTER ≈ 2k tokens / listing  (dimensional eval, no prose report)
//   TOP    ≈ 2k for non-top + 6–8k for top 8 prose reports
//   ALL    ≈ 6–8k tokens / listing (full prose for every passing URL)

const FILTER_PROMPT =
  '/career-ops pipeline — FILTER + DIMENSIONAL SCORE mode. For each pending URL in data/pipeline.md: ' +
  '(1) Fetch the JD via Playwright/WebFetch, apply user/portals.yml filters, dedup against data/scan-history.tsv and data/applications.md. ' +
  '(2) For passing entries run the FULL DIMENSIONAL SCORING per modes/scouting.md — all 10 dimensions (Skills Match, Ease of Entry, Strategic Fit, Current Fit, Growth/Mobility, Optionality/Exit, Brand Value, Sales-Trap Risk, Aspirational Fit, Overall) with one short sentence of reasoning per dimension. Classify into Tier T1/T2/T3/T4 based on the resulting score. ' +
  '(3) Write the row to data/scouting.md with the proper tier, score, CF/AF, and a one-line summary in the notes column. Append the full dimensional row to data/score-history.tsv. ' +
  '(4) **CRITICAL**: do NOT write any per-listing prose report file under reports/. Do NOT write the long-form Fit/Gaps/Verdict narrative or the oferta Block C–F prose. The dimensional table + tier + one-line note in scouting.md is the entire output for this path. ' +
  '(5) Mark each processed URL as [x] in pipeline.md. Update data/scan-history.tsv with scan_dates. ' +
  'Goal: every passing listing ends up in the Database with a real score the user can sort by, while saving the heavy prose-report tokens for entries the user explicitly decides to deep-dive on later.'

const TOP_REPORTS_PROMPT =
  '/career-ops pipeline — TOP REPORTS mode. ' +
  '(1) Filter every pending URL: fetch the JD, apply user/portals.yml filters, dedup against scan-history.tsv and applications.md. ' +
  '(2) For EVERY filtered entry run the FULL DIMENSIONAL SCORING per modes/scouting.md (all 10 dimensions with brief per-dimension reasoning, tier classification T1/T2/T3/T4). Write scouting.md row + score-history.tsv row. **No per-listing prose report file** for entries at this stage — they land in the Database with a score and tier only. ' +
  '(3) After all entries are scored, identify the 8 highest-scoring entries. ' +
  '(4) For those 8 ONLY: ALSO write the full per-listing prose report under reports/tier-N/{Company} - {Role}.md per user/profile.yml current_mode (modes/scouting.md short-summary or full report depending on tier; modes/oferta.md A–H if current_mode is applying). ' +
  '(5) The remaining (non-top) entries STAY scored in scouting.md but have NO prose report file — the user can promote them later via the Database "Generate report" action. ' +
  '(6) Mark all processed URLs as [x] in pipeline.md. ' +
  'Goal: substantial token saving vs ALL REPORTS by skipping the multi-paragraph prose for entries that don\'t make the top cut, while still giving every entry a sortable score in the Database.'

const ALL_REPORTS_PROMPT =
  '/career-ops pipeline — ALL REPORTS mode. ' +
  '(1) Filter every pending URL: fetch the JD, apply user/portals.yml filters, dedup. ' +
  '(2) For EVERY passing entry run the FULL evaluation per user/profile.yml current_mode (modes/scouting.md if scouting, modes/oferta.md if applying): full dimensional scoring AND the full per-listing prose report under reports/tier-N/{Company} - {Role}.md. Write scouting.md row + score-history.tsv row + the report file. ' +
  '(3) Process in parallel where safe. ' +
  '(4) Mark URLs as [x] in pipeline.md.'

const LOADING_MESSAGES = [
  'Sneaking past the careers-page bouncer…',
  'Bribing recruiters with cookies…',
  'Polishing your CV charm…',
  'Asking the universe for a Tier 1 hit…',
  'Decoding HR-speak into English…',
  'Counting open roles on tracked portals…',
  'Reading job descriptions you\u2019ll definitely skim…',
  'Looking under the couch for hidden listings…',
  'Side-eyeing the salary range…',
  'Whispering \u201Cremote-friendly\u201D into the API…',
  'Tickling Greenhouse for fresh openings…',
  'Distracting the rate limiter…',
  'Brewing a fresh batch of opportunity…',
  'Reverse-engineering \u201Ccompetitive compensation\u201D…',
  'Pretending to be a passionate self-starter…',
  'Filtering out the unicorn-hunting startups…',
]

export function CommandCenter() {
  const { repoPath } = useAppStore()
  const { scoreHistory, applications, pipeline, scansThisMonth, loaded, refresh } = useDataStore()

  // Compute stats
  const totalEvaluated = scoreHistory.length
  const active = applications.filter(a =>
    ['Applied', 'Responded', 'Interview', 'Offer'].includes(a.status)
  ).length
  const pendingListings = pipeline.length

  const lastScanDate = scoreHistory.length
    ? scoreHistory.sort((a, b) => b.date.localeCompare(a.date))[0]?.date
    : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Scouting</h1>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-8 gap-6 overflow-hidden min-h-0">
        {/* Hero — fixed height */}
        <div className="shrink-0 galaxy-bg rounded-lg p-6 border border-border-default">
          <div>
            <h1 className="text-page text-text-1 mb-1">Scouting</h1>
            <p className="text-body text-text-3">
              {loaded ? `${totalEvaluated} offers evaluated · ${pendingListings} pending in pipeline` : 'Loading data…'}
            </p>
          </div>
        </div>

        {/* Stats row — fixed height */}
        <div className="shrink-0 grid grid-cols-3 gap-3 lg:grid-cols-5">
          <StatCard
            label="Total evaluated"
            value={loaded ? String(totalEvaluated) : '—'}
            icon={BarChart2}
            loading={!loaded}
          />
          <StatCard
            label="Active"
            value={loaded ? String(active) : '—'}
            icon={Target}
            accent="text-accent"
            loading={!loaded}
          />
          <StatCard
            label="Pending Listings"
            value={loaded ? String(pendingListings) : '—'}
            icon={Inbox}
            loading={!loaded}
          />
          <StatCard
            label="Scans this month"
            value={loaded ? String(scansThisMonth) : '—'}
            icon={Radar}
            loading={!loaded}
          />
          <StatCard
            label="Last scan"
            value={lastScanDate ?? '—'}
            icon={Calendar}
            small
            loading={!loaded}
          />
        </div>

        {/* Scouting cockpit (flex-grows to fill remaining height) */}
        <ScoutingActionPanel repoPath={repoPath} onPipelineDone={refresh} />

        {/* Recent top picks — gives the page substance even when no scan
            is running. Reads from scoreHistory; clicks navigate to /reports
            filtered to that listing. */}
        <RecentTopPicks />
      </div>
    </div>
  )
}

function RecentTopPicks() {
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const navigate = useNavStore(s => s.navigate)

  const topPicks = useMemo(() => {
    return [...scoreHistory]
      .filter(s => s.tier === 'T1' || s.tier === 'T2-high' || s.tier === 'T2')
      .sort((a, b) => {
        // Prefer most recent; break ties by score desc.
        const cmp = (b.date ?? '').localeCompare(a.date ?? '')
        return cmp !== 0 ? cmp : (b.overall - a.overall)
      })
      .slice(0, 8)
  }, [scoreHistory])

  if (topPicks.length === 0) return null

  return (
    <div className="shrink-0">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] uppercase tracking-[0.12em] text-text-4 font-semibold">
          Recent top picks
        </p>
        <button
          onClick={() => navigate('database')}
          className="text-[11px] text-text-3 hover:text-accent transition-colors"
        >
          See all in Database →
        </button>
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
        {topPicks.map((entry, i) => (
          <TopPickCard
            key={`${entry.company}-${entry.role}-${i}`}
            entry={entry}
            onClick={() => navigate('reports', `${entry.company}|${entry.role}`)}
          />
        ))}
      </div>
    </div>
  )
}

function TopPickCard({ entry, onClick }: { entry: ScoreEntry; onClick: () => void }) {
  const tierColor =
    entry.tier === 'T1'      ? 'text-tier-1' :
    entry.tier === 'T2-high' ? 'text-success' :
    entry.tier === 'T2'      ? 'text-tier-2' :
                                'text-text-3'
  return (
    <button
      onClick={onClick}
      className="shrink-0 w-[200px] text-left p-3 rounded-lg bg-bg-panel border border-border-default hover:border-accent/40 hover:bg-accent/[0.04] transition-all"
    >
      <div className="flex items-start gap-2.5">
        <CompanyLogo company={entry.company} size={26} className="shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[12.5px] text-text-1 font-semibold truncate">{entry.company}</div>
          <div className="text-[11px] text-text-3 truncate mt-0.5">{entry.role}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2.5">
        <span className={cn('text-[10px] font-mono font-bold tracking-wide', tierColor)}>
          {entry.tier === 'T2-high' ? 'T2+' : entry.tier}
        </span>
        {entry.overall > 0 && (
          <span className="text-[11px] font-mono font-semibold text-text-2 tabular-nums">
            {entry.overall.toFixed(1)}
          </span>
        )}
      </div>
    </button>
  )
}

// ─── Scouting Action Panel ──────────────────────────────────────────────────

function ScoutingActionPanel({
  repoPath,
  onPipelineDone,
}: {
  repoPath: string | null
  onPipelineDone: () => void
}) {
  const { spawns, start, kill, clear } = useSpawnsStore()
  const pipelineModel = useAppStore(s => s.models.pipeline)
  const fullScan       = spawns[FULL_SCAN_ID]
  const apiScan        = spawns[API_SCAN_ID]
  const pipelineFilter = spawns[PIPELINE_FILTER_ID]
  const pipelineTop    = spawns[PIPELINE_TOP_ID]
  const pipelineAll    = spawns[PIPELINE_ALL_ID]

  // Refresh data store whenever any of these finishes (a Filter run grows
  // scouting.md; Top/All grow reports/; scan grows pipeline.md). One effect
  // per spawn so we don't miss simultaneous completions.
  useEffect(() => { if (statusDone(fullScan))       onPipelineDone() }, [fullScan?.status,       onPipelineDone])
  useEffect(() => { if (statusDone(apiScan))        onPipelineDone() }, [apiScan?.status,        onPipelineDone])
  useEffect(() => { if (statusDone(pipelineFilter)) onPipelineDone() }, [pipelineFilter?.status, onPipelineDone])
  useEffect(() => { if (statusDone(pipelineTop))    onPipelineDone() }, [pipelineTop?.status,    onPipelineDone])
  useEffect(() => { if (statusDone(pipelineAll))    onPipelineDone() }, [pipelineAll?.status,    onPipelineDone])

  const handleFullScan = () => {
    if (fullScan?.status === 'running') { kill(FULL_SCAN_ID); return }
    if (fullScan) clear(FULL_SCAN_ID)
    start(FULL_SCAN_ID, 'Full Scan', 'claude', claudeArgs('/career-ops scan', 'sonnet'))
  }
  const handleApiScan = () => {
    if (apiScan?.status === 'running') { kill(API_SCAN_ID); return }
    if (apiScan) clear(API_SCAN_ID)
    start(API_SCAN_ID, 'API Scan', 'node', ['scripts/scan.mjs'])
  }
  const handleFilter = () => {
    if (pipelineFilter?.status === 'running') { kill(PIPELINE_FILTER_ID); return }
    if (pipelineFilter) clear(PIPELINE_FILTER_ID)
    start(PIPELINE_FILTER_ID, 'Filter to Database', 'claude', claudeArgs(FILTER_PROMPT, pipelineModel))
  }
  const handleTopReports = () => {
    if (pipelineTop?.status === 'running') { kill(PIPELINE_TOP_ID); return }
    if (pipelineTop) clear(PIPELINE_TOP_ID)
    start(PIPELINE_TOP_ID, 'Generate Top Reports', 'claude', claudeArgs(TOP_REPORTS_PROMPT, pipelineModel))
  }
  const handleAllReports = () => {
    if (pipelineAll?.status === 'running') { kill(PIPELINE_ALL_ID); return }
    if (pipelineAll) clear(PIPELINE_ALL_ID)
    start(PIPELINE_ALL_ID, 'Generate All Reports', 'claude', claudeArgs(ALL_REPORTS_PROMPT, pipelineModel))
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <HoverDescriptionRow
        items={[
          {
            key: 'full',
            description: 'Playwright + ATS APIs + WebSearch — uses Claude (token cost)',
            node: (
              <ActionButton
                label="Full Scan"
                icon={Play}
                tone="primary"
                running={fullScan?.status === 'running'}
                onClick={handleFullScan}
                disabled={!repoPath}
              />
            ),
          },
          {
            key: 'api',
            description: 'Direct ATS API calls — zero token cost, instant',
            node: (
              <ActionButton
                label="API Only"
                icon={Zap}
                tone="outline"
                running={apiScan?.status === 'running'}
                onClick={handleApiScan}
                disabled={!repoPath}
              />
            ),
          },
          {
            key: 'sep',
            node: <div className="w-px h-6 bg-border-default" aria-hidden />,
          },
          {
            key: 'filter',
            description: 'Filter pending URLs and add lightweight metadata to the scouting database — no full reports',
            node: (
              <ActionButton
                label="Filter to Database"
                icon={Filter}
                tone="outline"
                running={pipelineFilter?.status === 'running'}
                onClick={handleFilter}
                disabled={!repoPath}
              />
            ),
          },
          {
            key: 'top',
            description: 'Filter, then generate full reports for the top 8 most-promising pending listings',
            node: (
              <ActionButton
                label="Top Reports"
                icon={Sparkles}
                tone="outline"
                running={pipelineTop?.status === 'running'}
                onClick={handleTopReports}
                disabled={!repoPath}
              />
            ),
          },
          {
            key: 'all',
            description: 'Generate full reports for every pending listing that passes the filter',
            node: (
              <ActionButton
                label="All Reports"
                icon={FileStack}
                tone="outline"
                running={pipelineAll?.status === 'running'}
                onClick={handleAllReports}
                disabled={!repoPath}
              />
            ),
          },
          {
            key: 'sep2',
            node: <div className="w-px h-6 bg-border-default" aria-hidden />,
          },
          {
            key: 'model',
            description: 'Model used for Filter / Top Reports / All Reports. Scan is always Sonnet.',
            node: <ModelChip />,
          },
        ]}
      />

      <ScanModelHint />

      {/* Activity is now exclusively on the Scan tab. When something is
          running anywhere, surface a quiet pointer so the user knows where
          to go for the live log. */}
      <RunningInScanFooter />
    </div>
  )
}

// Inline model selector — affects ONLY the three pipeline buttons
// (Filter to Database / Generate Top Reports / Generate All Reports).
// Full Scan is locked to Sonnet (cheap tool-use). Per-listing actions
// (Tailor CV / Draft / Prep / popover Generate Report) are locked to
// Opus (precision work). The user changes the one variable that
// matters: the bulk-pipeline model.
function ModelChip() {
  const pipeline = useAppStore(s => s.models.pipeline)
  const setModel = useAppStore(s => s.setModel)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const options: Array<{ id: 'sonnet' | 'opus'; label: string; tag: string }> = [
    { id: 'opus',   label: 'Opus',   tag: 'thorough' },
    { id: 'sonnet', label: 'Sonnet', tag: 'cheaper · fast' },
  ]
  const current = options.find(o => o.id === pipeline) ?? options[0]

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => setOpen(o => !o)}
        title="Model for the three pipeline buttons (Filter / Top Reports / All Reports)"
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border transition-colors text-[12px]',
          open
            ? 'border-accent/60 bg-accent/15 text-accent'
            : 'border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong',
        )}
      >
        <span className="text-text-4 font-mono uppercase tracking-wider text-[9.5px]">Pipeline</span>
        <span className="font-semibold">{current.label}</span>
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[180px] rounded-lg border border-border-default bg-bg-base shadow-card overflow-hidden">
          {options.map(o => (
            <button
              key={o.id}
              onClick={() => { setModel('pipeline', o.id); setOpen(false) }}
              className={cn(
                'w-full flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-left transition-colors',
                o.id === pipeline
                  ? 'bg-accent/8 text-text-1'
                  : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
              )}
            >
              <span className="font-medium">{o.label}</span>
              <span className="text-[10.5px] text-text-4">{o.tag}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ScanModelHint() {
  const pipeline = useAppStore(s => s.models.pipeline)
  return (
    <div className="shrink-0 -mt-1 text-center text-[10.5px] text-text-4 leading-relaxed">
      Full Scan: <span className="font-mono text-text-3">Sonnet</span> ·
      {' '}Pipeline buttons: <span className="font-mono text-text-3 capitalize">{pipeline}</span> (change above) ·
      {' '}Per-listing actions (Tailor CV / Draft / Prep): <span className="font-mono text-text-3">Opus</span>
    </div>
  )
}

// Shared exports — used by ScanView, ApplyingView, ActiveProcessesBar etc.
export {
  ActionButton, ActivityPanel, LoadingMessage, pickVisible, HoverDescriptionRow,
  ElapsedChip, formatElapsed, RunningInScanFooter, statusDone,
}

// Lightweight status check shared across ScoutingActionPanel's many useEffects.
function statusDone(rec: SpawnRecord | undefined): boolean {
  return rec?.status === 'done' || rec?.status === 'error' || rec?.status === 'killed'
}

// Footer shown on Scouting / Applying when at least one spawn is running
// somewhere. Activity panel itself moved to the Scan tab — this just points
// the user there.
function RunningInScanFooter() {
  const anyRunning = useSpawnsStore(isAnyRunning)
  const navigate = useNavStore(s => s.navigate)
  const runningCount = useSpawnsStore(s =>
    Object.values(s.spawns).filter(x => x.status === 'running').length
  )
  if (!anyRunning) return null
  return (
    <button
      onClick={() => navigate('scan')}
      className="shrink-0 mt-3 self-center inline-flex items-center gap-2 px-3 py-1.5 rounded-pill bg-accent/8 hover:bg-accent/14 border border-accent/30 text-accent text-[12px] transition-colors"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
      {runningCount} running — open Scan
      <ArrowRight size={11} className="opacity-70" />
    </button>
  )
}

function pickVisible(
  ...records: Array<SpawnRecord | undefined>
): SpawnRecord | undefined {
  const present = records.filter((r): r is SpawnRecord => !!r)
  if (present.length === 0) return undefined
  const running = present.filter(r => r.status === 'running')
  const pool = running.length ? running : present
  return pool.reduce((a, b) => (a.startedAt > b.startedAt ? a : b))
}

// ─── Action Button ──────────────────────────────────────────────────────────

function ActionButton({
  label, icon: Icon, tone, running, onClick, disabled, title,
}: {
  label: string
  icon: React.ElementType
  tone: 'primary' | 'outline'
  running: boolean
  onClick: () => void
  disabled?: boolean
  title?: string  // HTML title attr only — visible tooltip is owned by the row.
}) {
  if (running) {
    return (
      <button
        onClick={onClick}
        title="Click to stop"
        className="inline-flex items-center gap-2 rounded-pill px-5 py-2 text-[14px] font-medium border-2 border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
      >
        <Square size={13} className="fill-current" />
        Stop {label}
      </button>
    )
  }
  if (tone === 'primary') {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="btn-pill disabled:opacity-50"
      >
        <Icon size={14} />
        {label}
      </button>
    )
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="btn-pill-outline disabled:opacity-50"
    >
      <Icon size={14} />
      {label}
    </button>
  )
}

// ─── Hover-description row ──────────────────────────────────────────────────
// A button row with a single shared description slot centered below it. The
// slot has fixed height so it doesn't reflow when the description appears or
// changes, and the description STAYS centered on the row regardless of which
// button is hovered — only the text swaps. mouseEnter sets the description;
// the parent container's mouseLeave clears it, so moving between buttons
// (across the gap or the divider) doesn't flicker.

interface HoverItem {
  key: string
  node: React.ReactNode
  description?: string
}

function HoverDescriptionRow({ items, slotMaxWidth = 640 }: {
  items: HoverItem[]
  slotMaxWidth?: number
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const desc = hoverIdx !== null ? items[hoverIdx]?.description : null

  return (
    <div className="shrink-0 flex flex-col items-center pt-2">
      <div
        className="flex items-center gap-3"
        onMouseLeave={() => setHoverIdx(null)}
      >
        {items.map((item, i) => (
          <span
            key={item.key}
            className="inline-flex"
            onMouseEnter={item.description ? () => setHoverIdx(i) : undefined}
          >
            {item.node}
          </span>
        ))}
      </div>
      <div
        className="h-12 flex items-start justify-center pt-3 px-4"
        style={{ maxWidth: slotMaxWidth }}
      >
        <p
          className="text-[12px] text-text-3 transition-opacity duration-150 text-center whitespace-nowrap"
          style={{ opacity: desc ? 1 : 0 }}
        >
          {desc ?? '\u00A0'}
        </p>
      </div>
    </div>
  )
}

// ─── Activity Panel ─────────────────────────────────────────────────────────
// Shared between Command Center and /scan. Flex-grows to fill the remaining
// vertical space of its parent flex column.

function ActivityPanel({ record }: { record: SpawnRecord | undefined }) {
  const logRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new lines.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [record?.output.length])

  const isRunning = record?.status === 'running'
  const hasOutput = (record?.output.length ?? 0) > 0
  const showLoadingMessages = isRunning && !hasOutput

  return (
    <div
      className="flex-1 min-h-0 relative rounded-xl overflow-hidden flex flex-col"
      style={{ background: '#1F1B36', boxShadow: '0 10px 32px rgba(20, 14, 50, 0.18)' }}
    >
      {/* Header strip — no static "Terminal" label. When the running spawn is
          a Claude invocation the brand mark sits next to the label so the user
          knows what's at the wheel. The elapsed chip ticks every second while
          running so a "stuck" run can never look like "instant" success. */}
      <div
        className="shrink-0 h-8 px-5 flex items-center justify-between border-b text-[10px] font-mono uppercase tracking-wider"
        style={{ background: '#2A2548', borderColor: 'rgba(255,255,255,0.05)' }}
      >
        <span className="text-white/55 inline-flex items-center gap-1.5">
          {record?.tool === 'claude' && <ClaudeLogo size={12} />}
          {record ? `${record.label} ${statusGlyph(record)}` : 'Idle'}
        </span>
        {record?.startedAt ? (
          <span className="inline-flex items-center gap-2">
            <ElapsedChip record={record} />
            <span className="text-white/30">·</span>
            <span className="text-white/40 tabular-nums">
              {new Date(record.startedAt).toLocaleTimeString()}
            </span>
          </span>
        ) : null}
      </div>

      {/* Body */}
      <div
        ref={logRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-[1.6] relative"
        style={{ userSelect: 'text', color: '#D4CFE6' }}
      >
        {!record && (
          <p className="text-white/40 italic">Pick a scan or generate reports above.</p>
        )}

        {record && record.output.map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-all',
              // Order matters — check most specific patterns first.
              line.startsWith('→ ')                       ? 'text-[#A795E8]' :  // tool-use one-liner — muted violet
              line.startsWith('✓ Done')                   ? 'text-[#9AE3A8]' :  // final success capstone
              /error/i.test(line)                         ? 'text-[#FF8FA3]' :
              /warn/i.test(line)                          ? 'text-[#F7CC78]' :
              /✓|^\s*✓|done|found|appended/i.test(line)   ? 'text-[#9AE3A8]' :
              ''
            )}
          >
            {line}
          </div>
        ))}

        {showLoadingMessages && (
          <LoadingMessage
            seed={record!.startedAt}
            showClaudeMark={record!.tool === 'claude'}
          />
        )}

        {isRunning && hasOutput && (
          <span className="inline-block w-1.5 h-3 bg-accent-light animate-pulse rounded-sm align-middle ml-0.5" />
        )}

        {record && !isRunning && (
          <div className="mt-2 text-white/45">
            {record.status === 'done'   && '— exited cleanly —'}
            {record.status === 'error'  && `— exit ${record.exitCode ?? '?'} —`}
            {record.status === 'killed' && '— stopped —'}
          </div>
        )}
      </div>
    </div>
  )
}

function ElapsedChip({ record }: { record: SpawnRecord }) {
  // Force a re-render every second while the spawn is running, so the
  // elapsed text updates live. After the spawn finishes we freeze on the
  // recorded endedAt — no more ticks.
  const [, setTick] = useState(0)
  const isRunning = record.status === 'running'
  useEffect(() => {
    if (!isRunning) return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [isRunning])
  const end = isRunning ? Date.now() : (record.endedAt ?? record.startedAt)
  return (
    <span
      className={cn(
        'tabular-nums',
        isRunning ? 'text-accent-light' : 'text-white/40',
      )}
    >
      {formatElapsed(end - record.startedAt)}
    </span>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${String(rm).padStart(2, '0')}m`
}

function statusGlyph(r: SpawnRecord): string {
  if (r.status === 'running') return '· running'
  if (r.status === 'done')    return '· done'
  if (r.status === 'error')   return '· error'
  if (r.status === 'killed')  return '· stopped'
  return ''
}

function LoadingMessage({ seed, showClaudeMark = false }: { seed: number; showClaudeMark?: boolean }) {
  const [idx, setIdx] = useState(() => Math.floor((seed / 1000) % LOADING_MESSAGES.length))
  useEffect(() => {
    const t = setInterval(() => {
      setIdx(i => (i + 1) % LOADING_MESSAGES.length)
    }, 2600)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="absolute inset-0 top-7 flex items-center justify-center pointer-events-none px-6">
      <div className="flex flex-col items-center gap-3">
        {showClaudeMark && (
          <div className="animate-pulse">
            <ClaudeLogo size={28} />
          </div>
        )}
        <p
          key={idx}
          className="italic text-[12.5px] text-center"
          style={{
            color: '#B5A3FF',
            animation: 'chip-appear 320ms ease both',
          }}
        >
          {LOADING_MESSAGES[idx]}
        </p>
      </div>
    </div>
  )
}
