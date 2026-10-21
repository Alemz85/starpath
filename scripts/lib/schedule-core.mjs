/**
 * schedule-core.mjs — state, cadence, lock and launchd plist for the weekly
 * scheduled run (scripts/scheduled-run.mjs).
 *
 * The decisions are pure and unit-tested (decideRun, nextRunAt, buildPlist,
 * summarizeRun, normalizeState); the few I/O helpers (readState, updateState,
 * acquireRunLock) are thin and take a root folder so tests use a temp dir.
 *
 * State lives in `data/scheduled-runs.json` (a link into private/, so the run
 * history stays out of the public repo and in the user's backup).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic, resolveWriteTarget } from './write-file-atomic.mjs'
import { lockPathFor, tryAcquire, withLockSync } from './dir-lock.mjs'

export const LABEL = 'com.starpath.scheduled-run'
export const STATE_REL = 'data/scheduled-runs.json'
export const LOG_REL = 'data/scheduled-runs.log'
/** launchd's own capture of stdout/stderr (the run writes LOG_REL itself, so they don't double up). */
export const LAUNCHD_LOG_REL = 'data/scheduled-runs.launchd.log'
export const INTERVAL_DAYS = 7
/**
 * A run counts as "a week ago" 6 hours early. The run is long (the evaluation
 * workers), so one that starts at 09:00 finishes at, say, 10:30; without a
 * tolerance the next week's 09:00 fire would be 90 minutes short and the run
 * would slip to a later retry fire.
 */
export const CADENCE_TOLERANCE_HOURS = 6
/**
 * The job also fires RETRY_COUNT more times, RETRY_EVERY_HOURS apart, later the
 * same day (never the next day), so a failed run is retried while the user is
 * still around. A fire after a finished run is a no-op.
 */
export const RETRY_EVERY_HOURS = 2
export const RETRY_COUNT = 4
export const MAX_RUNS_KEPT = 30
/** A run lock older than this is presumed hung (the pid check handles crashes). */
export const RUN_LOCK_STALE_MS = 12 * 3_600_000

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Statuses that count as a finished full run for the weekly cadence. */
const FULL_STATUSES = new Set(['completed', 'completed-with-errors'])

// ── State ──────────────────────────────────────────────────────────────────

export function emptyState() {
  return { version: 1, enabled: false, slot: null, runs: [] }
}

function validSlot(s) {
  return s && Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6
    && Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23
    && Number.isInteger(s.minute ?? 0) && (s.minute ?? 0) >= 0 && (s.minute ?? 0) <= 59
}

/** Tolerant read of whatever is on disk: unknown shapes become the empty state. */
export function normalizeState(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const slot = validSlot(raw.slot) ? { weekday: raw.slot.weekday, hour: raw.slot.hour, minute: raw.slot.minute ?? 0 } : null
  const runs = Array.isArray(raw.runs)
    ? raw.runs.filter((r) => r && typeof r === 'object' && typeof r.startedAt === 'string')
    : []
  const options = raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options) ? raw.options : undefined
  return { version: 1, enabled: raw.enabled === true, slot, ...(options ? { options } : {}), runs: runs.slice(-MAX_RUNS_KEPT) }
}

export function statePath(root) { return join(root, STATE_REL) }

export function readState(root) {
  try {
    return normalizeState(JSON.parse(readFileSync(statePath(root), 'utf8')))
  } catch {
    return emptyState()
  }
}

/** Read-modify-write under the state file's lock. `fn(state)` returns the new state. */
export function updateState(root, fn) {
  const file = statePath(root)
  return withLockSync(lockPathFor(file), () => {
    const next = normalizeState(fn(readState(root)))
    writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n')
    return next
  }, { label: 'scheduled-runs-state', timeoutMs: 10_000 })
}

// ── Cadence ────────────────────────────────────────────────────────────────

/** The most recent finished full run (manual or scheduled), or null. */
export function lastFullRun(state) {
  let best = null
  for (const r of state.runs) {
    if (!FULL_STATUSES.has(r.status) || !r.finishedAt) continue
    const t = Date.parse(r.finishedAt)
    if (!Number.isFinite(t)) continue
    if (!best || t > best.at) best = { run: r, at: t }
  }
  return best
}

/** The most recent run of any status, or null. */
export function lastRun(state) {
  let best = null
  for (const r of state.runs) {
    const t = Date.parse(r.finishedAt || r.startedAt)
    if (!Number.isFinite(t)) continue
    if (!best || t > best.at) best = { run: r, at: t }
  }
  return best
}

