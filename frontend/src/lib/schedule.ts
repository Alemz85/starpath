// Scheduled runs — the pure side of Settings › General › Scheduled runs.
//
// The scheduler itself is scripts/scheduled-run.mjs (docs/REPO-GUIDE.md §
// Scheduled runs). The app drives it over the generic `ipc.run`: `status
// --json` to read, `install --slot …` / `uninstall` to change. Everything
// here is parsing and wording, so it tests without Electron.

export interface ScheduleSlot { weekday: number; hour: number; minute: number }

export type ScheduleRunStatus =
  | 'running' | 'completed' | 'completed-with-errors' | 'partial' | 'failed' | 'interrupted'

export interface ScheduleRun {
  id: string
  trigger: 'scheduled' | 'manual'
  startedAt: string
  finishedAt: string | null
  status: ScheduleRunStatus
  summaryText: string
  error: string | null
}

export interface ScheduleStatus {
  installed: boolean
  loaded: boolean
  /** null when not installed; false means `problems` says what to fix. */
  upToDate: boolean | null
  problems: string[]
  slot: ScheduleSlot | null
  slotLabel: string | null
  running: boolean
  lastRun: ScheduleRun | null
  lastFullRunAt: string | null
  nextRunAt: string | null
  dueNow: boolean
  options: { top: number; parallel: number; model: string; jobspy: boolean }
  logPath: string
  root: string
  claudeFound: boolean
}

export interface SlotPick { weekday: number; hour: number; minute: number; label: string; evidence: string }
export interface SlotSuggestion { picks: SlotPick[]; confidence: 'low' | 'medium' | 'high'; fallback: boolean }

export const SCHEDULER_SCRIPT = 'scripts/scheduled-run.mjs'

export const schedulerArgs = {
  status: () => [SCHEDULER_SCRIPT, 'status', '--json'],
  suggest: () => [SCHEDULER_SCRIPT, 'suggest', '--json'],
  /** With no slot, the CLI installs the saved one, else the top suggestion. */
  install: (slot?: ScheduleSlot | null) => [SCHEDULER_SCRIPT, 'install', ...(slot ? ['--slot', slotArg(slot)] : [])],
  uninstall: () => [SCHEDULER_SCRIPT, 'uninstall'],
}

const DAY_ARGS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
/** Display order, Monday first; the values are launchd's (0 = Sunday). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const
export const MINUTE_CHOICES = [0, 15, 30, 45] as const

const pad = (n: number) => String(n).padStart(2, '0')

/** The CLI's `--slot` text: "tue 09:30". */
export function slotArg(slot: ScheduleSlot): string {
  return `${DAY_ARGS[slot.weekday]} ${pad(slot.hour)}:${pad(slot.minute)}`
}

export function slotLabel(slot: ScheduleSlot): string {
  return `${WEEKDAY_NAMES[slot.weekday]} ${pad(slot.hour)}:${pad(slot.minute)}`
}

export function sameSlot(a: ScheduleSlot | null, b: ScheduleSlot | null): boolean {
  if (!a || !b) return a === b
  return a.weekday === b.weekday && a.hour === b.hour && a.minute === b.minute
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  // The CLI prints one JSON document; tolerate log lines before it.
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      const v: unknown = JSON.parse(lines[i])
      if (isRecord(v)) return v
    } catch { /* keep looking */ }
  }
  try {
    const v: unknown = JSON.parse(stdout)
    return isRecord(v) ? v : null
  } catch { return null }
}

function toSlot(v: unknown): ScheduleSlot | null {
  if (!isRecord(v)) return null
  const { weekday, hour, minute } = v
  if (typeof weekday !== 'number' || typeof hour !== 'number') return null
  if (weekday < 0 || weekday > 6 || hour < 0 || hour > 23) return null
  return { weekday, hour, minute: typeof minute === 'number' ? minute : 0 }
}

