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
 * Run: node scripts/score-trend.mjs            (JSON to stdout)
 *      node scripts/score-trend.mjs --summary  (human-readable report)
 *      node scripts/score-trend.mjs --summary --min-delta 0.3
 *      node scripts/score-trend.mjs --summary --stable-band 0.4
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseScoreHistory, analyzeTrend } from './lib/score-trend-core.mjs'

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
}

// --- Arrow + sign helpers for the summary ---
const arrow = (v) => (v === 'improving' ? '↑' : v === 'declining' ? '↓' : '→')
const signed = (n) => (n > 0 ? `+${n}` : `${n}`)

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
    console.log(`  ${arrow(lt.verdict)} ${lt.verdict}  (${signed(lt.delta)} Overall, ${signed(lt.strongSolidShareDelta)} pts strong/solid)`)
  }

  // --- Re-evaluated listings summary ---
  if (ts.reevaluated > 0) {
    console.log('\nRE-EVALUATED LISTINGS')
    console.log('-'.repeat(48))
    console.log(`  ${ts.verdicts.improving} improving · ${ts.verdicts.declining} declining · ${ts.verdicts.stable} stable`)
    console.log(`  avg move ${signed(ts.avgDelta)} · band upgrades ${ts.bandUpgrades} · downgrades ${ts.bandDowngrades}`)

    // --- Per-listing movers (biggest absolute move first) ---
    console.log('\nBIGGEST MOVERS (first → latest Overall)')
    console.log('-'.repeat(48))
    for (const t of listingTrajectories.slice(0, 12)) {
      const label = `${t.company} — ${t.role}`.slice(0, 40)
      const band = t.bandChanged ? `  [${t.bandFrom}→${t.bandTo}]` : ''
      const driver = t.topMover ? `  (${t.topMover.label} ${signed(t.topMover.delta)})` : ''
      console.log(`  ${arrow(t.verdict)} ${label.padEnd(41)} ${t.firstOverall} → ${t.latestOverall}  ${signed(t.delta)}${band}${driver}`)
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
