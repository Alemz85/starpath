#!/usr/bin/env node
/**
 * comp-bench.mjs — compensation benchmarking over the user's own evaluated
 * landscape, benchmarked against the comp targets in user/profile.yml.
 *
 * Distinct from `compare-offers` (which ranks 2+ concrete live offers): this
 * mines what the roles the user TARGETS actually pay — by archetype, by city —
 * and flags where the user's stated target band sits above or below that
 * landscape. It is strictly READ-ONLY: it never mutates a tracked file.
 *
 * Two signals, kept distinct (see scripts/lib/comp-bench-core.mjs header):
 *   • the dense savings-power PROXY (salary_adj_city on every scored row), and
 *   • the sparse disclosed-salary ANCHORS (parsed to annual EUR) for the
 *     euro-denominated target-vs-landscape drift verdict.
 *
 * All math lives in the pure, unit-tested scripts/lib/comp-bench-core.mjs; this
 * file is only I/O, arg parsing, and rendering.
 *
 * Run:
 *   node scripts/comp-bench.mjs                 human-readable summary (default)
 *   node scripts/comp-bench.mjs --json          structured JSON to stdout
 *   node scripts/comp-bench.mjs --min-roles 4   raise the per-group floor (default 3)
 *   node scripts/comp-bench.mjs --gbp-eur 1.15  override the GBP→EUR rate (default 1.17)
 *   node scripts/comp-bench.mjs --score-history PATH   override the TSV source
 *   node scripts/comp-bench.mjs --profile PATH         override the profile.yml source
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

import { parseScoreHistory } from './lib/targeting-core.mjs'
import { benchmarkComp, fmtK, DEFAULT_GBP_TO_EUR } from './lib/comp-bench-core.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* ───── CLI args ─────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}
const firstExisting = (paths) => paths.find((p) => existsSync(p)) || paths[0]

const SCORE_HISTORY = argVal('--score-history') || join(ROOT, 'data/score-history.tsv')
const PROFILE_YML = argVal('--profile') || firstExisting([
  join(ROOT, 'user/profile.yml'),
  join(ROOT, 'data/profile.yml'),
])

const minRolesArg = Number(argVal('--min-roles'))
const minRoles = Number.isFinite(minRolesArg) && minRolesArg >= 1 ? Math.floor(minRolesArg) : 3
const gbpArg = Number(argVal('--gbp-eur'))
const gbpToEur = Number.isFinite(gbpArg) && gbpArg > 0 ? gbpArg : DEFAULT_GBP_TO_EUR

const rel = (p) => relative(ROOT, p) || p
function fail(msg) {
  process.stderr.write(`\n${msg}\n\n`)
  process.exit(1)
}

/* ───── Read the compensation block out of profile.yml ───────────────
 *
 * Whatever the user wrote under `compensation:` flows through verbatim — no
 * target band is hardcoded here. A missing file/block yields an empty target;
 * the proxy benchmark still runs (it doesn't need euros), only the euro-
 * denominated drift verdict goes quiet.
 */
function loadCompensation(path) {
  if (!path || !existsSync(path)) return {}
  try {
    const doc = yaml.load(readFileSync(path, 'utf8')) || {}
    return doc.compensation || doc?.candidate?.compensation || {}
  } catch (e) {
    process.stderr.write(`⚠️  Could not parse ${rel(path)}: ${e.message}\n`)
    return {}
  }
}

