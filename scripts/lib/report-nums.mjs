/**
 * report-nums.mjs — row numbers claimed before an evaluation runs.
 *
 * A tracker row number (`{num}` in a scouting or tracker TSV) used to be
 * picked by each worker from the tracker's current max, and fixed up with
 * `++maxNum` at merge time — two concurrent evaluations could pick the same
 * one. Now a worker claims its number first: the claim is a sentinel file
 * created with O_EXCL (`wx`), so exactly one claimant gets each number.
 *
 * Sentinels live beside the tracker's real file (so per profile) in
 * `.reserved-nums/<tracker>/<num>`; their body is JSON { pid, by, at }.
 * The next number is one past the highest of: the tracker's rows, existing
 * sentinels, numbered report files under `reports/` (legacy `{num}-slug.md`
 * names) and an optional floor. The merge scripts keep a reserved number
 * even when a higher one merged first, and release sentinels once merged.
 *
 * Unit-tested in report-nums.test.mjs.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveWriteTarget } from './write-file-atomic.mjs'

export const TRACKERS = {
  scouting: 'data/scouting.md',
  applications: 'data/applications.md',
}

/** The sentinel folder for a tracker file (resolved through links). */
export function reservedDirFor(trackerFile) {
  const real = resolveWriteTarget(trackerFile)
  return join(dirname(real), '.reserved-nums', basename(real).replace(/\.md$/, ''))
}

/** Row numbers in a markdown tracker table (first cell of each data row). */
export function trackerNums(raw) {
  const nums = []
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line)
    if (m) nums.push(Number(m[1]))
  }
  return nums
}

/** Reserved numbers currently held in `dir`. */
export function reservedNums(dir) {
  try {
    return readdirSync(dir).filter((f) => /^\d+$/.test(f)).map(Number)
  } catch { return [] }
}

/** Highest `{num}-…md` prefix among report files under `reportsDir` (recursive, through links). */
export function maxReportFileNum(reportsDir) {
  let max = 0
  const walk = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      let isDir = e.isDirectory()
      if (e.isSymbolicLink()) { try { isDir = statSync(p).isDirectory() } catch { continue } }
      if (isDir) { if (depth < 4) walk(p, depth + 1); continue }
      const m = /^(\d+)-.*\.md$/.exec(e.name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  if (reportsDir) walk(reportsDir, 0)
  return max
}

/** The floor a new reservation must exceed. */
export function currentFloor({ trackerFile, reportsDir = null, min = 0 }) {
  const raw = existsSync(trackerFile) ? readFileSync(trackerFile, 'utf-8') : ''
  const dir = reservedDirFor(trackerFile)
  return Math.max(0, min, ...trackerNums(raw), ...reservedNums(dir), maxReportFileNum(reportsDir))
}

/**
 * Claim the next free number. Returns { num, sentinel }. Safe under
 * concurrency: losers of a race on one number move on to the next.
 */
export function reserveNum({ trackerFile, reportsDir = null, min = 0, by = '' }) {
  const dir = reservedDirFor(trackerFile)
  mkdirSync(dir, { recursive: true })
  let n = currentFloor({ trackerFile, reportsDir, min }) + 1
  for (let tries = 0; tries < 10_000; tries++, n++) {
    const sentinel = join(dir, String(n))
    let fd
    try {
      fd = openSync(sentinel, 'wx')
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, by, at: new Date().toISOString() }) + '\n')
    } finally { closeSync(fd) }
    return { num: n, sentinel }
  }
  throw new Error(`report-nums: could not reserve a number above ${n}`)
}

export function isReserved(trackerFile, num) {
  return existsSync(join(reservedDirFor(trackerFile), String(num)))
}

/** Drop a reservation (after its row merged, or the evaluation was abandoned). */
export function releaseNum(trackerFile, num) {
  const p = join(reservedDirFor(trackerFile), String(num))
  if (!existsSync(p)) return false
  rmSync(p, { force: true })
  return true
}

/**
 * Remove reservations older than `days` (workers that never merged). Their
 * numbers are not reused: the floor only moves up.
 */
export function gcReservations(trackerFile, { days = 7, now = Date.now() } = {}) {
  const dir = reservedDirFor(trackerFile)
  const removed = []
  for (const n of reservedNums(dir)) {
    const p = join(dir, String(n))
    try {
      if (now - statSync(p).mtimeMs > days * 86_400_000) { rmSync(p, { force: true }); removed.push(n) }
    } catch { /* gone already */ }
  }
  return removed
}

/**
 * Which number a merged TSV row gets. Its own number stands when no row has
 * it yet and it is either above the current max or a reservation (a worker
 * that reserved early can merge after one that reserved later). Otherwise the
 * next number past the max, as before.
 */
export function pickEntryNum({ wanted, taken, maxNum, reserved }) {
  if (Number.isInteger(wanted) && wanted > 0 && !taken.has(wanted) && (wanted > maxNum || reserved)) return wanted
  return maxNum + 1
}
