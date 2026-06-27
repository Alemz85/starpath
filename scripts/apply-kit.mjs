#!/usr/bin/env node
/**
 * apply-kit.mjs — "is this application ready to send, and what's missing?"
 *
 * Applying *well* to one listing means several artifacts need to exist for that
 * `company + role`, each produced by a different existing mode. Nothing assembles
 * them into a single readiness view. This CLI is that orchestrator. It is strictly
 * READ-ONLY: it inspects what is on disk and reports a readiness checklist with the
 * exact next action for each gap — it GENERATES nothing and SUBMITS nothing. The
 * Ethical-Use rule in CLAUDE.md (never auto-submit) holds by construction.
 *
 * It resolves the on-disk facts for one listing, then hands them to the pure,
 * unit-tested scripts/lib/apply-kit-core.mjs for all status/verdict/ranking logic.
 * This file is only I/O + invocation.
 *
 * Artifacts inspected (mode that fills each gap in parens):
 *   • Scouting report   reports/tier-{1..4}/{Company} - {Role}.md      (scouting)
 *   • Tailored CV       output/cv-…{company}…-{date}.{pdf,html}        (pdf)
 *   • Drafted answers   interview-prep/{Company} - {Role}.md           (apply)
 *   • Company research  data/companies/{slug}.md  (+ freshness)        (deep)
 *   • Outreach plan     rows in data/outreach.md matching the company  (contacto)
 *   • Story bank        interview-prep/story-bank.md (supporting note) (interview-prep)
 *
 * Run:
 *   node scripts/apply-kit.mjs "Acme" "Strategy Analyst"     readiness for one listing
 *   node scripts/apply-kit.mjs --company "Acme" --role "..."  explicit flags (role optional)
 *   node scripts/apply-kit.mjs "Acme" "..." --json            structured JSON (frontend/scripts)
 *   node scripts/apply-kit.mjs "Acme" "..." --write           also write reports/kits/{slug}-{role}.md
 *   node scripts/apply-kit.mjs "Acme" "..." --out PATH        write to an explicit path
 *   node scripts/apply-kit.mjs --all                          readiness for every Applied/Evaluated listing
 *   node scripts/apply-kit.mjs --all --json                   the same, as JSON
 *
 * Exit code: 0 if the (single) kit is ready-to-send, 1 if blocked. `--all` always 0.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { slugify, freshness, validateArtifact, parseFrontmatter } from './lib/company-research-core.mjs'
import { parseStoryBank, validateBank } from './lib/story-bank.mjs'
import { parseLog, collapse } from './outreach-cadence.mjs'
import { classifyContact } from './outreach-core.mjs'
import { assembleKit, renderKit, atsSidecarName, cvFactsFromFiles } from './lib/apply-kit-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPORTS_DIR = join(ROOT, 'reports')
const OUTPUT_DIR = join(ROOT, 'output')
const PREP_DIR = join(ROOT, 'interview-prep')
const COMPANIES_DIR = join(ROOT, 'data', 'companies')
const STORY_BANK = join(PREP_DIR, 'story-bank.md')
const OUTREACH_FILE = join(ROOT, 'data', 'outreach.md')
const APPLICATIONS_FILE = join(ROOT, 'data', 'applications.md')
const KITS_DIR = join(REPORTS_DIR, 'kits')
const TIER_DIRS = ['tier-1', 'tier-2', 'tier-3', 'tier-4']

/* ───── CLI args ───────────────────────────────────────────────────────────────*/
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const getVal = (flag) => {
  const i = argv.indexOf(flag)
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null
}
const asJson = has('--json')
const doAll = has('--all')
const doWrite = has('--write') || getVal('--out') !== null
const explicitOut = getVal('--out')

// Positional args = the first non-flag tokens (company, role). Flags --company/--role win.
const positionals = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    // Skip the value of value-taking flags so it isn't read as a positional.
    if (a === '--company' || a === '--role' || a === '--out') i++
    continue
  }
  positionals.push(a)
}
const company = getVal('--company') || positionals[0] || null
const role = getVal('--role') || positionals[1] || null

function today() {
  return new Date().toISOString().slice(0, 10)
}
function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/* ───── Fact resolvers (the only place that touches disk) ──────────────────────*/