function toRun(v: unknown): ScheduleRun | null {
  if (!isRecord(v) || typeof v.startedAt !== 'string' || typeof v.status !== 'string') return null
  return {
    id: String(v.id ?? v.startedAt),
    trigger: v.trigger === 'scheduled' ? 'scheduled' : 'manual',
    startedAt: v.startedAt,
    finishedAt: typeof v.finishedAt === 'string' ? v.finishedAt : null,
    status: v.status as ScheduleRunStatus,
    summaryText: typeof v.summaryText === 'string' ? v.summaryText : '',
    error: typeof v.error === 'string' ? v.error : null,
  }
}

export function parseScheduleStatus(stdout: string): ScheduleStatus | null {
  const r = lastJsonObject(stdout)
  if (!r || typeof r.installed !== 'boolean') return null
  const slot = toSlot(r.slot)
  const opts = isRecord(r.options) ? r.options : {}
  return {
    installed: r.installed,
    loaded: r.loaded === true,
    upToDate: typeof r.upToDate === 'boolean' ? r.upToDate : null,
    problems: Array.isArray(r.problems) ? r.problems.filter((p): p is string => typeof p === 'string') : [],
    slot,
    slotLabel: slot ? slotLabel(slot) : null,
    running: r.running === true,
    lastRun: toRun(r.lastRun),
    lastFullRunAt: typeof r.lastFullRunAt === 'string' ? r.lastFullRunAt : null,
    nextRunAt: typeof r.nextRunAt === 'string' ? r.nextRunAt : null,
    dueNow: r.dueNow === true,
    options: {
      top: typeof opts.top === 'number' ? opts.top : 15,
      parallel: typeof opts.parallel === 'number' ? opts.parallel : 2,
      model: typeof opts.model === 'string' ? opts.model : 'sonnet',
      jobspy: opts.jobspy === true,
    },
    logPath: typeof r.logPath === 'string' ? r.logPath : '',
    root: typeof r.root === 'string' ? r.root : '',
    claudeFound: r.claudeFound !== false,
  }
}

export function parseSlotSuggestion(stdout: string): SlotSuggestion | null {
  const r = lastJsonObject(stdout) ?? (() => { try { const v: unknown = JSON.parse(stdout); return isRecord(v) ? v : null } catch { return null } })()
  if (!r || !Array.isArray(r.picks)) return null
  const picks: SlotPick[] = []
  for (const p of r.picks) {
    const slot = toSlot(p)
    if (!slot || !isRecord(p)) continue
    picks.push({ ...slot, label: slotLabel(slot), evidence: typeof p.evidence === 'string' ? p.evidence : '' })
  }
  if (picks.length === 0) return null
  const confidence = r.confidence === 'high' || r.confidence === 'medium' ? r.confidence : 'low'
  return { picks, confidence, fallback: r.fallback === true }
}

/** "Tue 27 Oct, 09:30" in the user's locale and time zone. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day}, ${time}`
}

export type ChipToneName = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'

/** Label + chip tone for the last run's result. */
export function runResultChip(status: ScheduleRunStatus | undefined): { label: string; tone: ChipToneName } {
  switch (status) {
    case 'completed': return { label: 'Completed', tone: 'success' }
    case 'completed-with-errors': return { label: 'Completed with errors', tone: 'warning' }
    case 'partial': return { label: 'Scan only', tone: 'muted' }
    case 'failed': return { label: 'Failed', tone: 'danger' }
    case 'interrupted': return { label: 'Interrupted', tone: 'warning' }
    case 'running': return { label: 'Running', tone: 'accent' }
    default: return { label: 'No runs yet', tone: 'muted' }
  }
}

/** One plain sentence on whether the job will fire, for the header of the section. */
export function jobStateLine(s: ScheduleStatus): string {
  if (!s.installed) return 'Off. Nothing runs on its own.'
  if (!s.loaded) return 'Installed but not loaded. Switch it Off and On again to load it.'
  if (s.upToDate === false) return 'On, but needs attention (see below).'
  return 'On.'
}
