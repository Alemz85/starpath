import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  normalizeState, emptyState, decideRun, eligibleAt, lastFullRun, nextRunAt, newRun, reconcileRuns,
  upsertRun, finalStatus, summarizeRun, buildPlist, parseSlot, readState, updateState,
  acquireRunLock, isRunLocked, runLockPath, fireTimes, LABEL, MAX_RUNS_KEPT, CADENCE_TOLERANCE_HOURS, countingScanAt,
} from './schedule-core.mjs'

const DAY = 86_400_000
const HOUR = 3_600_000
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

const done = (finishedAt, status = 'completed') => ({ id: finishedAt, trigger: 'scheduled', startedAt: finishedAt, finishedAt, status, stages: [], summary: {}, error: null })
const stateWith = (...runs) => ({ ...emptyState(), runs })

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sched-'))
  mkdirSync(join(root, 'data'))
  return root
}

// ── cadence ──

test('first run is due when nothing has run', () => {
  const d = decideRun({ state: emptyState(), now: Date.now() })
  assert.equal(d.run, true)
  assert.equal(d.reason, 'first run')
})

test('a full run finished 3 days ago blocks the next one', () => {
  const now = at(2026, 10, 26, 9)
  const state = stateWith(done(new Date(now - 3 * DAY).toISOString()))
  const d = decideRun({ state, now })
  assert.equal(d.run, false)
  assert.match(d.reason, /3\.0 days ago/)
})

test('a run counts from the last full run, manual or scheduled', () => {
  const now = at(2026, 10, 26, 9)
  const manual = { ...done(new Date(now - 2 * DAY).toISOString()), trigger: 'manual' }
  const older = done(new Date(now - 20 * DAY).toISOString())
  assert.equal(decideRun({ state: stateWith(older, manual), now }).run, false)
})

test('exactly 7 days later it runs; the 6-hour tolerance covers the run length', () => {
  const finished = at(2026, 10, 19, 10, 30)
  const state = stateWith(done(new Date(finished).toISOString()))
  assert.equal(decideRun({ state, now: finished + 7 * DAY }).run, true)
  // Next Tuesday 09:00 is 6d22.5h after a 10:30 finish: due thanks to the tolerance.
  assert.equal(decideRun({ state, now: at(2026, 10, 26, 9) }).run, true)
  // 6h + 1min short of the tolerance is still blocked.
  assert.equal(decideRun({ state, now: finished + 7 * DAY - CADENCE_TOLERANCE_HOURS * HOUR - 60_000 }).run, false)
})

test('failed, interrupted and running records do not start the 7 days', () => {
  const now = at(2026, 10, 26, 9)
  const iso = new Date(now - DAY).toISOString()
  const state = stateWith(done(iso, 'failed'), done(iso, 'interrupted'), { ...done(iso, 'running'), finishedAt: null })
  assert.equal(lastFullRun(state), null)
  assert.equal(decideRun({ state, now }).run, true)
})

test('completed-with-errors still counts as a finished full run', () => {
  const now = at(2026, 10, 26, 9)
  const state = stateWith(done(new Date(now - DAY).toISOString(), 'completed-with-errors'))
  assert.equal(decideRun({ state, now }).run, false)
})

test('--force runs regardless', () => {
  const now = at(2026, 10, 26, 9)
  const state = stateWith(done(new Date(now - HOUR).toISOString()))
  const d = decideRun({ state, now, force: true })
  assert.equal(d.run, true)
  assert.equal(d.reason, 'forced')
})

// ── a scan of any kind counts (app Full/API scan, manual scan.mjs, scheduled run) ──

test('an app scan 3 days ago holds the run off, even with no full run on record', () => {
  const now = at(2026, 10, 28, 12)
  const d = decideRun({ state: emptyState(), now, lastScan: { at: now - 3 * DAY, ok: true } })
  assert.equal(d.run, false)
  assert.match(d.reason, /a scan ran 3\.0 days ago/)
  assert.ok(d.eligibleAt > now)
})

test('a last scan 8 days ago does not: the run is due', () => {
  const now = at(2026, 10, 28, 12)
  const d = decideRun({ state: emptyState(), now, lastScan: { at: now - 8 * DAY, ok: true } })
  assert.equal(d.run, true)
  assert.equal(d.reason, 'due')
})

