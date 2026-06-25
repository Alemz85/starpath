'use client'

import { useEffect, useMemo } from 'react'
import { CheckCircle2, X as XIcon, AlertTriangle, RotateCw, Trash2, Zap } from 'lucide-react'
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
 * in the panel below. Auto-collapses to a placeholder when there's no spawn.
 *
 * Each row carries a live "last action" subline — the most recent humanized
 * output line — so when several spawns run at once (Full Scan + JobSpy +
 * Filter) the user can see what every background process is doing at a
 * glance, without clicking each one to read its focused log. Finished rows
 * can be dismissed individually (× on hover) or all at once (Clear finished),
 * both wired to the store's existing `clear` action. Failed rows swap the
 * timing readout for an inline retry / sign-in so the user can recover from
 * the list without opening the log.
 */
export function ActiveProcessesBar({ focusedId, onFocus }: Props) {
  const spawns = useSpawnsStore(s => s.spawns)
  const clear  = useSpawnsStore(s => s.clear)
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
  // placeholder. Limits visible rows to ~4 then scrolls inside.
  return (
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel">
      <div className="flex items-center justify-between px-4 h-8 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase tracking-wider" aria-hidden="true">
          Active processes
          <span className="ml-1.5 font-mono text-text-3">{ordered.length}</span>
        </span>
        {/* Hidden but accessible count for screen readers */}
        <span className="sr-only">
          {ordered.length === 0
            ? 'No active processes'
            : `${ordered.length} process${ordered.length === 1 ? '' : 'es'}`}
        </span>
        {finishedIds.length > 0 && (
          <button
            onClick={() => finishedIds.forEach(clear)}
            title="Dismiss every finished, errored, or stopped process row"
            aria-label={`Clear ${finishedIds.length} finished process${finishedIds.length === 1 ? '' : 'es'}`}
            className="inline-flex items-center gap-1 text-micro text-text-4 hover:text-text-2 transition-colors"
          >
            <Trash2 size={10} aria-hidden="true" />
            Clear finished
          </button>
        )}
      </div>
      {ordered.length === 0 ? (
        <EmptyState />
      ) : (
        // Two-line rows (~42px) — cap the visible window near 4.5 rows so a
        // longer tail hints that it scrolls. role="log" tells screen readers
        // this region accumulates status messages over time.
        <div
          role="log"
          aria-label="Process list"
          aria-live="polite"
          className="max-h-[200px] overflow-y-auto p-1.5 space-y-0.5"
        >
          {ordered.map(rec => (
            <ProcessRow
              key={rec.id}
              rec={rec}
              focused={rec.id === focusedId}
              onClick={() => onFocus(rec.id)}
              onClear={isRunning(rec.status) ? undefined : () => clear(rec.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Empty state — shown when no spawns exist yet. Replaces the bare italic
// placeholder with a structured hint that surfaces the right affordance
// (scan buttons live in the Scouting tab).
function EmptyState() {
  return (
    <div
      className="px-4 py-5 flex flex-col items-center gap-1.5 text-center"
      aria-label="No active processes. Start a scan or generate reports from the Scouting tab."
    >
      <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-bg-elevated text-text-4 mb-0.5">
        <Zap size={14} aria-hidden="true" />
      </span>
      <p className="text-label font-medium text-text-3">No processes running</p>
      <p className="text-micro text-text-4 max-w-[220px] leading-relaxed normal-case tracking-normal font-normal">
        Scans and report runs from Scouting or Applying will appear here.
      </p>
    </div>
  )
}

function ProcessRow({
  rec, focused, onClick, onClear,
}: {
  rec: SpawnRecord
  focused: boolean
  onClick: () => void
  /** Present only for finished rows — running spawns must be killed (which
   *  leaves a record), not cleared, so the process can't be orphaned. */
  onClear?: () => void
}) {
  const startedHHMM = new Date(rec.startedAt).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  })
  const isError = rec.status === 'error'
  const sub = subline(rec)
  const statusLabel = statusWord(rec.status)

  // The label region is the only row-level button so the right-side action
  // buttons (retry / sign-in / dismiss) aren't nested inside another
  // interactive element. Outer is a plain div; clicking the label focuses.
  return (
    <div
      className={cn(
        'group w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors text-[12px]',
        focused ? 'bg-accent/12' : 'hover:bg-bg-elevated',
      )}
    >
      <button
        onClick={onClick}
        aria-pressed={focused}
        aria-label={`${rec.label} — ${statusLabel}${sub.text ? `, ${sub.text}` : ''}. Click to view log.`}
        className={cn(
          'flex items-start gap-2.5 flex-1 min-w-0 text-left',
          focused ? 'text-text-1' : 'text-text-2',
        )}
      >
        <span className="mt-0.5" aria-hidden="true">
          <StatusIcon status={rec.status} />
        </span>
        <div className="flex-1 min-w-0">
          <span className="block truncate font-medium" aria-hidden="true">{rec.label}</span>
          {/* Live "last action" subline — the freshest humanized output line.
              aria-hidden because the full text is surfaced in the button's
              aria-label above; this is visual-only reinforcement. */}
          <div
            className={cn(
              'truncate font-mono text-[10.5px] leading-[1.5] mt-0.5',
              isError ? 'text-danger/80' : 'text-text-4',
            )}
            aria-hidden="true"
            title={sub.title}
          >
            {sub.text}
          </div>
        </div>
      </button>

      {/* Right-side actions, aligned to the first text line. Failed rows swap
          the timing readout for an inline retry / sign-in; every finished row
          also gets a hover × to dismiss. */}
      <div className="flex items-center gap-2.5 shrink-0 mt-0.5">
        {isError ? (
          <RowRetry rec={rec} />
        ) : (
          <>
            <span className="text-[10.5px] text-text-4 font-mono tabular-nums" aria-hidden="true">
              started {startedHHMM}
            </span>
            <span className="inline-flex items-center w-px h-3 bg-border-default" aria-hidden="true" />
            <ElapsedChipInline record={rec} />
          </>
        )}
        {onClear && (
          <button
            onClick={onClear}
            title="Dismiss this row"
            aria-label={`Dismiss ${rec.label}`}
            className="-mr-0.5 p-0.5 rounded text-text-4 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all"
          >
            <XIcon size={11} aria-hidden="true" />
          </button>
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
      <button
        onClick={() => relogin()}
        disabled={reloginInProgress}
        aria-label={reloginInProgress ? 'Waiting for sign-in' : 'Sign in again to retry'}
        className="shrink-0 inline-flex items-center gap-1.5 pl-1 pr-2.5 h-6 rounded-pill bg-accent hover:bg-accent-hover text-white text-[10.5px] font-medium transition-colors disabled:opacity-70"
      >
        <span className="bg-white rounded-full p-0.5" aria-hidden="true"><ClaudeLogo size={9} /></span>
        {reloginInProgress ? 'Waiting…' : 'Sign in'}
      </button>
    )
  }
  return (
    <button
      onClick={() => retry(rec.id)}
      aria-label={`Retry ${rec.label}`}
      className="shrink-0 inline-flex items-center gap-1 px-2.5 h-6 rounded-pill bg-bg-elevated hover:bg-accent/10 text-text-3 hover:text-accent text-[10.5px] font-medium transition-colors"
    >
      <RotateCw size={10} aria-hidden="true" />
      Retry
    </button>
  )
}

// The subline shows what a spawn is doing right now (or last did). Running
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

function statusWord(status: SpawnStatus): string {
  if (status === 'running') return 'running'
  if (status === 'done')    return 'finished'
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

function StatusIcon({ status }: { status: SpawnStatus }) {
  if (status === 'running') return <OrbitalLoader size={14} rings={2} strokeClass="text-accent" className="shrink-0" />
  if (status === 'done')    return <CheckCircle2 size={12} className="shrink-0 text-success" />
  if (status === 'error')   return <AlertTriangle size={12} className="shrink-0 text-danger" />
  return <XIcon size={12} className="shrink-0 text-text-4" />  // killed
}

// Wrapper that styles ElapsedChip for the in-row context (smaller, muted).
function ElapsedChipInline({ record }: { record: SpawnRecord }) {
  return (
    <span className="shrink-0 text-[10.5px]" aria-hidden="true">
      <ElapsedChip record={record} />
    </span>
  )
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
