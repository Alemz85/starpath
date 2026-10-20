#!/usr/bin/env node
/**
 * reserve-report-num.mjs — claim a tracker row number before evaluating.
 *
 * Every evaluation that writes a scouting (or tracker) TSV takes its `{num}`
 * from here instead of reading the tracker's max: the claim is an O_EXCL
 * sentinel, so concurrent workers can never get the same number. The batch
 * runner claims one per listing before it spawns the worker; the app's eval
 * prompts tell the worker to run this. Logic: lib/report-nums.mjs.
 *
 * Usage:
 *   node scripts/reserve-report-num.mjs [--tracker scouting|applications] [--by <label>] [--min N] [--json]
 *       prints the reserved number (3-digit padded unless --json)
 *   node scripts/reserve-report-num.mjs release <num> [--tracker …]
 *   node scripts/reserve-report-num.mjs list [--tracker …]
 *   node scripts/reserve-report-num.mjs gc [--days 7] [--tracker …]
 *
 * Paths resolve through the data root (CAREER_OPS_ROOT, then STARPATH_DATA /
 * private/ / this checkout).
 */

import { join } from 'node:path'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import {
  TRACKERS, gcReservations, releaseNum, reserveNum, reservedDirFor, reservedNums,
} from './lib/report-nums.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1]
}
const VALUE_FLAGS = new Set(['--tracker', '--by', '--min', '--days'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))

const tracker = flag('--tracker') || 'scouting'
if (!TRACKERS[tracker]) {
  console.error(`Unknown --tracker "${tracker}" (use ${Object.keys(TRACKERS).join(' | ')})`)
  process.exit(2)
}
const ROOT = process.env.CAREER_OPS_ROOT || dataRootFor(repoRootFrom(import.meta.url))
const trackerFile = join(ROOT, TRACKERS[tracker])
const [cmd = 'reserve', arg] = positional

if (cmd === 'reserve') {
  const min = Number(flag('--min') || 0)
  const { num } = reserveNum({ trackerFile, reportsDir: join(ROOT, 'reports'), min, by: flag('--by') || `pid:${process.ppid}` })
  if (argv.includes('--json')) console.log(JSON.stringify({ num, tracker }))
  else console.log(String(num).padStart(3, '0'))
} else if (cmd === 'release') {
  const n = Number(arg)
  if (!Number.isInteger(n) || n <= 0) { console.error('release needs a number'); process.exit(2) }
  console.log(releaseNum(trackerFile, n) ? `released ${n}` : `${n} was not reserved`)
} else if (cmd === 'list') {
  console.log(reservedNums(reservedDirFor(trackerFile)).sort((a, b) => a - b).join('\n'))
} else if (cmd === 'gc') {
  const removed = gcReservations(trackerFile, { days: Number(flag('--days') || 7) })
  console.log(removed.length ? `removed ${removed.length} stale reservation(s): ${removed.join(', ')}` : 'nothing to remove')
} else {
  console.error(`Unknown command "${cmd}". Use reserve | release <num> | list | gc.`)
  process.exit(2)
}
