#!/usr/bin/env node
/**
 * build-demo.mjs — generate the fictional demo workspace (demo/).
 *
 * Reads the persona and listings from scripts/demo/seed.mjs, scores every
 * listing with the real engine (scripts/score-listing.mjs, with the demo's
 * own eligibility profile, calibration and tax / cost-of-living values passed
 * in, so nothing is read from a private data root), and writes the same
 * layout a private data root has: user/, data/, reports/, interview-prep/.
 *
 * Trackers are written with the project's own formatters and headers
 * (scouting-core, tracker-core, dedup-index, profile-core scaffolds), so the
 * demo parses exactly like real data.
 *
 * Deterministic: the same seed and the same --as-of give byte-identical
 * output. Every date in the seed is an offset from --as-of, which is stored in
 * demo/.demo-meta.json.
 *
 * Usage:
 *   node scripts/demo/build-demo.mjs                       (as of today, into demo/)
 *   node scripts/demo/build-demo.mjs --as-of 2026-10-20
 *   node scripts/demo/build-demo.mjs --out /tmp/demo-check --as-of 2026-10-20
 *
 * The output folder is replaced, except its chat/ subfolder (the app's demo
 * chat store). The build refuses to write into a non-empty folder that isn't
 * a previous demo build.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { scoreListing } from '../score-listing.mjs'
import { eligibilityFlags } from '../lib/eligibility.mjs'
import { VERDICT_LABELS } from '../lib/score-bands.mjs'
import { roundToBand } from '../lib/tax-cache.mjs'
import {
  SCORE_HISTORY_HEADER, SCOUTING_SCAFFOLD, APPLICATIONS_SCAFFOLD, PIPELINE_SCAFFOLD, DISCARDED_HEADER,
} from '../lib/profile-core.mjs'
import { HEADER as DEDUP_HEADER, buildIndexLines } from '../lib/dedup-index.mjs'
import { HISTORY_HEADER as SCAN_HEADER } from '../lib/merge-staging-core.mjs'
import { formatScoutingRow, formatEligibilityCell } from '../lib/scouting-core.mjs'
import { formatScoreCell } from '../lib/tracker-core.mjs'

// Daily brief cores (the brief is assembled in-process so it is deterministic).
import { parseScanHistory, buildDigest } from '../lib/whats-new-core.mjs'
import { parseScoreHistory } from '../lib/targeting-core.mjs'
import { analyze as analyzeFollowups } from '../lib/followup-cadence-core.mjs'
import { classifyAll } from '../outreach-core.mjs'
import { parseLog, collapse } from '../outreach-cadence.mjs'
import { parseNetwork, parsePipeline } from '../lib/network-core.mjs'
import { warmOutreachOpportunities } from '../lib/warm-outreach-core.mjs'
import { positioningIntel } from '../lib/positioning-core.mjs'
import { parseApplicationsDeadlines, parseScoutingDeadlines, classifyDeadlines } from '../lib/deadlines-core.mjs'
import { parsePendingEntries, buildScanIndex, buildDedupKeySet, triagePending } from '../lib/triage-core.mjs'
import { assembleBrief, renderBrief } from '../lib/daily-brief-core.mjs'
import { countPendingPipelineLines } from '../lib/profile-core.mjs'
import { parseAppRow } from '../lib/tracker-core.mjs'

import * as seed from './seed.mjs'
import * as docs from './documents.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const DEFAULT_OUT = join(REPO_ROOT, 'demo')
export const META_FILE = '.demo-meta.json'
export const GENERATOR = 'scripts/demo/build-demo.mjs'
/** Folders inside the output the build never touches (the app's demo chat store). */
export const PRESERVED_DIRS = ['chat']

const TAX_SOURCE = 'demo tax table'
const COL_SOURCE = 'demo cost-of-living table'

// The report header's action phrase, as modes/_shared.md § Standard report
// block format lists it.
const REPORT_ACTIONS = {
  go: 'apply now',
  stretch: 'apply with prep',
  solid: 'apply',
  thin: 'apply only if your pipeline is thin',
  growth: 'close the gap first',
}

