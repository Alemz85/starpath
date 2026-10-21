#!/usr/bin/env node
/**
 * calibration-advisor.mjs — Scoring-calibration feedback for career-ops.
 *
 * The scoring engine reads calibration (brand-bonus lists, dream companies,
 * comp targets, growth signals) from user/profile.yml + user/_profile.md and
 * applies it deterministically (scripts/lib/calibration.mjs). But nothing ever
 * tells the user whether that calibration still matches reality. This advisor
 * mines data/score-history.tsv (every scouting evaluation) and, when available,
 * the application outcomes (scripts/outcomes.mjs: status log + tracker, gated
 * per docs/scoring-statistical-design.md § 3.7), and SURFACES where the
 * calibration looks off:
 *
 *   • brand bonuses that are inert (the company's mean Want is in the top
 *     verdict row without them) or misdirected (its mean Want stays in the
 *     bottom row even with them, so every verdict is Skip),
 *   • un-credited companies whose roles keep reaching the top Want row
 *     (candidates to add),
 *   • rubric dimensions pinned at a ceiling/floor (no discriminating signal),
 *   • comp targets that sit above (or below) what the landscape actually pays,
 *   • archetypes the verdict grid says to apply to that never progress, or
 *     vice-versa, and Ease bands that rank outcomes the wrong way round (both
 *     from the one outcomes analysis, never from the tracker's status text).
 *
 * Scoring model: v2 (docs/scoring-v2.md) — Want / Ease / verdict; blocked
 * (eligibility red) rows never enter a score claim.
 *
 * It is SUGGEST-ONLY. It never writes user/* — it prints concrete edits the
 * user can choose to apply, keeping personalization in the user layer where it
 * belongs. Its one write: each gated suggestion is posted to the user's
 * Messages (data/agent-messages.jsonl), keyed by its stable id so a re-run
 * never repeats one that is open or dismissed. `--no-post` skips that.
 *
 * Usage:
 *   node scripts/calibration-advisor.mjs            # human-readable summary
 *   node scripts/calibration-advisor.mjs --json     # structured JSON to stdout
 *   node scripts/calibration-advisor.mjs --no-post  # don't post suggestions to Messages
 *   node scripts/calibration-advisor.mjs --root <data root> --today YYYY-MM-DD
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
import { analyzeCalibration, advisoryToSuggestion } from './lib/calibration-advisor.mjs'
import { VERDICT_LABELS } from './lib/score-bands.mjs'
import { dataRootFor } from './lib/data-root.mjs'
import { loadOutcomeInputs } from './lib/outcome-inputs.mjs'
import { analyzeApplicationOutcomes } from './lib/outcome-stats.mjs'
import { todayLocal } from './lib/status-ledger.mjs'
import { postFromSuggestion } from './lib/messages-core.mjs'
import { messagesPathFor, postMessage } from './lib/messages-store.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/* ───── CLI args ─────────────────────────────────────────────────── */
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}

// The data root (private/, through the same resolution as outcomes.mjs).
const ROOT = argVal('--root') || dataRootFor(REPO)
const TODAY = argVal('--today') || todayLocal()
const POST = !args.includes('--no-post')

const SCORE_HISTORY =
  argVal('--score-history') || join(ROOT, 'data/score-history.tsv')
const PROFILE_YML = argVal('--profile') || firstExisting([
  join(ROOT, 'user/profile.yml'),
  join(ROOT, 'data/profile.yml'),
])

function firstExisting(paths) {
  return paths.find(p => existsSync(p)) || paths[0]
}

