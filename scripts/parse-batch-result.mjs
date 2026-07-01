#!/usr/bin/env node

// parse-batch-result.mjs — CLI wrapper around lib/batch-usage.mjs.
//
// Reads one batch worker log (the file written by batch-runner.sh for a
// single `claude -p --output-format json` spawn) and prints ONE tab-separated
// line the runner can `read` back:
//
//   status \t score \t input_tokens \t cache_creation \t cache_read \t output_tokens \t cost_usd \t duration_ms \t num_turns
//
// Missing values print as '-'. Exits 0 even for mangled logs (accounting
// must never fail the batch); exits 1 only on usage error.
//
// Usage: node scripts/parse-batch-result.mjs <logfile>

import { readFile } from 'fs/promises'
import { parseWorkerLog } from './lib/batch-usage.mjs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: parse-batch-result.mjs <logfile>\n')
  process.exit(1)
}

let content = ''
try {
  content = await readFile(file, 'utf8')
} catch {
  // Missing log: report unknowns, don't fail the batch.
}

const p = parseWorkerLog(content)
const cell = (v) => (v == null ? '-' : String(v))
process.stdout.write(
  [
    p.status, p.score, p.inputTokens, p.cacheCreationTokens, p.cacheReadTokens,
    p.outputTokens, p.costUsd, p.durationMs, p.numTurns,
  ].map(cell).join('\t') + '\n',
)