// ── Small helpers ───────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** Report filename part: drop ( ) [ ] : / \ ? * " < > | and collapse spaces (modes/scouting.md § File Naming). */
export function fileSafe(s) {
  return String(s).replace(/[()[\]:/\\?*"<>|]/g, '').replace(/\s+/g, ' ').trim()
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const num = (n) => (n == null ? '' : String(n))
/** Code-point order, so sorting never depends on the machine's locale. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const tsvSafe = (s) => String(s ?? '').replace(/[\t\n]+/g, ' ')
const cellReason = (s) => String(s).replace(/[;\n]+/g, ',').replace(/\|/g, '/').trim()

function taxRate(place, gross) {
  const band = roundToBand(gross)
  const hit = place.tax.find(([b]) => b >= band) ?? place.tax[place.tax.length - 1]
  return { band: hit[0], rate: hit[1] }
}

const DIM_ROWS = [
  ['growth_mobility', 'Growth / Mobility (match)'],
  ['optionality_exit', 'Optionality / Exit (match)'],
  ['brand_value', 'Brand Value (match)'],
  ['role_content', 'Role content (match)'],
  ['best_cities', 'City (hygiene)'],
  ['salary_adj_city', 'Salary Adj for City (hygiene)'],
  ['work_life_balance', 'Work-Life Balance (hygiene)'],
]
const EASE_ROWS = [
  ['skills_match', 'Skills Match (ease)'],
  ['experience_bar', 'Experience bar (ease)'],
  ['competition', 'Competition (ease)'],
]
const GAP_LABELS = {
  growth_mobility: 'Growth / Mobility', optionality_exit: 'Optionality / Exit', brand_value: 'Brand Value',
  role_content: 'Role content', best_cities: 'City', salary_adj_city: 'Salary Adj for City',
  work_life_balance: 'Work-Life Balance', skills_match: 'Skills Match', experience_bar: 'Experience bar',
  competition: 'Competition',
}
const GAP_ORDER = Object.keys(GAP_LABELS)

// ── Eligibility inputs ──────────────────────────────────────────────────────

function eligibilityProfile(t) {
  return {
    available_from: t.availableFrom,
    blocked_windows: [],
    graduations: [{ degree: 'BSc', date: t.bscGrad }, { degree: 'MSc', date: t.mscGrad }],
    languages: seed.persona.languages.map(({ language, level }) => ({ language, level })),
    work_authorisation: ['EU'],
    duration_months: { min: 6, max: 24 },
    permanent_start_ok_before_block: true,
  }
}

function resolveFacts(L, asOf) {
  const f = L.facts ?? {}
  const out = { employment: L.employment }
  if (f.start) out.start = { earliest: f.start.in == null ? null : addDays(asOf, f.start.in), latest: null, flexible: !!f.start.flexible, text: null }
  if (f.duration_months != null) out.duration_months = f.duration_months
  if (f.graduation) out.graduation = { from: addMonths(asOf, f.graduation.fromMonths), to: addMonths(asOf, f.graduation.toMonths), soft: !!f.graduation.soft, text: null }
  if (f.languages) out.languages = f.languages.map(l => ({ ...l, text: null }))
  out.country = f.country
  if (f.work_auth) out.work_auth = { below_sponsorship_salary_floor: false, ...f.work_auth }
  if (f.other) out.other = f.other
  return out
}

const LEVEL_WORD = { native: 'native', C2: 'C2', C1: 'C1', B2: 'B2', B1: 'B1', A2: 'A2', A1: 'A1' }

/** Advisor-voice reason for one eligibility row of a written report (red never reaches a report). */
function eligibilityText(check, L, facts, ctx) {
  if (L.elig?.[check.check]) return L.elig[check.check]
  const place = seed.places[L.city]
  switch (check.check) {
    case 'start_date':
      if (check.status === 'amber') return 'They don’t say when it starts'
      if (facts.start?.earliest) return `It starts on ${docs.longDate(facts.start.earliest)}, after you are free to begin`
      return 'No start date given, and nothing on your side stops an early start'
    case 'duration':
      if (check.status === 'amber') return 'They don’t say how long it runs'
      if (facts.duration_months) return `${facts.duration_months} months, inside the length you can take`
      return 'Permanent contract'
    case 'graduation':
      if (!facts.graduation) return 'No graduation window'
      return 'They want recent graduates, and your MSc falls inside their window'
    case 'language': {
      const req = (facts.languages ?? []).filter(l => l.required)
      const plus = (facts.languages ?? []).filter(l => !l.required)
      const mine = (lang) => seed.persona.languages.find(p => p.language === lang)
      if (check.status === 'amber') {
        return check.reason.replace(/^(\w+) (\w+) required; you have (\w+) \(1 step below\)$/,
          (_, lang, lvl, have) => `They ask for ${lang} at ${lvl}; yours is ${have}, one step short`)
      }
      const parts = req.map(l => `${l.language} at ${LEVEL_WORD[l.level] ?? l.level}`)
      const have = req.map(l => `${l.language} ${mine(l.language)?.label === 'Native' ? 'native' : mine(l.language)?.label}`)
      let s = req.length
        ? `They ask for ${parts.join(' and ')}; you have ${have.join(' and ')}`
        : 'No language requirement stated'
      if (plus.length) s += `. ${plus.map(l => l.language).join(' and ')} ${plus.length > 1 ? 'are a plus' : 'is a plus'}, not a requirement`
      return s
    }
    case 'work_auth':
      return `${place.countryName.replace(/^the /, 'The ')} is covered by your EU work rights`
    case 'other':
      return check.status === 'green' ? 'Nothing else they require' : check.reason
    default:
      return check.reason
  }
}

// ── Scoring ─────────────────────────────────────────────────────────────────

async function scoreAll(asOf, t) {
  const profile = eligibilityProfile(t)
  const recs = []
  const ordered = seed.listings.map((L, i) => ({ L, i })).sort((a, b) => a.L.evaluated - b.L.evaluated || a.i - b.i)
  for (const [idx, { L }] of ordered.entries()) {
    const place = seed.places[L.city]
    if (!place) throw new Error(`seed: unknown city "${L.city}" for ${L.id}`)
    const date = addDays(asOf, L.evaluated)
    const url = `https://example.com/jobs/${slug(L.company)}/${slug(L.role)}-${L.jobId}`
    const facts = resolveFacts(L, asOf)
    const calibration = {
      ...seed.calibration,
      has_structured_onboarding: !!L.onboarding,
      has_sink_or_swim_signal: !!L.sinkOrSwim,
    }
    const input = {
      company: L.company, role: L.role, url, role_archetype: L.archetype,
      city: L.city, country: place.country,
      comp: L.comp, comp_source: L.compSource ?? 'disclosed',
      is_intern: !!L.intern, soft_benefits_modifier: L.soft ?? 0,
      calibration,
      eligibility_facts: facts,
      eligibility_profile: profile,
      scoring_weights: {},
      referral: L.referral ?? null,
      today: date,
      prior: false,
      judgment_scores: L.scores,
    }
    let tax = null
    if (L.comp) {
      const total = Object.values(buildComp(L.comp)).reduce((a, b) => a + b, 0)
      tax = taxRate(place, total)
      input.tax_override = { rate: tax.rate, source: TAX_SOURCE }
      input.col_override = { baseline_eur: place.baseline, source: COL_SOURCE }
    }
    const r = await scoreListing(input)
    if (r.error) throw new Error(`score-listing failed for ${L.id}: ${r.error} — ${r.message}`)
    if (r.verdict !== L.expect) {
      throw new Error(`seed: ${L.id} scored "${r.verdict}" (Match ${r.match?.score ?? '—'}, Ease ${r.ease?.score ?? '—'}) but its prose was written for "${L.expect}". ` +
        'The rubric moved this listing: update its scores or prose in scripts/demo/seed.mjs.')
    }
    recs.push({
      L, r, num: idx + 1, id: L.id, company: L.company, role: L.role, date, url, facts, tax,
      tier: r.tier, verdict: r.verdict,
      match: r.match?.score ?? null, ease: r.ease?.score ?? null, priority: r.priority ?? null,
    })
  }
  return recs
}

// Mirrors score-bands buildTotalComp's components (used only to pick the demo tax band).
function buildComp(c) {
  const out = { base: c.base }
  if (c.bonusPct != null) out.bonus = c.base * c.bonusPct
  if (c.equityAnnualEur != null) out.equity = c.equityAnnualEur
  if (c.thirteenthMonthMonths) out.thirteenth = (c.base / 12) * c.thirteenthMonthMonths
  if (c.benefitsMonthlyEur != null) out.benefits = c.benefitsMonthlyEur * 12
  if (c.signOnEur != null) out.signOn = c.signOnEur / (c.tenureYears ?? 3)
  return out
}

// ── Reports ─────────────────────────────────────────────────────────────────

function eligibilityHeader(r) {
  if (r.eligibility.status === 'green') return 'green'
  const reasons = r.eligibility.checks.filter(c => c.status !== 'green').map(c => cellReason(c.reason))
  return `${r.eligibility.status} — ${reasons.join('; ')}`
}

const fmtScore = (v) => `${v}/10`

/** "€870", rounded to €10 the way the engine's salary summary rounds it. */
function savingsPhrase(r) {
  const s = r.salary_adj_for_city.computed.savings
  if (s <= 0) throw new Error('build-demo: a {savings} comp note needs positive savings')
  return `€${(Math.round(s / 10) * 10).toLocaleString('en-US')}`
}

function renderReport(rec, ctx) {
  const { L, r } = rec
  const R = L.reasons
  const growth = r.verdict === 'growth'
  const lines = []
  lines.push(`# ${growth ? 'Gap & Growth' : 'Scouting'}: ${L.company} — ${L.role}`, '')
  lines.push(`**Date:** ${rec.date}`)
  lines.push(`**Location:** ${L.location}${L.remote ? ` · ${L.remote}` : ''}`)
  lines.push(`**Archetype:** ${L.archetype}`)
  if (growth) lines.push('**Mode:** scouting (growth target)')
  lines.push(`**Match:** ${rec.match}/10 · **Ease:** ${rec.ease}/10`)
  lines.push(`**Eligibility:** ${eligibilityHeader(r)}`)
  lines.push(`**Verdict:** ${VERDICT_LABELS[r.verdict]} — ${REPORT_ACTIONS[r.verdict]}`)
  lines.push(`**Tier:** ${r.tier}`)
  lines.push(`**URL:** ${rec.url}`, '')

  lines.push('## Eligibility', '| Check | Status | Reason |', '|-------|--------|--------|')
  for (const c of r.eligibility.checks) lines.push(`| ${c.check} | ${c.status} | ${eligibilityText(c, L, rec.facts, ctx)} |`)
  const questions = r.eligibility.checks.flatMap(c =>
    c.check === 'other' ? (c.entries ?? []).filter(e => e.status === 'amber').map(e => e.question) : (c.status === 'amber' ? [c.question] : []))
  if (questions.length) {
    lines.push('', '**Ask the recruiter:**', ...questions.map(q => `- ${q}`))
  }
  lines.push('')

  lines.push('## Dimensional scoring', '| Dimension | Score | Reasoning |', '|-----------|-------|-----------|')
  for (const [key, label] of DIM_ROWS) {
    const reason = key === 'salary_adj_city' ? r.salary_adj_for_city.summary : R[key]
    lines.push(`| ${label} | ${fmtScore(r.dims[key])} | ${reason} |`)
  }
  lines.push(`| **Match (rollup)** | **${rec.match}/10** | ${R.match} |`)
  for (const [key, label] of EASE_ROWS) lines.push(`| ${label} | ${fmtScore(r.dims[key])} | ${R[key]} |`)
  lines.push(`| **Ease (rollup)** | **${rec.ease}/10** | ${R.ease} |`)
  lines.push(`| Best-fit Early-career Roles (context) | — | ${R.best_fit} |`, '')

  const P = L.report
  if (r.tier === 'T1') {
    lines.push('## A) Role summary', '| Field | Value |', '|-------|-------|')
    lines.push(`| Domain | ${P.summary.domain} |`, `| Function | ${P.summary.function} |`, `| Seniority | ${P.summary.seniority} |`,
      `| Remote | ${P.summary.remote} |`, `| TL;DR | ${P.summary.tldr} |`, '')
    lines.push('## B) Gaps and opportunities', P.gaps, '')
    lines.push('## C) Comp & demand', '| Source | Band | Note |', '|--------|------|------|',
      `| ${P.comp.source}, ${rec.date} | ${P.comp.band} | ${P.comp.note.replace('{savings}', savingsPhrase(r))} |`, '')
    lines.push('## D) Recommendation', P.recommendation, '')
    lines.push('## E) Career path impact', P.career, '')
  } else if (r.tier === 'T2') {
    lines.push('## Fit / gaps', `- **Strongest match:** ${P.strongest}`, `- **Biggest gap:** ${P.biggest}`, '')
    lines.push('## Recommendation', P.recommendation, '')
    lines.push('## Path forward', P.path, '')
  } else if (r.tier === 'T3') {
    lines.push('## Gaps and opportunities', `- **Gap:** ${P.gap}`, `- **Revisit when:** ${P.revisit}`, '')
  }
  lines.push(`Salary math: ${r.salary_adj_for_city.math}`)
  return lines.join('\n') + '\n'
}

// ── Trackers ────────────────────────────────────────────────────────────────

function keyGaps(rec) {
  if (!rec.r.dims) return '—'
  const low = GAP_ORDER
    .map(k => ({ k, v: rec.r.dims[k] }))
    .filter(x => x.v <= 5)
    .sort((a, b) => a.v - b.v || GAP_ORDER.indexOf(a.k) - GAP_ORDER.indexOf(b.k))
    .slice(0, 3)
  return low.length ? low.map(x => GAP_LABELS[x.k]).join('|') : '—'
}

function scoreHistoryRow(rec) {
  const { L, r } = rec
  const blocked = r.verdict === 'blocked'
  const d = blocked ? {} : r.dims
  const cols = [
    rec.date, L.archetype,
    num(d.skills_match), num(d.experience_bar), num(d.competition), num(rec.ease),
    num(d.growth_mobility), num(d.optionality_exit), num(d.brand_value), num(d.role_content),
    num(d.best_cities), num(d.salary_adj_city), num(d.work_life_balance), num(rec.match), num(rec.priority),
    r.eligibility.status, eligibilityFlags(r.eligibility), r.verdict,
    blocked ? '' : (L.reasons?.best_fit ?? L.role), 'scouting', L.company, L.role, r.tier, L.source,
    L.location, L.employmentType, L.duration, L.salaryRaw ?? 'n/d', rec.url,
  ]
  return cols.map(tsvSafe).join('\t')
}

function scoutingEligibilityCell(r) {
  const s = r.eligibility.status
  if (s === 'green') return 'green'
  const reasons = r.eligibility.checks.filter(c => c.status === s).map(c => cellReason(c.reason))
  return formatEligibilityCell(s, reasons)
}

function deadlineCell(L, asOf) {
  return typeof L.deadline === 'number' ? addDays(asOf, L.deadline) : (L.deadline ?? 'n/d')
}

// ── Build ───────────────────────────────────────────────────────────────────

function assertEnUsNumbers() {
  if ((1234.5).toLocaleString() !== '1,234.5') {
    throw new Error('build-demo: number formatting is not en-US in this process; run the CLI (it re-runs itself under LC_ALL=en_US.UTF-8) so the salary math is reproducible')
  }
}

/**
 * Build the demo in memory. Returns { files: Map<relPath, string>, meta }.
 */
export async function buildDemo({ asOf }) {
  if (!ISO_RE.test(asOf ?? '')) throw new Error(`build-demo: --as-of must be YYYY-MM-DD (got ${asOf})`)
  assertEnUsNumbers()
  const t = docs.timeline(asOf)
  const day = (offset) => addDays(asOf, offset)
  const files = new Map()
  const put = (rel, content) => {
    if (files.has(rel)) throw new Error(`build-demo: two outputs for ${rel}`)
    files.set(rel, content)
  }

  const recs = await scoreAll(asOf, t)
  const recById = new Map(recs.map(r => [r.id, r]))

  // Report paths for T1–T3.
  for (const rec of recs) {
    const n = { T1: 1, T2: 2, T3: 3 }[rec.tier]
    rec.reportPath = n ? `reports/tier-${n}/${fileSafe(rec.company)} - ${fileSafe(rec.role)}.md` : null
    if (n && !rec.L.reasons) throw new Error(`seed: ${rec.id} lands in ${rec.tier} but has no reasons / report prose`)
  }

  // Applications (promoted), numbered in promotion order.
  const apps = seed.applications.map((a, i) => {
    const rec = recById.get(a.id)
    if (!rec) throw new Error(`seed: application ${a.id} has no listing`)
    if (rec.verdict === 'blocked') throw new Error(`seed: ${a.id} is blocked and cannot be promoted`)
    rec.promotedTo = i + 1
    return { ...a, num: i + 1, company: rec.company, role: rec.role, rec, date: day(a.d) }
  })
  const appsById = new Map(apps.map(a => [a.id, a]))

  const ctx = { asOf, t, day, recs, recById, apps, appsById, eligibility: eligibilityProfile(t) }

  // ── user/ ──
  put('user/cv.md', docs.renderCv(ctx))
  put('user/profile.yml', docs.renderProfileYml(ctx))
  put('user/_profile.md', docs.renderProfileMd(ctx))
  put('user/portals.yml', docs.renderPortalsYml(ctx))
  put('user/article-digest.md', docs.renderArticleDigest(ctx))

  // ── reports/ ──
  for (const rec of recs) if (rec.reportPath) put(rec.reportPath, renderReport(rec, ctx))

  // ── data/score-history.tsv (append order = evaluation order) ──
  put('data/score-history.tsv', SCORE_HISTORY_HEADER + '\n' + recs.map(scoreHistoryRow).join('\n') + '\n')

  // ── data/report-summaries.tsv (headerless) ──
  put('data/report-summaries.tsv', recs.map(rec => [
    rec.date, rec.company, rec.role, rec.L.archetype, rec.tier, num(rec.match), num(rec.ease),
    rec.r.eligibility.status, keyGaps(rec), rec.verdict,
  ].map(tsvSafe).join('\t')).join('\n') + '\n')

  // ── data/scouting.md (merge scripts insert newest rows on top) ──
  const scoutingRows = recs.map(rec => {
    const blocked = rec.verdict === 'blocked'
    return formatScoutingRow({
      num: rec.num, date: rec.date, company: rec.company, role: rec.role,
      match: blocked ? '—' : rec.match, ease: blocked ? '—' : rec.ease, tier: rec.tier,
      eligibility: scoutingEligibilityCell(rec.r),
      report: rec.reportPath ? `[${rec.num}](${rec.reportPath})` : '—',
      deadline: deadlineCell(rec.L, asOf),
      hint: rec.promotedTo ? `PROMOTED-${rec.promotedTo}` : rec.r.promotion_hint,
      notes: blocked ? rec.r.note : rec.L.note,
    })
  })
  put('data/scouting.md', SCOUTING_SCAFFOLD + [...scoutingRows].reverse().join('\n') + '\n')

  // ── data/applications.md (newest on top, 10 columns) ──
  const appRows = apps.map(a => {
    const rec = a.rec
    const notes = `Promoted from scouting #${rec.num} (${rec.tier}, ${rec.r.eligibility.status}). ${a.notes}`.replace(/\|/g, '/')
    return `| ${a.num} | ${a.date} | ${rec.company} | ${rec.role} | ${formatScoreCell(rec.match, rec.ease)} | ${a.status} | ${a.pdf ? '✅' : '❌'} | ${deadlineCell(rec.L, asOf)} | ${rec.reportPath ? `[${rec.num}](${rec.reportPath})` : '—'} | ${notes} |`
  })
  put('data/applications.md', APPLICATIONS_SCAFFOLD + [...appRows].reverse().join('\n') + '\n')

  // ── data/dedup-index.tsv (same logic as rebuild-dedup-index.mjs) ──
  put('data/dedup-index.tsv', [DEDUP_HEADER, ...buildIndexLines(files.get('data/scouting.md'), files.get('data/applications.md'))].join('\n') + '\n')

  // ── data/scan-history.tsv ──
  const runs = seed.scanRuns
  const latestRun = runs[runs.length - 1]
  const scanRow = ({ url, seen, lastSeen, portal, title, company, location }) => {
    const dates = runs.filter(o => o >= seen && o <= (lastSeen ?? latestRun)).map(day)
    if (!dates.length || dates[0] !== day(seen)) throw new Error(`seed: first_seen ${seen} for ${company} — ${title} is not a scanner run`)
    return [url, day(seen), portal, title, company, location, 'added', dates.join('|')].map(tsvSafe).join('\t')
  }
  const pendingEntries = seed.pending.map(([company, title, location, relevance, seen, portal, jobId]) => ({
    company, title, location, relevance, seen, portal,
    url: `https://example.com/jobs/${slug(company)}/${slug(title)}-${jobId}`,
  }))
  const scanned = [
    ...recs.filter(rec => rec.L.source === 'scan').map(rec => ({
      url: rec.url, seen: rec.L.seen, lastSeen: rec.L.lastSeen, portal: rec.L.portal, title: rec.role, company: rec.company, location: rec.L.location,
    })),
    ...pendingEntries,
  ].sort((a, b) => a.seen - b.seen || (b.relevance ?? 0) - (a.relevance ?? 0) || byCodePoint(a.url, b.url))
  put('data/scan-history.tsv', SCAN_HEADER + '\n' + scanned.map(scanRow).join('\n') + '\n')

  // ── data/pipeline.md ──
  // Worded like scan-core's relevance reasons, from the demo portals' title filter.
  const wordRe = (w) => new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i')
  const relevanceNote = (e) => {
    const city = e.location.split(',')[0]
    const hits = seed.titleFilter.positive.filter(p => wordRe(p).test(e.title))
    const phrases = hits.filter(p => p.includes(' '))
    const words = hits.filter(p => !p.includes(' '))
    const reasons = []
    if (phrases.length) reasons.push(`matches ${phrases.length} target phrase${phrases.length > 1 ? 's' : ''} (${phrases.join(', ')})`)
    if (words.length) reasons.push(`matches ${words.length} target keyword${words.length > 1 ? 's' : ''} (${words.join(', ')})`)
    const boosts = seed.titleFilter.seniority_boost.filter(b => wordRe(b).test(e.title))
    if (boosts.length) reasons.push(`right seniority band (${boosts.join(', ')})`)
    if (e.seen >= latestRun - 4) reasons.push('freshly posted')
    if (seed.preferredCities.includes(city)) reasons.push('in a target city')
    if (!hits.length) throw new Error(`seed: pending "${e.company} — ${e.title}" matches no positive title keyword`)
    return `relevance ${e.relevance.toFixed(1)} — ${reasons.join(', ')}`
  }
  const pendingLines = [...pendingEntries]
    .sort((a, b) => a.seen - b.seen || b.relevance - a.relevance || byCodePoint(a.url, b.url))
    .map(e => `- [ ] ${e.url} | ${e.company} | ${e.title} | ${relevanceNote(e)}`)
  const processedLines = recs.map(rec => rec.verdict === 'blocked'
    ? `- [x] #${rec.num} | ${rec.url} | ${rec.company} | ${rec.role} | BLOCKED | T4 | ${cellReason(rec.r.eligibility.blocking_reason)}`
    : `- [x] #${rec.num} | ${rec.url} | ${rec.company} | ${rec.role} | ${formatScoreCell(rec.match, rec.ease)} | ${rec.tier} | ${rec.verdict}`)
  put('data/pipeline.md', PIPELINE_SCAFFOLD + pendingLines.join('\n') + '\n\n## Processed\n' + processedLines.join('\n') + '\n')

  // ── data/network.md, outreach.md, follow-ups.md ──
  put('data/network.md', docs.renderNetwork(ctx))
  put('data/outreach.md', docs.renderOutreach(ctx))
  put('data/follow-ups.md', docs.renderFollowUps(ctx))
  put('data/agent-messages.jsonl', docs.renderMessages(ctx))

  // ── data caches (demo values) ──
  const usedPlaces = [...new Set(recs.filter(r => r.tax).map(r => r.L.city))].sort()
  put('data/col-cache.tsv', 'city\tbaseline_eur\tsource\tlast_updated\n' +
    usedPlaces.map(c => [c, seed.places[c].baseline, COL_SOURCE, day(-30)].join('\t')).join('\n') + '\n')
  const taxRows = [...new Map(recs.filter(r => r.tax).map(r => {
    const country = seed.places[r.L.city].country
    return [`${country}\t${r.tax.band}`, [country, r.tax.band, r.tax.rate, TAX_SOURCE, day(-30)].join('\t')]
  })).entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([, row]) => row)
  put('data/tax-cache.tsv', 'country\tgross_band_eur\teffective_rate\tsource\tlast_updated\n' + taxRows.join('\n') + '\n')
  const compRows = recs.filter(r => r.L.compBand).map(r =>
    [r.company, r.L.archetype, r.L.city, 'EUR', r.L.compBand.min, r.L.compBand.max, 'demo', r.L.compBand.confidence, r.date].join('\t'))
  put('data/comp-cache.tsv', 'company\trole_archetype\tcity\tcurrency\tmin\tmax\tsource\tconfidence\tlast_updated\n' + compRows.join('\n') + '\n')

  put('data/discarded.tsv', DISCARDED_HEADER + '\n')
  put('data/filter-audit-state.json', '{}\n')

  // ── interview-prep/ ──
  put('interview-prep/story-bank.md', docs.renderStoryBank(ctx))
  const prepFor = (id, render) => {
    const rec = recById.get(id)
    put(`interview-prep/${fileSafe(rec.company)} - ${fileSafe(rec.role)}.md`, render(ctx))
  }
  prepFor('northwind-gap', docs.renderNorthwindPrep)
  prepFor('wingtip-pa', docs.renderWingtipPrep)

  // ── reports/briefs/ (assembled from the same cores daily-brief.mjs uses) ──
  put(`reports/briefs/${asOf}-brief.md`, renderDailyBrief(files, asOf))

  // ── README + meta ──
  const verdictCounts = {}
  for (const rec of recs) verdictCounts[rec.verdict] = (verdictCounts[rec.verdict] ?? 0) + 1
  const statusCounts = {}
  for (const a of apps) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1
  ctx.counts = {
    scouting: recs.length,
    verdictLine: ['go', 'stretch', 'solid', 'thin', 'growth', 'skip', 'blocked']
      .filter(v => verdictCounts[v]).map(v => `${verdictCounts[v]} ${VERDICT_LABELS[v]}`).join(', '),
    applications: apps.length,
    statusLine: apps.map(a => a.status).join(', '),
    pending: pendingLines.length,
    processed: processedLines.length,
    scan: scanned.length,
    runs: runs.length,
    network: seed.network.length,
    outreach: seed.outreach.length,
    followUps: seed.followUps.length,
    reports: recs.filter(r => r.reportPath).length,
    stories: seed.stories.length,
    preps: 2,
  }
  put('README.md', docs.renderReadme(ctx))

  const meta = { asOf, seedVersion: seed.SEED_VERSION, generator: GENERATOR }
  put(META_FILE, JSON.stringify(meta, null, 2) + '\n')

  return { files, meta }
}

/** The daily brief for as-of, from the demo files (mirrors scripts/daily-brief.mjs, minus the outcome-pattern subprocess). */
function renderDailyBrief(files, asOf) {
  const f = (p) => files.get(p) ?? ''
  const scanRows = parseScanHistory(f('data/scan-history.tsv'))
  const scoreRows = parseScoreHistory(f('data/score-history.tsv'))
  const collapsed = collapse(parseLog(f('data/outreach.md')))
  const contacts = parseNetwork(f('data/network.md'))
  const pipeline = parsePipeline(f('data/applications.md'), f('data/scouting.md'))
  const warm = warmOutreachOpportunities({ contacts, pipeline, collapsedContacts: collapsed, today: asOf })
  let active = 0
  let evaluated = 0
  for (const line of f('data/applications.md').split('\n')) {
    const row = parseAppRow(line)
    if (!row) continue
    const s = row.status.trim().toLowerCase()
    if (['applied', 'responded', 'interview', 'offer'].includes(s)) active++
    else if (s === 'evaluated') evaluated++
  }
  const inputs = {
    digest: scanRows.length ? buildDigest(scanRows, scoreRows, { asOf }) : null,
    followupResult: analyzeFollowups({ appsContent: f('data/applications.md'), followupsContent: f('data/follow-ups.md'), todayIso: asOf, reportExists: (rel) => files.has(rel) }),
    patterns: null,
    outreachResult: classifyAll(collapsed, asOf),
    warmOutreach: warm.length ? warm : null,
    positioningIntel: scoreRows.length ? positioningIntel(scoreRows) : null,
    classifiedDeadlines: classifyDeadlines([...parseApplicationsDeadlines(f('data/applications.md')), ...parseScoutingDeadlines(f('data/scouting.md'))], asOf),
    triage: triagePending(parsePendingEntries(f('data/pipeline.md')), {
      today: asOf,
      scanIndex: buildScanIndex(f('data/scan-history.tsv')),
      dedupKeys: buildDedupKeySet(f('data/dedup-index.tsv')),
      dreamCompanies: [{ name: 'Northwind Analytics', priority: 'top' }, { name: 'Contoso', priority: 'lower' }, { name: 'Tailspin Toys', priority: 'lower' }],
      affinityCompanies: seed.calibration.brand_affinity_companies,
    }),
    pipelineHealth: { active, evaluated, inboxCount: countPendingPipelineLines(f('data/pipeline.md')) },
    crossProfile: [],
  }
  return renderBrief(assembleBrief(inputs, { asOf, period: 'daily' }))
}

// ── Writing ─────────────────────────────────────────────────────────────────

function listFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = relative(base, full).split(sep).join('/')
    if (statSync(full).isDirectory()) {
      if (dir === base && PRESERVED_DIRS.includes(name)) continue
      out.push(...listFiles(full, base))
    } else {
      out.push(rel)
    }
  }
  return out
}

/** Every file in a built demo folder (relative, '/'-separated), skipping the preserved chat store. */
export function listDemoFiles(dir) {
  return existsSync(dir) ? listFiles(dir) : []
}

function pruneEmptyDirs(dir, base) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (!statSync(full).isDirectory()) continue
    if (dir === base && PRESERVED_DIRS.includes(name)) continue
    pruneEmptyDirs(full, base)
    if (readdirSync(full).length === 0) rmdirSync(full)
  }
}

