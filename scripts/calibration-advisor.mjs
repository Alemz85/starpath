#!/usr/bin/env node
/**
 * calibration-advisor.mjs — Scoring-calibration feedback for career-ops.
 *
 * The scoring engine reads calibration (brand-bonus lists, dream companies,
 * comp targets, growth signals) from user/profile.yml + user/_profile.md and
 * applies it deterministically (scripts/lib/calibration.mjs). But nothing ever
 * tells the user whether that calibration still matches reality. This advisor
 * mines data/score-history.tsv (every scouting evaluation) and, when available,
 * the outcome funnel in data/applications.md, and SURFACES where the calibration
 * looks off:
 *
 *   • brand bonuses that are inert (the company already scores strong) or
 *     misdirected (it scores so weak even the bonus can't reach the apply bar),
 *   • un-credited companies that consistently score strong (candidates to add),
 *   • rubric dimensions pinned at a ceiling/floor (no discriminating signal),
 *   • comp targets that sit above (or below) what the landscape actually pays,
 *   • archetypes the rubric loves but that never convert, or vice-versa.
 *
 * It is strictly READ-ONLY and SUGGEST-ONLY. It never writes user/* — it prints
 * concrete edits the user can choose to apply, keeping personalization in the
 * user layer where it belongs.
 *
 * Usage:
 *   node scripts/calibration-advisor.mjs            # human-readable summary
 *   node scripts/calibration-advisor.mjs --json     # structured JSON to stdout
 *   node scripts/calibration-advisor.mjs --score-history path.tsv --profile path.yml
 *                                                   # override input paths
 *
 * All math lives in scripts/lib/calibration-advisor.mjs (pure + unit-tested).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

import { parseScoreHistory } from './lib/targeting-core.mjs'
import { parseAppRow, normalizeStatus } from './lib/tracker-core.mjs'
import { analyzeCalibration } from './lib/calibration-advisor.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* ───── CLI args ─────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}

const SCORE_HISTORY =
  argVal('--score-history') || join(ROOT, 'data/score-history.tsv')
const PROFILE_YML = argVal('--profile') || firstExisting([
  join(ROOT, 'user/profile.yml'),
  join(ROOT, 'data/profile.yml'),
])
const APPS_FILE = argVal('--applications') || firstExisting([
  join(ROOT, 'data/applications.md'),
  join(ROOT, 'applications.md'),
])

function firstExisting(paths) {
  return paths.find(p => existsSync(p)) || paths[0]
}

/* ───── Read calibration out of user/profile.yml ─────────────────────
 *
 * Calibration lives in the structured `calibration:` block, with dream
 * companies historically also under `target_roles.dream_companies` /
 * `profile.dream_companies`. We merge all three sources into the single shape
 * scripts/lib/calibration.mjs (and the advisor) consume, so the advisor sees
 * exactly what the scorer sees. Everything is optional — a missing file or
 * block yields an empty calibration (the advisor still runs the rubric-health
 * and comp checks that don't need it).
 */
function loadCalibration(path) {
  if (!path || !existsSync(path)) return {}
  let doc
  try {
    doc = yaml.load(readFileSync(path, 'utf8')) || {}
  } catch (e) {
    process.stderr.write(`⚠️  Could not parse ${path}: ${e.message}\n`)
    return {}
  }
  const cal = { ...(doc.calibration || {}) }

  // Fold in dream_companies from the historical locations if not already set.
  const dreamFromTargets =
    doc?.target_roles?.dream_companies ?? doc?.profile?.dream_companies ?? null
  if (dreamFromTargets && !cal.dream_companies) {
    cal.dream_companies = dreamFromTargets
  }
  return cal
}

/* ───── Read outcomes out of data/applications.md ────────────────────
 *
 * We reuse tracker-core's row parser (handles both the 9- and 10-column
 * layouts) and status normalizer, so the advisor's outcome join matches the
 * rest of the pipeline. Returns [] when the file is absent — the advisor then
 * simply skips the score→outcome calibration check.
 */
function loadOutcomes(path) {
  if (!path || !existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    const row = parseAppRow(line)
    if (!row) continue
    // tracker-core.normalizeStatus returns { status: 'Rejected'|... } (canonical,
    // capitalized); the advisor's outcome join wants a bare lowercase token.
    const norm = normalizeStatus(row.status || '')
    const status = (norm?.status || '').toLowerCase()
    out.push({ company: row.company, role: row.role, status })
  }
  return out
}

/* ───── Run ──────────────────────────────────────────────────────── */
function main() {
  if (!existsSync(SCORE_HISTORY)) {
    fail(`No score history found at ${rel(SCORE_HISTORY)}. Evaluate some roles first — calibration feedback needs a score history to mine.`)
  }
  const rows = parseScoreHistory(readFileSync(SCORE_HISTORY, 'utf8'))
  const calibration = loadCalibration(PROFILE_YML)
  const outcomes = loadOutcomes(APPS_FILE)

  const report = analyzeCalibration(rows, { calibration, outcomes })

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  if (report.error) fail(report.error)
  printSummary(report)
}

function fail(msg) {
  if (asJson) {
    process.stdout.write(JSON.stringify({ error: msg }, null, 2) + '\n')
  } else {
    process.stderr.write(`\n  ${msg}\n\n`)
  }
  process.exit(asJson ? 0 : 1)
}

const rel = (p) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p

