'use client'

import { useEffect, useRef, useState, useId } from 'react'
import { clsx } from 'clsx'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, isAnyRunning, claudeArgs, isAuthFailure, diagnoseFailure, type SpawnRecord } from '@/store/spawns'
import { useWriteGate } from '@/store/dataRoot'
import { claudeEvalArgsResolved, filterAllPrompt, refreshCvSummary } from '@/lib/evalSpawn'
import { useScanFilter } from '@/store/scanFilter'
import { useNavStore } from '@/store/nav'
import { ipc } from '@/lib/ipc'
import { ClaudeLogo } from '@/components/shared/Logos'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { OrbitalLoader } from '@/components/ui/orbital-loader'
import { Button, Panel, Stat, StatStrip, type StatTone } from '@/components/ui'
import { Play, Zap, Filter, Square, ArrowRight, ChevronDown, Check, Plus, Star, AlertTriangle, RotateCw, Loader2, ListFilter, X } from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'

// Class strings below are combined with `clsx`, not `cn`: tailwind-merge
// reads custom size tokens (`text-label`, `text-body`) as text colours and
// drops them when a `text-text-*` colour follows.

// Legacy stat tile, kept as a thin wrapper over the `Stat` primitive so the
// views that still import it keep compiling while they migrate to
// `<StatStrip><Stat/></StatStrip>` directly. `accent` / `highlightDot` were
// Tailwind class strings; they now only pick the Stat tone.
function HeroStatTile({
  value, label, sub, accent, highlightDot,
}: {
  value: string | number
  label: string
  sub?: string
  accent?: string
  highlightDot?: string
}) {
  return (
    <Stat
      value={value}
      label={label}
      hint={sub}
      tone={accent ? heroTone(accent) : 'default'}
      dot={!!highlightDot}
    />
  )
}

function heroTone(accentClass: string): StatTone {
  if (/danger/.test(accentClass))  return 'danger'
  if (/warning/.test(accentClass)) return 'warning'
  if (/success/.test(accentClass)) return 'success'
  return 'accent'
}

const FULL_SCAN_ID       = 'cmd-full-scan'
const API_SCAN_ID        = 'cmd-api-scan'
const PIPELINE_FILTER_ID = 'cmd-pipeline-filter'
const FILTERED_SCAN_ID   = 'cmd-filtered-scan'
// JobSpy aggregator scraper (Indeed + Google). Single shared spawn —
// either Full Scan or API Only triggers it; if it's already running,
// the second click reuses it. Writes to staging files, picked up by
// scripts/merge-scan-staging.mjs after both finish.
//
// JOBSPY_ENABLED gates the spawn AND the merge step. Flip to true to
// re-enable; the constants below stay in place so re-enabling is a
// one-line change. (Disabled because Indeed/Google funnel surfaces too
// many CPG/HR/retail roles that bypass the title positives — see top-20
// jobspy-scored audit: nothing apply-worthy.)
const JOBSPY_ENABLED     = false
const JOBSPY_ID          = 'cmd-jobspy'
const STAGING_MERGE_ID   = 'cmd-staging-merge'
const JOBSPY_PYTHON      = 'scripts/jobspy/.venv/bin/python'
const JOBSPY_SCRIPT      = 'scripts/jobspy/scan.py'

// "Filter to Database" rides the compact eval bundle (batch/batch-prompt.md,
// loaded via --append-system-prompt-file in claudeEvalArgs) instead of the
// `/career-ops pipeline` slash command — token-cost lever 3: the worker no
// longer re-reads CLAUDE.md + modes/* before touching a single JD. The task
// prompt itself (gate criteria + score-only deviation + merge step) lives in
// lib/evalSpawn.filterAllPrompt, shared with the Pipeline inbox and the
// Reports top-5 path and unit-tested there.

