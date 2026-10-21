#!/usr/bin/env node

// parse-batch-result.mjs — CLI wrapper around lib/batch-usage.mjs.
//
// Reads one batch worker log (the file written by batch-runner.sh for a
// single `claude -p --output-format json` spawn) and prints ONE tab-separated
// line the runner can `read` back:
//
//   status \t score \t input_tokens \t cache_creation \t cache_read \t output_tokens \t cost_usd \t duration_ms \t num_turns \t verdict \t denied \t outcome \t reported_error
//
// `score` is the worker's Priority (sqrt(match × ease), docs/scoring-v2.md
// §8.6); a Blocked listing has no Priority, so score is '-' and verdict is
// 'blocked'. `denied` is the `;`-joined calls the CLI refused (the worker's
// permissions, scripts/lib/worker-capabilities.mjs); the runner fails the
// listing when it is not '-'. `outcome` is what the worker's own final JSON
// says (completed | failed | closed | parked | duplicate; batch-usage.mjs › reportedOutcome)
// and `reported_error` its `error`: a worker can exit 0 and still report
// "status": "failed". Missing values print as '-'. Exits 0 even for mangled logs
// (accounting must never fail the batch); exits 1 only on usage error.
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
    p.outputTokens, p.costUsd, p.durationMs, p.numTurns, p.blocked ? 'blocked' : p.verdict,
    p.denied.length > 0 ? p.denied.join('; ').replace(/[\t\n]+/g, ' ') : null,
    p.outcome,
    p.reportedError ? p.reportedError.replace(/[\t\n]+/g, ' ') : null,
  ].map(cell).join('\t') + '\n',
)
