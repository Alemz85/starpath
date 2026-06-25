#!/usr/bin/env node
/**
 * training-roi.mjs — Training / certification ROI evaluator for the `training`
 * mode. Grounds a "is this course worth it?" decision in data/score-history.tsv
 * instead of vibes: does the training close a dimension that's systemically
 * dragging the user's evaluations, does it map to archetypes they actually
 * target, and is the time/cost proportionate to the gap it closes?
 *
 * The math lives in scripts/lib/training-roi.mjs (pure, tested). This file is
 * the thin file/CLI wrapper.
 *
 * Usage:
 *   node scripts/training-roi.mjs --offer '<json>'            (JSON to stdout)
 *   node scripts/training-roi.mjs --offer '<json>' --summary  (human-readable)
 *   node scripts/training-roi.mjs --drag                      (just the drag table)
 *
 * The --offer JSON describes the training (the agent fills this from the
 * user's description + the dimension/archetype mapping it derives at runtime):
 *   {
 *     "name": "Anthropic Applied LLM Evals course",
 *     "targetDimensions": ["skills_match", "ease_of_entry"],
 *     "mappedArchetypes": ["Strategy & Operations", "AI Product"],
 *     "weeks": 6,
 *     "hoursPerWeek": 8,
 *     "costEur": 0,
 *     "producesArtifact": true,
 *     "brandStrength": 8
 *   }
 *
 * targetDimensions accept loose aliases ("ease of entry", "brand", "skills");
 * mappedArchetypes are matched against the score-history archetype buckets.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseScoreHistory, dimensionDrag } from './lib/targeting-core.mjs'
import { trainingVerdict } from './lib/training-roi.mjs'

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)))
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv')

const args = process.argv.slice(2)
const summaryMode = args.includes('--summary')
const dragOnly = args.includes('--drag')
const offerIdx = args.indexOf('--offer')
const offerJson = offerIdx !== -1 ? args[offerIdx + 1] : null

function loadRows() {
  if (!existsSync(SCORE_HISTORY_FILE)) return []
  return parseScoreHistory(readFileSync(SCORE_HISTORY_FILE, 'utf-8'))
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

const rows = loadRows()
if (rows.length === 0) {
  fail(
    'No scouting evaluations found in data/score-history.tsv. ' +
      'Run a few /career-ops scouting evaluations first — the ROI verdict needs ' +
      'a corpus to measure the gap against.',
  )
}

// --drag: just print the systemic-drag table, so the agent (or user) can see
// which dimension a training SHOULD target before describing one.
if (dragOnly) {
  const drag = dimensionDrag(rows)
  if (summaryMode) {
    console.log('\nDIMENSION DRAG (weakest first — the gap a training should close)')
    console.log('-'.repeat(56))
    drag.forEach((d, i) => {
      console.log(
        `  ${String(i + 1).padStart(2)}. ${d.label.padEnd(20)} avg ${String(d.avg).padStart(4)}  (low in ${d.lowShare}% of evals)`,
      )
    })
    console.log('')
  } else {
    console.log(JSON.stringify({ evaluated: rows.length, dimensionDrag: drag }, null, 2))
  }
  process.exit(0)
}

if (!offerJson) {
  fail(
    'Missing --offer \'<json>\'. Provide the training as JSON, e.g.\n' +
      "  node scripts/training-roi.mjs --offer '{\"name\":\"X\",\"targetDimensions\":[\"skills_match\"],\"mappedArchetypes\":[\"Strategy & Operations\"],\"weeks\":6,\"hoursPerWeek\":8,\"producesArtifact\":true}'\n" +
      'Or run with --drag to see which dimension a training should target.',
  )
}

let offer
try {
  offer = JSON.parse(offerJson)
} catch (e) {
  fail(`--offer is not valid JSON: ${e.message}`)
}

const result = trainingVerdict(rows, offer)
result.meta = { evaluated: rows.length, offerName: offer.name || '(unnamed)' }

if (!summaryMode) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// --- Human-readable summary ---
const VERDICT_LABEL = {
  WORTH_IT: 'WORTH IT',
  TIMEBOX: 'WORTH IT — but TIMEBOX',
  SKIP: 'SKIP',
}

console.log(`\n${'='.repeat(60)}`)
console.log(`  Training ROI — ${result.meta.offerName}`)
console.log(`  Measured against ${result.meta.evaluated} scouting evaluations`)
console.log(`${'='.repeat(60)}\n`)

console.log(`VERDICT: ${VERDICT_LABEL[result.verdict] || result.verdict}`)
console.log(`  ${result.headline}\n`)

console.log('REASONING')
console.log('-'.repeat(56))
result.trace.forEach((line) => console.log(`  • ${line}`))

if (result.unknownDimensions.length > 0) {
  console.log(
    `\n  ⚠ Unrecognized target dimension(s): ${result.unknownDimensions.join(', ')} ` +
      '(not one of the 6 scored dimensions — ignored).',
  )
}

if (result.verdict === 'SKIP' && result.context.topDrag) {
  const td = result.context.topDrag
  console.log(
    `\n  → If you want training that DOES move the needle, target "${td.label}" ` +
      `(avg ${td.avg}, low in ${td.lowShare}% of evals) — your biggest systemic drag.`,
  )
}

console.log('')
