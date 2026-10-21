#!/usr/bin/env node
/**
 * sweep-batch-work.mjs — delete stale worker scratch from batch/work/.
 *
 * Workers write their score-listing inputs, row files and saved postings to
 * batch/work/. The batch runner deletes each worker's files when it finishes;
 * the app's evaluation spawns had nobody to do that, so the folder grew run
 * after run and a new run could open a file an earlier one left under the
 * same name. The app runs this before every evaluation spawn.
 *
 * Usage: node scripts/sweep-batch-work.mjs [--hours 24] [--dry-run]
 *   Deletes plain files directly in batch/work/ last modified more than
 *   --hours ago (default 24, far longer than any run), never folders.
 */

import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRootFrom } from './lib/data-root.mjs'

/** Pure: which entries are stale. `entries` = [{ name, isFile, mtimeMs }]. */
export function staleEntries(entries, { now = Date.now(), hours = 24 } = {}) {
  const cutoff = now - hours * 3600_000
  return entries.filter((e) => e.isFile && e.mtimeMs < cutoff && !e.name.startsWith('.')).map((e) => e.name)
}

export function sweepBatchWork(dir, { now = Date.now(), hours = 24, dryRun = false } = {}) {
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir).map((name) => {
    const st = statSync(join(dir, name))
    return { name, isFile: st.isFile(), mtimeMs: st.mtimeMs }
  })
  const stale = staleEntries(entries, { now, hours })
  if (!dryRun) for (const name of stale) unlinkSync(join(dir, name))
  return stale
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--hours')
  const hours = i === -1 ? 24 : Number(argv[i + 1])
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('--hours must be a positive number')
    process.exit(2)
  }
  const dryRun = argv.includes('--dry-run')
  const removed = sweepBatchWork(join(repoRootFrom(import.meta.url), 'batch', 'work'), { hours, dryRun })
  console.log(`${dryRun ? 'would remove' : 'removed'} ${removed.length} stale file(s) from batch/work/`)
}