/* ───── Human-readable summary ──────────────────────────────────────── */
function printSummary(r) {
  if (r.error) {
    console.log(`\n${r.error}\n`)
    return
  }
  const { metadata: m, landscape, target, drift, byArchetype, byCity, floorRisks, recommendations } = r

  console.log(`\n${'='.repeat(64)}`)
  console.log(`  Compensation Benchmark — ${m.analysisDate}`)
  console.log(`  ${m.evaluated} evaluated roles (${m.dateRange.from} to ${m.dateRange.to})`)
  console.log(`  ${m.disclosedAnchors} disclosed-salary anchors · ${m.withSalaryAdj} with savings-power score`)
  console.log(`${'='.repeat(64)}\n`)

  // Target band.
  const t = target
  const bandStr = (t.targetLow != null || t.targetHigh != null)
    ? `€${fmtK(t.targetLow)}–${fmtK(t.targetHigh)}${t.floor != null ? ` (floor €${fmtK(t.floor)})` : ''}`
    : '(none stated in profile.yml)'
  console.log('YOUR STATED TARGET')
  console.log('-'.repeat(48))
  console.log(`  ${bandStr}\n`)

  // Drift verdict — the headline.
  console.log('TARGET vs LANDSCAPE')
  console.log('-'.repeat(48))
  if (drift.drift) {
    const tag = {
      'target-above-landscape': 'TARGET ABOVE LANDSCAPE',
      'target-below-landscape': 'TARGET BELOW LANDSCAPE',
      aligned: 'ALIGNED',
    }[drift.drift.verdict] || drift.drift.verdict
    console.log(`  [${tag}]  basis: ${drift.drift.basis}`)
    console.log(`  ${wrap(drift.drift.note, 4)}`)
  } else {
    const ft = drift.byType.fulltime.count
    console.log(`  Not enough disclosed full-time salaries to judge drift (${ft} found; need ≥ 2).`)
    console.log(`  Disclosed comp is sparse in your landscape — lean on the savings-power read below.`)
  }
  // Always show the anchor breakdown when any exist.
  const ftB = drift.byType.fulltime, inB = drift.byType.intern
  if (ftB.count || inB.count) {
    console.log('')
    if (ftB.count) console.log(`  Full-time anchors: ${ftB.count} · median €${fmtK(ftB.medianEur)} · range €${fmtK(ftB.minEur)}–${fmtK(ftB.maxEur)}`)
    if (inB.count) console.log(`  Intern anchors:    ${inB.count} · median €${fmtK(inB.medianEur)} · range €${fmtK(inB.minEur)}–${fmtK(inB.maxEur)} (annualized stipend)`)
  }
  console.log('')

  // Savings-power proxy — landscape + per archetype.
  console.log('SAVINGS-POWER BY ARCHETYPE (best comp first · 1-10 after cost-of-living)')
  console.log('-'.repeat(48))
  console.log(`  landscape median ${landscape.adjMedian ?? '—'}  ·  mean ${landscape.adjMean ?? '—'}`)
  for (const a of byArchetype.slice(0, 10)) {
    const anchor = a.anchorCount
      ? `  ·  ${a.anchorCount} disclosed (med €${fmtK(a.anchorMedianEur)})`
      : ''
    console.log(
      `  ${a.label.slice(0, 34).padEnd(35)} med ${String(a.adjMedian).padStart(4)}  ` +
      `${String(a.count).padStart(3)} roles  weak ${String(a.compWeakShare).padStart(3)}%${anchor}`,
    )
  }
  console.log('')

  // Per city.
  if (byCity.length) {
    console.log('SAVINGS-POWER BY CITY (best comp first)')
    console.log('-'.repeat(48))
    for (const c of byCity.slice(0, 10)) {
      const anchor = c.anchorCount ? `  ·  ${c.anchorCount} disclosed (med €${fmtK(c.anchorMedianEur)})` : ''
      console.log(
        `  ${c.label.slice(0, 24).padEnd(25)} med ${String(c.adjMedian).padStart(4)}  ` +
        `${String(c.count).padStart(3)} roles  weak ${String(c.compWeakShare).padStart(3)}%${anchor}`,
      )
    }
    console.log('')
  }

  // Comp-floor risks.
  if (floorRisks.length) {
    console.log('COMP-FLOOR DRAG (non-intern roles at savings-power ≤ 4 — each takes −0.4 Overall)')
    console.log('-'.repeat(48))
    for (const f of floorRisks.slice(0, 10)) {
      const eur = f.disclosedEur != null ? ` · €${fmtK(f.disclosedEur)}` : ''
      console.log(`  ${`${f.company} — ${f.role}`.slice(0, 46).padEnd(47)} adj ${f.salaryAdj}${eur}`)
    }
    console.log('')
  }

  // Recommendations.
  if (recommendations.length) {
    console.log('COMP MOVES')
    console.log('='.repeat(64))
    recommendations.forEach((rec, i) => {
      console.log(`  ${i + 1}. [${rec.impact.toUpperCase()}] ${rec.action}`)
      console.log(`     ${wrap(rec.reasoning, 5)}`)
    })
  }
  console.log('')
}

// Soft-wrap a long string to ~76 cols with a hanging indent, for terminal prose.
function wrap(text, indent = 0) {
  const pad = ' '.repeat(indent)
  const width = 76 - indent
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim())
      line = w
    } else {
      line = (line + ' ' + w).trim()
    }
  }
  if (line) lines.push(line.trim())
  return lines.join('\n' + pad)
}

/* ───── Run ──────────────────────────────────────────────────────── */
if (!existsSync(SCORE_HISTORY)) {
  fail(`No score history at ${rel(SCORE_HISTORY)}. Evaluate some roles first (scouting) — comp benchmarking mines your score history.`)
}
const rows = parseScoreHistory(readFileSync(SCORE_HISTORY, 'utf8'))
const scored = rows.filter((r) => Number.isFinite(r.overall))
const comp = loadCompensation(PROFILE_YML)

const report = benchmarkComp(scored, comp, { minRoles, gbpToEur })

if (asJson) console.log(JSON.stringify(report, null, 2))
else printSummary(report)

if (report.error) process.exit(1)
