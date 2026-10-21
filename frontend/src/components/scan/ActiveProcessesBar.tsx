'use client'

import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Check, X as XIcon, AlertTriangle, RotateCw, Trash2, Zap } from 'lucide-react'
import { OrbitalLoader } from '@/components/ui/orbital-loader'
import { Button, Panel } from '@/components/ui'
import { useSpawnsStore, isAuthFailure, type SpawnRecord, type SpawnStatus } from '@/store/spawns'
import { useAppStore } from '@/store/app'
import { ClaudeLogo } from '@/components/shared/Logos'
import { formatElapsed } from '@/components/command-center/CommandCenter'

// Class strings are combined with `clsx`, not `cn` — tailwind-merge reads
// `text-body` / `text-label` as colours and would drop them.

interface Props {
  focusedId: string | null
  onFocus: (id: string) => void
}

/**
 * Compact list of every active spawn (running first, then a short tail of
 * recently finished). Clicking a row sets the focused spawn — its log shows
 * in the panel below. Shows a placeholder when there's no spawn.
 *
 * Each row carries a live "last action" read-out — the most recent humanized
 * output line — so when several spawns run at once (Full Scan + JobSpy +
 * Filter) the user can see what every background process is doing at a
 * glance, without clicking each one to read its focused log. Running rows
 * can be stopped and finished rows dismissed individually, or all finished
 * rows at once (Clear finished), wired to the store's `kill` / `clear`
 * actions. Failed rows swap the timing readout for an inline retry / sign-in
 * so the user can recover from the list without opening the log.
 */