/* ───── Human-readable summary ───────────────────────────────────── */
function printSummary(r) {
  const { metadata: m, diagnostics: d, suggestions } = r
  const insufficient = r.insufficientData || []
  const line = (s = '') => process.stdout.write(s + '\n')

  line()
  line('  ┌─────────────────────────────────────────────────────────────┐')
  line('  │  CALIBRATION ADVISOR — does your scoring match reality?       │')
  line('  └─────────────────────────────────────────────────────────────┘')
  line()
  line(`  Evaluated roles:   ${m.evaluated}  (${m.dateRange.from || '?'} → ${m.dateRange.to || '?'})`)
  line(`  Calibration set:   ${m.calibrationConfigured ? 'yes' : 'no (brand/growth bonuses not configured)'}`)
  line(`  Outcomes joined:   ${m.outcomesAvailable ? 'yes (applications.md)' : 'no — apply to roles to unlock score→outcome checks'}`)
  line()

  // ── Rubric dimension health ──
  const flagged = (d.dimensionSignal || []).filter(x => x.status === 'pinned-ceiling' || x.status === 'pinned-floor')
  if (flagged.length) {
    line('  RUBRIC SIGNAL HEALTH')
    for (const x of flagged) {
      const where = x.pinned === 'ceiling' ? `${x.ceilShare}% ≥9` : `${x.floorShare}% ≤2`
      line(`    ⚠  ${pad(x.label, 20)} pinned at ${x.pinned} (mean ${x.mean}, ${where}) — no signal  [n=${x.count}, ${x.confidence}]`)
    }
    line()
  }

  // ── Brand-bonus drift ──
  const drift = d.brandBonusDrift || []
  if (drift.length) {
    line('  BRAND-BONUS DRIFT')
    for (const x of drift) {
      const tag = x.verdict === 'misdirected' ? '✗ misdirected' : '· inert'
      line(`    ${pad(tag, 14)} ${pad(x.company, 22)} avg ${x.avgOverall}/10 over ${x.roles}  [${x.source}]  [n=${x.roles}, ${x.confidence}]`)
    }
    line()
  }

  // ── Candidates ──
  const cand = (d.brandBonusCandidates || []).slice(0, 5)
  if (cand.length) {
    line('  UN-CREDITED STRONG COMPANIES (candidates to add)')
    for (const x of cand) {
      line(`    +  ${pad(x.company, 22)} avg ${x.avgOverall}/10 over ${x.roles} evals  [n=${x.roles}, ${x.confidence}]`)
    }
    line()
  }

  // ── Comp reality ──
  const comp = d.compReality
  if (comp && comp.status !== 'sparse' && comp.status !== 'aligned') {
    line('  COMP-TARGET REALITY')
    const label = comp.status === 'targets-above-market'
      ? `targets ABOVE market (mean ${comp.mean}/10, ${comp.lowShare}% ≤4)`
      : `targets BELOW market (mean ${comp.mean}/10, comp never bites)`
    line(`    ⚠  ${label}  [n=${comp.count}, ${comp.confidence}]`)
    line()
  }

  // ── Score → outcome ──
  const so = d.scoreOutcome
  if (so?.available) {
    const flags = so.archetypes.filter(a => a.flag)
    if (flags.length) {
      line('  SCORE → OUTCOME MISMATCH')
      for (const a of flags) {
        const desc = a.flag === 'high-score-no-convert'
          ? `scores high (${a.avgScore}) but 0/${a.applied} converted`
          : `scores low (${a.avgScore}) yet converts ${a.convertRate}%`
        line(`    ⚠  ${pad(a.archetype, 24)} ${desc}  [n=${a.applied}, ${a.confidence}]`)
      }
      line()
    }
  }

  // ── Suggestions ──
  const sev = { high: '●', medium: '◐', low: '○' }

  if (!suggestions.length) {
    if (insufficient.length) {
      // Don't claim a clean bill of health when the only reason nothing fired
      // is that the evidence is too thin — that's a different statement.
      line(`  ⃠ No advisory has enough evidence yet — ${insufficient.length} withheld below their sample gates.`)
    } else {
      line('  ✓ No calibration mismatches detected with the current evidence.')
    }
    line('    (More evaluations / outcomes sharpen this — re-run as the history grows.)')
    line()
  } else {
    line('  SUGGESTED EDITS (review and apply yourself — nothing was changed)')
    line('  ───────────────────────────────────────────────────────────────')
    suggestions.forEach((s) => {
      line()
      line(`  ${sev[s.severity] || '·'} [${s.severity}] ${s.action}`)
      line(`     why:  ${s.reasoning}`)
      line(`     edit: ${s.target} — ${s.edit}`)
      line(`     n:    ${s.sampleSize} observation(s) · ${s.confidence} confidence (gate ${s.gate})`)
    })
    line()
    line('  Nothing was written. Apply the edits you agree with to your user/* files.')
    line()
  }

  // ── Suppressed advisories (docs/scoring-statistical-design.md § 3.4) ──
  // These are NOT recommendations. They are shown so the user can see what the
  // advisor would say once the evidence arrives — an advisory below its gate is
  // withheld outright rather than rendered with a hedge.
  if (insufficient.length) {
    line('  INSUFFICIENT DATA — not recommendations, shown for transparency')
    line('  ───────────────────────────────────────────────────────────────')
    insufficient.forEach((s) => {
      line()
      line(`  ⃠  ${s.action}`)
      line(`     held: ${s.reason}`)
    })
    line()
  }
}

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

main()