/**
 * The last scan of ANY kind that counts toward the cadence, as epoch ms, or
 * null. `scan` is the marker every completed scan leaves (last-scan.mjs:
 * `{at, ok}`), whoever ran it: the app's Full scan or API scan, a manual
 * `node scripts/scan.mjs`, or a scheduled run. A scan where no board answered
 * (`ok: false`) does not count.
 *
 * One exception keeps the same-day retries working: a scan made inside a
 * scheduled run that then failed or was interrupted belongs to that run, and
 * the run is what the retry fires redo, so it does not hold the next one off.
 */
export function countingScanAt(state, scan) {
  if (!scan || scan.ok === false || !Number.isFinite(scan.at)) return null
  for (const r of state.runs) {
    if (!['failed', 'interrupted', 'running'].includes(r.status)) continue
    const from = Date.parse(r.startedAt)
    const to = r.finishedAt ? Date.parse(r.finishedAt) : Infinity
    if (Number.isFinite(from) && scan.at >= from && scan.at <= to) return null
  }
  return scan.at
}

/** The moment the weekly cadence next allows a run, or `now` when nothing has run or scanned. */
export function eligibleAt(state, now, scan = null) {
  const last = lastFullRun(state)
  const scanAt = countingScanAt(state, scan)
  const afterRun = last ? last.at + INTERVAL_DAYS * DAY_MS - CADENCE_TOLERANCE_HOURS * HOUR_MS : now
  const afterScan = scanAt !== null ? scanAt + INTERVAL_DAYS * DAY_MS - CADENCE_TOLERANCE_HOURS * HOUR_MS : now
  return Math.max(afterRun, afterScan)
}

/**
 * Should this invocation do a full run? Only when NO scan of any kind (see
 * countingScanAt) and no finished full run happened within the last 7 days
 * (minus the tolerance); `force` overrides.
 * Returns { run, reason, eligibleAt }.
 */
export function decideRun({ state, now, force = false, lastScan = null }) {
  if (force) return { run: true, reason: 'forced', eligibleAt: eligibleAt(state, now, lastScan) }
  const at = eligibleAt(state, now, lastScan)
  const scanAt = countingScanAt(state, lastScan)
  const last = lastFullRun(state)
  if (now >= at) return { run: true, reason: last || scanAt !== null ? 'due' : 'first run', eligibleAt: at }
  const due = `next run is due after ${new Date(at).toISOString()}`
  // Name the event that is holding the run off: the later of the two.
  if (scanAt !== null && (!last || scanAt >= last.at)) {
    return { run: false, reason: `a scan ran ${((now - scanAt) / DAY_MS).toFixed(1)} days ago (${new Date(scanAt).toISOString()}); ${due}`, eligibleAt: at }
  }
  return {
    run: false,
    reason: `last full run finished ${((now - last.at) / DAY_MS).toFixed(1)} days ago (${last.run.finishedAt}); ${due}`,
    eligibleAt: at,
  }
}

/**
 * Nominal fire times of the job as { weekday, hour, minute }: the slot, then
 * RETRY_COUNT more every RETRY_EVERY_HOURS the same day. Retries that would
 * pass midnight are dropped.
 */
export function fireTimes(slot) {
  const out = []
  for (let i = 0; i <= RETRY_COUNT; i++) {
    const hour = slot.hour + i * RETRY_EVERY_HOURS
    if (hour > 23) break
    out.push({ weekday: slot.weekday, hour, minute: slot.minute ?? 0 })
  }
  return out
}

/**
 * The next time the job fires AND the cadence allows a run, as epoch ms.
 * (launchd fires the missed interval on wake; that run happens whenever the
 * Mac wakes, so this is the nominal time.)
 */
export function nextRunAt({ slot, state, now, lastScan = null }) {
  if (!validSlot(slot)) return null
  const start = Math.max(now, eligibleAt(state, now, lastScan))
  const times = fireTimes(slot)
  const first = new Date(start)
  for (let i = 0; i < 21; i++) {
    const probe = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
    if (probe.getDay() !== slot.weekday) continue
    for (const t of times) {
      const at = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate(), t.hour, t.minute, 0, 0).getTime()
      if (at >= start) return at
    }
  }
  return null
}

// ── Run records ────────────────────────────────────────────────────────────

/** A new in-progress run record. */
export function newRun({ id, trigger, now }) {
  return { id, trigger, startedAt: new Date(now).toISOString(), finishedAt: null, status: 'running', stages: [], summary: {}, error: null }
}

/** Mark records left `running` by a process that died as `interrupted`. */
export function reconcileRuns(state, { now }) {
  const runs = state.runs.map((r) => r.status === 'running'
    ? { ...r, status: 'interrupted', finishedAt: new Date(now).toISOString(), error: r.error ?? 'the process ended before the run finished' }
    : r)
  return { ...state, runs }
}

