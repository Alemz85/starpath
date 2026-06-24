// cache-tsv.mjs — small TSV read/write helpers shared by the three caches
// (col-cache, tax-cache, comp-cache). Each cache file lives in data/ with
// a fixed header row; rows are tab-separated, no escaping (the values we
// store are simple — city/country names, numbers, ISO dates).
//
// All cache helpers follow the same shape:
//
//   const row = await lookup({ ...keys })   → row object or null (miss / stale)
//   await append({ ...row })                → adds a row; never modifies existing rows
//
// Stale rows are NOT auto-deleted; the agent / future runs can refresh
// them, and history is preserved. The caller decides how stale is "too
// stale" via the `maxAgeDays` arg in lookup().

import { readFile, writeFile, appendFile } from 'fs/promises'
import { existsSync } from 'fs'
import { resolve } from 'path'

const REPO = process.cwd()  // assume invoked from repo root

/** Read a TSV file into an array of row objects keyed by header. */
export async function readTsv(relativePath) {
  const path = resolve(REPO, relativePath)
  if (!existsSync(path)) return { headers: [], rows: [] }
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = lines[0].split('\t')
  const rows = lines.slice(1).map(line => {
    const cells = line.split('\t')
    const row = {}
    headers.forEach((h, i) => { row[h] = cells[i] ?? '' })
    return row
  })
  return { headers, rows }
}

/** Append one row to a TSV file; creates the file with header if missing. */
export async function appendTsv(relativePath, headers, row) {
  const path = resolve(REPO, relativePath)
  if (!existsSync(path)) {
    await writeFile(path, headers.join('\t') + '\n')
  }
  const cells = headers.map(h => String(row[h] ?? ''))
  await appendFile(path, cells.join('\t') + '\n')
}

/**
 * Returns true if `iso` (YYYY-MM-DD) is within `days` of today.
 *
 * `now` is injectable (defaults to the wall clock) so the freshness
 * boundary is deterministically testable — the same pattern the renderer
 * libs use for clock-dependent pure functions.
 */
export function isFresh(iso, days, now = new Date()) {
  if (!iso) return false
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return false
  const ageDays = (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24)
  return ageDays <= days
}

/** Today as ISO date (YYYY-MM-DD). `now` injectable for testing. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10)
}