const LOADING_MESSAGES = [
  'Sneaking past the careers-page bouncer…',
  'Bribing recruiters with cookies…',
  'Polishing your CV charm…',
  'Asking the universe for a Tier 1 hit…',
  'Decoding HR-speak into English…',
  'Counting open roles on tracked portals…',
  'Reading job descriptions you’ll definitely skim…',
  'Looking under the couch for hidden listings…',
  'Side-eyeing the salary range…',
  'Whispering “remote-friendly” into the API…',
  'Tickling Greenhouse for fresh openings…',
  'Distracting the rate limiter…',
  'Brewing a fresh batch of opportunity…',
  'Reverse-engineering “competitive compensation”…',
  'Pretending to be a passionate self-starter…',
  'Filtering out the unicorn-hunting startups…',
]

// ─── Scouting Action Panel ──────────────────────────────────────────────────

export function ScoutingActionPanel({
  repoPath,
  onPipelineDone,
}: {
  repoPath: string | null
  onPipelineDone: () => void
}) {
  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)
  const pipelineModel = useAppStore(s => s.models.pipeline)
  // Demo mode is read-only: every button in this row writes or spawns work.
  const { canWrite, readOnlyTitle } = useWriteGate()
  const blocked = !repoPath || !canWrite
  // In the demo the shared hover line explains why the row is disabled.
  const describe = (text: string) => readOnlyTitle ? `${readOnlyTitle}. ${text}` : text
  const fullScan       = spawns[FULL_SCAN_ID]
  const apiScan        = spawns[API_SCAN_ID]
  const pipelineFilter = spawns[PIPELINE_FILTER_ID]
  const jobspy        = spawns[JOBSPY_ID]
  const stagingMerge  = spawns[STAGING_MERGE_ID]

  // Refresh the data store when each finishes (Filter grows scouting.md;
  // scan grows pipeline.md). Reports generation has moved off this tab —
  // it's now triggered from the Reports tab and refreshes there.
  useEffect(() => { if (statusDone(fullScan))       onPipelineDone() }, [fullScan?.status,       onPipelineDone])
  useEffect(() => { if (statusDone(apiScan))        onPipelineDone() }, [apiScan?.status,        onPipelineDone])
  useEffect(() => { if (statusDone(pipelineFilter)) onPipelineDone() }, [pipelineFilter?.status, onPipelineDone])

  // When JobSpy AND at least one scan have finished, run the merge step
  // exactly once. The "!stagingMerge" guard prevents re-firing — once
  // start() runs, stagingMerge becomes a record so the condition stays
  // false until the next scan click (which clears it via startJobspyIfIdle).
  //
  // Gated on JOBSPY_ENABLED so when JobSpy is off, the merge never runs
  // (nothing to merge — staging files stay empty).
  useEffect(() => {
    if (!JOBSPY_ENABLED) return
    const jobspyDone = statusDone(jobspy)
    const someScanDone = statusDone(fullScan) || statusDone(apiScan)
    if (jobspyDone && someScanDone && !stagingMerge) {
      start(STAGING_MERGE_ID, 'Merge JobSpy staging', 'node', ['scripts/merge-scan-staging.mjs'])
    }
  }, [jobspy?.status, fullScan?.status, apiScan?.status, stagingMerge, start])

  // Refresh the data store after the merge appends staging into pipeline.md
  useEffect(() => { if (statusDone(stagingMerge)) onPipelineDone() }, [stagingMerge?.status, onPipelineDone])

  // Spawn JobSpy alongside whichever scan was clicked. If JobSpy is
  // already running (e.g. from the other scan button), reuse it instead
  // of double-spawning — avoids racing on the same staging files.
  const startJobspyIfIdle = () => {
    if (!JOBSPY_ENABLED) return
    if (jobspy?.status === 'running') return
    if (jobspy) clear(JOBSPY_ID)
    if (stagingMerge) clear(STAGING_MERGE_ID)
    start(JOBSPY_ID, 'JobSpy (Indeed + Google)', JOBSPY_PYTHON, [JOBSPY_SCRIPT])
  }

  const handleFullScan = () => {
    if (fullScan?.status === 'running') { kill(FULL_SCAN_ID); return }
    if (fullScan) clear(FULL_SCAN_ID)
    start(FULL_SCAN_ID, 'Full scan', 'claude', claudeArgs('/career-ops scan', 'sonnet'))
    startJobspyIfIdle()
  }
  const handleApiScan = () => {
    if (apiScan?.status === 'running') { kill(API_SCAN_ID); return }
    if (apiScan) clear(API_SCAN_ID)
    start(API_SCAN_ID, 'API scan', 'node', ['scripts/scan.mjs'])
    startJobspyIfIdle()
  }
  const handleFilter = async () => {
    if (pipelineFilter?.status === 'running') { kill(PIPELINE_FILTER_ID); return }
    if (pipelineFilter) clear(PIPELINE_FILTER_ID)
    // Fire-and-forget CV-summary refresh — finishes in ms while the Claude
    // CLI boots; the bundle falls back to user/cv.md if the artifact is missing.
    void refreshCvSummary()
    start(PIPELINE_FILTER_ID, 'Filter to Database', 'claude', await claudeEvalArgsResolved(filterAllPrompt(), pipelineModel))
  }

  return (
    <div className="shrink-0 flex flex-col">
      <HoverDescriptionRow
        slotMaxWidth={960}
        items={[
          {
            key: 'full',
            description: describe('Playwright + ATS APIs + WebSearch + JobSpy aggregators (Indeed/Google). Uses Claude (token cost); JobSpy runs in parallel at zero token cost.'),
            node: (
              <ActionButton
                label="Full scan"
                icon={Play}
                tone="primary"
                running={fullScan?.status === 'running'}
                onClick={handleFullScan}
                disabled={blocked}
                title={readOnlyTitle}
              />
            ),
          },
          {
            key: 'api',
            description: describe('Direct ATS API calls + JobSpy aggregators (Indeed/Google). Zero token cost; JobSpy runs in parallel.'),
            node: (
              <ActionButton
                label="API only"
                icon={Zap}
                tone="outline"
                running={apiScan?.status === 'running'}
                onClick={handleApiScan}
                disabled={blocked}
                title={readOnlyTitle}
              />
            ),
          },
          {
            key: 'filtered',
            description: describe('Scan only the companies you pick. Opens a picker preselected with your dream companies; costs Claude tokens.'),
            node: <FilteredScanButton disabled={blocked} title={readOnlyTitle} />,
          },
          {
            key: 'sep',
            node: <div className="w-px h-5 mx-1 bg-border-default" aria-hidden />,
          },
          {
            key: 'filter',
            description: describe('Discard off-archetype, wrong-seniority and geo-locked listings, then score the survivors (~20–30%) into the Database. No prose reports.'),
            node: (
              <ActionButton
                label="Filter to Database"
                icon={Filter}
                tone="outline"
                running={pipelineFilter?.status === 'running'}
                onClick={() => void handleFilter()}
                disabled={blocked}
                title={readOnlyTitle}
              />
            ),
          },
          {
            key: 'sep2',
            node: <div className="w-px h-5 mx-1 bg-border-default" aria-hidden />,
          },
          {
            key: 'add-listing',
            description: describe('Paste a job URL the scanner missed. Score it into the Database now (uses tokens, no prose report) or queue it for the next filter pass.'),
            node: <AddListingButton disabled={blocked} title={readOnlyTitle} />,
          },
          {
            key: 'model',
            description: 'Model for the Filter to Database run. Scans always use Sonnet; report generation has its own model in Settings › Models.',
            node: <ModelChip />,
          },
        ]}
      />

      {/* Daily brief — the backend digest's "do this first" pick + the top
          few prioritized items per section, computed by scripts/daily-brief.mjs
          (--json) and rendered natively. Content-sized up to half the
          remaining height; renders nothing at all when the brief has nothing
          to say, and the Filtered scan panel then takes the whole area.
          Deactivatable via Settings › General › Features. */}
      {/* Activity is now exclusively on the Activity tab. When something is
          running anywhere, surface a quiet pointer so the user knows where
          to go for the live log. */}
      <RunningInScanFooter />
    </div>
  )
}