// Normalize a company/role token the way report/prep filenames are written, so a
// case- or spacing-variant still matches. Filenames are "{Company} - {Role}.md".
function normToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// 1. Scouting report: scan tier-1..4 for a "{Company} - {Role}.md" whose company
//    and role tokens match. We match on normalized company+role so minor casing
//    or punctuation differences in the query still resolve.
function resolveReport(co, ro) {
  const wantCo = normToken(co)
  const wantRo = normToken(ro)
  for (let t = 0; t < TIER_DIRS.length; t++) {
    const dir = join(REPORTS_DIR, TIER_DIRS[t])
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue
      const stem = file.replace(/\.md$/, '')
      const dash = stem.indexOf(' - ')
      const fileCo = normToken(dash === -1 ? stem : stem.slice(0, dash))
      const fileRo = normToken(dash === -1 ? '' : stem.slice(dash + 3))
      const coMatch = fileCo === wantCo || (wantCo && fileCo.startsWith(wantCo))
      // If a role was given, require it to match too; otherwise company-only match.
      const roMatch = !wantRo || fileRo === wantRo || (fileRo && fileRo.includes(wantRo)) || (wantRo.includes(fileRo) && fileRo.length > 0)
      if (coMatch && roMatch) {
        return { exists: true, path: `reports/${TIER_DIRS[t]}/${file}`, tier: t + 1 }
      }
    }
  }
  return { exists: false }
}

// 2. Tailored CV: output/cv-…-{date}.{pdf,html}. The company token is embedded in
//    the filename (cv-{candidate}-{company}-{date}). Match on the company slug
//    token; prefer the most recent (filenames sort lexicographically by date).
//    Then read the ATS-coverage sidecar pdf mode wrote next to the CV
//    (cv-….ats.json) so the readiness verdict reflects whether the CV is actually
//    tailored to this role — not just that some PDF exists. No sidecar → the CV
//    reads as ATS-unverified (stale), which honestly nudges a re-tailor. All the
//    sidecar-parsing / fact-shaping logic lives in the pure apply-kit-core.
function resolveCv(co) {
  if (!existsSync(OUTPUT_DIR)) return { exists: false }
  const coSlug = slugify(co)
  if (!coSlug) return { exists: false }
  const matches = readdirSync(OUTPUT_DIR)
    .filter((f) => /^cv-.*\.(pdf|html)$/i.test(f))
    .filter((f) => slugify(f).includes(coSlug))
    .sort() // date suffix → lexicographic = chronological; last = newest
  if (matches.length === 0) return { exists: false }
  const cvFile = matches[matches.length - 1]
  const cvPath = `output/${cvFile}`
  // The sidecar shares the CV's stem with a .ats.json extension. A PDF and its
  // HTML twin produce the same sidecar name, so a coverage record written for
  // either is found.
  const sidecarRel = atsSidecarName(cvPath)
  const sidecarAbs = join(ROOT, sidecarRel)
  const sidecarText = existsSync(sidecarAbs) ? readFileSync(sidecarAbs, 'utf8') : null
  return cvFactsFromFiles({ exists: true, path: cvPath, sidecarText })
}

// 3. Drafted answers: interview-prep/{Company} - {Role}.md (mirrors report naming).
function resolveAnswers(co, ro) {
  if (!existsSync(PREP_DIR)) return { exists: false }
  const wantCo = normToken(co)
  const wantRo = normToken(ro)
  for (const file of readdirSync(PREP_DIR)) {
    if (!file.endsWith('.md') || file === 'story-bank.md') continue
    const stem = file.replace(/\.md$/, '')
    const dash = stem.indexOf(' - ')
    const fileCo = normToken(dash === -1 ? stem : stem.slice(0, dash))
    const fileRo = normToken(dash === -1 ? '' : stem.slice(dash + 3))
    const coMatch = fileCo === wantCo || (wantCo && fileCo.startsWith(wantCo))
    const roMatch = !wantRo || fileRo === wantRo || (fileRo && fileRo.includes(wantRo))
    if (coMatch && roMatch) return { exists: true, path: `interview-prep/${file}` }
  }
  return { exists: false }
}

// 4. Company research: data/companies/{slug}.md + freshness via company-research-core.
function resolveResearch(co) {
  const slug = slugify(co)
  const rel = `data/companies/${slug}.md`
  const abs = join(COMPANIES_DIR, `${slug}.md`)
  if (!existsSync(abs)) return { exists: false }
  const content = readFileSync(abs, 'utf8')
  const v = validateArtifact(content, { expectedSlug: slug })
  const f = freshness(parseFrontmatter(content), today())
  return { exists: true, path: rel, state: f.state, ageDays: f.ageDays, valid: v.ok }
}

