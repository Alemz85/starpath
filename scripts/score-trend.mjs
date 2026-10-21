#!/usr/bin/env node
/**
 * score-trend.mjs — Re-evaluation / score-trend tracker for career-ops
 * (scoring v2: Match, Ease, verdict — docs/scoring-v2.md).
 *
 * The targeting analyzer (analyze-patterns.mjs --scouting) treats
 * data/score-history.tsv as a flat landscape. This tool adds the TIME axis it
 * omits, answering two questions the flat view can't:
 *
 *   1. Per-listing trajectory — for every company+role evaluated on 2+
 *      distinct dates, how did its Match and its Ease MOVE (each against its
 *      own noise floor), and did its verdict move (upgrade / downgrade)?
 *   2. Landscape trend — are the roles you've evaluated *later* stronger matches /
 *      easier to reach than your *earlier* ones, and did the actionable share
 *      (go + stretch + solid) rise? (i.e. is your targeting sharpening?)
 *
 * Blocked evaluations (eligibility red) carry no Match / Ease: they are kept out
 * of every score number but still count on the verdict axis, so a listing that
 * went blocked ↔ scored shows up as a verdict move.
 *
 * Read-only: it never writes to score-history.tsv or anything else. All math
 * lives in the pure lib/score-trend-core.mjs; this file is just file I/O +
 * formatting.
 *
 * Every claim here is bound by docs/scoring-statistical-design.md: per-listing
 * Match moves under 0.30 and Ease moves under 0.35 print as "flat within noise",
 * and the corpus verdict is withheld entirely below 10 scored evals per
 * calendar window rather than rendered in a hedged form.
 *
 * Run: node scripts/score-trend.mjs            (JSON to stdout)
 *      node scripts/score-trend.mjs --summary  (human-readable report)
 *      node scripts/score-trend.mjs --summary --min-delta 0.3
 *      node scripts/score-trend.mjs --summary --min-window-verdict 6   (inspection only)
 *      node scripts/score-trend.mjs --summary --match-floor 0.3 --ease-floor 0.35
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseScoreHistory, analyzeTrend } from './lib/score-trend-core.mjs'
import { GATES, MATCH_NOISE_FLOOR, EASE_NOISE_FLOOR } from './lib/scoring-stats.mjs'
import { VERDICT_LABELS } from './lib/score-bands.mjs'

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)))
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv')

// --- CLI args ---
const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/score-trend.mjs [--summary] [options]

Re-evaluation trajectories and the earlier-vs-later landscape trend over
data/score-history.tsv, on Match and Ease separately (scoring v2).

  --summary                 human-readable report (default: JSON)
  --min-delta N             smallest Match/Ease move a recommendation fires on (default 0.5)
  --min-per-window N        minimum scored rows per calendar window to split (default 3)
  --min-window-verdict N    corpus-verdict gate per window (default ${GATES.trendMinPerWindowForVerdict}; inspection only)
  --match-floor N            Match noise floor (default ${MATCH_NOISE_FLOOR}; inspection only)
  --ease-floor N            Ease noise floor (default ${EASE_NOISE_FLOOR}; inspection only)`)
  process.exit(0)
}

const summaryMode = args.includes('--summary')

function numArg(flag, fallback) {
  const i = args.indexOf(flag)
  if (i === -1 || args[i + 1] === undefined) return fallback
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : fallback
}
const opts = {
  minDelta: numArg('--min-delta', 0.5),
  minPerWindow: numArg('--min-per-window', 3),
  // Statistical contract (docs/scoring-statistical-design.md § 3.3): the
  // corpus "targeting is sharpening" verdict needs ≥10 scored evals per
  // calendar window. Overridable for inspection, never for publishing.
  minPerWindowForVerdict: numArg('--min-window-verdict', GATES.trendMinPerWindowForVerdict),
  matchFloor: numArg('--match-floor', MATCH_NOISE_FLOOR),
  easeFloor: numArg('--ease-floor', EASE_NOISE_FLOOR),
}

// --- Arrow + sign helpers for the summary ---
// Arrows are reserved for movement that cleared the floor AND the gate
// (docs § 4 rule 5); anything within noise renders flat, never with a direction.
const arrow = (v) => (v === 'improving' ? '↑' : v === 'declining' ? '↓' : '·')
const signed = (n) => (n > 0 ? `+${n}` : `${n}`)
const label = (v) => VERDICT_LABELS[v] ?? v

/** "Match 7.1 → 7.6 (+0.5) ↑" / "Match flat within noise (|Δ| 0.10 < 0.30)" / "Match n/a (1 scored eval)". */
function metricCell(name, track) {
  if (!track || !Number.isFinite(track.delta)) {
    return `${name} n/a (${track?.n ?? 0} scored eval${track?.n === 1 ? '' : 's'})`
  }
  if (!track.detectable) {
    return `${name} ${track.first} → ${track.latest} flat within noise (|Δ| ${Math.abs(track.delta).toFixed(2)} < ${track.noiseFloor})`
  }
  return `${name} ${track.first} → ${track.latest} (${signed(track.delta)}) ${arrow(track.movementClass)}`
}