/** Append a run (replacing the same id), keeping the newest MAX_RUNS_KEPT. */
export function upsertRun(state, run) {
  const runs = state.runs.filter((r) => r.id !== run.id)
  runs.push(run)
  return { ...state, runs: runs.slice(-MAX_RUNS_KEPT) }
}

/** Final status from stage outcomes: failed if a required stage failed, else completed (with errors when evaluations failed). */
export function finalStatus(stages, summary) {
  if (stages.some((s) => s.status === 'failed' && s.required !== false)) return 'failed'
  if ((summary?.evalFailed ?? 0) + (summary?.evalNoResult ?? 0) > 0 || stages.some((s) => s.status === 'failed')) return 'completed-with-errors'
  return 'completed'
}

/** One line for the UI and the log. */
export function summarizeRun(run) {
  if (!run) return 'no runs yet'
  const s = run.summary ?? {}
  const parts = []
  if (run.status === 'failed') {
    const bad = (run.stages ?? []).find((x) => x.status === 'failed')
    return `failed${bad ? ` at ${bad.name}` : ''}${run.error ? `: ${run.error}` : ''}`
  }
  if (run.status === 'interrupted') return 'interrupted before it finished'
  if (run.status === 'running') return 'running'
  if (Number.isFinite(s.scanNew)) parts.push(`${s.scanNew} new listing${s.scanNew === 1 ? '' : 's'}`)
  if (Number.isFinite(s.queued)) parts.push(`${s.queued} queued for evaluation`)
  if (Number.isFinite(s.evalCompleted)) parts.push(`${s.evalCompleted} evaluated`)
  if (s.evaluations === false) parts.push('evaluations off')
  if ((s.evalFailed ?? 0) > 0) parts.push(`${s.evalFailed} failed`)
  if ((s.evalNoResult ?? 0) > 0) parts.push(`${s.evalNoResult} without a result`)
  if (Number.isFinite(s.costUsd) && s.costUsd > 0) parts.push(`$${s.costUsd.toFixed(2)}`)
  return parts.length ? parts.join(', ') : run.status
}

// ── Run lock ───────────────────────────────────────────────────────────────

export function runLockPath(root) {
  return join(dirname(resolveWriteTarget(statePath(root))), '.scheduled-run.lock')
}

/** Take the run lock, or null when another run holds it. */
export function acquireRunLock(root, { label = 'scheduled-run' } = {}) {
  return tryAcquire(runLockPath(root), { label, staleMs: RUN_LOCK_STALE_MS })
}

export function isRunLocked(root) {
  return existsSync(runLockPath(root))
}

// ── launchd plist ──────────────────────────────────────────────────────────

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The LaunchAgent plist. `StartCalendarInterval` fires at the slot and then
 * every RETRY_EVERY_HOURS later the same day (see fireTimes); the 7-day check
 * inside the script (no scan of any kind in the last week) makes the extra fires no-ops once a run has finished, and
 * the run lock turns one that lands mid-run into a no-op. launchd runs a missed
 * interval when the Mac wakes, which is the "retry until it ran" behaviour.
 *
 * launchd's environment is minimal, so the PATH is explicit (the batch runner
 * needs `claude`, `node`, `bc`) and every executable is an absolute path.
 */
export function buildPlist({ label = LABEL, nodePath, scriptPath, root, slot, pathEnv, home, logPath }) {
  if (!validSlot(slot)) throw new Error('buildPlist: invalid slot')
  const intervals = fireTimes(slot).map((t) => `    <dict>
      <key>Weekday</key><integer>${t.weekday}</integer>
      <key>Hour</key><integer>${t.hour}</integer>
      <key>Minute</key><integer>${t.minute}</integer>
    </dict>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(scriptPath)}</string>
    <string>run</string>
    <string>--trigger</string>
    <string>scheduled</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathEnv)}</string>
    <key>HOME</key>
    <string>${xml(home)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`
}

// ── Slot parsing ───────────────────────────────────────────────────────────

const DAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}

/** "tue 09:00", "Tuesday 9", "2 9:30" -> { weekday, hour, minute }, or null. */
export function parseSlot(text) {
  const m = /^\s*([a-z]+|\d)\s+(\d{1,2})(?::(\d{2}))?\s*$/i.exec(String(text ?? ''))
  if (!m) return null
  const wd = /^\d$/.test(m[1]) ? Number(m[1]) % 7 : DAY_ALIASES[m[1].toLowerCase()]
  if (wd === undefined) return null
  const slot = { weekday: wd, hour: Number(m[2]), minute: m[3] ? Number(m[3]) : 0 }
  return validSlot(slot) ? slot : null
}

export { validSlot }
