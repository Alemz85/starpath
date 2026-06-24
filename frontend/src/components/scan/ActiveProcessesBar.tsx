'use client'

import { useEffect, useMemo } from 'react'
import { CheckCircle2, X as XIcon, AlertTriangle, RotateCw } from 'lucide-react'
import { OrbitalLoader } from '@/components/ui/orbital-loader'
import { cn } from '@/lib/utils'
import { useSpawnsStore, isAuthFailure, type SpawnRecord, type SpawnStatus } from '@/store/spawns'
import { useAppStore } from '@/store/app'
import { ClaudeLogo } from '@/components/shared/Logos'
import { ElapsedChip } from '@/components/command-center/CommandCenter'

interface Props {
  focusedId: string | null
  onFocus: (id: string) => void
}

/**
 * Compact list of every active spawn (running first, then a short tail of
 * recently finished). Clicking a row sets the focused spawn — its log shows
 * in the panel below. Auto-collapses to nothing when there's no spawn.
 */
export function ActiveProcessesBar({ focusedId, onFocus }: Props) {
  const spawns = useSpawnsStore(s => s.spawns)
  const ordered = useMemo(() => orderForBar(spawns), [spawns])

  // Auto-focus the most-recent running spawn on mount or when the focused one
  // disappears. Keeps the log relevant without forcing the user to click.
  useEffect(() => {
    if (ordered.length === 0) return
    const focusedStillExists = focusedId && ordered.some(r => r.id === focusedId)
    if (focusedStillExists) return
    const firstRunning = ordered.find(r => r.status === 'running') ?? ordered[0]
    if (firstRunning) onFocus(firstRunning.id)
  }, [ordered, focusedId, onFocus])

  // Always rendered — when there's nothing running we show a neutral
  // placeholder. Limits visible rows to ~4 then scrolls inside.
  return (
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel">
      <div className="flex items-center justify-between px-4 h-8 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase tracking-wider">
          Active processes
          <span className="ml-1.5 font-mono text-text-3">{ordered.length}</span>
        </span>
      </div>
      {ordered.length === 0 ? (
        <div className="px-4 py-4 text-[11.5px] text-text-4 italic">
          Nothing running. Anything you fire from Scouting or Applying shows up here.
        </div>
      ) : (
        // ~32px row * 4 = 128px + p-1.5 (12px) = 140px max before scrolling
        <div className="max-h-[140px] overflow-y-auto p-1.5 space-y-0.5">
          {ordered.map(rec => (
            <ProcessRow
              key={rec.id}
              rec={rec}
              focused={rec.id === focusedId}
              onClick={() => onFocus(rec.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProcessRow({
  rec, focused, onClick,
}: {
  rec: SpawnRecord
  focused: boolean
  onClick: () => void
}) {
  const startedHHMM = new Date(rec.startedAt).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  })
  const isError = rec.status === 'error'
  // The row was a single <button>; error rows now carry their own action
  // button, so the container is a div with the label region as the button to
  // avoid nesting interactive elements.
  return (
    <div
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors text-[12px]',
        focused ? 'bg-accent/12' : 'hover:bg-bg-elevated',
      )}
    >
      <button
        onClick={onClick}
        className={cn(
          'flex items-center gap-2.5 flex-1 min-w-0 text-left',
          focused ? 'text-text-1' : 'text-text-2',
        )}
      >
        <StatusIcon status={rec.status} />
        <span className="truncate flex-1">{rec.label}</span>
      </button>
      {isError ? (
        <RowRetry rec={rec} />
      ) : (
        <>
          <span className="shrink-0 text-[10.5px] text-text-4 font-mono tabular-nums">
            started {startedHHMM}
          </span>
          <span className="shrink-0 inline-flex items-center w-px h-3 bg-border-default" aria-hidden />
          <ElapsedChipInline record={rec} />
        </>
      )}
    </div>
  )
}

// Inline recovery on a failed row — re-login when the failure is an auth
// death, otherwise a verbatim retry. Mirrors the activity panel's FailureCard
// so the user can recover from the list without opening the log.
function RowRetry({ rec }: { rec: SpawnRecord }) {
  const retry = useSpawnsStore(s => s.retry)
  const relogin = useAppStore(s => s.relogin)
  const reloginInProgress = useAppStore(s => s.reloginInProgress)

  if (isAuthFailure(rec)) {
    return (
      <button
        onClick={() => relogin()}
        disabled={reloginInProgress}
        className="shrink-0 inline-flex items-center gap-1.5 pl-1 pr-2.5 h-6 rounded-pill bg-accent hover:bg-accent-hover text-white text-[10.5px] font-medium transition-colors disabled:opacity-70"
      >
        <span className="bg-white rounded-full p-0.5"><ClaudeLogo size={9} /></span>
        {reloginInProgress ? 'Waiting…' : 'Sign in'}
      </button>
    )
  }
  return (
    <button
      onClick={() => retry(rec.id)}
      className="shrink-0 inline-flex items-center gap-1 px-2.5 h-6 rounded-pill bg-bg-elevated hover:bg-accent/10 text-text-3 hover:text-accent text-[10.5px] font-medium transition-colors"
    >
      <RotateCw size={10} />
      Retry
    </button>
  )
}

function StatusIcon({ status }: { status: SpawnStatus }) {
  if (status === 'running') return <OrbitalLoader size={14} rings={2} strokeClass="text-accent" className="shrink-0" />
  if (status === 'done')    return <CheckCircle2 size={12} className="shrink-0 text-success" />
  if (status === 'error')   return <AlertTriangle size={12} className="shrink-0 text-danger" />
  return <XIcon size={12} className="shrink-0 text-text-4" />  // killed
}

// Wrapper that styles ElapsedChip for the in-row context (smaller, muted).
function ElapsedChipInline({ record }: { record: SpawnRecord }) {
  return (
    <span className="shrink-0 text-[10.5px]">
      <ElapsedChip record={record} />
    </span>
  )
}

function orderForBar(spawns: Record<string, SpawnRecord>): SpawnRecord[] {
  const all = Object.values(spawns)
  const running = all.filter(r => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const finished = all
    .filter(r => r.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
    .slice(0, 4)  // keep a short tail of recently finished
  return [...running, ...finished]
}