// ─── Filtered scan ──────────────────────────────────────────────────────────
//
// A pill in the action row that opens a company picker. The picker lists
// every tracked_company in portals.yml as a toggle chip, pre-selects the
// user's dream_companies (from profile.yml) on first mount of the session,
// then leaves the selection alone. Running spawns Claude with `/career-ops
// scan` plus an explicit allowlist of company names (covers both API-method
// and websearch-method ones). The selection is loaded by the button itself
// so the dream defaults are in place before the picker is ever opened.

const METHOD_LABEL: Record<'api' | 'websearch' | 'unknown', string> = {
  api: 'API',
  websearch: 'web search',
  unknown: 'unknown method',
}

type TrackedCompany = { name: string; method: 'api' | 'websearch' | 'unknown' }

function FilteredScanButton({ disabled, title }: { disabled?: boolean; title?: string }) {
  const repoPath = useAppStore(s => s.repoPath)
  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)
  const filteredScan = spawns[FILTERED_SCAN_ID]
  const selected      = useScanFilter(s => s.selected)
  const applyDefaults = useScanFilter(s => s.applyDreamDefaults)

  const [open, setOpen] = useState(false)
  const [companies, setCompanies] = useState<TrackedCompany[]>([])
  const [dreamCompanies, setDreamCompanies] = useState<string[]>([])

  // Load on mount: portals.yml → tracked_companies (with their scan
  // method) and profile.yml → dream_companies (just the names).
  useEffect(() => {
    if (!repoPath) return
    Promise.all([
      ipc.readFile('user/portals.yml'),
      ipc.readFile('user/profile.yml'),
    ]).then(([portalsRaw, profileRaw]) => {
      if (portalsRaw) setCompanies(parseTrackedCompanies(portalsRaw))
      if (profileRaw) setDreamCompanies(parseDreamCompanyNames(profileRaw))
    })
  }, [repoPath])

  // First-mount only — pre-select dream companies. The store's
  // `initialized` guard prevents this from clobbering user edits on
  // subsequent remounts.
  useEffect(() => {
    if (dreamCompanies.length > 0) applyDefaults(dreamCompanies)
  }, [dreamCompanies, applyDefaults])

  const running = filteredScan?.status === 'running'

  const run = () => {
    if (running) { kill(FILTERED_SCAN_ID); return }
    if (filteredScan) clear(FILTERED_SCAN_ID)
    if (selected.size === 0) return
    const list = Array.from(selected).join(', ')
    const slash =
      `/career-ops scan — FILTERED RUN. Only scan these tracked_companies from user/portals.yml: ${list}. ` +
      `Skip every other tracked_company. Skip the search_queries section entirely. ` +
      `For each named company, follow its scan_method (api → direct API call; websearch → WebSearch with the company's scan_query). ` +
      `Append new URLs to data/pipeline.md per the standard scan mode; respect data/scan-history.tsv for dedup.`
    start(FILTERED_SCAN_ID, `Filtered scan (${selected.size})`, 'claude', claudeArgs(slash, 'sonnet'))
    setOpen(false)
  }

  const noCompanies = companies.length === 0

  return (
    <>
      {running ? (
        <Button
          tone="stop"
          size="lg"
          pill
          onClick={run}
          title="Click to stop (live log on the Activity tab)"
          icon={<Square size={12} className="fill-current" aria-hidden />}
        >
          Stop filtered scan
        </Button>
      ) : (
        <Button
          tone="secondary"
          size="lg"
          pill
          onClick={() => setOpen(true)}
          disabled={disabled || noCompanies}
          title={title ?? (noCompanies ? 'No tracked companies in user/portals.yml yet' : undefined)}
          icon={<ListFilter size={15} aria-hidden />}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          Filtered scan
          {selected.size > 0 && <span className="text-text-4 font-normal">{selected.size}</span>}
        </Button>
      )}
      {open && (
        <FilteredScanDialog
          companies={companies}
          dreamCompanies={dreamCompanies}
          onRun={run}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function FilteredScanDialog({ companies, dreamCompanies, onRun, onClose }: {
  companies: TrackedCompany[]
  dreamCompanies: string[]
  onRun: () => void
  onClose: () => void
}) {
  const selected      = useScanFilter(s => s.selected)
  const toggle        = useScanFilter(s => s.toggle)
  const applyDefaults = useScanFilter(s => s.applyDreamDefaults)
  const clearAll      = useScanFilter(s => s.clear)
  const titleId = useId()
  const runRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    runRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Dream companies first (alphabetical within group), then everyone else.
  const dreamSet = new Set(dreamCompanies)
  const sorted = [...companies].sort((a, b) => {
    const aDream = dreamSet.has(a.name)
    const bDream = dreamSet.has(b.name)
    if (aDream !== bDream) return aDream ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const selectedNames = [...selected]
  const dreamSelected = selectedNames.filter(n => dreamSet.has(n)).length
  const matchesDreams = selected.size === dreamCompanies.length && selectedNames.every(n => dreamSet.has(n))
  const meta = selected.size === 0
    ? 'Pick the companies to scan'
    : `${selected.size} of ${companies.length} selected` +
      (dreamCompanies.length > 0 ? ` · ${matchesDreams ? 'matches your dream list' : `${dreamSelected} dream`}` : '')

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/30 px-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
        className="w-[720px] max-w-full max-h-[76vh] flex flex-col rounded-xl bg-bg-base border border-border-default shadow-lift overflow-hidden"
        style={{ animation: 'chip-appear 160ms cubic-bezier(0.25, 1, 0.5, 1) both' }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-title text-text-1">Filtered scan</h2>
            <p className="text-label text-text-3 mt-0.5">{meta}</p>
          </div>
          <Button tone="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose} icon={<X size={15} />} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4" style={{ scrollbarWidth: 'thin' }}>
          <div className="flex flex-wrap gap-1.5">
            {sorted.map(c => {
              const isSelected = selected.has(c.name)
              const isDream = dreamSet.has(c.name)
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => toggle(c.name)}
                  aria-pressed={isSelected}
                  title={`${c.name} · ${METHOD_LABEL[c.method]}${isDream ? ' · dream company' : ''}`}
                  className={clsx(
                    'chip chip-md h-7 px-2.5 gap-1.5 transition-colors duration-150 ease-quart',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    isSelected
                      ? 'chip-accent hover:bg-accent/20'
                      : 'hover:bg-bg-base hover:border-border-strong hover:text-text-1',
                  )}
                >
                  <CompanyLogo company={c.name} size={14} className="shrink-0" />
                  <span className="truncate max-w-[160px]">{c.name}</span>
                  {isDream && <Star size={12} className="shrink-0 text-accent-text" aria-hidden />}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-border-default bg-bg-elevated/60">
          <Button tone="ghost" size="sm" onClick={clearAll} disabled={selected.size === 0}>Clear</Button>
          {dreamCompanies.length > 0 && (
            <Button
              tone="ghost"
              size="sm"
              onClick={() => applyDefaults(dreamCompanies, true)}
              title="Reset selection to your dream_companies list from profile.yml"
            >
              Reset to dreams
            </Button>
          )}
          <div className="flex-1" />
          <Button tone="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            ref={runRef}
            tone="primary"
            size="sm"
            icon={<Play size={13} aria-hidden />}
            onClick={onRun}
            disabled={selected.size === 0}
            title={selected.size === 0 ? 'Select at least one company first' : `Scan only the ${selected.size} selected ${selected.size === 1 ? 'company' : 'companies'}. Costs Claude tokens.`}
          >
            Run filtered scan
          </Button>
        </div>
      </div>
    </div>
  )
}

// Lightweight portals.yml + profile.yml extractors. Mirrors the shape of
// parseCompanies / extractDreamCompanies in SettingsView; kept inline
// here so the cockpit doesn't pull on the Settings module just for two
// regex helpers.

function parseTrackedCompanies(yaml: string): Array<{ name: string; method: 'api' | 'websearch' | 'unknown' }> {
  const section = yaml.split('tracked_companies:')[1] ?? ''
  return section
    .split('\n  - name: ')
    .slice(1)
    .map(block => {
      const name = block.split('\n')[0].trim().replace(/^["']|["']$/g, '')
      if (!name) return null
      const has_api = /\n\s+api:\s*\S/.test(block)
      const is_ws  = /scan_method:\s*websearch/.test(block)
      const method: 'api' | 'websearch' | 'unknown' =
        has_api ? 'api' : is_ws ? 'websearch' : 'unknown'
      return { name, method }
    })
    .filter((c): c is { name: string; method: 'api' | 'websearch' | 'unknown' } => c !== null)
}

function parseDreamCompanyNames(yaml: string): string[] {
  const m = yaml.match(/dream_companies:\s*\n([\s\S]*?)(?=\n  \w|\n\w|\n#|$)/)
  if (!m) return []
  return [...m[1].matchAll(/^\s*-\s+name:\s*["']?([^"'\n]+)["']?/gm)]
    .map(x => x[1].trim()).filter(Boolean)
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
      <Button
        tone="ghost"
        size="sm"
        onClick={() => setOpen(o => !o)}
        title="Model for the three pipeline buttons (Filter / Top Reports / All Reports)"
        aria-expanded={open}
        className={open ? 'bg-bg-elevated text-text-1' : undefined}
        trailing={
          <ChevronDown
            size={12}
            className={clsx('transition-transform duration-150', open && 'rotate-180')}
            aria-hidden
          />
        }
      >
        <span>Model</span>
        <span className="text-text-4" aria-hidden>·</span>
        <span className="text-text-1">{current.label}</span>
      </Button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[200px] p-1 rounded-lg border border-border-default bg-bg-base shadow-menu">
          {options.map(o => {
            const isSelected = o.id === pipeline
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => { setModel('pipeline', o.id); setOpen(false) }}
                className={clsx(
                  'w-full flex items-center gap-2 h-8 px-2.5 rounded text-body text-left transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  isSelected
                    ? 'bg-accent-soft text-accent-text'
                    : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
                )}
              >
                <span className="font-medium">{o.label}</span>
                <span className={clsx('text-label', isSelected ? 'text-accent-text/80' : 'text-text-4')}>{o.tag}</span>
                <span className="ml-auto inline-flex items-center w-3 shrink-0">
                  {isSelected && <Check size={12} aria-hidden />}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Shared exports — used by ScanView, ApplyingView, ActiveProcessesBar etc.
export {
  ActionButton, ActivityPanel, LoadingMessage, pickVisible, HoverDescriptionRow,
  ElapsedChip, formatElapsed, RunningInScanFooter, statusDone, HeroStatTile,
}

// Lightweight status check shared across ScoutingActionPanel's many useEffects.
function statusDone(rec: SpawnRecord | undefined): boolean {
  return rec?.status === 'done' || rec?.status === 'error' || rec?.status === 'killed'
}

// Footer shown on Scouting / Applying when at least one spawn is running
// somewhere. The live log lives on the Activity tab — this just points the
// user there.
function RunningInScanFooter() {
  const anyRunning = useSpawnsStore(isAnyRunning)
  const navigate = useNavStore(s => s.navigate)
  const runningCount = useSpawnsStore(s =>
    Object.values(s.spawns).filter(x => x.status === 'running').length
  )
  if (!anyRunning) return null
  return (
    <Button
      tone="tinted"
      size="sm"
      onClick={() => navigate('scan')}
      className="shrink-0 self-start mt-2"
      icon={<span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />}
      trailing={<ArrowRight size={12} aria-hidden />}
    >
      {`${runningCount} running · open Activity`}
    </Button>
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

// "Stop full scan" — lower-case the label's first letter unless it opens an
// acronym ("Stop API only").
function stopLabel(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label
}

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
      <Button
        tone="stop"
        size="lg"
        pill
        onClick={onClick}
        title="Click to stop"
        icon={<Square size={12} className="fill-current" aria-hidden />}
      >
        {`Stop ${stopLabel(label)}`}
      </Button>
    )
  }
  return (
    <Button
      tone={tone === 'primary' ? 'primary' : 'secondary'}
      size="lg"
      pill
      onClick={onClick}
      disabled={disabled}
      title={title}
      icon={<Icon size={15} aria-hidden />}
    >
      {label}
    </Button>
  )
}

// Dedicated CTA for the Add Listing modal. Tinted rather than secondary
// because it represents a CREATE action — the user is contributing new
// data, not running an automation. Hover-row description owns the tooltip.
function AddListingButton({ disabled, title }: { disabled?: boolean; title?: string }) {
  const show = useAddListingStore(s => s.show)
  return (
    <Button
      tone="tinted"
      size="lg"
      pill
      onClick={() => show()}
      disabled={disabled}
      title={title}
      icon={<Plus size={15} aria-hidden />}
    >
      Add listing
    </Button>
  )
}

// ─── Hover-description row ──────────────────────────────────────────────────
// A left-aligned button row with a single shared description slot under it.
// The slot has a fixed 20px height so it doesn't reflow when the description
// appears or changes — only the text swaps. mouseEnter sets the description;
// the row's mouseLeave clears it, so moving between buttons (across the gap
// or the divider) doesn't flicker.

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
    <div className="shrink-0 flex flex-col items-start min-w-0">
      <div
        className="flex items-center gap-2"
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
      <div className="h-5 mt-1.5 w-full" style={{ maxWidth: slotMaxWidth }}>
        <p
          className="text-label leading-5 text-text-3 truncate transition-opacity duration-150"
          style={{ opacity: desc ? 1 : 0 }}
        >
          {desc ?? ' '}
        </p>
      </div>
    </div>
  )
}

// ─── Activity Panel ─────────────────────────────────────────────────────────
// The matte terminal on the Activity tab. Flex-grows to fill the remaining
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
  // Idle state — no spawn picked yet — surfaces the starfield decoration
  // so the Activity surface reads as "deep space waiting for liftoff"
  // instead of an empty matte rectangle. The moment a run starts the
  // stars step aside (overflow-hidden keeps them from racing past the
  // streaming output text either way).
  const isIdle = !record

  return (
    <div className={clsx(
      'flex-1 min-h-0 relative rounded-lg overflow-hidden flex flex-col bg-night',
      isIdle && 'galaxy-stars',
    )}>
      {/* Header strip — no static "Terminal" label. When the running spawn is
          a Claude invocation the brand mark sits next to the label so the user
          knows what's at the wheel. The elapsed readout ticks every second
          while running so a "stuck" run can never look like "instant" success. */}
      <div className="shrink-0 h-8 px-4 flex items-center justify-between gap-3 border-b border-white/5 bg-night-2 text-label">
        <span className="text-white/60 inline-flex items-center gap-1.5 min-w-0 truncate">
          {record?.tool === 'claude' && <ClaudeLogo size={12} />}
          {record ? `${record.label} ${statusGlyph(record)}` : 'Idle'}
        </span>
        {record?.startedAt ? (
          <span className="inline-flex items-center gap-2 shrink-0 tabular-nums">
            <ElapsedChip record={record} />
            <span className="text-white/30" aria-hidden>·</span>
            <span className="text-white/40">
              {new Date(record.startedAt).toLocaleTimeString()}
            </span>
          </span>
        ) : null}
      </div>

      {/* Body — the log itself is the one mono surface. */}
      <div
        ref={logRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-[1.6] relative text-term-text"
        style={{ userSelect: 'text' }}
      >
        {!record && (
          <p className="font-sans text-label text-white/40 italic">Pick a scan or generate reports above.</p>
        )}

        {record && record.output.map((line, i) => (
          <div
            key={i}
            className={clsx(
              'whitespace-pre-wrap break-all',
              // Order matters — check most specific patterns first.
              line.startsWith('→ ')                       ? 'text-term-tool' :  // tool-use one-liner — muted theme tint
              line.startsWith('✓ Done')                   ? 'text-term-ok' :  // final success capstone
              /error/i.test(line)                         ? 'text-term-err' :
              /warn/i.test(line)                          ? 'text-term-warn' :
              /✓|^\s*✓|done|found|appended/i.test(line)   ? 'text-term-ok' :
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

        {record && !isRunning && record.status !== 'error' && (
          <div className="mt-2 text-white/45">
            {record.status === 'done'   && '— exited cleanly —'}
            {record.status === 'killed' && '— stopped —'}
          </div>
        )}

        {record && record.status === 'error' && <FailureCard record={record} />}
      </div>
    </div>
  )
}

// Shown at the foot of the log when a run ends in error. Replaces the bare
// "— exit 1 —" line with a diagnosed cause and a one-click recovery: re-login
// when the failure is an auth death (the cause behind 401'd scans), otherwise
// a verbatim Retry of the same command.
function FailureCard({ record }: { record: SpawnRecord }) {
  const retry = useSpawnsStore(s => s.retry)
  const relogin = useAppStore(s => s.relogin)
  const reloginInProgress = useAppStore(s => s.reloginInProgress)
  const authFail = isAuthFailure(record)
  const reason = diagnoseFailure(record)

  return (
    <div className="mt-3 font-sans rounded-lg border border-term-err/25 bg-term-err/[0.07] px-3.5 py-3 flex items-start gap-3">
      <AlertTriangle size={14} className="text-term-err shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-white/85">
          Run failed
          {record.exitCode != null && (
            <span className="text-white/40 font-normal"> · exit {record.exitCode}</span>
          )}
        </div>
        {reason && <div className="text-label text-white/55 mt-0.5">{reason}</div>}
      </div>
      {authFail ? (
        <button
          type="button"
          onClick={() => relogin()}
          disabled={reloginInProgress}
          className="btn btn-sm btn-primary shrink-0"
        >
          {reloginInProgress
            ? <Loader2 size={12} className="animate-spin" aria-hidden />
            : <span className="bg-white rounded-full p-0.5" aria-hidden><ClaudeLogo size={10} /></span>}
          {reloginInProgress ? 'Waiting…' : 'Sign in again'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => retry(record.id)}
          className="btn btn-sm shrink-0 bg-white/10 text-white hover:bg-white/15"
        >
          <RotateCw size={12} aria-hidden />
          Retry
        </button>
      )}
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
      className={clsx(
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
      <div className="flex flex-col items-center gap-4">
        {/* Orbital rings while waiting for first output — reads as
            "scanning through the universe of listings". */}
        <div className="relative inline-flex items-center justify-center">
          <OrbitalLoader size={64} strokeClass="text-accent-light" />
          {showClaudeMark && (
            <div className="absolute inset-0 flex items-center justify-center">
              <ClaudeLogo size={20} />
            </div>
          )}
        </div>
        <p
          key={idx}
          className="font-sans italic text-body text-center text-accent-light max-w-[42ch]"
          style={{
            animation: 'chip-appear 320ms ease both',
          }}
        >
          {LOADING_MESSAGES[idx]}
        </p>
      </div>
    </div>
  )
}
