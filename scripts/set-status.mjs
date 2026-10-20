#!/usr/bin/env node
/**
 * set-status.mjs — the single way to change an application's status.
 *
 * Validates the status against templates/states.yml, rewrites the row in
 * data/applications.md under the tracker lock, and appends the change to the
 * status log (status-log.tsv beside applications.md). The app's dropdown,
 * drag-and-drop and chat confirm cards call the same code
 * (lib/status-ledger.mjs) through IPC.
 *
 * Usage:
 *   node scripts/set-status.mjs <num> <status> [--date YYYY-MM-DD] [--stage "…"] [--note "…"]
 *   node scripts/set-status.mjs --company "Nimbus Robotics" --role "Strategy Analyst" <status> […]
 *   node scripts/set-status.mjs history <num> [--json]
 *   node scripts/set-status.mjs history [--json]          (the whole log)
 *   node scripts/set-status.mjs backfill [--dry-run]      (origin row per application, idempotent)
 *
 * --date defaults to today; a past date is fine (rejections are often logged
 * late). --stage is free text, e.g. where a rejection happened.
 * Paths resolve through the data root (CAREER_OPS_ROOT, then STARPATH_DATA /
 * private/ / this checkout).
 */

import { join } from 'node:path'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { backfill, ledgerPathFor, readHistory, setStatus } from './lib/status-ledger.mjs'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--date', '--stage', '--note', '--company', '--role', '--source'])
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))
const JSON_OUT = argv.includes('--json')

const REPO = repoRootFrom(import.meta.url)
const ROOT = process.env.CAREER_OPS_ROOT || dataRootFor(REPO)
const appsFile = join(ROOT, 'data/applications.md')
const statesFile = join(REPO, 'templates/states.yml')

function main() {
  const [first, second] = positional

  if (first === 'backfill') {
    const added = backfill({ appsFile, dryRun: argv.includes('--dry-run') })
    if (JSON_OUT) return console.log(JSON.stringify(added))
    const verb = argv.includes('--dry-run') ? 'would add' : 'added'
    console.log(added.length
      ? `${verb} ${added.length} origin row(s) to ${ledgerPathFor(appsFile)}`
      : 'every application already has an origin row')
    return
  }

  if (first === 'history') {
    const entries = readHistory({ appsFile, num: second ?? null, company: flag('--company') ?? null, role: flag('--role') ?? null })
    if (JSON_OUT) return console.log(JSON.stringify(entries))
    if (!entries.length) return console.log('no status history')
    for (const e of entries) {
      const move = e.from ? `${e.from} → ${e.to}` : `start: ${e.to}`
      const extra = [e.stage && `stage: ${e.stage}`, e.note].filter(Boolean).join(' · ')
      console.log(`#${e.num}  ${e.date}  ${move}  (${e.source})${extra ? '  ' + extra : ''}`)
    }
    return
  }

  const byName = flag('--company') !== undefined
  const num = byName ? null : first
  const to = byName ? first : second
  if (!to) {
    console.error('Usage: set-status.mjs <num> <status> [--date YYYY-MM-DD] [--stage "…"] [--note "…"]')
    process.exit(2)
  }
  const result = setStatus({
    appsFile, statesFile,
    num, company: flag('--company'), role: flag('--role'),
    to, date: flag('--date'), stage: flag('--stage'), note: flag('--note'),
    source: flag('--source') ?? 'cli',
  })
  if (JSON_OUT) return console.log(JSON.stringify(result))
  if (!result.changed) return console.log(`already ${result.to}; nothing changed`)
  for (const e of result.entries) console.log(`#${e.num} ${e.company} — ${e.role}: ${e.from} → ${e.to} (${e.date})`)
}

try {
  main()
} catch (e) {
  if (JSON_OUT) console.log(JSON.stringify({ error: e.message, code: e.code ?? null }))
  else console.error(`❌ ${e.message}`)
  process.exit(1)
}
