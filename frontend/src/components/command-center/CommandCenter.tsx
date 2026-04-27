'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, type SpawnRecord } from '@/store/spawns'
import { ModeToggle } from './ModeToggle'
import { StatCard } from './StatCard'
import {
  BarChart2, Clock, Inbox, Target, Radar, Calendar,
  Play, Zap, FileOutput, Square,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const FULL_SCAN_ID  = 'cmd-full-scan'
const API_SCAN_ID   = 'cmd-api-scan'
const PIPELINE_ID   = 'cmd-pipeline'

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
  const { currentMode, repoPath } = useAppStore()
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
        <h1 className="text-body text-text-1 font-medium">Command Center</h1>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-8 gap-6 overflow-hidden min-h-0">
        {/* Hero — fixed height */}
        <div className="shrink-0 galaxy-bg rounded-lg p-6 border border-border-default">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-page text-text-1 mb-1">Command Center</h1>
              <p className="text-body text-text-3">
                {loaded ? `${totalEvaluated} offers evaluated · ${pendingListings} pending in pipeline` : 'Loading data…'}
              </p>
            </div>
            <ModeToggle />
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

        {/* Action panel — scouting cockpit (flex-grows to fill remaining height) */}
        {currentMode === 'scouting' ? (
          <ScoutingActionPanel repoPath={repoPath} onPipelineDone={refresh} />
        ) : (
          <div className="shrink-0 rounded-lg border border-border-default bg-bg-elevated px-5 py-4 text-body text-text-3 flex items-center gap-2">
            <Clock size={14} className="text-text-4" />
            Job-seeking mode — manage active offers from the Pipeline tab.
          </div>
        )}
      </div>
    </div>
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
  const fullScan = spawns[FULL_SCAN_ID]
  const apiScan  = spawns[API_SCAN_ID]
  const pipeline = spawns[PIPELINE_ID]

  // The spawn currently shown in the activity panel: prefer the running one,
  // else the most recently started (so the user sees the latest result).
  const visible = pickVisible(fullScan, apiScan, pipeline)

  // Refresh data store when a spawn finishes successfully.
  useEffect(() => {
    if (pipeline?.status === 'done') onPipelineDone()
  }, [pipeline?.status, onPipelineDone])

  useEffect(() => {
    if (fullScan?.status === 'done' || apiScan?.status === 'done') onPipelineDone()
  }, [fullScan?.status, apiScan?.status, onPipelineDone])

  const handleFullScan = () => {
    if (fullScan?.status === 'running') { kill(FULL_SCAN_ID); return }
    if (fullScan) clear(FULL_SCAN_ID)
    start(FULL_SCAN_ID, 'Full Scan', 'claude', ['-p', '@modes/scan.md'])
  }
  const handleApiScan = () => {
    if (apiScan?.status === 'running') { kill(API_SCAN_ID); return }
    if (apiScan) clear(API_SCAN_ID)
    start(API_SCAN_ID, 'API Scan', 'node', ['scripts/scan.mjs'])
  }
  const handlePipeline = () => {
    if (pipeline?.status === 'running') { kill(PIPELINE_ID); return }
    if (pipeline) clear(PIPELINE_ID)
    start(PIPELINE_ID, 'Generate Reports', 'claude', ['-p', '@modes/pipeline.md'])
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-7">
      {/* Button row — centered, with | as the midpoint */}
      <div className="shrink-0 flex items-center justify-center gap-3 pt-2">
        <ActionButton
          label="Full Scan"
          icon={Play}
          tone="primary"
          running={fullScan?.status === 'running'}
          onClick={handleFullScan}
          disabled={!repoPath}
          title="Playwright + ATS APIs + WebSearch — uses Claude (token cost)"
        />
        <ActionButton
          label="API Only"
          icon={Zap}
          tone="outline"
          running={apiScan?.status === 'running'}
          onClick={handleApiScan}
          disabled={!repoPath}
          title="Direct ATS API calls — zero token cost, instant"
        />
        <div className="w-px h-6 bg-border-default" aria-hidden />
        <ActionButton
          label="Generate Reports"
          icon={FileOutput}
          tone="outline"
          running={pipeline?.status === 'running'}
          onClick={handlePipeline}
          disabled={!repoPath}
          title="Process pending listings in data/pipeline.md into evaluation reports"
        />
      </div>

      {/* Activity panel (flex-grows to fill remaining vertical space) */}
      <ActivityPanel record={visible} />
    </div>
  )
}

// Shared exports — used by ScanView too.
export { ActionButton, ActivityPanel, LoadingMessage, pickVisible }

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
  title?: string
}) {
  if (running) {
    return (
      <button
        onClick={onClick}
        title="Stop"
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
      {/* Header strip — no static "Terminal" label */}
      <div
        className="shrink-0 h-7 px-3 flex items-center justify-between border-b text-[10px] font-mono uppercase tracking-wider"
        style={{ background: '#2A2548', borderColor: 'rgba(255,255,255,0.05)' }}
      >
        <span className="text-white/55">
          {record ? `${record.label} ${statusGlyph(record)}` : 'Idle'}
        </span>
        {record?.startedAt ? (
          <span className="text-white/40 tabular-nums">
            {new Date(record.startedAt).toLocaleTimeString()}
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
              /error/i.test(line)               ? 'text-[#FF8FA3]' :
              /warn/i.test(line)                ? 'text-[#F7CC78]' :
              /✓|done|found|appended/i.test(line)? 'text-[#9AE3A8]' :
              ''
            )}
          >
            {line}
          </div>
        ))}

        {showLoadingMessages && <LoadingMessage seed={record!.startedAt} />}

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

function statusGlyph(r: SpawnRecord): string {
  if (r.status === 'running') return '· running'
  if (r.status === 'done')    return '· done'
  if (r.status === 'error')   return '· error'
  if (r.status === 'killed')  return '· stopped'
  return ''
}

function LoadingMessage({ seed }: { seed: number }) {
  const [idx, setIdx] = useState(() => Math.floor((seed / 1000) % LOADING_MESSAGES.length))
  useEffect(() => {
    const t = setInterval(() => {
      setIdx(i => (i + 1) % LOADING_MESSAGES.length)
    }, 2600)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="absolute inset-0 top-7 flex items-center justify-center pointer-events-none px-6">
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
  )
}