export function ActiveProcessesBar({ focusedId, onFocus }: Props) {
  const spawns = useSpawnsStore(s => s.spawns)
  const clear  = useSpawnsStore(s => s.clear)
  const kill   = useSpawnsStore(s => s.kill)
  const ordered = useMemo(() => orderForBar(spawns), [spawns])

  // Finished rows that are eligible for dismissal. A "Clear finished" header
  // action only appears when at least one exists. We clear from the full
  // spawn set (not just the visible tail) so the action also purges the
  // older finished records orderForBar trims away.
  const finishedIds = useMemo(
    () => Object.values(spawns).filter(r => !isRunning(r.status)).map(r => r.id),
    [spawns],
  )

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
  // placeholder. Limits visible rows to ~4.5 then scrolls inside.
  return (
    <Panel
      flush
      className="shrink-0"
      title="Active processes"
      meta={ordered.length}
      action={finishedIds.length > 0 ? (
        <Button
          tone="ghost"
          size="xs"
          onClick={() => finishedIds.forEach(clear)}
          title="Dismiss every finished, errored, or stopped process row"
          aria-label={`Clear ${finishedIds.length} finished process${finishedIds.length === 1 ? '' : 'es'}`}
          icon={<Trash2 size={12} aria-hidden="true" />}
        >
          Clear finished
        </Button>
      ) : undefined}
    >
      {/* Spoken count for screen readers */}
      <span className="sr-only">
        {ordered.length === 0
          ? 'No active processes'
          : `${ordered.length} process${ordered.length === 1 ? '' : 'es'}`}
      </span>
      {ordered.length === 0 ? (
        <EmptyState />
      ) : (
        // 40px rows — cap the visible window near 4.5 rows so a longer tail
        // hints that it scrolls. role="log" tells screen readers this region
        // accumulates status messages over time.
        <div
          role="log"
          aria-label="Process list"
          aria-live="polite"
          className="max-h-[188px] overflow-y-auto -mt-1.5 px-1.5 pb-1.5"
        >
          {ordered.map(rec => (
            <ProcessRow
              key={rec.id}
              rec={rec}
              focused={rec.id === focusedId}
              onClick={() => onFocus(rec.id)}
              onStop={isRunning(rec.status) ? () => kill(rec.id) : undefined}
              onClear={isRunning(rec.status) ? undefined : () => clear(rec.id)}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

// Empty state — shown when no spawns exist yet. Points at where runs start
// (scan buttons live in the Scouting tab).
function EmptyState() {
  return (
    <div
      className="px-4 pt-2 pb-5 flex flex-col items-center gap-2 text-center"
      aria-label="No active processes. Start a scan or generate reports from the Scouting tab."
    >
      <Zap size={20} className="text-text-4" aria-hidden="true" />
      <div>
        <p className="text-label font-medium text-text-3">No processes running</p>
        <p className="text-label text-text-3 max-w-[280px]">
          Scans and report runs from Scouting or Applying show up here.
        </p>
      </div>
    </div>
  )
}

function ProcessRow({
  rec, focused, onClick, onStop, onClear,
}: {
  rec: SpawnRecord
  focused: boolean
  onClick: () => void
  /** Present only for running rows — kills the process (leaves a record). */
  onStop?: () => void
  /** Present only for finished rows — running spawns must be killed (which
   *  leaves a record), not cleared, so the process can't be orphaned. */
  onClear?: () => void
}) {
  const startedHHMM = new Date(rec.startedAt).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  })
  const isError = rec.status === 'error'
  const sub = subline(rec)
  const statusLabel = statusWord(rec)

  // The label region is the only row-level button so the right-side action
  // buttons (stop / retry / sign-in / clear) aren't nested inside another
  // interactive element. Outer is a plain div; clicking the label focuses.
  return (
    <div
      className={clsx(
        'w-full flex items-center gap-2 h-10 px-2 rounded transition-colors duration-150',
        focused ? 'bg-accent-soft' : 'hover:bg-bg-elevated',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={focused}
        aria-label={`${rec.label} — ${statusLabel}${sub.text ? `, ${sub.text}` : ''}. Click to view log.`}
        className="flex items-center gap-2.5 flex-1 min-w-0 h-full text-left rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="w-4 inline-flex items-center justify-center shrink-0" aria-hidden="true">
          <StatusIcon rec={rec} />
        </span>
        <span className="text-body font-medium text-text-1 truncate min-w-0 shrink-0 max-w-[45%]" aria-hidden="true">
          {rec.label}
        </span>
        {/* Live "last action" read-out — the freshest humanized output line.
            aria-hidden because the full text is surfaced in the button's
            aria-label above; this is visual-only reinforcement. */}
        <span
          className={clsx('text-label truncate min-w-0 flex-1', isError ? 'text-danger' : 'text-text-4')}
          aria-hidden="true"
          title={sub.title}
        >
          {sub.text}
        </span>
      </button>

      {/* Right-side readout + actions. Failed rows swap the timing readout
          for an inline retry / sign-in. */}
      <div className="flex items-center gap-1.5 shrink-0">
        {isError ? (
          <RowRetry rec={rec} />
        ) : (
          <RowElapsed record={rec} startedHHMM={startedHHMM} />
        )}
        {onStop && (
          <Button
            tone="ghost"
            size="xs"
            onClick={onStop}
            title="Stop this process"
            aria-label={`Stop ${rec.label}`}
          >
            Stop
          </Button>
        )}
        {onClear && (
          <Button
            tone="ghost"
            size="xs"
            onClick={onClear}
            title="Dismiss this row"
            aria-label={`Dismiss ${rec.label}`}
          >
            Clear
          </Button>
        )}
      </div>
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
      <Button
        tone="tinted"
        size="xs"
        onClick={() => relogin()}
        disabled={reloginInProgress}
        aria-label={reloginInProgress ? 'Waiting for sign-in' : 'Sign in again to retry'}
        icon={<span className="inline-flex" aria-hidden="true"><ClaudeLogo size={12} /></span>}
      >
        {reloginInProgress ? 'Waiting…' : 'Sign in'}
      </Button>
    )
  }
  return (
    <Button
      tone="ghost"
      size="xs"
      onClick={() => retry(rec.id)}
      aria-label={`Retry ${rec.label}`}
      icon={<RotateCw size={12} aria-hidden="true" />}
    >
      Retry
    </Button>
  )
}

// Start time + live elapsed for the row. Ticks every second while running,
// freezes on endedAt once the spawn finishes.
function RowElapsed({ record, startedHHMM }: { record: SpawnRecord; startedHHMM: string }) {
  const [, setTick] = useState(0)
  const running = isRunning(record.status)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const end = running ? Date.now() : (record.endedAt ?? record.startedAt)
  return (
    <span
      className="text-label text-text-4 tabular-nums whitespace-nowrap px-1"
      aria-hidden="true"
      title={`Started ${startedHHMM}`}
    >
      {startedHHMM} · {formatElapsed(end - record.startedAt)}
    </span>
  )
}

// The read-out shows what a spawn is doing right now (or last did). Running
// spawns that haven't emitted yet read "starting…"; once output streams we
// surface the most recent line; finished spawns with no captured output fall
// back to a terse status word rather than an empty slot.
function subline(rec: SpawnRecord): { text: string; title: string } {
  const last = lastOutputLine(rec.output)
  if (last) return { text: last, title: last }
  if (isRunning(rec.status)) return { text: 'starting…', title: 'Waiting for first output' }
  const word =
    rec.status === 'done'   ? 'exited cleanly' :
    rec.status === 'error'  ? `exited ${rec.exitCode ?? '?'}` :
    'stopped'
  return { text: word, title: word }
}

function statusWord(rec: SpawnRecord): string {
  const status = rec.status
  if (status === 'running') return 'running'
  if (status === 'done')    return rec.warnings?.length ? 'finished with warnings' : 'finished'
  if (status === 'error')   return 'failed'
  return 'stopped'
}

function lastOutputLine(output: string[]): string | null {
  for (let i = output.length - 1; i >= 0; i--) {
    const line = output[i]?.trim()
    if (line) return line
  }
  return null
}

function StatusIcon({ rec }: { rec: SpawnRecord }) {
  const status = rec.status
  if (status === 'running') return <OrbitalLoader size={14} rings={2} strokeClass="text-accent" className="shrink-0" />
  // Done, but some calls were refused on the way: warning state, not failure.
  if (status === 'done' && rec.warnings?.length) return <AlertTriangle size={13} className="shrink-0 text-warning" />
  if (status === 'done')    return <Check size={13} className="shrink-0 text-success" />
  if (status === 'error')   return <AlertTriangle size={13} className="shrink-0 text-danger" />
  return <XIcon size={13} className="shrink-0 text-text-4" />  // killed
}

function isRunning(status: SpawnStatus): boolean {
  return status === 'running'
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
