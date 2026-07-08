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
 *   • scripts/lib/warm-outreach-core.mjs — untouched warm referral paths into
 *     pipeline companies (network-core × outreach-plan-core decision ladder)
 *   • scripts/lib/positioning-core.mjs  — one standing targeting insight
 *   • scripts/lib/triage-core.mjs       — the inbox's "deep-eval next" top slice
 *
 * The single "do this first" pick is ranked across ALL action sections by genuine
 * time-criticality (deadlines closing today > urgent follow-ups > overdue
 * follow-ups > outreach nudges > fresh postings), not by section position.
 *
 * When the repo hosts multiple search profiles (profiles/ exists with ≥2
 * profiles — see docs/superpowers/specs/2026-07-07-multi-profile-design.md),
 * the brief ends with an "Other searches" footer: one read-only summary line per
 * NON-active profile (pending inbox · urgent deadlines · new-this-week + a switch
 * hint), so a second search isn't invisible until you switch to it. On a
 * single-profile / pre-migration repo the footer is absent and the output is
 * byte-identical to before.
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

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

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
import {
  parsePendingEntries,
  buildScanIndex,
  buildDedupKeySet,
  triagePending,
} from './lib/triage-core.mjs'
import { parseNetwork, parsePipeline } from './lib/network-core.mjs'
import { warmOutreachOpportunities } from './lib/warm-outreach-core.mjs'
import { assembleBrief, renderBrief, countFreshScanRows } from './lib/daily-brief-core.mjs'
import {
  PROFILES_DIR,
  ACTIVE_POINTER,
  parseActive,
  parseMeta,
  validateSlug,
  countPendingPipelineLines,
  profileRelPath,
} from './lib/profile-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCAN_FILE = join(ROOT, 'data/scan-history.tsv')
const SCORE_FILE = join(ROOT, 'data/score-history.tsv')
const OUTREACH_FILE = join(ROOT, 'data/outreach.md')
const NETWORK_FILE = join(ROOT, 'data/network.md')
const APPS_FILE = join(ROOT, 'data/applications.md')
const SCOUTING_FILE = join(ROOT, 'data/scouting.md')
const PIPELINE_FILE = join(ROOT, 'data/pipeline.md')
const DEDUP_FILE = join(ROOT, 'data/dedup-index.tsv')
const PROFILE_FILE = join(ROOT, 'user/profile.yml')
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

// 3b. Warm outreach paths — warm-outreach-core over data/network.md × the
//     pipeline × data/outreach.md. Empty world degrades gracefully: no roster,
//     no pipeline, or no warm first touch to recommend → null → section omitted
//     (same convention as every other missing input).
function getWarmOutreach() {
  const contacts = parseNetwork(read(NETWORK_FILE))
  if (contacts.length === 0) return null
  const pipeline = parsePipeline(read(APPS_FILE), read(SCOUTING_FILE))
  if (pipeline.length === 0) return null
  const collapsedContacts = collapse(parseLog(read(OUTREACH_FILE)))
  const opportunities = warmOutreachOpportunities({ contacts, pipeline, collapsedContacts, today: asOf })
  return opportunities.length ? opportunities : null
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
//    inboxCount = pending inbox URLs (countPendingPipelineLines — the one
//    counter shared with the cross-profile footer and `profile list`).
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

  // Count pending inbox URLs with the SAME counter the cross-profile footer and
  // `profile list` use (countPendingPipelineLines) — one source of truth. The
  // former bespoke regex here required the URL immediately after the bullet, so
  // it matched ZERO real scanner lines (`- [ ] url | Co | Title | relevance …`)
  // and the "N URLs in pipeline inbox" clause silently never rendered, even
  // though the triage section one block down parsed those very lines fine.
  const inboxCount = existsSync(PIPELINE_FILE)
    ? countPendingPipelineLines(read(PIPELINE_FILE))
    : 0

  return { active, evaluated, inboxCount }
}

