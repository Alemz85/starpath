'use client'

import { useEffect, useMemo } from 'react'
import { Loader2, CheckCircle2, X as XIcon, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSpawnsStore, type SpawnRecord, type SpawnStatus } from '@/store/spawns'
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

  if (ordered.length === 0) return null

  return (
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel">
      <div className="flex items-center justify-between px-3 h-8 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase tracking-wider">
          Active processes
          <span className="ml-1.5 font-mono text-text-3">{ordered.length}</span>
        </span>
      </div>
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
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors text-[12px]',
        focused
          ? 'bg-accent/12 text-text-1'
          : 'hover:bg-bg-elevated text-text-2',
      )}
    >
      <StatusIcon status={rec.status} />
      <span className="truncate flex-1">{rec.label}</span>
      <ElapsedChipInline record={rec} />
    </button>
  )
}

function StatusIcon({ status }: { status: SpawnStatus }) {
  if (status === 'running') return <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
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