// 5. Outreach: rows in data/outreach.md whose company matches. Collapse to per-
//    contact records and count contacts + total touches + the most recent touch.
function resolveOutreach(co) {
  if (!existsSync(OUTREACH_FILE)) return {}
  const wantCo = normToken(co)
  const rows = collapse(parseLog(read(OUTREACH_FILE)))
    .filter((r) => normToken(r.company) === wantCo)
  if (rows.length === 0) return {}
  let touches = 0
  let lastTouch = null
  for (const r of rows) {
    touches += Number.isFinite(r.touches) ? r.touches : 1
    if (r.lastTouch && (!lastTouch || r.lastTouch > lastTouch)) lastTouch = r.lastTouch
  }
  return { contacts: rows.length, touches, lastTouch }
}

// 6. Story bank: a cross-listing supporting signal (count + health + gap count).
function resolveStoryBank() {
  if (!existsSync(STORY_BANK)) return { exists: false }
  const report = validateBank(parseStoryBank(readFileSync(STORY_BANK, 'utf8')))
  return {
    exists: true,
    storyCount: report.storyCount,
    ok: report.ok,
    gaps: Array.isArray(report.gaps) ? report.gaps.length : 0,
  }
}

function gatherFacts(co, ro) {
  return {
    report: resolveReport(co, ro),
    cv: resolveCv(co),
    answers: resolveAnswers(co, ro),
    research: resolveResearch(co),
    outreach: resolveOutreach(co),
    storyBank: resolveStoryBank(),
  }
}

/* ───── --all: every Applied/Evaluated listing from applications.md ────────────*/

// Parse applications.md (| # | Date | Company | Role | Score | Status | … |) into
// {company, role} pairs. We use this only to enumerate listings for --all; the
// per-listing readiness comes from the artifact files, not this table.
function parseApplications(content) {
  const out = []
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((s) => s.trim())
    if (cells.length < 6) continue
    const num = parseInt(cells[1], 10)
    if (Number.isNaN(num)) continue // header/separator
    const co = cells[3]
    const ro = cells[4]
    if (co) out.push({ company: co, role: ro || '' })
  }
  return out
}

/* ───── Emit ───────────────────────────────────────────────────────────────────*/

function buildOne(co, ro) {
  const facts = gatherFacts(co, ro)
  const kit = assembleKit({ company: co, role: ro || '', slug: slugify(co) }, facts)
  return kit
}

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n`)
  process.stderr.write(
    'usage: apply-kit.mjs "<company>" ["<role>"] [--json] [--write|--out PATH]\n' +
    '       apply-kit.mjs --all [--json]\n'
  )
  process.exit(2)
}

if (doAll) {
  const apps = parseApplications(read(APPLICATIONS_FILE))
  const kits = apps.map((a) => buildOne(a.company, a.role))
  if (asJson) {
    process.stdout.write(JSON.stringify({ count: kits.length, kits }, null, 2) + '\n')
    process.exit(0)
  }
  if (kits.length === 0) {
    process.stdout.write('No applications in data/applications.md to check.\n')
    process.exit(0)
  }
  // Compact roster: one line per listing, least-ready first.
  const rank = { blocked: 0, 'sendable-with-gaps': 1, ready: 2 }
  kits.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.completeness - b.completeness))
  process.stdout.write('Application-kit readiness — all tracked listings\n')
  process.stdout.write('─'.repeat(64) + '\n')
  for (const k of kits) {
    const mark = k.verdict === 'ready' ? '✓' : k.verdict === 'blocked' ? '✗' : '○'
    const title = (k.role ? `${k.company} — ${k.role}` : k.company).slice(0, 42).padEnd(42)
    const pct = String(Math.round(k.completeness * 100)).padStart(3)
    const nextHint = k.topAction ? `→ ${k.topAction.mode}` : 'ready to send'
    process.stdout.write(`${mark} ${title} ${pct}%  ${nextHint}\n`)
  }
  process.exit(0)
}

// Single-listing mode.
if (!company) usage('Provide a company (and optionally a role).')

const kit = buildOne(company, role)

if (asJson) {
  process.stdout.write(JSON.stringify(kit, null, 2) + '\n')
  process.exit(kit.readyToSend ? 0 : 1)
}

const markdown = renderKit(kit)

if (doWrite) {
  const slugRole = role ? `-${slugify(role)}` : ''
  const outPath = explicitOut
    ? (explicitOut.startsWith('/') ? explicitOut : join(ROOT, explicitOut))
    : join(KITS_DIR, `${slugify(company)}${slugRole}.md`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, markdown, 'utf8')
  const rel = outPath.startsWith(ROOT) ? outPath.slice(ROOT.length + 1) : outPath
  process.stdout.write(`Wrote readiness kit to ${rel}\n`)
} else {
  process.stdout.write(markdown)
}

process.exit(kit.readyToSend ? 0 : 1)
