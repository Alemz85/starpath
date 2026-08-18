'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, isAnyRunning, claudeArgs, isAuthFailure, diagnoseFailure, type SpawnRecord } from '@/store/spawns'
import { claudeEvalArgs, filterAllPrompt, refreshCvSummary } from '@/lib/evalSpawn'
import { useScanFilter } from '@/store/scanFilter'
import { useNavStore } from '@/store/nav'
import { ipc } from '@/lib/ipc'
import { ClaudeLogo } from '@/components/shared/Logos'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { OrbitalLoader } from '@/components/ui/orbital-loader'
import {
  Play, Zap, Filter, Square, ArrowRight,
  ChevronDown, ChevronRight, Check, Plus,
  AlertTriangle, RotateCw, Loader2,
} from 'lucide-react'
import { useAddListingStore } from '@/store/addListing'
import { DailyBriefPanel } from '@/components/command-center/DailyBriefPanel'
import { cn, formatRelative } from '@/lib/utils'

// StatTile — single column inside a hero stat strip. No card frame, no
// border on its own; relies on a sibling `divide-x` parent to provide
// the hairline rhythm. Optional `accent` color highlights the most
// actionable figure (pending listings, interviewing) and a tiny
// pulsing dot draws the eye to non-zero values.
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
    <div className="px-5 first:pl-0 last:pr-0">
      <div className="relative inline-block">
        <span className={cn(
          'text-[26px] font-mono font-semibold tabular-nums leading-none',
          accent ?? 'text-text-1',
        )}>
          {value}
        </span>
        {highlightDot && (
          <span
            className={cn('absolute -top-0.5 -right-2.5 w-1.5 h-1.5 rounded-full animate-pulse', highlightDot)}
            aria-hidden
          />
        )}
      </div>
      <div className="text-label text-text-2 font-medium mt-2">{label}</div>
      {sub && <div className="text-micro text-text-4 mt-0.5 normal-case">{sub}</div>}
    </div>
  )
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
// jobspy-scored audit: nothing ≥7.5 overall.)
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
  const repoPath = useAppStore(s => s.repoPath)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const pipeline = useDataStore(s => s.pipeline)
  const scansThisMonth = useDataStore(s => s.scansThisMonth)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)

  const totalEvaluated = scoreHistory.length
  const distinctCompanies = useMemo(
    () => new Set(scoreHistory.map(e => e.company).filter(Boolean)).size,
    [scoreHistory],
  )
  const active = applications.filter(a =>
    ['Applied', 'Responded', 'Interview', 'Offer'].includes(a.status)
  ).length
  const pendingListings = pipeline.length
  const lastScanDate = scoreHistory.length
    ? [...scoreHistory].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? null
    : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Scouting</h1>
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-8 gap-6 overflow-hidden min-h-0">
        {/* Editorial hero — display title + 4-column stat strip below.
            The strip uses hairline dividers (no card frames) so it
            doesn't read as a templated SaaS dashboard, but every key
            number is large and instantly scannable. The Pending column
            gets accent emphasis and a pulsing dot when > 0 so the
            "you have stuff to filter" signal can't be missed. */}
        <div className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos">
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            <h1 className="text-display-2 text-text-1">Scouting</h1>
            {loaded && lastScanDate && (
              <span className="text-label text-text-3">
                Last scan{' '}
                <span className="text-text-2 font-medium">{formatRelative(lastScanDate)}</span>
              </span>
            )}
          </div>

          {loaded ? (
            <div className="grid grid-cols-4 divide-x divide-border-default/50">
              <HeroStatTile
                value={totalEvaluated}
                label="Evaluated"
                sub={`${distinctCompanies} ${distinctCompanies === 1 ? 'company' : 'companies'}`}
              />
              <HeroStatTile
                value={active}
                label="Active"
                sub={active === 1 ? 'application' : 'applications'}
              />
              <HeroStatTile
                value={pendingListings}
                label="Pending"
                sub="ready to filter"
                accent={pendingListings > 0 ? 'text-accent' : undefined}
                highlightDot={pendingListings > 0 ? 'bg-accent' : undefined}
              />
              <HeroStatTile
                value={scansThisMonth}
                label="Scans"
                sub="this month"
              />
            </div>
          ) : (
            <div className="h-14 shimmer rounded-lg" />
          )}
        </div>

        {/* Scouting cockpit (flex-grows to fill remaining height).
            Recent top picks was removed from this view — the Database
            tab is the canonical "browse what's been scored" surface, and
            the Filtered Scan section below is now the visual anchor for
            the cockpit's bottom half. */}
        <ScoutingActionPanel repoPath={repoPath} onPipelineDone={refresh} />
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
  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)
  const pipelineModel = useAppStore(s => s.models.pipeline)
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
    start(FULL_SCAN_ID, 'Full Scan', 'claude', claudeArgs('/career-ops scan', 'sonnet'))
    startJobspyIfIdle()
  }
  const handleApiScan = () => {
    if (apiScan?.status === 'running') { kill(API_SCAN_ID); return }
    if (apiScan) clear(API_SCAN_ID)
    start(API_SCAN_ID, 'API Scan', 'node', ['scripts/scan.mjs'])
    startJobspyIfIdle()
  }
  const handleFilter = () => {
    if (pipelineFilter?.status === 'running') { kill(PIPELINE_FILTER_ID); return }
    if (pipelineFilter) clear(PIPELINE_FILTER_ID)
    // Fire-and-forget CV-summary refresh — finishes in ms while the Claude
    // CLI boots; the bundle falls back to user/cv.md if the artifact is missing.
    void refreshCvSummary()
    start(PIPELINE_FILTER_ID, 'Filter to Database', 'claude', claudeEvalArgs(filterAllPrompt(), pipelineModel))
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <HoverDescriptionRow
        items={[
          {
            key: 'full',
            description: 'Playwright + ATS APIs + WebSearch + JobSpy aggregators (Indeed/Google) — uses Claude (token cost). JobSpy runs in parallel as a zero-token sibling.',
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
            description: 'Direct ATS API calls + JobSpy aggregators (Indeed/Google) — zero token cost. JobSpy runs in parallel.',
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
            description: 'Discard off-archetype / wrong-seniority / geo-locked listings, then score the survivors (~20–30%) into the Database. No prose reports.',
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
            key: 'sep2',
            node: <div className="w-px h-6 bg-border-default" aria-hidden />,
          },
          {
            key: 'add-listing',
            description: 'Paste a job posting URL the scanner didn\'t find. Choose to score it into the Database now (uses tokens, no prose report) or just queue it for the next filter pass.',
            node: <AddListingButton disabled={!repoPath} />,
          },
          {
            key: 'sep3',
            node: <div className="w-px h-6 bg-border-default" aria-hidden />,
          },
          {
            key: 'model',
            description: 'Model used for the Filter to Database run. Scan is always Sonnet. Report generation has its own model — set in Settings → Models, used by the Reports tab\'s Generate Top 5 button and the per-listing Generate Report action.',
            node: <ModelChip />,
          },
        ]}
      />

      {/* Daily brief — the backend digest's "do this first" pick + the top
          few prioritized items per section, computed by scripts/daily-brief.mjs
          (--json) and rendered natively. Occupies the cockpit's middle band;
          renders nothing at all when the brief has nothing to say, so the
          Filtered Scan section below keeps its bottom anchor either way. */}
      <DailyBriefPanel />

      <FilteredScanRow />

      {/* Activity is now exclusively on the Scan tab. When something is
          running anywhere, surface a quiet pointer so the user knows where
          to go for the live log. */}
      <RunningInScanFooter />
    </div>
  )
}

