#!/usr/bin/env node
/**
 * score-trend.mjs — Re-evaluation / score-trend tracker for career-ops.
 *
 * The targeting analyzer (analyze-patterns.mjs --scouting) treats
 * data/score-history.tsv as a flat landscape. This tool adds the TIME axis it
 * omits, answering two questions the flat view can't:
 *
 *   1. Per-listing trajectory — for every company+role evaluated 2+ times,
 *      how did its Overall MOVE across re-evaluations (improving / declining /
 *      stable), and which dimension drove the move?
 *   2. Landscape trend — are the roles you've evaluated *recently* scoring
 *      higher than your *earlier* ones? (i.e. is your targeting sharpening?)
 *
 * Read-only: it never writes to score-history.tsv or anything else. All math
 * lives in the pure lib/score-trend-core.mjs; this file is just file I/O +
 * formatting.
 *
 * Every claim here is bound by docs/scoring-statistical-design.md: per-listing
 * moves under the 0.30 Overall noise floor print as "flat within noise", and
 * the corpus verdict is withheld entirely below 10 scored evals per calendar
 * window rather than rendered in a hedged form.
 *
 * Run: node scripts/score-trend.mjs            (JSON to stdout)
 *      node scripts/score-trend.mjs --summary  (human-readable report)
 *      node scripts/score-trend.mjs --summary --min-delta 0.3
 *      node scripts/score-trend.mjs --summary --stable-band 0.4
 *      node scripts/score-trend.mjs --summary --min-window-verdict 6
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseScoreHistory, analyzeTrend } from './lib/score-trend-core.mjs'
import { GATES, OVERALL_NOISE_FLOOR } from './lib/scoring-stats.mjs'

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)))
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv')

// --- CLI args ---
const args = process.argv.slice(2)
const summaryMode = args.includes('--summary')

function numArg(flag, fallback) {
  const i = args.indexOf(flag)
  if (i === -1 || args[i + 1] === undefined) return fallback
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : fallback
}
const opts = {
  minDelta: numArg('--min-delta', 0.5),
  stableBand: numArg('--stable-band', 0.25),
  minPerWindow: numArg('--min-per-window', 3),
  // Statistical contract (docs/scoring-statistical-design.md § 3.3): the
  // corpus "targeting is sharpening" verdict needs ≥10 scored evals per
  // calendar window. Overridable for inspection, never for publishing.
  minPerWindowForVerdict: numArg('--min-window-verdict', GATES.trendMinPerWindowForVerdict),
  noiseFloor: numArg('--noise-floor', OVERALL_NOISE_FLOOR),
}

// --- Arrow + sign helpers for the summary ---
// Arrows are reserved for movement that cleared the noise floor (docs § 4
// rule 5); anything within noise renders flat, never with a direction.
const arrow = (v) => (v === 'improving' ? '↑' : v === 'declining' ? '↓' : '→')
const signed = (n) => (n > 0 ? `+${n}` : `${n}`)
const movementArrow = (t) =>
  t.movementClass === 'improving' ? '↑' : t.movementClass === 'declining' ? '↓' : '·'

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`)
    return
  }
  const { metadata, trajectorySummary: ts, listingTrajectories, landscapeTrend, recommendations } = result

  console.log(`\n${'='.repeat(64)}`)
  console.log(`  Score Trend — ${metadata.analysisDate}`)
  console.log(`  ${metadata.evaluated} evaluations (${metadata.dateRange.from} to ${metadata.dateRange.to}) · ${metadata.reevaluatedListings} re-evaluated listing(s)`)
  console.log(`${'='.repeat(64)}\n`)

  // --- Landscape trend (is targeting sharpening?) ---
  console.log('LANDSCAPE TREND (earlier vs recent evaluations)')
  console.log('-'.repeat(48))
  if (landscapeTrend.insufficientData) {
    console.log(`  ${landscapeTrend.reason}`)
  } else {
    const lt = landscapeTrend
    console.log(`  earlier  avg ${lt.older.avgOverall}  (${lt.older.count} evals, ${lt.older.strongSolidShare}% strong/solid, ${lt.older.dateRange.from}→${lt.older.dateRange.to})`)
    console.log(`  recent   avg ${lt.recent.avgOverall}  (${lt.recent.count} evals, ${lt.recent.strongSolidShare}% strong/solid, ${lt.recent.dateRange.from}→${lt.recent.dateRange.to})`)
    // The verdict line follows the contract, not the legacy dead-band: under
    // the per-window gate it is an explicit insufficient-data marker; within
    // the noise floor it is a stated flat result, never a hedged direction.
    if (lt.reportableVerdict === 'insufficient-data') {
      console.log(`  ⃠ insufficient data — no verdict`)
      console.log(`    ${lt.verdictGate.reason}`)
    } else if (lt.reportableVerdict === 'flat-within-noise') {
      console.log(`  · flat within noise  (|Δ| ${Math.abs(lt.delta).toFixed(2)} < ${lt.noiseFloor} floor; n=${Math.min(lt.verdictGate.olderCount, lt.verdictGate.recentCount)}, ${lt.verdictConfidence} confidence)`)
    } else {
      console.log(`  ${arrow(lt.reportableVerdict)} ${lt.reportableVerdict}  (${signed(lt.delta)} Overall, ${signed(lt.strongSolidShareDelta)} pts strong/solid; n=${Math.min(lt.verdictGate.olderCount, lt.verdictGate.recentCount)}, ${lt.verdictConfidence} confidence)`)
    }
  }

  // --- Re-evaluated listings summary ---
  if (ts.reevaluated > 0) {
    console.log('\nRE-EVALUATED LISTINGS')
    console.log('-'.repeat(48))
    console.log(`  ${ts.detectable} moved beyond the ${ts.noiseFloor} noise floor · ${ts.withinNoise} flat within noise`)
    console.log(`  of those: ${ts.movement.improving} improving · ${ts.movement.declining} declining`)
    console.log(`  avg move ${signed(ts.avgDelta)} · band upgrades ${ts.bandUpgrades} · downgrades ${ts.bandDowngrades}`)

    // --- Per-listing movers (biggest absolute move first) ---
    console.log('\nBIGGEST MOVERS (first → latest Overall)')
    console.log('-'.repeat(48))
    for (const t of listingTrajectories.slice(0, 12)) {
      const label = `${t.company} — ${t.role}`.slice(0, 40)
      const band = t.bandChanged ? `  [${t.bandFrom}→${t.bandTo}]` : ''
      const driver = t.topMover ? `  (${t.topMover.label} ${signed(t.topMover.delta)})` : ''
      // Sub-floor moves print flat and carry no sign; every row states its n.
      const move = t.detectable
        ? `${signed(t.delta)}`
        : `flat within noise (|Δ| ${Math.abs(t.delta).toFixed(2)} < ${t.noiseFloor})`
      console.log(`  ${movementArrow(t)} ${label.padEnd(41)} ${t.firstOverall} → ${t.latestOverall}  ${move}  [n=${t.evals}, ${t.confidence}]${band}${driver}`)
    }
  } else {
    console.log('\nRE-EVALUATED LISTINGS')
    console.log('-'.repeat(48))
    console.log('  No company+role has been evaluated more than once yet.')
  }

  // --- Recommendations ---
  if (recommendations.length > 0) {
    console.log(`\nMOVES`)
    console.log('='.repeat(64))
    recommendations.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`)
      console.log(`     ${r.reasoning}`)
    })
  }
  console.log('')
}

// --- Run ---
const tsvText = existsSync(SCORE_HISTORY_FILE) ? readFileSync(SCORE_HISTORY_FILE, 'utf-8') : ''
const result = analyzeTrend(parseScoreHistory(tsvText), opts)

if (summaryMode) {
  printSummary(result)
} else {
  console.log(JSON.stringify(result, null, 2))
}

if (result.error) process.exit(1)