/* ───── Read calibration + scoring weights out of user/profile.yml ──────
 *
 * Calibration lives in the structured `calibration:` block (dream_companies,
 * lower_tier_dream_companies, brand_affinity_companies, extra_brand_bonuses —
 * the field names scripts/lib/calibration.mjs reads), with dream companies
 * historically also under `target_roles.dream_companies` /
 * `profile.dream_companies`. We merge all three sources into the single shape
 * the scorer consumes, so the advisor sees exactly what the scorer sees. The
 * `scoring:` block's want_weights / ease_weights are read the same way
 * score-listing.mjs reads them. Everything is optional — a missing file or
 * block yields an empty calibration and default weights (the advisor still
 * runs the rubric-health and comp checks that don't need them).
 */
function loadProfile(path) {
  if (!path || !existsSync(path)) return { calibration: {}, weights: {} }
  let doc
  try {
    doc = yaml.load(readFileSync(path, 'utf8')) || {}
  } catch (e) {
    process.stderr.write(`⚠️  Could not parse ${path}: ${e.message}\n`)
    return { calibration: {}, weights: {} }
  }
  const cal = { ...(doc.calibration || {}) }

  // Fold in dream_companies from the historical locations if not already set.
  const dreamFromTargets =
    doc?.target_roles?.dream_companies ?? doc?.profile?.dream_companies ?? null
  if (dreamFromTargets && !cal.dream_companies) {
    cal.dream_companies = dreamFromTargets
  }
  const scoring = doc.scoring || {}
  const weights = {
    want: scoring.want ?? scoring.want_weights,
    ease: scoring.ease ?? scoring.ease_weights,
  }
  return { calibration: cal, weights }
}

/* ───── Outcomes: the one source (scripts/outcomes.mjs) ──────────────
 *
 * Status log + tracker + score-history (+ the optional materials index),
 * joined and classified by outcome-stats, gates included
 * (docs/scoring-statistical-design.md § 3.7). The advisor never reads the
 * tracker's status text itself. No applications → null (the score→outcome
 * checks are skipped).
 */
function loadOutcomes() {
  const inputs = loadOutcomeInputs(ROOT, { today: TODAY, profileFile: PROFILE_YML })
  if (!inputs.applications.length) return null
  return analyzeApplicationOutcomes(inputs)
}

/* ───── Messages: post each gated suggestion (keyed, so repeats are no-ops) ── */
function postSuggestions(suggestions) {
  const file = messagesPathFor(ROOT)
  const out = { posted: 0, existing: 0, failed: 0 }
  for (const s of suggestions) {
    try {
      const r = postMessage(file, postFromSuggestion(advisoryToSuggestion(s)))
      if (r.posted) out.posted++
      else out.existing++
    } catch (e) {
      out.failed++
      process.stderr.write(`⚠️  Could not post "${s.id}" to Messages: ${e.message}\n`)
    }
  }
  return out
}

