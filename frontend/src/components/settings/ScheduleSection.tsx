'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, FileText, Lightbulb, Eye } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useWriteGate } from '@/store/dataRoot'
import { ipc } from '@/lib/ipc'
import { Button, Chip } from '@/components/ui'
import { FeatureToggle } from '@/components/settings/FeatureToggle'
import {
  MINUTE_CHOICES, WEEKDAY_NAMES, WEEKDAY_ORDER, formatWhen, jobStateLine, parseScheduleStatus,
  parseSlotSuggestion, runResultChip, sameSlot, schedulerArgs, slotLabel,
  type ScheduleSlot, type ScheduleStatus, type SlotSuggestion,
} from '@/lib/schedule'

// Settings › General › Scheduled runs.
//
// The weekly scan + evaluation run (scripts/scheduled-run.mjs, a macOS
// LaunchAgent). This panel reads `status --json` and changes the job by
// running `install --slot …` / `uninstall` through the generic ipc.run, so it
// needs no IPC of its own. Switching On writes a LaunchAgent into the user's
// ~/Library/LaunchAgents, which is why it only ever happens on their click.

const POLL_WHILE_RUNNING_MS = 20_000
const HOURS = Array.from({ length: 24 }, (_, h) => h)

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; status: ScheduleStatus }

async function runScheduler(args: string[]): Promise<{ ok: boolean; stdout: string; message: string }> {
  const res = await ipc.run('node', args)
  const text = (res.stderr || res.stdout || '').trim()
  return { ok: res.code === 0, stdout: res.stdout, message: text.split('\n').filter(Boolean).slice(-2).join(' ') }
}

export function ScheduleSection() {
  const repoPath = useAppStore(s => s.repoPath)
  const { canWrite, readOnlyTitle } = useWriteGate()
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [draft, setDraft] = useState<ScheduleSlot | null>(null)
  const [suggestion, setSuggestion] = useState<SlotSuggestion | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    const res = await runScheduler(schedulerArgs.status())
    if (seq.current !== mine) return
    const status = res.ok ? parseScheduleStatus(res.stdout) : null
    if (!status) {
      setLoaded({ state: 'error', message: res.message || 'The scheduler did not answer.' })
      return
    }
    setLoaded({ state: 'ready', status })
    setDraft(prev => prev ?? status.slot)
  }, [])

  useEffect(() => {
    if (!repoPath || !canWrite) return
    void load()
  }, [repoPath, canWrite, load])

  const running = loaded.state === 'ready' && loaded.status.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void load(), POLL_WHILE_RUNNING_MS)
    return () => clearInterval(t)
  }, [running, load])

  if (!canWrite) {
    return (
      <p className="mt-3 flex items-center gap-2 text-label text-warning-text">
        <Eye size={14} className="shrink-0" aria-hidden />
        <span>{readOnlyTitle}. Scheduled runs work on your own data: turn off Show demo data to manage them.</span>
      </p>
    )
  }
  if (!repoPath) return <p className="mt-3 text-label text-text-4">Set the repository first.</p>
  if (loaded.state === 'loading') return <p className="mt-3 text-label text-text-4" role="status">Reading the schedule…</p>
  if (loaded.state === 'error') {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-label text-danger" role="alert">Could not read the schedule: {loaded.message}</p>
        <Button tone="secondary" size="sm" onClick={() => void load()}>Try again</Button>
      </div>
    )
  }

  const status = loaded.status
  const current = draft ?? status.slot ?? { weekday: 3, hour: 12, minute: 0 }
  const dirty = status.installed && !sameSlot(current, status.slot)

  const apply = async (label: string, args: string[], success: string) => {
    setBusy(true)
    setNote(null)
    const res = await runScheduler(args)
    setBusy(false)
    if (res.ok) setNote({ tone: 'ok', text: success })
    else setNote({ tone: 'error', text: `${label} failed: ${res.message || 'unknown error'}` })
    await load()
    if (res.ok) setDraft(null)
  }

  const turnOn = () => apply('Turning on', schedulerArgs.install(draft ?? status.slot), 'Scheduled runs are on.')
  const turnOff = () => apply('Turning off', schedulerArgs.uninstall(), 'Scheduled runs are off. Your slot and run history are kept.')
  const saveSlot = () => apply('Changing the slot', schedulerArgs.install(current), `The job now runs at ${slotLabel(current)}.`)

  const suggest = async () => {
    setSuggesting(true)
    setNote(null)
    const res = await runScheduler(schedulerArgs.suggest())
    setSuggesting(false)
    const parsed = res.ok ? parseSlotSuggestion(res.stdout) : null
    if (parsed) setSuggestion(parsed)
    else setNote({ tone: 'error', text: `Could not work out a quiet slot: ${res.message || 'no data'}` })
  }

  const last = status.lastRun
  const chip = runResultChip(last?.status)

  return (
    <div className="mt-4 space-y-4">
      <FeatureToggle
        label="Run on its own"
        sub={`${jobStateLine(status)} Scans the job boards, queues the best listings and evaluates them on ${status.options.model === 'sonnet' ? 'Sonnet' : status.options.model}, at most once every 7 days. It never applies or sends anything.`}
        value={status.installed}
        onChange={(on) => { if (on !== status.installed) void (on ? turnOn() : turnOff()) }}
        disabled={busy}
      />

      <div>
        <div className="text-body font-medium text-text-1">Slot</div>
        <div className="text-label text-text-3 mt-0.5">
          The hour of the week the job fires. If the Mac is asleep then, it runs when it wakes; a failed run is retried at the same time on the next two days.
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SlotPicker value={current} onChange={setDraft} disabled={busy} />
          {dirty && (
            <Button tone="primary" size="sm" onClick={() => void saveSlot()} disabled={busy} loading={busy}>
              Use this slot
            </Button>
          )}
          <Button
            tone="ghost"
            size="sm"
            onClick={() => void suggest()}
            disabled={busy || suggesting}
            loading={suggesting}
            icon={<Lightbulb size={13} aria-hidden="true" />}
            title="Looks at when you use Claude (timestamps only) and when your Mac is awake"
          >
            Suggest quiet slots
          </Button>
        </div>
        {suggestion && (
          <ul className="mt-2 space-y-1.5" aria-label="Suggested slots">
            {suggestion.picks.map((p) => (
              <li key={`${p.weekday}-${p.hour}-${p.minute}`} className="flex items-start gap-2">
                <Button tone="secondary" size="xs" onClick={() => setDraft({ weekday: p.weekday, hour: p.hour, minute: p.minute })} className="shrink-0">
                  {p.label}
                </Button>
                <span className="text-label text-text-3 min-w-0">{p.evidence}</span>
              </li>
            ))}
            <li className="text-label text-text-4">
              Confidence: {suggestion.confidence}{suggestion.fallback ? ' (built-in default, not enough history)' : ''}. Click a slot to select it{status.installed ? ', then Use this slot.' : ', then switch Run on its own On.'}
            </li>
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-label">
        <dt className="text-text-3">Last run</dt>
        <dd className="min-w-0 text-text-1">
          {last ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip tone={chip.tone} size="md">{chip.label}</Chip>
              <span>{formatWhen(last.finishedAt ?? last.startedAt)}</span>
              <span className="text-text-3">({last.trigger})</span>
              {last.summaryText && <span className="text-text-3 min-w-0">{last.summaryText}</span>}
            </span>
          ) : <span className="text-text-3">Never</span>}
        </dd>
        <dt className="text-text-3">Next run</dt>
        <dd className="text-text-1">
          {status.running
            ? 'Running now'
            : status.installed
              ? (status.nextRunAt ? formatWhen(status.nextRunAt) : '—')
              : <span className="text-text-3">Not scheduled</span>}
        </dd>
        <dt className="text-text-3">Runs in</dt>
        <dd className="min-w-0 truncate font-mono text-text-2" title={status.root}>{status.root}</dd>
        <dt className="text-text-3">Log</dt>
        <dd className="min-w-0 flex items-center gap-2">
          <span className="min-w-0 truncate font-mono text-text-2" title={status.logPath}>{status.logPath}</span>
          <Button
            tone="ghost"
            size="xs"
            icon={<FileText size={12} aria-hidden="true" />}
            onClick={() => void ipc.openFile(status.logPath)}
            className="shrink-0"
          >
            Open
          </Button>
        </dd>
      </dl>

      {!status.claudeFound && (
        <p className="text-label text-warning-text" role="status">
          The claude command line tool was not found, so evaluations would fail. Scans and triage still work.
        </p>
      )}
      {status.installed && status.problems.length > 0 && (
        <div className="text-label text-warning-text" role="status">
          <p>The installed job needs attention: {status.problems.join('; ')}.</p>
          <p className="mt-0.5">Switch Run on its own Off and On again to rewrite it.</p>
        </div>
      )}
      {note && (
        <p
          className={note.tone === 'error' ? 'text-label text-danger' : 'flex items-center gap-1.5 text-label text-success'}
          role={note.tone === 'error' ? 'alert' : 'status'}
        >
          {note.tone === 'ok' && <Check size={13} aria-hidden="true" />}
          {note.text}
        </p>
      )}
    </div>
  )
}

