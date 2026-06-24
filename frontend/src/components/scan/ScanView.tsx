'use client'

import { useEffect, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useSpawnsStore, isAnyRunning } from '@/store/spawns'
import { ActivityPanel } from '@/components/command-center/CommandCenter'
import { ActiveProcessesBar } from './ActiveProcessesBar'
import { Activity } from 'lucide-react'

/**
 * The Scan tab is the unified activity hub. It used to host the same scan
 * action buttons as Scouting; those moved to Scouting (the cockpit) and this
 * tab is now purely about watching things run:
 *   - top: ActiveProcessesBar — every running/recent spawn across the app
 *   - bottom: ActivityPanel for the focused spawn's live log
 *
 * `focusedSpawnId` is local state. Default-focus follows the most recent
 * running spawn; switching is one click.
 */
export function ScanView() {
  const refresh = useDataStore(s => s.refresh)
  const spawns = useSpawnsStore(s => s.spawns)
  const acknowledgeFailures = useSpawnsStore(s => s.acknowledgeFailures)
  const anyRunning = useSpawnsStore(isAnyRunning)
  const runningCount = Object.values(spawns).filter(s => s.status === 'running').length

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focused = focusedId ? spawns[focusedId] : undefined

  // This tab IS where failures are reviewed — clear the sidebar badge while
  // it's open (on mount and whenever a new failure lands while watching).
  const failureSignature = Object.values(spawns)
    .filter(s => s.status === 'error')
    .map(s => s.id)
    .join('|')
  useEffect(() => {
    acknowledgeFailures()
  }, [acknowledgeFailures, failureSignature])

  // Whenever any spawn finishes, give the data store a chance to resync —
  // otherwise newly-generated reports / scouting rows wouldn't appear in
  // the other tabs without a manual refresh.
  useEffect(() => {
    const finishedIds = Object.values(spawns)
      .filter(s => s.status === 'done' || s.status === 'error' || s.status === 'killed')
      .map(s => `${s.id}:${s.endedAt ?? s.startedAt}`)
      .join('|')
    if (finishedIds) refresh()
    // We deliberately don't include `refresh` itself — it's stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.values(spawns)
    .filter(s => s.status === 'done' || s.status === 'error' || s.status === 'killed')
    .map(s => `${s.id}:${s.endedAt}`)
    .join('|')])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium flex items-center gap-2">
          <Activity size={14} className="text-accent" />
          Activity
        </h1>
        {anyRunning && (
          <span className="text-micro font-mono px-2 py-0.5 rounded-pill border text-accent border-accent/40 bg-accent/10">
            {runningCount} running
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col px-8 pt-6 pb-8 gap-4 overflow-hidden min-h-0">
        <ActiveProcessesBar
          focusedId={focusedId}
          onFocus={setFocusedId}
        />
        <ActivityPanel record={focused} />
      </div>
    </div>
  )
}