// 7. Inbox triage — the "deep-eval next" top slice from triage-core, ranked
//    with the same signals `npm run triage` uses (scan relevance, freshness,
//    dream/affinity company from user/profile.yml, title level, dedup hits).
//    Best-effort + read-only: a missing/unparseable profile just drops the
//    company boosts, never the section.
function getTriage() {
  const pipelineMd = read(PIPELINE_FILE)
  if (!pipelineMd) return null
  const entries = parsePendingEntries(pipelineMd)
  if (entries.length === 0) return null

  let dreamCompanies = []
  let affinityCompanies = []
  try {
    const profile = yaml.load(read(PROFILE_FILE)) ?? {}
    const dreams = profile?.target_roles?.dream_companies ?? []
    dreamCompanies = (Array.isArray(dreams) ? dreams : [])
      .map((d) => (typeof d === 'string' ? { name: d, priority: 'top' } : d))
      .filter((d) => d && d.name)
    affinityCompanies = profile?.calibration?.brand_affinity_companies ?? []
  } catch {
    // no profile boosts — deterministic signals still rank the inbox
  }

  return triagePending(entries, {
    today: asOf,
    scanIndex: buildScanIndex(read(SCAN_FILE)),
    dedupKeys: buildDedupKeySet(read(DEDUP_FILE)),
    dreamCompanies,
    affinityCompanies,
  })
}

// 8. Cross-profile awareness — one summary line per OTHER search profile.
//    Only when profiles/ exists AND there are ≥2 profiles; otherwise [] so the
//    brief is byte-identical to the pre-feature single-profile output. Every
//    read is READ-ONLY over the inactive profiles' files and fail-soft: a
//    missing/malformed file in another profile yields zeros for that metric,
//    never a crash of the brief.
function readProfileFile(slug, canonicalPath) {
  // Read a canonical path inside a specific (inactive) profile directly, never
  // through the active symlink. Best-effort: absent/unreadable → ''.
  try {
    const p = join(ROOT, profileRelPath(slug, canonicalPath))
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

// meta.yml sits at profiles/<slug>/meta.yml (one level above the canonical
// user/ · data/ · reports/ subtrees), so read it directly rather than via
// profileRelPath (which prefixes a canonical sub-path).
function readMetaRaw(slug) {
  try {
    const p = join(ROOT, PROFILES_DIR, slug, 'meta.yml')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

function getCrossProfileSummaries() {
  const profilesDir = join(ROOT, PROFILES_DIR)
  if (!existsSync(profilesDir)) return [] // pre-migration single-profile layout

  const activeSlug = existsSync(join(ROOT, ACTIVE_POINTER))
    ? parseActive(read(join(ROOT, ACTIVE_POINTER)))
    : null

  let slugs
  try {
    slugs = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory()) return false
        return validateSlug(e.name).valid // skips `active` + any stray non-profile dir
      })
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }

  // Need ≥2 profiles total for the section to make sense.
  if (slugs.length < 2) return []

  const summaries = []
  for (const slug of slugs) {
    if (slug === activeSlug) continue // the active search is the whole rest of the brief

    const meta = parseMeta(readMetaRaw(slug))

    const pipelineMd = readProfileFile(slug, 'data/pipeline.md')
    const pendingInbox = countPendingPipelineLines(pipelineMd)

    // Urgent deadlines = act-today + this-week buckets, computed by the SAME
    // parsing path deadlines.mjs uses (parse apps + scouting, classify, read
    // the urgent bucket count).
    let urgentDeadlines = 0
    try {
      const appEntries = parseApplicationsDeadlines(readProfileFile(slug, 'data/applications.md'))
      const scoutEntries = parseScoutingDeadlines(readProfileFile(slug, 'data/scouting.md'))
      const classified = classifyDeadlines([...appEntries, ...scoutEntries], asOf)
      urgentDeadlines = classified.counts.urgent
    } catch {
      urgentDeadlines = 0
    }

    const freshThisWeek = countFreshScanRows(readProfileFile(slug, 'data/scan-history.tsv'), asOf)

    summaries.push({
      slug,
      label: meta.label || slug,
      pendingInbox,
      urgentDeadlines,
      freshThisWeek,
    })
  }

  return summaries
}

/* ───── Assemble + emit ──────────────────────────────────────────────────────*/

const inputs = {
  digest: getDigest(),
  followupResult: getFollowupResult(),
  patterns: getPatternsResult(),
  outreachResult: getOutreachResult(),
  warmOutreach: getWarmOutreach(),
  positioningIntel: getPositioningIntel(),
  classifiedDeadlines: getClassifiedDeadlines(),
  triage: getTriage(),
  pipelineHealth: getPipelineHealth(),
  crossProfile: getCrossProfileSummaries(),
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
