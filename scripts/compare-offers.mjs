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
//       { "label": "Northwind — Analyst", "want": 8.25, "ease": 6.4,
//         "scores": { "comp": 8, "growth": 8, "brand": 9, "location": 6, "risk": 7 } },
//       { "label": "Contoso — Ops", "want": 7.1, "ease": 7.6,
//         "scores": { "comp": 6, "growth": 5, "brand": 4, "location": 9, "risk": 8 } }
//     ]
//   }
// "weights" is optional (uniform if omitted). Each offer needs the comp /
// growth / brand / location / risk factor scores in [1,10] (comp via
// compFactorFromSavings; the others from the report). The fit factor is the
// scouting Want — pass "want" (stored value; "ease" optional) or "dims" (the
// ten v2 dimensions, replayed through the engine). The offer is already in
// hand, so Ease and the verdict are shown for context only and never affect
// the ranking. A hand-typed scores.fit is only for offers with no scouting
// evaluation.

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

const cell = (v) => (v == null ? '—' : v)

function renderTable(result) {
  const { ranking, weights } = result
  const headerFactors = FACTORS.map(f => `${f}(${pct(weights[f])})`)
  const lines = []
  // fit(…) is the Want-based factor that ranks; Ease / Verdict are context only.
  lines.push(['#', 'Offer', ...headerFactors, 'TOTAL', 'Ease (info)', 'Verdict (info)'].join('\t'))
  for (const r of ranking) {
    lines.push([
      r.rank,
      r.label,
      ...FACTORS.map(f => r.scores[f]),
      r.total,
      cell(r.ease),
      cell(r.verdictLabel),
    ].join('\t'))
  }
  return lines.join('\n')
}

const HELP = `compare-offers — weighted multi-offer comparison (ofertas mode).

  node scripts/compare-offers.mjs offers.json [--json]
  cat offers.json | node scripts/compare-offers.mjs [--json]

Each offer: { label, want (or dims), ease?, scores: { comp, growth, brand,
location, risk } }. Fit = the scouting Want (the offer is in hand, so Ease
doesn't rank); Ease and the verdict are shown for context only.`

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP)
    return
  }
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
  const factorPair = (x, a, b) => `${FACTOR_LABELS[x.factor]} (${a.scores[x.factor]} vs ${b.scores[x.factor]})`
  if (t.winnerWins.length) {
    console.log(`${result.winner.label} wins on: ` +
      t.winnerWins.map(x => factorPair(x, result.winner, result.runnerUp)).join('; '))
  }
  if (t.runnerUpWins.length) {
    console.log(`${result.runnerUp.label} wins on: ` +
      t.runnerUpWins.map(x => factorPair(x, result.runnerUp, result.winner)).join('; '))
  }
  console.log('')
  console.log('Recommendation:')
  console.log(result.recommendation)
  console.log('')
}

main()