export function writeDemo(outDir, files) {
  const out = resolve(outDir)
  if (out === REPO_ROOT || REPO_ROOT.startsWith(out + sep) || existsSync(join(out, '.git'))) {
    throw new Error(`build-demo: refusing to write into ${out} (repository root or a git checkout)`)
  }
  if (existsSync(out)) {
    const entries = readdirSync(out).filter(n => !PRESERVED_DIRS.includes(n))
    if (entries.length && !existsSync(join(out, META_FILE))) {
      throw new Error(`build-demo: ${out} is not empty and has no ${META_FILE}; refusing to replace a folder that isn't a demo build`)
    }
    for (const rel of listFiles(out)) if (!files.has(rel)) rmSync(join(out, rel))
    pruneEmptyDirs(out, out)
  }
  for (const [rel, content] of files) {
    const abs = join(out, rel)
    mkdirSync(dirname(abs), { recursive: true })
    if (existsSync(abs) && readFileSync(abs, 'utf8') === content) continue
    writeFileSync(abs, content)
  }
  return out
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i !== -1 ? argv[i + 1] : undefined
  }
  return {
    out: get('--out') ?? DEFAULT_OUT,
    asOf: get('--as-of') ?? new Date().toISOString().slice(0, 10),
  }
}

async function main() {
  // The engine formats euros with toLocaleString(); pin en-US so the output
  // is identical on every machine.
  if ((1234.5).toLocaleString() !== '1,234.5' && !process.env.STARPATH_DEMO_LOCALE_PINNED) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', STARPATH_DEMO_LOCALE_PINNED: '1' },
    })
    process.exit(res.status ?? 1)
  }
  const { out, asOf } = parseArgs(process.argv.slice(2))
  const { files } = await buildDemo({ asOf })
  const dir = writeDemo(out, files)
  process.stdout.write(`Built the demo workspace as of ${asOf}: ${files.size} files in ${relative(process.cwd(), dir) || '.'}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`${e.message}\n`)
    process.exit(1)
  })
}
