#!/usr/bin/env node
/**
 * daily-brief.mjs — assemble a single dated "what should I do now?" brief.
 *
 * Several read-only analysis cores each answer one slice of the search; nothing
 * bundles them into one portable artifact you can read, cron, or email. This CLI
 * is that bundler. It is strictly READ-ONLY over all canonical data — it never
 * mutates a single tracked file.
 *
 * It composes (importing, never modifying) the existing cores:
 *   • scripts/lib/whats-new-core.mjs    — fresh high-fit postings since last scan
 *   • scripts/followup-cadence.mjs      — due/overdue application follow-ups
 *   • scripts/analyze-patterns.mjs      — one learned targeting lesson (outcomes)
 *   • scripts/outreach-core.mjs         — outreach threads where a nudge is due
 *   • scripts/lib/positioning-core.mjs  — one standing targeting insight
 *
 * The single "do this first" pick is ranked across ALL action sections by genuine
 * time-criticality (deadlines closing today > urgent follow-ups > overdue
 * follow-ups > outreach nudges > fresh postings), not by section position.
 *
 * All ranking/sectioning/rendering lives in the pure, unit-tested
 * scripts/lib/daily-brief-core.mjs; this file is only I/O + invocation.
 *
 * Run:
 *   node scripts/daily-brief.mjs                 print the brief to stdout (daily)
 *   node scripts/daily-brief.mjs --weekly        weekly framing + 7-day new-hits window
 *   node scripts/daily-brief.mjs --write         also write reports/briefs/{date}-brief.md
 *   node scripts/daily-brief.mjs --out PATH      write to an explicit path
 *   node scripts/daily-brief.mjs --json          structured JSON to stdout (no markdown)
 *   node scripts/daily-brief.mjs --since 2026-06-01   override the new-hits cutoff
 *   node scripts/daily-brief.mjs --as-of 2026-06-25   override "today" (testing/backdated)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { parseScoreHistory } from './lib/targeting-core.mjs'
import { parseScanHistory, buildDigest } from './lib/whats-new-core.mjs'
import { positioningIntel } from './lib/positioning-core.mjs'
import { classifyAll } from './outreach-core.mjs'
import { parseLog, collapse } from './outreach-cadence.mjs'
import {
  parseApplicationsDeadlines,
  parseScoutingDeadlines,
  classifyDeadlines,
} from './lib/deadlines-core.mjs'
import { parseAppRow } from './lib/tracker-core.mjs'
import { assembleBrief, renderBrief } from './lib/daily-brief-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCAN_FILE = join(ROOT, 'data/scan-history.tsv')
const SCORE_FILE = join(ROOT, 'data/score-history.tsv')
const OUTREACH_FILE = join(ROOT, 'data/outreach.md')
const APPS_FILE = join(ROOT, 'data/applications.md')
const SCOUTING_FILE = join(ROOT, 'data/scouting.md')
const PIPELINE_FILE = join(ROOT, 'data/pipeline.md')
const FOLLOWUP_SCRIPT = join(ROOT, 'scripts/followup-cadence.mjs')
const PATTERNS_SCRIPT = join(ROOT, 'scripts/analyze-patterns.mjs')
const BRIEFS_DIR = join(ROOT, 'reports/briefs')

// --- CLI args ---
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const getVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}
const weekly = has('--weekly')
const asJson = has('--json')
const doWrite = has('--write') || getVal('--out') !== null
const explicitOut = getVal('--out')
const since = getVal('--since')
const asOfArg = getVal('--as-of')

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
const asOf = asOfArg && /^\d{4}-\d{2}-\d{2}$/.test(asOfArg) ? asOfArg : todayStr()

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/* ───── Gather each core's output (read-only) ────────────────────────────────*/

// 1. Fresh high-fit postings — whats-new digest.
function getDigest() {
  const scanRows = parseScanHistory(read(SCAN_FILE))
  if (scanRows.length === 0) return null
  const scoreRows = parseScoreHistory(read(SCORE_FILE))
  // Weekly → 7-day window; daily → "since the previous scan" default. An
  // explicit --since always wins.
  const opts = { asOf }
  if (since) opts.since = since
  else if (weekly) opts.days = 7
  return buildDigest(scanRows, scoreRows, opts)
}

