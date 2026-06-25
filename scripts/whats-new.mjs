#!/usr/bin/env node
/**
 * whats-new.mjs — "What's new & worth my time since last scan" digest.
 *
 * After a scan run, this gives a quick read on what is *actually new* versus
 * noise, and which of the new postings are worth evaluation effort — without
 * the user scanning tabs. It is strictly READ-ONLY over the canonical data:
 *
 *   data/scan-history.tsv   — every posting the scanners surfaced (first_seen,
 *                             status, scan_dates)
 *   data/score-history.tsv  — every scouting evaluation (overall score keyed by url)
 *
 * It NEVER mutates any canonical file. All math lives in the pure core
 * scripts/lib/whats-new-core.mjs (unit-tested); this file is only I/O + render.
 *
 * Run:
 *   node scripts/whats-new.mjs                 human-readable digest (since last run)
 *   node scripts/whats-new.mjs --days 7        new in the last 7 days
 *   node scripts/whats-new.mjs --since 2026-06-01
 *   node scripts/whats-new.mjs --all           include scanner-filtered rows too
 *   node scripts/whats-new.mjs --json          structured JSON to stdout
 *   node scripts/whats-new.mjs --top 10        cap the printed list
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseScoreHistory } from './lib/targeting-core.mjs'
import {
  parseScanHistory,
  buildDigest,
  PRIORITY_LABELS,
} from './lib/whats-new-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCAN_FILE = join(ROOT, 'data/scan-history.tsv')
const SCORE_FILE = join(ROOT, 'data/score-history.tsv')

// --- CLI args ---
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const includeNoise = args.includes('--all')
const getVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}
const since = getVal('--since')
const daysRaw = getVal('--days')
const days = daysRaw != null && !Number.isNaN(Number(daysRaw)) ? Number(daysRaw) : null
const topRaw = getVal('--top')
const top = topRaw != null && !Number.isNaN(Number(topRaw)) ? Number(topRaw) : null

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const scanRows = parseScanHistory(read(SCAN_FILE))
const scoreRows = parseScoreHistory(read(SCORE_FILE))

if (scanRows.length === 0) {
  if (asJson) {
    process.stdout.write(JSON.stringify({ error: 'no-scan-history', items: [] }) + '\n')
  } else {
    console.log('No scan history found at data/scan-history.tsv — run a scan first.')
  }
  process.exit(0)
}

const digest = buildDigest(scanRows, scoreRows, { since, days, includeNoise })

if (asJson) {
  process.stdout.write(JSON.stringify(digest, null, 2) + '\n')
  process.exit(0)
}

// ── human-readable render ──────────────────────────────────────────────────
const BANDS = { strong: '★★', solid: '★', pass: '·', weak: '↓' }
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
const fmtScore = (it) =>
  it.overall != null ? `${it.overall.toFixed(1)} ${BANDS[it.band] || ''}`.trim() : '—'

const windowLabel =
  digest.basis === 'since' ? `since ${digest.cutoff}`
    : digest.basis === 'days' ? `last ${days} day(s) (since ${digest.cutoff})`
      : digest.basis === 'single-run' ? `first scan (${digest.cutoff})`
        : `since the previous scan (run ${digest.latestRun})`

console.log('')
console.log(`What's new — ${windowLabel}`)
console.log('─'.repeat(64))

if (digest.totalNew === 0) {
  console.log('Nothing new in this window.')
  console.log('')
  process.exit(0)
}

// one-line scoreboard
const c = digest.counts
const board = [
  c.prioritize ? `${c.prioritize} prioritize` : null,
  c.review ? `${c.review} worth-a-look` : null,
  c['needs-eval'] ? `${c['needs-eval']} needs-eval` : null,
  c.low ? `${c.low} low-fit` : null,
  includeNoise && c.noise ? `${c.noise} filtered` : null,
].filter(Boolean).join('  ·  ')
console.log(`${digest.totalNew} new posting(s):  ${board}`)
console.log('')

const list = top != null ? digest.items.slice(0, top) : digest.items
let lastPriority = null
for (const it of list) {
  if (it.priority !== lastPriority) {
    console.log(`  ${PRIORITY_LABELS[it.priority] || it.priority}`)
    lastPriority = it.priority
  }
  const age = it.ageDays != null ? `${it.ageDays}d` : ''
  const seen = it.timesSeen > 1 ? `×${it.timesSeen}` : ''
  console.log(
    `    ${pad(fmtScore(it), 7)} ${pad(it.company, 18)} ${pad(it.title, 40)} ` +
    `${pad(it.location, 14)} ${pad(age, 4)}${seen}`,
  )
}
if (top != null && digest.items.length > top) {
  console.log(`    … and ${digest.items.length - top} more (drop --top to see all)`)
}

// a tight "do this next" closer
console.log('')
if (digest.prioritize.length) {
  const names = digest.prioritize.slice(0, 5).map((i) => `${i.company} (${fmtScore(i)})`).join(', ')
  console.log(`Prioritize: ${names}${digest.prioritize.length > 5 ? ', …' : ''}`)
}
if (digest.needsEval.length) {
  console.log(`Evaluate next: ${digest.needsEval.length} new unscored posting(s) — run scouting on them.`)
}
console.log('')
