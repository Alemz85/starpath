#!/usr/bin/env node
/**
 * outcomes.mjs — what happened to the applications you sent, with gates.
 *
 * Joins the status log, applications.md, score-history and (optionally) your
 * materials index on one application key, classifies every application that
 * reached the market (progressed / rejected / no-response / pending /
 * withdrawn), and reports counts, gated rates, rejection timing and the
 * Ease-vs-outcome check. Below a gate the counts stay and every conclusion is
 * withheld (docs/scoring-statistical-design.md § 3.7).
 *
 * Read-only. Suggest-only: a confirmed gap is printed as a suggestion with a
 * stable id; nothing is ever written.
 *
 * Usage:
 *   node scripts/outcomes.mjs                 # human-readable summary
 *   node scripts/outcomes.mjs --chat          # compact block + why-table (markdown), for the chat
 *   node scripts/outcomes.mjs --json          # structured JSON
 *   node scripts/outcomes.mjs --materials <path.tsv>   # materials index (else user/profile.yml outcomes.materials_index)
 *   node scripts/outcomes.mjs --today 2026-10-20       # pin "today" (tests, reproducible runs)
 *
 * Math: scripts/lib/outcome-stats.mjs. Inputs: scripts/lib/outcome-inputs.mjs.
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataRootFor } from './lib/data-root.mjs'
import { loadOutcomeInputs } from './lib/outcome-inputs.mjs'
import { analyzeApplicationOutcomes, formatOutcomesBlock, formatRate } from './lib/outcome-stats.mjs'
import { todayLocal } from './lib/status-ledger.mjs'

const ROOT = dataRootFor(dirname(dirname(fileURLToPath(import.meta.url))))

const args = process.argv.slice(2)
const argVal = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null
}
const root = argVal('--root') || ROOT
const today = argVal('--today') || todayLocal()

const inputs = loadOutcomeInputs(root, { materialsPath: argVal('--materials'), today })
const result = analyzeApplicationOutcomes(inputs)

if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({ ...result, sources: { materialsIndex: inputs.sources.materialsFound } }, null, 2) + '\n')
} else if (args.includes('--chat')) {
  process.stdout.write(formatOutcomesBlock(result) + '\n')
} else {
  printSummary(result)
}

function printSummary(r) {
  const o = r.overall
  const out = []
  out.push('', `Application outcomes — ${r.records.length} sent, as of ${r.today}`, '')
  if (!r.records.length) {
    out.push('  No application has reached the market yet (nothing at Applied or beyond).', '')
    process.stdout.write(out.join('\n') + '\n')
    return
  }
  const c = o.counts
  out.push(`  ${c.progressed} progressed · ${c.rejected} rejected · ${c.noResponse} no response · ${c.pending} pending${c.withdrawn ? ` · ${c.withdrawn} withdrawn` : ''}`)
  out.push(o.sample.sufficient
    ? `  reply ${formatRate(o.rates.reply, o.sample)} · progress ${formatRate(o.rates.progress, o.sample)} · interview ${formatRate(o.rates.interview, o.sample)}`
    : `  rates withheld: ${o.sample.n} resolved, ${o.sample.gate} needed`)
  const t = o.timing
  out.push(`  rejections: ${t.fast} fast · ${t.normal} normal · ${t.late} late${t.untimed ? ` · ${t.untimed} approximate` : ''}` +
    (t.sample.sufficient ? ` — median ${t.medianDays}d` : ` — timing withheld: ${t.sample.n} exactly dated, ${t.sample.gate} needed`))
  out.push('', '  Ease vs outcomes:')
  for (const cmp of r.easeCheck.comparisons) {
    const name = cmp.kind === 'high-no-progress' ? 'high never progresses' : `${cmp.higher} vs ${cmp.lower}`
    out.push(`    ${name.padEnd(22)} ${cmp.status}`)
  }
  if (r.suggestions.length) {
    out.push('', '  Suggestions (yours to decide; nothing is applied):')
    for (const s of r.suggestions) out.push(`    [${s.id}] ${s.title}`)
  } else {
    out.push('', '  No conclusion about the scoring is supported yet.')
  }
  out.push('', '  Per application: node scripts/outcomes.mjs --chat', '')
  process.stdout.write(out.join('\n') + '\n')
}
