#!/usr/bin/env node
/**
 * training-roi.mjs — Training / certification ROI evaluator for the `training`
 * mode. Grounds a "is this course worth it?" decision in data/score-history.tsv
 * instead of vibes: does the training close a dimension that's systemically
 * dragging the user's evaluations, does it map to archetypes they actually
 * target, what does replaying the scoring engine with that dimension lifted
 * do to Ease and the verdicts, and is the time/cost proportionate to the gap
 * it closes? Blocked rows (eligibility red) are excluded from the score math.
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
 *     "name": "Applied SQL for Analysts course",
 *     "targetDimensions": ["skills_match", "experience_bar"],
 *     "mappedArchetypes": ["Strategy & Operations", "Data Analyst"],
 *     "weeks": 6,
 *     "hoursPerWeek": 8,
 *     "costEur": 0,
 *     "producesArtifact": true,
 *     "brandStrength": 8,
 *     "expectedLift": 1
 *   }
 *
 * targetDimensions are the dimensions a training can move: skills_match,
 * experience_bar, competition, role_content (loose aliases accepted:
 * "skills", "experience", "credential", "positioning"). expectedLift is the
 * integer steps assumed (default 1) for the engine replay. mappedArchetypes
 * are matched against the score-history archetype buckets. Want/Ease weights
 * for the replay come from user/profile.yml → scoring.want_weights /
 * scoring.ease_weights when present (engine defaults otherwise).
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { parseScoreHistory, dimensionDrag, isBlocked } from './lib/targeting-core.mjs'
import { trainingVerdict, TRAINABLE_DIMS } from './lib/training-roi.mjs'

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)))
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv')
const PROFILE_FILE = join(CAREER_OPS, 'user/profile.yml')

const args = process.argv.slice(2)
const summaryMode = args.includes('--summary')
const dragOnly = args.includes('--drag')
const offerIdx = args.indexOf('--offer')
const offerJson = offerIdx !== -1 ? args[offerIdx + 1] : null

function loadRows() {
  if (!existsSync(SCORE_HISTORY_FILE)) return []
  return parseScoreHistory(readFileSync(SCORE_HISTORY_FILE, 'utf-8'))
}

// Best effort: the user's Want/Ease weights, so the replay matches how their
// listings were scored. Missing / unreadable profile → engine defaults.
function loadWeights() {
  try {
    if (!existsSync(PROFILE_FILE)) return {}
    const scoring = yaml.load(readFileSync(PROFILE_FILE, 'utf-8'))?.scoring || {}
    return { wantWeights: scoring.want_weights, easeWeights: scoring.ease_weights }
  } catch {
    return {}
  }
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

const rows = loadRows()
const blockedCount = rows.filter(isBlocked).length
const scoredCount = rows.length - blockedCount
if (scoredCount === 0) {
  fail(
    'No scored scouting evaluations found in data/score-history.tsv' +
      (blockedCount ? ` (${blockedCount} blocked rows carry no scores)` : '') + '. ' +
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
        `  ${String(i + 1).padStart(2)}. ${d.label.padEnd(20)} avg ${String(d.avg).padStart(4)}  ${d.rollup === 'ease' ? 'Ease' : 'Want'}  (low in ${d.lowShare}% of evals)${TRAINABLE_DIMS.includes(d.key) ? '' : '  [not trainable]'}`,
      )
    })
    console.log('')
  } else {
    console.log(JSON.stringify({ evaluated: scoredCount, blocked: blockedCount, dimensionDrag: drag }, null, 2))
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

const result = trainingVerdict(rows, offer, loadWeights())
result.meta = { evaluated: scoredCount, blocked: blockedCount, offerName: offer.name || '(unnamed)' }

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
console.log(`  Measured against ${result.meta.evaluated} scored scouting evaluations` +
  (result.meta.blocked ? ` (${result.meta.blocked} blocked excluded)` : ''))
console.log(`${'='.repeat(60)}\n`)

console.log(`VERDICT: ${VERDICT_LABEL[result.verdict] || result.verdict}`)
console.log(`  ${result.headline}\n`)

console.log('REASONING')
console.log('-'.repeat(56))
result.trace.forEach((line) => console.log(`  • ${line}`))

if (result.unknownDimensions.length > 0) {
  console.log(
    `\n  ⚠ Unrecognized target dimension(s): ${result.unknownDimensions.join(', ')} ` +
      `(not a dimension a training can move — ${TRAINABLE_DIMS.join(', ')} — ignored).`,
  )
}

if (result.verdict === 'SKIP' && result.context.topTrainableDrag) {
  const td = result.context.topTrainableDrag
  console.log(
    `\n  → If you want training that DOES move the needle, target "${td.label}" ` +
      `(avg ${td.avg}, low in ${td.lowShare}% of evals) — your biggest drag a training can move.`,
  )
}

console.log('')