// 2. Due follow-ups — run the existing followup-cadence.mjs as a subprocess and
//    parse its JSON. It auto-runs on import (prints + exits), so a subprocess is
//    the clean way to consume it without modifying it.
function getFollowupResult() {
  if (!existsSync(FOLLOWUP_SCRIPT)) return null
  try {
    const out = execFileSync('node', [FOLLOWUP_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } catch (e) {
    // The script exits non-zero when there are no applications; it still prints
    // a JSON `{ error }` body on stdout, which execFileSync attaches to e.stdout.
    if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
      try { return JSON.parse(e.stdout) } catch { /* fall through */ }
    }
    return null
  }
}

// 2b. Learned targeting lesson — run analyze-patterns.mjs as a subprocess and
//     parse its JSON. Like followup-cadence, it auto-runs on import and exits
//     non-zero when there isn't enough outcome data yet (it still prints a JSON
//     `{ error }` body, which we tolerate by returning null). A subprocess keeps
//     analyze-patterns.mjs untouched.
function getPatternsResult() {
  if (!existsSync(PATTERNS_SCRIPT)) return null
  try {
    const out = execFileSync('node', [PATTERNS_SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
      try { return JSON.parse(e.stdout) } catch { /* fall through */ }
    }
    return null
  }
}

// 3. Due outreach nudges — outreach-core over data/outreach.md.
function getOutreachResult() {
  if (!existsSync(OUTREACH_FILE)) return null
  const contacts = collapse(parseLog(read(OUTREACH_FILE)))
  return classifyAll(contacts, asOf)
}

// 4. One standing positioning insight — positioning-core over score-history.
function getPositioningIntel() {
  const scoreRows = parseScoreHistory(read(SCORE_FILE))
  if (scoreRows.length === 0) return null
  return positioningIntel(scoreRows)
}

// 5. Deadline urgency — deadlines-core.classifyDeadlines over applications.md +
//    scouting.md. Read-only import-only: deadlines-core is never modified.
function getClassifiedDeadlines() {
  const appsMd = read(APPS_FILE)
  const scoutingMd = read(SCOUTING_FILE)
  const appEntries = parseApplicationsDeadlines(appsMd)
  const scoutEntries = parseScoutingDeadlines(scoutingMd)
  const allEntries = [...appEntries, ...scoutEntries]
  if (allEntries.length === 0) return null
  return classifyDeadlines(allEntries, asOf)
}

// 6. Pipeline health — counts derived from applications.md + pipeline.md.
//    Active = Applied / Responded / Interview / Offer (in-flight).
//    Evaluated = waiting for a decision (not yet applied or terminal).
//    inboxCount = non-blank, non-comment lines in pipeline.md.
const ACTIVE_STATUSES = new Set(['applied', 'responded', 'interview', 'offer'])
const EVALUATED_STATUS = 'evaluated'

function getPipelineHealth() {
  const appsMd = read(APPS_FILE)
  let active = 0
  let evaluated = 0
  for (const line of appsMd.split('\n')) {
    const row = parseAppRow(line)
    if (!row) continue
    const s = row.status.replace(/\*\*/g, '').trim().toLowerCase()
    if (ACTIVE_STATUSES.has(s)) active++
    else if (s === EVALUATED_STATUS) evaluated++
  }

  // Count pipeline inbox items: non-blank lines that start with a URL or a
  // list marker, excluding the header/separator. We count lines that look like
  // they carry a URL (start with http or a list marker pointing to one).
  let inboxCount = 0
  if (existsSync(PIPELINE_FILE)) {
    for (const line of read(PIPELINE_FILE).split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('|') || t.startsWith('#') || t.startsWith('<!--')) continue
      // Count list-item lines with a URL
      if (/^[-*]\s+https?:\/\//.test(t) || /^https?:\/\//.test(t)) inboxCount++
    }
  }

  return { active, evaluated, inboxCount }
}

/* ───── Assemble + emit ──────────────────────────────────────────────────────*/

const inputs = {
  digest: getDigest(),
  followupResult: getFollowupResult(),
  patterns: getPatternsResult(),
  outreachResult: getOutreachResult(),
  positioningIntel: getPositioningIntel(),
  classifiedDeadlines: getClassifiedDeadlines(),
  pipelineHealth: getPipelineHealth(),
}

const brief = assembleBrief(inputs, { asOf, period: weekly ? 'weekly' : 'daily' })

if (asJson) {
  process.stdout.write(JSON.stringify(brief, null, 2) + '\n')
  process.exit(0)
}

const markdown = renderBrief(brief)

if (doWrite) {
  const outPath = explicitOut
    ? (explicitOut.startsWith('/') ? explicitOut : join(ROOT, explicitOut))
    : join(BRIEFS_DIR, `${asOf}-brief.md`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, markdown, 'utf8')
  const rel = outPath.startsWith(ROOT) ? outPath.slice(ROOT.length + 1) : outPath
  process.stdout.write(`Wrote brief to ${rel}\n`)
} else {
  process.stdout.write(markdown)
}