test('a failed scan (no board answered) does not count', () => {
  const now = at(2026, 10, 28, 12)
  const d = decideRun({ state: emptyState(), now, lastScan: { at: now - DAY, ok: false } })
  assert.equal(d.run, true)
  assert.equal(d.reason, 'first run')
  assert.equal(countingScanAt(emptyState(), { at: now - DAY, ok: false }), null)
  assert.equal(countingScanAt(emptyState(), { at: NaN, ok: true }), null)
  assert.equal(countingScanAt(emptyState(), null), null)
})

test('the later of scan and full run governs; the reason names it', () => {
  const now = at(2026, 10, 28, 12)
  const state = stateWith(done(new Date(now - 5 * DAY).toISOString()))
  const byScan = decideRun({ state, now, lastScan: { at: now - 2 * DAY, ok: true } })
  assert.equal(byScan.run, false)
  assert.match(byScan.reason, /a scan ran 2\.0 days ago/)
  const byRun = decideRun({ state, now, lastScan: { at: now - 6 * DAY, ok: true } })
  assert.equal(byRun.run, false)
  assert.match(byRun.reason, /last full run finished 5\.0 days ago/)
})

test('the tolerance applies to a scan too, and --force still overrides', () => {
  const scanned = at(2026, 10, 21, 12, 5)
  const lastScan = { at: scanned, ok: true }
  // A scheduled run scans a few minutes after it fires, so next week's same-slot fire is due.
  assert.equal(decideRun({ state: emptyState(), now: at(2026, 10, 28, 12), lastScan }).run, true)
  assert.equal(decideRun({ state: emptyState(), now: scanned + 7 * DAY - CADENCE_TOLERANCE_HOURS * HOUR - 60_000, lastScan }).run, false)
  assert.equal(decideRun({ state: emptyState(), now: scanned + HOUR, lastScan, force: true }).run, true)
})

test('a scan made inside a scheduled run that failed does not block the same-day retry', () => {
  const started = at(2026, 10, 28, 12)
  const scanAt = started + 60_000
  const failed = { ...done(new Date(started + 10 * 60_000).toISOString(), 'failed'), startedAt: new Date(started).toISOString() }
  const state = stateWith(failed)
  const now = at(2026, 10, 28, 14)
  assert.equal(countingScanAt(state, { at: scanAt, ok: true }), null)
  assert.equal(decideRun({ state, now, lastScan: { at: scanAt, ok: true } }).run, true)
  // A user's own scan made before the failed run, or after it, still counts.
  assert.equal(countingScanAt(state, { at: started - HOUR, ok: true }), started - HOUR)
  assert.equal(countingScanAt(state, { at: started + 3 * HOUR, ok: true }), started + 3 * HOUR)
  // …and so does a scan from a run that finished (even with errors).
  const fine = { ...done(new Date(started + 10 * 60_000).toISOString(), 'completed-with-errors'), startedAt: new Date(started).toISOString() }
  assert.equal(countingScanAt(stateWith(fine), { at: scanAt, ok: true }), scanAt)
})

test('nextRunAt waits for a counting scan', () => {
  const slot = { weekday: 3, hour: 12, minute: 0 }
  const scanned = at(2026, 10, 27, 20) // Tuesday evening, by hand
  const now = at(2026, 10, 27, 21)
  // Wed 12:00 is 16h later: held off; the 14:00 retry is also inside the week minus 6h tolerance.
  assert.equal(nextRunAt({ slot, state: emptyState(), now, lastScan: { at: scanned, ok: true } }), at(2026, 11, 4, 12))
  assert.equal(nextRunAt({ slot, state: emptyState(), now, lastScan: null }), at(2026, 10, 28, 12))
})

test('eligibleAt is now when nothing has run', () => {
  assert.equal(eligibleAt(emptyState(), 12345), 12345)
})

// ── next run ──

test('fireTimes: the slot, then every 2 hours the same day, nothing past midnight', () => {
  assert.deepEqual(fireTimes({ weekday: 3, hour: 12, minute: 0 }).map((t) => t.hour), [12, 14, 16, 18, 20])
  assert.ok(fireTimes({ weekday: 3, hour: 12, minute: 30 }).every((t) => t.weekday === 3 && t.minute === 30))
  assert.deepEqual(fireTimes({ weekday: 3, hour: 21, minute: 0 }).map((t) => t.hour), [21, 23])
  assert.deepEqual(fireTimes({ weekday: 3, hour: 23, minute: 0 }).map((t) => t.hour), [23])
})

