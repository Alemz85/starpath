#!/usr/bin/env node

/**
 * append-score-rows.mjs — add an evaluation's rows to data/score-history.tsv
 * and data/report-summaries.tsv (the sanctioned way; no shell redirection).
 *
 *   node scripts/append-score-rows.mjs --input batch/work/<id>-rows.json
 *
 * The input file is JSON written with the Write tool (no shell quoting):
 *
 *   { "score_history":  { "date": "2026-10-21", "archetype": "…", …any of the 29 columns by name… },
 *     "report_summary": { "date": "…", "company": "…", "role": "…", "archetype": "…", "tier": "T2",
 *                         "want": 7.5, "ease": 6, "eligibility": "green", "key_gaps": "—", "verdict": "stretch" } }
 *
 * Either key may be omitted. Columns not given are written empty; tabs and
 * newlines inside a value become spaces. The score_history column order and
 * header are SCORE_HISTORY_HEADER (docs/scoring-v2.md §8.1). Appends are
 * locked, atomic and idempotent (an identical row is not added twice).
 * Prints `{"score_history":"appended"|"duplicate","report_summary":…}`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRootFor, repoRootFrom } from './lib/data-root.mjs'
import { appendScoreRows } from './lib/score-rows.mjs'

const argv = process.argv.slice(2)
const i = argv.indexOf('--input')
if (i === -1 || !argv[i + 1]) {
  console.error("Usage: node scripts/append-score-rows.mjs --input batch/work/<id>-rows.json")
  process.exit(2)
}

try {
  const input = JSON.parse(readFileSync(argv[i + 1], 'utf-8'))
  const ROOT = process.env.CAREER_OPS_ROOT || dataRootFor(repoRootFrom(import.meta.url))
  const out = appendScoreRows(input, {
    historyFile: join(ROOT, 'data/score-history.tsv'),
    summariesFile: join(ROOT, 'data/report-summaries.tsv'),
  })
  console.log(JSON.stringify(out))
} catch (err) {
  console.error(`append-score-rows: ${err.message}`)
  process.exit(1)
}