function SlotPicker({ value, onChange, disabled }: {
  value: ScheduleSlot
  onChange: (slot: ScheduleSlot) => void
  disabled?: boolean
}) {
  const dayId = useId()
  const hourId = useId()
  const minuteId = useId()
  const minutes = (MINUTE_CHOICES as readonly number[]).includes(value.minute)
    ? [...MINUTE_CHOICES] as number[]
    : [...MINUTE_CHOICES, value.minute].sort((a, b) => a - b)
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Weekly slot">
      <label htmlFor={dayId} className="sr-only">Day of the week</label>
      <select
        id={dayId}
        value={value.weekday}
        disabled={disabled}
        onChange={e => onChange({ ...value, weekday: Number(e.target.value) })}
        className="input w-auto px-2 cursor-pointer"
      >
        {WEEKDAY_ORDER.map(d => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
      </select>
      <span className="text-label text-text-3" aria-hidden>at</span>
      <label htmlFor={hourId} className="sr-only">Hour</label>
      <select
        id={hourId}
        value={value.hour}
        disabled={disabled}
        onChange={e => onChange({ ...value, hour: Number(e.target.value) })}
        className="input w-auto px-2 cursor-pointer"
      >
        {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
      </select>
      <span className="text-label text-text-3" aria-hidden>:</span>
      <label htmlFor={minuteId} className="sr-only">Minute</label>
      <select
        id={minuteId}
        value={value.minute}
        disabled={disabled}
        onChange={e => onChange({ ...value, minute: Number(e.target.value) })}
        className="input w-auto px-2 cursor-pointer"
      >
        {minutes.map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
      </select>
    </div>
  )
}
