// status-ledger.test.mjs — the single status write path: validation, the
// applications.md rewrite through a profile link, the ledger append, history
// and the idempotent backfill. Fixtures are fictional.
//
// Run: node --test scripts/lib/status-ledger.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { lstatSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEDGER_COLUMNS, amendStatus, amendStatusAsync, backfill, canonicalStatus, dateError, ledgerPathFor, loadStates, parseLedger,
  planAmend, planBackfill, planStatusChange, readHistory, setStatus, setStatusAsync,
} from './status-ledger.mjs'
import { APPLICATIONS_SCAFFOLD } from './profile-core.mjs'
import { parseAppRow } from './tracker-core.mjs'
import { lockPathFor, tryAcquire } from './dir-lock.mjs'

const STATES = fileURLToPath(new URL('../../templates/states.yml', import.meta.url))
const CLI = fileURLToPath(new URL('../set-status.mjs', import.meta.url))
const NOW = new Date('2026-07-10T12:00:00')

const ROWS = [
  '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst | W8.5 E7.5 | Applied | ✅ | 2026-07-15 | [1](reports/tier-1/a.md) | sent |',
  '| 2 | 2026-06-03 | Contoso Labs | Ops Analyst | W7.0 E6.0 | Evaluated | ❌ | n/d | [2](reports/tier-2/b.md) |  |',
  '| 3 | 2026-06-05 | Fabrikam Energy | Data Analyst | W6.5 E6.5 | Interview | ❌ | n/d | — | round 2 |',
]

/** A data root whose data/applications.md is a link into a profile, as with profiles. */
function makeRoot({ linked = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'starpath-ledger-'))
  const body = APPLICATIONS_SCAFFOLD + ROWS.join('\n') + '\n'
  mkdirSync(join(root, 'data'), { recursive: true })
  if (linked) {
    mkdirSync(join(root, 'profiles/main/data'), { recursive: true })
    writeFileSync(join(root, 'profiles/main/data/applications.md'), body)
    symlinkSync('../profiles/main/data/applications.md', join(root, 'data/applications.md'))
  } else {
    writeFileSync(join(root, 'data/applications.md'), body)
  }
  return { root, appsFile: join(root, 'data/applications.md') }
}

const rowOf = (appsFile, num) => readFileSync(appsFile, 'utf-8').split('\n').map(parseAppRow).find((r) => r?.num === num)
const ledger = (appsFile) => parseLedger(readFileSync(ledgerPathFor(appsFile), 'utf-8'))

