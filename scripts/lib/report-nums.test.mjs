// report-nums.test.mjs — number reservation: floor, O_EXCL claims under real
// concurrency, release/gc, and the merge-side pick rule.
//
// Run: node --test scripts/lib/report-nums.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  currentFloor, gcReservations, isReserved, maxReportFileNum, pickEntryNum, releaseNum,
  reserveNum, reservedDirFor, reservedNums, trackerNums,
} from './report-nums.mjs'
import { SCOUTING_SCAFFOLD } from './profile-core.mjs'

const CLI = fileURLToPath(new URL('../reserve-report-num.mjs', import.meta.url))

function makeRoot(rows = []) {
  const root = mkdtempSync(join(tmpdir(), 'starpath-nums-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'reports/tier-1'), { recursive: true })
  writeFileSync(join(root, 'data/scouting.md'), SCOUTING_SCAFFOLD + rows.map((n) => `| ${n} | 2026-06-01 | Nimbus Robotics | Analyst ${n} | 7 | 6 | T2 | green | — | n/d |  |  |`).join('\n') + '\n')
  return root
}

test('trackerNums reads the first cell of data rows only', () => {
  assert.deepEqual(trackerNums('| # | Date |\n|---|---|\n| 3 | x |\n| 12 | y |\ntext'), [3, 12])
})

test('the first reservation is one past the tracker max; the next one past that', () => {
  const root = makeRoot([4, 9])
  try {
    const file = join(root, 'data/scouting.md')
    assert.equal(currentFloor({ trackerFile: file }), 9)
    assert.equal(reserveNum({ trackerFile: file }).num, 10)
    assert.equal(reserveNum({ trackerFile: file }).num, 11)
    assert.deepEqual(reservedNums(reservedDirFor(file)).sort((a, b) => a - b), [10, 11])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('numbered report files under reports/tier-N (through a link) raise the floor', () => {
  const root = makeRoot([2])
  try {
    mkdirSync(join(root, 'private/reports/tier-2'), { recursive: true })
    writeFileSync(join(root, 'private/reports/tier-2/041-nimbus-2026-05-01.md'), '')
    writeFileSync(join(root, 'reports/tier-1/Nimbus Robotics - Analyst.md'), '')
    symlinkSync('../private/reports/tier-2', join(root, 'reports/tier-2'))
    assert.equal(maxReportFileNum(join(root, 'reports')), 41)
    assert.equal(reserveNum({ trackerFile: join(root, 'data/scouting.md'), reportsDir: join(root, 'reports') }).num, 42)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('release and gc drop sentinels; numbers are not handed out again', () => {
  const root = makeRoot([1])
  try {
    const file = join(root, 'data/scouting.md')
    const a = reserveNum({ trackerFile: file })
    const b = reserveNum({ trackerFile: file })
    assert.ok(isReserved(file, a.num))
    assert.equal(releaseNum(file, a.num), true)
    assert.equal(releaseNum(file, a.num), false)
    const old = (Date.now() - 10 * 86_400_000) / 1000
    utimesSync(b.sentinel, old, old)
    assert.deepEqual(gcReservations(file, { days: 7 }), [b.num])
    assert.equal(existsSync(b.sentinel), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pickEntryNum keeps a free reserved number even below the max', () => {
  const taken = new Set([1, 2, 5])
  assert.equal(pickEntryNum({ wanted: 6, taken, maxNum: 5, reserved: false }), 6)
  assert.equal(pickEntryNum({ wanted: 4, taken, maxNum: 5, reserved: true }), 4, 'reserved early, merged late')
  assert.equal(pickEntryNum({ wanted: 4, taken, maxNum: 5, reserved: false }), 6, 'unreserved and stale: renumber')
  assert.equal(pickEntryNum({ wanted: 5, taken, maxNum: 5, reserved: true }), 6, 'already used: renumber')
  assert.equal(pickEntryNum({ wanted: NaN, taken, maxNum: 5, reserved: false }), 6)
})

test('concurrency: parallel CLI claims never return the same number', async () => {
  const root = makeRoot([7])
  try {
    const N = 12
    const runs = Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
      const p = spawn(process.execPath, [CLI, '--json', '--by', `w${i}`], { env: { ...process.env, CAREER_OPS_ROOT: root } })
      let out = ''; let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('exit', (code) => (code === 0 ? res(JSON.parse(out).num) : rej(new Error(err))))
    }))
    const nums = await Promise.all(runs)
    assert.equal(new Set(nums).size, N, `duplicates in ${nums}`)
    assert.ok(nums.every((n) => n > 7))
    assert.equal(reservedNums(reservedDirFor(join(root, 'data/scouting.md'))).length, N)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--count N claims N numbers in one call, one per line (or {nums} with --json)', () => {
  const root = makeRoot([7])
  try {
    const env = { ...process.env, CAREER_OPS_ROOT: root }
    const lines = execFileSync(process.execPath, [CLI, '--count', '3'], { env, encoding: 'utf8' }).trim().split('\n')
    assert.deepEqual(lines, ['008', '009', '010'])
    const json = JSON.parse(execFileSync(process.execPath, [CLI, '--count', '2', '--json'], { env, encoding: 'utf8' }))
    assert.deepEqual(json.nums, [11, 12])
    assert.equal(JSON.parse(execFileSync(process.execPath, [CLI, '--json'], { env, encoding: 'utf8' })).num, 13, 'one claim keeps its {num} shape')
    assert.throws(() => execFileSync(process.execPath, [CLI, '--count', '0'], { env, stdio: 'pipe' }))
    assert.equal(reservedNums(reservedDirFor(join(root, 'data/scouting.md'))).length, 6)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