function printMetricTrend(name, block) {
  if (block.reportableVerdict === 'insufficient-data') {
    console.log(`  ${name.padEnd(5)} earlier ${block.earlier ?? 'n/a'} · later ${block.later ?? 'n/a'}  — no verdict (gate not met)`)
  } else if (block.reportableVerdict === 'flat-within-noise') {
    console.log(`  ${name.padEnd(5)} earlier ${block.earlier} · later ${block.later}  · flat within noise (|Δ| ${Math.abs(block.delta).toFixed(2)} < ${block.noiseFloor} floor; n=${block.n}, ${block.confidence} confidence)`)
  } else {
    console.log(`  ${name.padEnd(5)} earlier ${block.earlier} · later ${block.later}  ${arrow(block.reportableVerdict)} ${block.reportableVerdict} (${signed(block.delta)}; n=${block.n}, ${block.confidence} confidence)`)
  }
}

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`)
    return
  }
  const { metadata, trajectorySummary: ts, listingTrajectories, landscapeTrend: lt, recommendations } = result

  console.log(`\n${'='.repeat(64)}`)
  console.log(`  Score Trend — ${metadata.analysisDate}`)
  console.log(`  ${metadata.evaluated} scored evaluations${metadata.blocked ? ` + ${metadata.blocked} blocked` : ''} (${metadata.dateRange.from} to ${metadata.dateRange.to}) · ${metadata.reevaluatedListings} re-evaluated listing(s)`)
  console.log(`  Noise floors: Match ${metadata.contract.noiseFloors.match} · Ease ${metadata.contract.noiseFloors.ease}`)
  console.log(`${'='.repeat(64)}\n`)

  // --- Landscape trend (is targeting sharpening?) ---
  console.log('LANDSCAPE TREND (earlier vs later evaluations)')
  console.log('-'.repeat(48))
  if (lt.insufficientData) {
    console.log(`  ${lt.reason}`)
  } else {
    const win = (w) => `${w.count} scored evals${w.blocked ? ` (+${w.blocked} blocked)` : ''}, ${w.actionableShare}% actionable, ${w.dateRange.from}→${w.dateRange.to}`
    console.log(`  split at ${lt.splitDate}`)
    console.log(`  earlier  ${win(lt.earlier)}`)
    console.log(`  later    ${win(lt.later)}`)
    // Verdict lines follow the contract: under the per-window gate an explicit
    // insufficient-data marker; within a floor a stated flat result.
    if (!lt.verdictGate.met) {
      console.log(`  ⃠ insufficient data — no verdict`)
      console.log(`    ${lt.verdictGate.reason}`)
    }
    printMetricTrend('Match', lt.match)
    printMetricTrend('Ease', lt.ease)
    const share = lt.verdictGate.met
      ? `${signed(lt.actionableShareDelta)} pts`
      : `${lt.actionableShareDelta} pts difference, no verdict`
    console.log(`  actionable share (go + stretch + solid) ${lt.earlier.actionableShare}% → ${lt.later.actionableShare}% (${share}; ${lt.verdictGate.earlierCount} vs ${lt.verdictGate.laterCount} evals)`)
  }

  // --- Verdict moves across re-evaluations ---
  const up = lt.verdictUpgrades
  const down = lt.verdictDowngrades
  if (up.n > 0) {
    const caveat = up.insufficientData
      ? ` — ${up.n} listing(s) compared, ${up.gate} needed before reading a direction`
      : ` (${up.confidence} confidence)`
    console.log(`  verdict moves: ${up.count} upgrade(s) · ${down.count} downgrade(s) of ${up.n} re-evaluated${caveat}`)
  }

  // --- Re-evaluated listings summary ---
  console.log('\nRE-EVALUATED LISTINGS')
  console.log('-'.repeat(48))
  if (ts.reevaluated > 0) {
    for (const [name, s] of [['Match', ts.match], ['Ease', ts.ease]]) {
      console.log(`  ${name}: ${s.detectable} of ${s.n} moved beyond the ${s.noiseFloor} floor (${s.improving} improving · ${s.declining} declining) · ${s.withinNoise} flat within noise`)
    }
    console.log(`  verdict: ${ts.verdictMoves.upgrade} upgraded · ${ts.verdictMoves.downgrade} downgraded · ${ts.verdictMoves.same} unchanged`)

    // --- Per-listing movers ---
    console.log('\nBIGGEST MOVERS (first → latest)')
    console.log('-'.repeat(48))
    for (const t of listingTrajectories.slice(0, 12)) {
      const name = `${t.company} — ${t.role}`.slice(0, 40)
      const verdict = t.verdictChanged
        ? `  [${label(t.verdictFrom)} → ${label(t.verdictTo)}${t.verdictMoveDetectable ? '' : ', sub-floor wobble'}]`
        : `  [${label(t.verdictTo)}]`
      const drivers = ['match', 'ease']
        .map(m => t[m].topMover)
        .filter(Boolean)
        .map(d => `${d.label} ${signed(d.delta)}`)
      const driver = drivers.length ? `  (${drivers.join(', ')})` : ''
      console.log(`  ${name.padEnd(41)} ${metricCell('Match', t.match)} · ${metricCell('Ease', t.ease)}  [n=${t.evals}, ${t.confidence}]${verdict}${driver}`)
    }
  } else {
    console.log('  No company+role has been evaluated on more than one date yet.')
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