test('nextRunAt: with no history, the next fire of the slot or one of its same-day retries', () => {
  const slot = { weekday: 3, hour: 12, minute: 0 } // Wednesday
  // Tuesday 2026-10-27 12:00 -> Wednesday the 28th 12:00
  assert.equal(nextRunAt({ slot, state: emptyState(), now: at(2026, 10, 27, 12) }), at(2026, 10, 28, 12))
  // Wednesday 12:30 (slot passed, never ran) -> the 14:00 retry counts.
  assert.equal(nextRunAt({ slot, state: emptyState(), now: at(2026, 10, 28, 12, 30) }), at(2026, 10, 28, 14))
  // Wednesday 21:00 -> past every fire, and there is no next-day retry: next Wednesday.
  assert.equal(nextRunAt({ slot, state: emptyState(), now: at(2026, 10, 28, 21) }), at(2026, 11, 4, 12))
  // Thursday: next Wednesday.
  assert.equal(nextRunAt({ slot, state: emptyState(), now: at(2026, 10, 29, 10) }), at(2026, 11, 4, 12))
})

test('nextRunAt: after a run it waits for the cadence, then the next fire', () => {
  const slot = { weekday: 3, hour: 12, minute: 0 }
  const finished = at(2026, 10, 28, 12, 40)
  const state = stateWith(done(new Date(finished).toISOString()))
  assert.equal(nextRunAt({ slot, state, now: at(2026, 10, 29, 9) }), at(2026, 11, 4, 12))
})

test('nextRunAt: null without a slot', () => {
  assert.equal(nextRunAt({ slot: null, state: emptyState(), now: 0 }), null)
})

// ── records ──

test('reconcileRuns turns a dead run into interrupted', () => {
  const now = at(2026, 10, 26, 9)
  const s = stateWith(newRun({ id: 'a', trigger: 'scheduled', now: now - HOUR }))
  const r = reconcileRuns(s, { now })
  assert.equal(r.runs[0].status, 'interrupted')
  assert.ok(r.runs[0].finishedAt)
})

test('upsertRun replaces by id and keeps only the newest records', () => {
  let s = emptyState()
  for (let i = 0; i < MAX_RUNS_KEPT + 5; i++) s = upsertRun(s, { ...done(new Date(i * DAY).toISOString()), id: `r${i}` })
  assert.equal(s.runs.length, MAX_RUNS_KEPT)
  assert.equal(s.runs.at(-1).id, `r${MAX_RUNS_KEPT + 4}`)
  s = upsertRun(s, { ...s.runs.at(-1), status: 'failed' })
  assert.equal(s.runs.length, MAX_RUNS_KEPT)
  assert.equal(s.runs.at(-1).status, 'failed')
})

test('finalStatus: required stage failure fails the run, eval failures only degrade it', () => {
  assert.equal(finalStatus([{ name: 'scan', status: 'failed' }], {}), 'failed')
  assert.equal(finalStatus([{ name: 'scan', status: 'ok' }, { name: 'evaluate', status: 'ok' }], { evalFailed: 2 }), 'completed-with-errors')
  assert.equal(finalStatus([{ name: 'jobspy', status: 'failed', required: false }], {}), 'completed-with-errors')
  assert.equal(finalStatus([{ name: 'scan', status: 'ok' }], { evalFailed: 0 }), 'completed')
})

test('summarizeRun gives one readable line', () => {
  assert.equal(summarizeRun(null), 'no runs yet')
  assert.equal(
    summarizeRun({ status: 'completed', summary: { scanNew: 12, queued: 8, evalCompleted: 8, evalFailed: 1 } }),
    '12 new listings, 8 queued for evaluation, 8 evaluated, 1 failed',
  )
  assert.match(summarizeRun({ status: 'failed', stages: [{ name: 'scan', status: 'failed' }], error: 'offline' }), /failed at scan: offline/)
})

test('normalizeState survives garbage', () => {
  assert.deepEqual(normalizeState(null), emptyState())
  assert.deepEqual(normalizeState({ slot: { weekday: 9, hour: 1 }, runs: 'x' }), emptyState())
  const s = normalizeState({ enabled: true, slot: { weekday: 2, hour: 9 }, runs: [{ startedAt: 'x' }, 5, null] })
  assert.equal(s.enabled, true)
  assert.deepEqual(s.slot, { weekday: 2, hour: 9, minute: 0 })
  assert.equal(s.runs.length, 1)
})

// ── state file + lock (real files) ──