test('states come from templates/states.yml, aliases included', () => {
  const states = loadStates(STATES)
  assert.deepEqual(states.map((s) => s.label), ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'])
  assert.equal(canonicalStatus('rejected', states), 'Rejected')
  assert.equal(canonicalStatus('rechazada', states), 'Rejected')
  assert.equal(canonicalStatus('**Applied**', states), 'Applied')
  assert.equal(canonicalStatus('Ghosted', states), null)
})

test('dateError accepts today and past dates only', () => {
  assert.equal(dateError('2026-07-10', '2026-07-10'), null)
  assert.equal(dateError('2026-05-02', '2026-07-10'), null)
  assert.match(dateError('2026-07-11', '2026-07-10'), /future/)
  assert.match(dateError('2026-02-30', '2026-07-10'), /not a real date/)
  assert.match(dateError('10/07/2026', '2026-07-10'), /YYYY-MM-DD/)
})

test('planStatusChange rewrites only the Status cell and reports from → to', () => {
  const raw = APPLICATIONS_SCAFFOLD + ROWS.join('\n')
  const { raw: next, changes } = planStatusChange(raw, { num: 1 }, 'Rejected')
  assert.deepEqual(changes, [{ num: 1, company: 'Nimbus Robotics', role: 'Strategy Analyst', from: 'Applied', to: 'Rejected' }])
  const row = next.split('\n').map(parseAppRow).find((r) => r?.num === 1)
  assert.equal(row.status, 'Rejected')
  assert.equal(row.notes, 'sent')
  assert.equal(row.deadline, '2026-07-15')
  assert.equal(next.split('\n').length, raw.split('\n').length)
  assert.throws(() => planStatusChange(raw, { num: 9 }, 'Applied'), (e) => e.code === 'ENOAPP')
  assert.throws(() => planStatusChange(raw, { num: 1, company: 'Contoso Labs', role: 'Ops Analyst' }, 'Applied'), (e) => e.code === 'EMISMATCH')
})

test('setStatus writes through the profile link and appends one ledger row', () => {
  const { root, appsFile } = makeRoot()
  try {
    const r = setStatus({ appsFile, statesFile: STATES, num: 1, to: 'rejected', date: '2026-07-01', stage: 'after first interview', note: 'form email', now: NOW })
    assert.equal(r.changed, true)
    assert.ok(lstatSync(appsFile).isSymbolicLink(), 'data/applications.md is still a link')
    assert.equal(rowOf(appsFile, 1).status, 'Rejected')
    assert.equal(ledgerPathFor(appsFile), join(realpathSync(join(root, 'profiles/main/data')), 'status-log.tsv'))
    const { header, rows } = ledger(appsFile)
    assert.deepEqual(header, LEDGER_COLUMNS)
    assert.equal(rows.length, 1)
    assert.deepEqual(
      { num: rows[0].num, date: rows[0].date, from: rows[0].from, to: rows[0].to, stage: rows[0].stage, source: rows[0].source, note: rows[0].note, company: rows[0].company },
      { num: 1, date: '2026-07-01', from: 'Applied', to: 'Rejected', stage: 'after first interview', source: 'cli', note: 'form email', company: 'Nimbus Robotics' },
    )
    assert.ok(!existsSync(lockPathFor(appsFile)), 'lock released')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setStatus by company + role; same status is a no-op; bad input is refused', () => {
  const { root, appsFile } = makeRoot({ linked: false })
  try {
    const r = setStatus({ appsFile, statesFile: STATES, company: 'contoso labs', role: 'ops analyst', to: 'Applied', source: 'app', now: NOW })
    assert.equal(r.entries[0].num, 2)
    assert.equal(r.date, '2026-07-10', 'date defaults to today')
    const again = setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Applied', now: NOW })
    assert.equal(again.changed, false)
    assert.equal(ledger(appsFile).rows.length, 1)
    assert.throws(() => setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Ghosted', now: NOW }), (e) => e.code === 'EBADSTATUS')
    assert.throws(() => setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Offer', date: '2026-08-01', now: NOW }), (e) => e.code === 'EBADDATE')
    assert.throws(() => setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Offer', source: 'renderer', now: NOW }), (e) => e.code === 'EBADSOURCE')
    assert.equal(rowOf(appsFile, 2).status, 'Applied', 'refused changes leave the file alone')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('stage and note cannot break the TSV or the table', () => {
  const { root, appsFile } = makeRoot({ linked: false })
  try {
    setStatus({ appsFile, statesFile: STATES, num: 3, to: 'Rejected', stage: 'final\tround', note: 'line one\nline two', now: NOW })
    const { rows } = ledger(appsFile)
    assert.equal(rows[0].stage, 'final round')
    assert.equal(rows[0].note, 'line one line two')
    assert.equal(rows[0].to, 'Rejected')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setStatusAsync waits for the tracker lock', async () => {
  const { root, appsFile } = makeRoot()
  try {
    const held = tryAcquire(lockPathFor(appsFile), { label: 'merge-tracker' })
    let done = false
    const p = setStatusAsync({ appsFile, statesFile: STATES, num: 2, to: 'Applied', source: 'app', now: NOW }).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(done, false, 'blocked while the merge holds the lock')
    assert.equal(rowOf(appsFile, 2).status, 'Evaluated')
    held.release()
    const r = await p
    assert.equal(r.changed, true)
    assert.equal(rowOf(appsFile, 2).status, 'Applied')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('history is per application and chronological by event date', () => {
  const { root, appsFile } = makeRoot()
  try {
    setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Applied', date: '2026-06-20', now: NOW })
    setStatus({ appsFile, statesFile: STATES, num: 1, to: 'Interview', date: '2026-06-25', now: NOW })
    setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Interview', date: '2026-07-02', now: NOW })
    // logged late, but it happened before the interview
    setStatus({ appsFile, statesFile: STATES, num: 2, to: 'Responded', date: '2026-06-28', now: NOW })
    const h = readHistory({ appsFile, num: 2 })
    assert.deepEqual(h.map((e) => `${e.date} ${e.from}>${e.to}`), [
      '2026-06-20 Evaluated>Applied', '2026-06-28 Interview>Responded', '2026-07-02 Applied>Interview',
    ])
    assert.equal(readHistory({ appsFile, company: 'Contoso Labs', role: 'Ops Analyst' }).length, 3)
    assert.equal(readHistory({ appsFile }).length, 4)
    assert.equal(readHistory({ appsFile, num: 3 }).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('backfill adds one origin row per application and is idempotent', () => {
  const { root, appsFile } = makeRoot()
  try {
    // A change logged before the backfill: the origin is the status before it.
    setStatus({ appsFile, statesFile: STATES, num: 3, to: 'Rejected', date: '2026-06-30', now: NOW })
    const first = backfill({ appsFile, now: NOW })
    assert.deepEqual(first.map((e) => [e.num, e.from, e.to, e.date, e.source]), [
      [1, '', 'Applied', '2026-06-01', 'backfill'],
      [2, '', 'Evaluated', '2026-06-03', 'backfill'],
      [3, '', 'Interview', '2026-06-05', 'backfill'],
    ])
    assert.deepEqual(backfill({ appsFile, now: NOW }), [], 'second run adds nothing')
    assert.throws(() => backfill({ appsFile: join(root, 'nope/applications.md') }), (e) => e.code === 'ENOAPP')
    assert.ok(!existsSync(join(root, 'nope')), 'a missing tracker leaves no lock folder behind')
    assert.equal(ledger(appsFile).rows.length, 4)
    assert.deepEqual(readHistory({ appsFile, num: 3 }).map((e) => e.to), ['Interview', 'Rejected'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planBackfill skips applications that already have an origin row', () => {
  const raw = APPLICATIONS_SCAFFOLD + ROWS.join('\n')
  const ledgerRows = parseLedger(LEDGER_COLUMNS.join('\t') + '\n1\t2026-06-01\tNimbus Robotics\tStrategy Analyst\t\tEvaluated\t\tmerge-tracker\t\t2026-06-01T00:00:00Z\n').rows
  assert.deepEqual(planBackfill(raw, ledgerRows, { now: NOW }).map((e) => e.num), [2, 3])
})

test('CLI: change, history and backfill end to end', () => {
  const { root, appsFile } = makeRoot()
  try {
    const env = { ...process.env, CAREER_OPS_ROOT: root }
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8' })
    let r = run('1', 'Offer', '--date', '2026-06-30', '--note', 'verbal')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /#1 Nimbus Robotics — Strategy Analyst: Applied → Offer/)
    r = run('--company', 'Contoso Labs', '--role', 'Ops Analyst', 'Discarded', '--json')
    assert.equal(JSON.parse(r.stdout).entries[0].num, 2)
    r = run('7', 'Applied')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /#7 is not in applications\.md/)
    r = run('backfill')
    assert.match(r.stdout, /added 3 origin row/)
    r = run('history', '1', '--json')
    assert.deepEqual(JSON.parse(r.stdout).map((e) => e.to), ['Applied', 'Offer'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('concurrent CLI changes to different rows all land, each logged once', async () => {
  const { root, appsFile } = makeRoot()
  try {
    const env = { ...process.env, CAREER_OPS_ROOT: root }
    const jobs = [['1', 'Interview'], ['2', 'Applied'], ['3', 'Offer']].map(([n, s]) => new Promise((res, rej) => {
      const p = spawn(process.execPath, [CLI, n, s], { env })
      let err = ''
      p.stderr.on('data', (d) => { err += d })
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(err))))
    }))
    await Promise.all(jobs)
    assert.deepEqual([1, 2, 3].map((n) => rowOf(appsFile, n).status), ['Interview', 'Applied', 'Offer'])
    assert.equal(ledger(appsFile).rows.length, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('amendStatus corrects the date and stage of the latest move to a status, keeping logged_at', () => {
  const { root, appsFile } = makeRoot()
  try {
    setStatus({ appsFile, statesFile: STATES, num: 1, to: 'Rejected', date: '2026-07-01', source: 'app', now: NOW })
    const before = ledger(appsFile).rows.find((e) => e.to === 'Rejected')
    const out = amendStatus({ appsFile, statesFile: STATES, num: 1, to: 'rejected', date: '2026-06-20', stage: 'after the final round', source: 'app', now: NOW })
    assert.equal(out.changed, true)
    const rows = ledger(appsFile).rows
    assert.equal(rows.length, 1, 'edited in place, nothing appended')
    assert.equal(rows[0].date, '2026-06-20')
    assert.equal(rows[0].stage, 'after the final round')
    assert.equal(rows[0].logged_at, before.logged_at)
    assert.match(rows[0].note, /corrected 2026-07-10/)
    assert.equal(rowOf(appsFile, 1).status, 'Rejected', 'applications.md untouched')
    // Same values again: no change, no second note.
    assert.equal(amendStatus({ appsFile, statesFile: STATES, num: 1, to: 'Rejected', date: '2026-06-20', source: 'app', now: NOW }).changed, false)
    // Clearing the stage.
    amendStatus({ appsFile, statesFile: STATES, company: 'nimbus robotics', role: 'strategy analyst', to: 'Rejected', stage: '', source: 'app', now: NOW })
    assert.equal(ledger(appsFile).rows[0].stage, '')
    assert.equal(ledger(appsFile).rows[0].note.match(/corrected/g).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('amendStatus refuses a future date and a status the application never had', () => {
  const { root, appsFile } = makeRoot()
  try {
    setStatus({ appsFile, statesFile: STATES, num: 1, to: 'Rejected', source: 'app', now: NOW })
    assert.throws(() => amendStatus({ appsFile, statesFile: STATES, num: 1, to: 'Rejected', date: '2026-08-01', now: NOW }), { code: 'EBADDATE' })
    assert.throws(() => amendStatus({ appsFile, statesFile: STATES, num: 2, to: 'Rejected', date: '2026-07-01', now: NOW }), { code: 'ENOENTRY' })
    assert.throws(() => amendStatus({ appsFile, statesFile: STATES, num: 9, to: 'Rejected', date: '2026-07-01', now: NOW }), { code: 'ENOAPP' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planAmend records a rejection older than the log as one origin-style entry', () => {
  const app = { num: 4, company: 'Tailspin Toys', role: 'Buyer', status: 'Rejected' }
  const plan = planAmend([], app, 'Rejected', { date: '2026-05-02', stage: 'after the case study', source: 'app' }, { now: NOW })
  assert.equal(plan.appended, true)
  assert.equal(plan.entry.from, '')
  assert.equal(plan.entry.date, '2026-05-02')
  assert.equal(plan.entry.stage, 'after the case study')
  assert.equal(plan.entry.source, 'app')
})

test('amendStatusAsync appends to a ledger that does not exist yet', async () => {
  const { root, appsFile } = makeRoot({ linked: false })
  try {
    // Row 3 is at Interview; pretend it was rejected before the log existed.
    writeFileSync(appsFile, readFileSync(appsFile, 'utf-8').replace('| Interview |', '| Rejected |'))
    const out = await amendStatusAsync({ appsFile, statesFile: STATES, num: 3, to: 'Rejected', date: '2026-06-30', source: 'app', now: NOW })
    assert.equal(out.changed, true)
    const { header, rows } = ledger(appsFile)
    assert.deepEqual(header, LEDGER_COLUMNS)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].date, '2026-06-30')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
