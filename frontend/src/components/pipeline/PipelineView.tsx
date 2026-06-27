'use client'

import { useEffect, useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, claudeArgs } from '@/store/spawns'
import { useAppStore } from '@/store/app'
import { PipelineInbox } from './PipelineInbox'
import { PipelineBoard } from './PipelineBoard'
import { ClosedApplicationsPanel } from '@/components/applying/ClosedApplicationsPanel'
import { evaluateInboxCommand, inboxSpawnId } from '@/lib/pipelineInbox'
import { STATUS_GROUPS, groupByStatus } from '@/lib/applyingBoard'
import type { AppStatus, ApplicationEntry } from '@/types'

// The Pipeline view is the workflow lens: a triage Inbox of pending URLs on the
// left and the application-status board on the right. It's the read-and-move
// surface — distinct from the Applying cockpit (which owns the heavy per-card
// CV/draft/prep spawns). Both halves write status through the canonical
// applications.md contract via the data store; the inbox triages a raw URL by
// spawning the scouting pipeline on it.
export function PipelineView() {
  const models = useAppStore(s => s.models)
  const applications = useDataStore(s => s.applications)
  const pipeline = useDataStore(s => s.pipeline)
  const scouting = useDataStore(s => s.scouting)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const setApplicationStatus = useDataStore(s => s.setApplicationStatus)

  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)

  // When an inbox evaluation finishes, the scouting pipeline has written new
  // rows to disk — pull them in so the URL drops out of the inbox and (if it
  // got promoted) shows up on the board without a manual refresh.
  const finishedInboxIds = useMemo(() => (
    Object.entries(spawns)
      .filter(([id, r]) =>
        id.startsWith('inbox-eval-') &&
        (r.status === 'done' || r.status === 'error' || r.status === 'killed'))
      .map(([id]) => id)
      .join(',')
  ), [spawns])

  useEffect(() => {
    if (finishedInboxIds) void refresh()
  }, [finishedInboxIds, refresh])

  // Closed-out rows (Rejected / Discarded) for the collapsible strip — same
  // treatment the Applying board gives them. Reuses the shared panel.
  const closedApps = useMemo(
    () => applications.filter(a => a.status === 'Rejected' || a.status === 'Discarded'),
    [applications],
  )

  // Board-level total for the header read-out.
  const activeCount = useMemo(() => {
    const grouped = groupByStatus(applications)
    return STATUS_GROUPS.reduce((n, s) => n + (grouped[s]?.length ?? 0), 0)
  }, [applications])

  const handleEvaluate = (url: string) => {
    const id = inboxSpawnId(url)
    if (spawns[id]?.status === 'running') { kill(id); return }
    if (spawns[id]) clear(id)
    start(id, `Evaluate: ${url}`, 'claude', claudeArgs(evaluateInboxCommand(url), models.draftApp))
  }

  const handleAdvance = (app: ApplicationEntry, to: AppStatus) => {
    void setApplicationStatus(app.company, app.role, to)
  }

  const handleRestore = (app: ApplicationEntry) => {
    void setApplicationStatus(app.company, app.role, 'Evaluated')
  }

  if (!loaded) {
    return <div className="grid h-full place-items-center text-[12px] text-text-4">Loading pipeline…</div>
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center gap-2.5 shrink-0">
        <GitBranch size={16} className="text-accent" />
        <h1 className="text-[15px] font-semibold text-text-1">Pipeline</h1>
        <span className="text-[11.5px] text-text-3">Triage the inbox · track every application</span>
        <span className="flex-1" />
        {/* The pending count is the one act-now signal here — it gets the
            accent treatment when there's something to triage (mirroring the
            sidebar's pending-accent convention), and falls back to muted when
            the inbox is clear so the read-out doesn't cry wolf at zero. */}
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          <span className={cn(pipeline.length > 0 && 'text-accent')}>{pipeline.length} pending</span>
          {' · '}{activeCount} active
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[20rem_1fr] gap-3">
        <PipelineInbox
          pending={pipeline}
          applications={applications}
          scouting={scouting}
          spawns={spawns}
          onEvaluate={handleEvaluate}
        />

        <div className="flex min-h-0 flex-col gap-3">
          <PipelineBoard applications={applications} onAdvance={handleAdvance} />
          <ClosedApplicationsPanel apps={closedApps} onRestore={handleRestore} />
        </div>
      </div>
    </div>
  )
}