/* ───── Run ──────────────────────────────────────────────────────── */
function main() {
  if (!existsSync(SCORE_HISTORY)) {
    fail(`No score history found at ${rel(SCORE_HISTORY)}. Evaluate some roles first — calibration feedback needs a score history to mine.`)
  }
  const rows = parseScoreHistory(readFileSync(SCORE_HISTORY, 'utf8'))
  const { calibration, weights } = loadProfile(PROFILE_YML)
  const outcomes = loadOutcomes()

  const report = analyzeCalibration(rows, { calibration, outcomes, weights })
  if (!report.error && POST && report.suggestions.length) {
    report.messages = postSuggestions(report.suggestions)
  }

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
  line(`  Scored roles:      ${m.evaluated}  (${m.dateRange.from || '?'} → ${m.dateRange.to || '?'})${m.blocked ? `  · ${m.blocked} blocked by eligibility (not scored, excluded)` : ''}`)
  line(`  Calibration set:   ${m.calibrationConfigured ? 'yes' : 'no (brand/growth bonuses not configured)'}`)
  line(`  Outcomes joined:   ${m.outcomesAvailable ? 'yes (status log + applications.md, as scripts/outcomes.mjs)' : 'no — apply to roles to unlock score→outcome checks'}`)
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
    line(`  BRAND-BONUS DRIFT (mean Want vs the verdict rows: ${m.contract.wantRows.mid.toFixed(1)} / ${m.contract.wantRows.high.toFixed(1)})`)
    for (const x of drift) {
      const tag = x.verdict === 'misdirected' ? '✗ misdirected' : '· inert'
      const unaided = x.avgWantUnaided !== x.avgWant ? ` (${x.avgWantUnaided} without the bonus)` : ''
      line(`    ${pad(tag, 14)} ${pad(x.company, 22)} Want ${x.avgWant}${unaided} · Ease ${x.avgEase} over ${x.roles}  [${x.source}]  [n=${x.roles}, ${x.confidence}]`)
    }
    line()
  }

  // ── Candidates ──
  const cand = (d.brandBonusCandidates || []).slice(0, 5)
  if (cand.length) {
    line('  UN-CREDITED TOP-WANT COMPANIES (candidates to add)')
    for (const x of cand) {
      line(`    +  ${pad(x.company, 22)} Want ${x.avgWant} · Ease ${x.avgEase} over ${x.roles} evals  [n=${x.roles}, ${x.confidence}]`)
    }
    line()
  }

  // ── Comp reality ──
  const comp = d.compReality
  if (comp && comp.status !== 'sparse' && comp.status !== 'aligned') {
    line('  COMP-TARGET REALITY')
    const label = comp.status === 'targets-above-market'
      ? `targets ABOVE market (mean salary score ${comp.mean}, ${comp.lowShare}% ≤4)`
      : `targets BELOW market (mean salary score ${comp.mean}, comp never bites)`
    const interns = comp.internsExcluded ? `, ${comp.internsExcluded} intern rows excluded` : ''
    line(`    ⚠  ${label}  [n=${comp.count}, ${comp.confidence}${interns}]`)
    line()
  }

  // ── Score → outcome ──
  const so = d.scoreOutcome
  if (so?.available) {
    const flags = so.archetypes.filter(a => a.flag)
    if (flags.length) {
      line('  SCORE → OUTCOME MISMATCH')
      for (const a of flags) {
        const where = `typically ${VERDICT_LABELS[a.typicalVerdict] ?? a.typicalVerdict} (Want ${a.avgWant} · Ease ${a.avgEase})`
        const desc = a.flag === 'high-score-no-convert'
          ? `${where} but 0/${a.applied} progressed`
          : `${where} yet progresses ${a.convertRate}%`
        line(`    ⚠  ${pad(a.archetype, 24)} ${desc}  [n=${a.applied}, ${a.confidence}]`)
      }
      line()
    }
    const ex = so.excluded || {}
    if (ex.unscored || ex.pending || ex.withdrawn) {
      line(`    (excluded from score→outcome: ${ex.unscored || 0} resolved without a score, ${ex.pending || 0} pending, ${ex.withdrawn || 0} withdrawn)`)
      line()
    }
  }

  // ── Ease vs outcomes (outcome-stats' check, gates included) ──
  const eo = d.easeOutcome
  if (eo?.available && eo.comparisons.length) {
    line('  EASE VS OUTCOMES')
    for (const c of eo.comparisons) {
      const name = c.kind === 'high-no-progress' ? 'high never progresses' : `${c.higher} vs ${c.lower}`
      const short = c.status === 'insufficient'
        ? ` (resolved: ${c.shortfall.map(x => `${x.band} ${x.n}`).join(', ')}; ${c.shortfall[0].gate} needed per band)`
        : ''
      line(`    ${pad(name, 24)} ${c.status}${short}`)
    }
    line()
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
    line('  Nothing in user/* was changed. Apply the edits you agree with yourself.')
    const msg = r.messages
    if (msg) {
      line(`  Messages: ${msg.posted} new suggestion(s) posted, ${msg.existing} already there (open or dismissed)${msg.failed ? `, ${msg.failed} failed` : ''}.`)
    }
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
