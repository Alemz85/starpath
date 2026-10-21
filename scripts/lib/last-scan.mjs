/**
 * last-scan.mjs — the marker every completed scan leaves in data/last-scan.json.
 *
 * The weekly scheduled run fires only when NO scan of any kind happened in the
 * last 7 days: the app's Full scan or API scan, a manual `node scripts/scan.mjs`
 * or an earlier scheduled run. They all run scan.mjs, so scan.mjs records its
 * own end here and the scheduler (schedule-core.mjs › decideRun) reads it.
 *
 * A marker beats deriving the date from scan-history.tsv: that file only gains
 * dates when a scan finds a posting it already knows or a new one, so a scan
 * that finds nothing leaves no trace, and its dates are days, not moments.
 *
 *   { "version": 1, "at": "<ISO time the scan ended>", "ok": true,
 *     "boards": <fetched>, "errors": <failed>, "added": <new offers>, "source": "scan.mjs" }
 *
 * `ok` is true when at least one board answered; a scan where every board
 * failed (offline, blocked) did not really scan and does not count. A dry run
 * writes nothing. The file lives in data/ (a link into private/), written
 * atomically.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './write-file-atomic.mjs'

export const LAST_SCAN_REL = 'data/last-scan.json'

/** The marker for a scan that just ended. `boards` = boards fetched, `errors` = how many of them failed. */
export function buildLastScan({ now = Date.now(), boards = 0, errors = 0, added = 0 } = {}) {
  return {
    version: 1,
    at: new Date(now).toISOString(),
    ok: boards > 0 && errors < boards,
    boards,
    errors,
    added,
    source: 'scan.mjs',
  }
}

/** Write the marker under `root` (default: the current directory). */
export function writeLastScan(marker, root = '.') {
  writeFileAtomic(join(root, LAST_SCAN_REL), JSON.stringify(marker, null, 2) + '\n')
}

/** Tolerant read: `{at (epoch ms), ok, ...}` or null when missing, unreadable or malformed. */
export function readLastScan(root = '.') {
  try {
    const raw = JSON.parse(readFileSync(join(root, LAST_SCAN_REL), 'utf8'))
    const at = Date.parse(raw?.at)
    if (!Number.isFinite(at)) return null
    return { at, ok: raw.ok !== false, boards: raw.boards ?? null, errors: raw.errors ?? null, added: raw.added ?? null }
  } catch {
    return null
  }
}
