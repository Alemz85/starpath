// File side of the usage ledger: append one row per finished app spawn, read
// both ledgers for Settings › Token usage. The row format and parsing are the pure
// core in lib/usage.ts.

import { ipc } from '@/lib/ipc'
import {
  APP_USAGE_PATH,
  BATCH_USAGE_PATH,
  appUsageRow,
  appendUsageRow,
  parseUsageTsv,
  type AppUsageInput,
  type UsageEntry,
} from '@/lib/usage'

// Spawns can finish in the same tick; each append reads, adds a line and
// writes the whole (small) file back, so they run one after the other.
let queue: Promise<unknown> = Promise.resolve()

const listeners = new Set<() => void>()

/** Call `cb` after each row lands in the ledger; returns the unsubscribe. */
export function onUsageRecorded(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Append one finished spawn to batch/logs/app-usage.tsv. Never throws — the ledger is a convenience. */
export function recordAppUsage(entry: AppUsageInput): Promise<void> {
  const next = queue.then(async () => {
    const existing = await ipc.readFile(APP_USAGE_PATH).catch(() => null)
    await ipc.writeFile(APP_USAGE_PATH, appendUsageRow(existing, appUsageRow(entry)))
    listeners.forEach(cb => cb())
  })
  queue = next.catch(() => undefined)
  return next.catch(() => undefined)
}

/** Every recorded run, from the app's ledger and the batch runner's, newest first. */
export async function loadUsage(): Promise<UsageEntry[]> {
  const [app, batch] = await Promise.all([
    ipc.readFile(APP_USAGE_PATH).catch(() => null),
    ipc.readFile(BATCH_USAGE_PATH).catch(() => null),
  ])
  return [...parseUsageTsv(app, 'app'), ...parseUsageTsv(batch, 'batch')].sort((a, b) => b.at - a.at)
}