test('updateState writes atomically through the data link and readState reads it back', () => {
  const root = tmpRoot()
  const priv = mkdtempSync(join(tmpdir(), 'sched-priv-'))
  try {
    rmSync(join(root, 'data'), { recursive: true })
    symlinkSync(priv, join(root, 'data'))
    updateState(root, (s) => ({ ...s, enabled: true, slot: { weekday: 2, hour: 9, minute: 0 } }))
    assert.ok(existsSync(join(priv, 'scheduled-runs.json')), 'landed in the linked folder')
    assert.equal(readState(root).slot.hour, 9)
    updateState(root, (s) => upsertRun(s, done('2026-10-20T08:00:00.000Z')))
    assert.equal(readState(root).runs.length, 1)
    assert.equal(readState(root).enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(priv, { recursive: true, force: true })
  }
})

test('readState on a missing or corrupt file is the empty state', () => {
  const root = tmpRoot()
  try {
    assert.deepEqual(readState(root), emptyState())
    updateState(root, (s) => s)
    // corrupt it
    writeFileSync(join(root, 'data', 'scheduled-runs.json'), '{ nope')
    assert.deepEqual(readState(root), emptyState())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the run lock stops a second run and releases cleanly', () => {
  const root = tmpRoot()
  try {
    const a = acquireRunLock(root)
    assert.ok(a)
    assert.equal(isRunLocked(root), true)
    assert.equal(acquireRunLock(root), null, 'second run is refused while the first holds it')
    a.release()
    assert.equal(isRunLocked(root), false)
    const b = acquireRunLock(root)
    assert.ok(b, 'free again after release')
    b.release()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a lock left by a dead process is reclaimed', () => {
  const root = tmpRoot()
  try {
    const lock = runLockPath(root)
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483646, token: 'dead', host: hostname(), label: 'old', at: Date.now() }))
    const h = acquireRunLock(root)
    assert.ok(h, 'stale lock from a dead pid is taken over')
    h.release()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── plist + slot ──

test('buildPlist has the slot plus the same-day retries, absolute paths and a minimal env', () => {
  const plist = buildPlist({
    nodePath: '/opt/homebrew/bin/node',
    scriptPath: '/work/repo/scripts/scheduled-run.mjs',
    root: '/work/repo',
    slot: { weekday: 3, hour: 12, minute: 30 },
    pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
    home: '/Users/someone',
    logPath: '/work/repo/data/scheduled-runs.log',
  })
  assert.match(plist, new RegExp(`<string>${LABEL}</string>`))
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>\/work\/repo\/scripts\/scheduled-run\.mjs<\/string>\s*<string>run<\/string>/)
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/work\/repo<\/string>/)
  // Wednesday only (no next-day retries), at 12:30 and every 2 hours after.
  const weekdays = [...plist.matchAll(/<key>Weekday<\/key><integer>(\d)<\/integer>/g)].map((m) => Number(m[1]))
  assert.deepEqual(weekdays, [3, 3, 3, 3, 3])
  const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]))
  assert.deepEqual(hours, [12, 14, 16, 18, 20])
  assert.equal([...plist.matchAll(/<key>Minute<\/key><integer>30<\/integer>/g)].length, 5)
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
})

test('buildPlist escapes XML in paths and rejects a bad slot', () => {
  const plist = buildPlist({
    nodePath: '/n', scriptPath: '/a&b/<s>.mjs', root: '/r', slot: { weekday: 1, hour: 1, minute: 0 },
    pathEnv: '/x', home: '/h', logPath: '/l',
  })
  assert.match(plist, /\/a&amp;b\/&lt;s&gt;\.mjs/)
  assert.throws(() => buildPlist({ nodePath: '/n', scriptPath: '/s', root: '/r', slot: { weekday: 9, hour: 1 }, pathEnv: '', home: '', logPath: '' }))
})

test('parseSlot accepts names, numbers and short times', () => {
  assert.deepEqual(parseSlot('tue 09:00'), { weekday: 2, hour: 9, minute: 0 })
  assert.deepEqual(parseSlot('Thursday 7'), { weekday: 4, hour: 7, minute: 0 })
  assert.deepEqual(parseSlot('0 18:45'), { weekday: 0, hour: 18, minute: 45 })
  assert.equal(parseSlot('someday 9'), null)
  assert.equal(parseSlot('tue 25:00'), null)
  assert.equal(parseSlot(''), null)
})
