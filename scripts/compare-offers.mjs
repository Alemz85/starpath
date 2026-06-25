#!/usr/bin/env node
// compare-offers.mjs — thin CLI over scripts/lib/offer-compare.mjs.
//
// The `ofertas` mode (modes/ofertas.md) is normally driven by the agent, which
// derives each offer's six factor scores from the scouting reports + a deep-dive
// and forwards the candidate's weights from user/profile.yml. This CLI lets the
// agent (or the user) run the deterministic comparison from a small JSON file so
// the ranking + recommendation are reproducible and the math is auditable.
//
// All scoring/comp/tradeoff logic lives in the pure lib; this file is only I/O
// + formatting. No user data, defaults, or company lists are hardcoded here.
//
// Usage:
//   node scripts/compare-offers.mjs offers.json
//   cat offers.json | node scripts/compare-offers.mjs
//   node scripts/compare-offers.mjs offers.json --json   # raw result object
//
// Input JSON shape:
//   {
//     "weights": { "comp": 3, "fit": 2, "growth": 2, "brand": 1, "location": 1, "risk": 1 },
//     "offers": [
//       { "label": "Stripe — Analyst", "scores": { "comp": 8, "fit": 9, "growth": 8, "brand": 9, "location": 6, "risk": 7 } },
//       { "label": "Local Co — Ops",   "scores": { "comp": 6, "fit": 7, "growth": 5, "brand": 4, "location": 9, "risk": 8 } }
//     ]
//   }
// "weights" is optional (uniform if omitted). Each offer needs all six factor
// scores in [1,10] — derive them up front (comp via compFactorFromSavings,
// fit via fitFactorFromDims; growth/brand/location/risk from the report).

import { readFileSync } from 'node:fs'
import { FACTORS, FACTOR_LABELS, compareOffers } from './lib/offer-compare.mjs'

function readInput(args) {
  const fileArg = args.find(a => !a.startsWith('--'))
  if (fileArg) return readFileSync(fileArg, 'utf8')
  return readFileSync(0, 'utf8') // stdin
}

function pct(x) {
  return `${Math.round(x * 100)}%`
}

function renderTable(result) {
  const { ranking, weights } = result
  const headerFactors = FACTORS.map(f => `${f}(${pct(weights[f])})`)
  const lines = []
  lines.push(['#', 'Offer', ...headerFactors, 'TOTAL'].join('\t'))
  for (const r of ranking) {
    lines.push([
      r.rank,
      r.label,
      ...FACTORS.map(f => r.scores[f]),
      r.total,
    ].join('\t'))
  }
  return lines.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')

  let input
  try {
    input = JSON.parse(readInput(args))
  } catch (e) {
    console.error(`compare-offers: could not read/parse input JSON — ${e.message}`)
    process.exit(1)
  }

  let result
  try {
    result = compareOffers(input.offers, input.weights)
  } catch (e) {
    console.error(`compare-offers: ${e.message}`)
    process.exit(1)
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('\nMulti-offer comparison')
  console.log('======================\n')
  console.log(renderTable(result))
  console.log('')

  const t = result.tradeoffs
  if (t.winnerWins.length) {
    console.log(`${result.winner.label} wins on: ` +
      t.winnerWins.map(x => `${FACTOR_LABELS[x.factor]} (${x.winnerScore} vs ${x.runnerUpScore})`).join('; '))
  }
  if (t.runnerUpWins.length) {
    console.log(`${result.runnerUp.label} wins on: ` +
      t.runnerUpWins.map(x => `${FACTOR_LABELS[x.factor]} (${x.runnerUpScore} vs ${x.winnerScore})`).join('; '))
  }
  console.log('')
  console.log('Recommendation:')
  console.log(result.recommendation)
  console.log('')
}

main()