// ─── Filtered Scan ──────────────────────────────────────────────────────────
//
// Always-visible chip strip listing every tracked_company in portals.yml.
// Pre-selects the user's dream_companies (from profile.yml) on first
// mount of the session, then leaves the selection alone. The Run button
// spawns Claude with `/career-ops scan` plus an explicit allowlist of
// company names — Claude reads the regular scan mode and constrains to
// those companies (covers both API-method and websearch-method ones).

function FilteredScanRow() {
  const repoPath = useAppStore(s => s.repoPath)
  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)
  const filteredScan = spawns[FILTERED_SCAN_ID]
  const selected     = useScanFilter(s => s.selected)
  const toggle       = useScanFilter(s => s.toggle)
  const applyDefaults = useScanFilter(s => s.applyDreamDefaults)
  const clearAll     = useScanFilter(s => s.clear)

  const [companies, setCompanies] = useState<Array<{ name: string; method: 'api' | 'websearch' | 'unknown' }>>([])
  const [dreamCompanies, setDreamCompanies] = useState<string[]>([])
  // Chip canvas defaults to collapsed — the header strip's selection
  // summary + Run button cover the common case (run a quick filtered
  // scan on the existing dream selection). Editing the company set is
  // the less-common action and lives behind a one-click expand.
  const [expanded, setExpanded] = useState(false)

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

  const handleRun = () => {
    if (filteredScan?.status === 'running') { kill(FILTERED_SCAN_ID); return }
    if (filteredScan) clear(FILTERED_SCAN_ID)
    if (selected.size === 0) return
    const list = Array.from(selected).join(', ')
    const slash =
      `/career-ops scan — FILTERED RUN. Only scan these tracked_companies from user/portals.yml: ${list}. ` +
      `Skip every other tracked_company. Skip the search_queries section entirely. ` +
      `For each named company, follow its scan_method (api → direct API call; websearch → WebSearch with the company's scan_query). ` +
      `Append new URLs to data/pipeline.md per the standard scan mode; respect data/scan-history.tsv for dedup.`
    start(FILTERED_SCAN_ID, `Filtered Scan (${selected.size})`, 'claude', claudeArgs(slash, 'sonnet'))
  }

  const handleResetDefaults = () => applyDefaults(dreamCompanies, true)

  if (companies.length === 0) {
    // No tracked_companies in portals.yml yet — onboarding wizard probably
    // hasn't completed. Hide the row entirely instead of showing an empty
    // strip; user gets the chips back as soon as they configure portals.
    return null
  }

  const running = filteredScan?.status === 'running'

  // Dream companies first (alphabetical within group), then everyone else
  // (alphabetical). Sorting at render time avoids reflow when the user
  // toggles selection — only the sort key (dream / non-dream) is fixed
  // while the user works through the list.
  const sortedCompanies = (() => {
    const dreamSet = new Set(dreamCompanies)
    return [...companies].sort((a, b) => {
      const aDream = dreamSet.has(a.name)
      const bDream = dreamSet.has(b.name)
      if (aDream !== bDream) return aDream ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  })()

  return (
    // mt-auto pushes the section to the bottom of the cockpit's flex
    // column, leaving the action buttons above and the section here as
    // the visual anchor of the empty space below them.
    <div className="mt-auto pt-6">
      <div className="rounded-xl border border-border-default overflow-hidden bg-bg-panel/80">
        {/* Header strip — icon-mark left, status middle, actions right.
            Clickable as a whole to toggle the chip canvas; the inner
            action buttons stop propagation so they don't double-toggle.
            Soft galaxy gradient so it reads as a distinct surface from
            the action-button row above. */}
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          className={cn(
            'w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors',
            expanded ? 'border-b border-border-default/60' : 'border-b border-transparent',
            'hover:bg-accent/[0.02]',
          )}
          style={{
            background: 'linear-gradient(135deg, rgba(124,92,255,0.10) 0%, rgba(124,92,255,0.02) 100%)',
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center shrink-0">
              <Filter size={14} className="text-accent" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-text-1 leading-tight flex items-center gap-1.5">
                Filtered Scan
                <span className="text-text-4">
                  {expanded
                    ? <ChevronDown size={12} />
                    : <ChevronRight size={12} />}
                </span>
              </div>
              <div className="text-[11.5px] text-text-3 truncate mt-0.5">
                {selected.size === 0
                  ? 'Pick companies to scan only those — others stay untouched.'
                  : (
                    <>
                      <span className="text-text-1 font-medium">{selected.size}</span>
                      <span> of {companies.length} selected</span>
                      {dreamCompanies.length > 0 && (
                        <span className="text-text-4"> · {selected.size === dreamCompanies.length && [...selected].every(n => dreamCompanies.includes(n)) ? 'matches your dream list' : `${[...selected].filter(n => dreamCompanies.includes(n)).length} dream`}</span>
                      )}
                    </>
                  )}
              </div>
            </div>
          </div>
          <div
            className="flex items-center gap-1.5 shrink-0"
            // Inner action buttons own their own clicks; stop propagation
            // so clicking Clear / Reset / Run doesn't also collapse or
            // expand the chip canvas.
            onClick={e => e.stopPropagation()}
          >
            {selected.size > 0 && (
              <button
                onClick={clearAll}
                className="text-[11.5px] text-text-4 hover:text-text-2 px-2 py-1.5 rounded transition-colors"
              >
                Clear
              </button>
            )}
            {dreamCompanies.length > 0 && (
              <button
                onClick={handleResetDefaults}
                title="Reset selection to your dream_companies list from profile.yml"
                className="text-[11.5px] text-text-4 hover:text-text-2 px-2 py-1.5 rounded transition-colors"
              >
                Reset to dreams
              </button>
            )}
            <button
              onClick={handleRun}
              disabled={!repoPath || (!running && selected.size === 0)}
              title={running
                ? 'Stop the run (live log on the Activity tab)'
                : selected.size === 0
                  ? 'Select at least one company first'
                  : `Spawn Claude to scan only the ${selected.size} selected ${selected.size === 1 ? 'company' : 'companies'}. Costs Claude tokens.`}
              className={cn(
                'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12.5px] font-medium border transition-colors shadow-sm',
                running
                  ? 'bg-danger/15 border-danger/40 text-danger hover:bg-danger/20'
                  : 'bg-accent border-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {running ? <Square size={12} className="fill-current" /> : <Filter size={12} />}
              {running ? 'Stop' : 'Run filtered scan'}
            </button>
          </div>
        </button>

        {/* Chip canvas — collapsed by default, expands inline on click. */}
        {expanded && (
        <div
          className="flex flex-wrap gap-2 max-h-[240px] overflow-y-auto px-4 py-4"
          style={{ scrollbarWidth: 'thin' }}
        >
          {sortedCompanies.map(c => {
            const isSelected = selected.has(c.name)
            const isDream = dreamCompanies.includes(c.name)
            return (
              <button
                key={c.name}
                onClick={() => toggle(c.name)}
                title={`${c.name} · ${c.method.toUpperCase()}${isDream ? ' · dream company' : ''}`}
                className={cn(
                  'inline-flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-md text-[12px] border transition-all',
                  isSelected
                    ? 'bg-accent/20 border-accent/50 text-accent-text shadow-sm'
                    : 'bg-bg-elevated/60 border-border-default text-text-2 hover:text-text-1 hover:border-border-strong hover:bg-bg-elevated',
                )}
              >
                {isDream && (
                  <span
                    title="Dream company"
                    className={cn(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      isSelected ? 'bg-tier-1' : 'bg-tier-1/70',
                    )}
                    aria-hidden
                  />
                )}
                <CompanyLogo company={c.name} size={14} className="shrink-0" />
                <span className="truncate max-w-[160px] font-medium">{c.name}</span>
              </button>
            )
          })}
        </div>
        )}
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
    { id: 'opus',   label: 'Opus 5',   tag: 'thorough' },
    { id: 'sonnet', label: 'Sonnet 5', tag: 'cheaper · fast' },
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
        <span className="text-text-4 text-[12px]">Model:</span>
        <span className="font-semibold">{current.label}</span>
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[180px] rounded-lg border border-border-default bg-bg-base shadow-card overflow-hidden">
          {options.map(o => {
            const isSelected = o.id === pipeline
            return (
              <button
                key={o.id}
                onClick={() => { setModel('pipeline', o.id); setOpen(false) }}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-[12px] text-left transition-colors',
                  isSelected
                    ? 'bg-accent/20 text-accent-text'
                    : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
                )}
              >
                <span className="font-medium">{o.label}</span>
                <span className={cn('text-[10.5px]', isSelected ? 'text-accent-text/80' : 'text-text-4')}>{o.tag}</span>
                <span className="ml-auto inline-flex items-center w-3 shrink-0">
                  {isSelected && <Check size={11} />}
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

// Dedicated CTA for the Add Listing modal. Visually distinct from the
// scan/filter buttons (accent-soft tint, plus glyph) because it
// represents a CREATE action — the user is contributing new data, not
// running an automation. Hover-row description owns the tooltip.
function AddListingButton({ disabled }: { disabled?: boolean }) {
  const show = useAddListingStore(s => s.show)
  return (
    <button
      onClick={() => show()}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-2 rounded-pill px-4 py-2 text-[13.5px] font-medium border transition-all',
        'border-accent/40 bg-accent/10 text-accent-text hover:bg-accent/15 hover:border-accent/55',
        'disabled:opacity-40 disabled:cursor-not-allowed',
      )}
    >
      <Plus size={14} />
      Add Listing
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
  // Idle state — no spawn picked yet — surfaces the starfield decoration
  // so the Activity surface reads as "deep space waiting for liftoff"
  // instead of an empty matte rectangle. The moment a run starts the
  // stars step aside (overflow-hidden keeps them from racing past the
  // streaming output text either way).
  const isIdle = !record

  return (
    <div className={cn(
      'flex-1 min-h-0 relative rounded-xl overflow-hidden flex flex-col bg-galaxy-matte shadow-card',
      isIdle && 'galaxy-stars',
    )}>
      {/* Header strip — no static "Terminal" label. When the running spawn is
          a Claude invocation the brand mark sits next to the label so the user
          knows what's at the wheel. The elapsed chip ticks every second while
          running so a "stuck" run can never look like "instant" success. */}
      <div className="shrink-0 h-8 px-5 flex items-center justify-between border-b border-white/5 text-[10px] font-mono uppercase tracking-wider bg-galaxy-matte-2">
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
    <div className="mt-3 rounded-lg border border-[#FF8FA3]/25 bg-[#FF8FA3]/[0.07] px-3.5 py-3 flex items-start gap-3">
      <AlertTriangle size={14} className="text-[#FF8FA3] shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-white/85 font-medium">
          Run failed
          {record.exitCode != null && (
            <span className="text-white/40 font-normal"> · exit {record.exitCode}</span>
          )}
        </div>
        {reason && <div className="text-[11.5px] text-white/55 mt-0.5 leading-snug">{reason}</div>}
      </div>
      {authFail ? (
        <button
          onClick={() => relogin()}
          disabled={reloginInProgress}
          className="shrink-0 inline-flex items-center gap-1.5 pl-1.5 pr-3 h-7 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[11.5px] font-medium transition-all disabled:opacity-70 disabled:active:scale-100"
        >
          {reloginInProgress
            ? <Loader2 size={12} className="animate-spin" />
            : <span className="bg-white rounded-full p-0.5"><ClaudeLogo size={11} /></span>}
          {reloginInProgress ? 'Waiting…' : 'Sign in again'}
        </button>
      ) : (
        <button
          onClick={() => retry(record.id)}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 h-7 bg-white/8 hover:bg-white/14 text-white/80 hover:text-white rounded-pill text-[11.5px] font-medium transition-colors"
        >
          <RotateCw size={12} />
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
      <div className="flex flex-col items-center gap-4">
        {/* Orbital rings while waiting for first output. The Claude
            mark used to pulse here, but a tri-ring orbit reads as
            "we're scanning through the universe of listings" — a
            domain-truer signal than a generic logo bounce. */}
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
          className="italic text-[12.5px] text-center text-accent-light max-w-[42ch]"
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
