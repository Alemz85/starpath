// batch-usage.mjs — parse `claude -p --output-format json` worker logs into
// per-spawn token/cost accounting rows.
//
// Why this exists: the batch runner is the system's main token spender, and
// TODO.md's token-cost project starts with "measure before optimizing". A
// worker log (stdout+stderr combined) normally ends with one compact JSON
// "result" event carrying usage + cost. This module extracts that event
// robustly (stderr noise, partial logs, legacy text logs) and renders one
// TSV row per spawn for batch/logs/usage.tsv.
//
// Pure functions only — the CLI wrapper (scripts/parse-batch-result.mjs)
// does the file I/O.

export const USAGE_TSV_HEADER = [
  'timestamp',
  'batch_id',
  'report_num',
  'status',
  'score',
  'input_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'output_tokens',
  'cost_usd',
  'duration_ms',
  'num_turns',
].join('\t')

/**
 * Find the final Claude CLI "result" event in a worker log.
 *
 * `claude -p --output-format json` emits a single JSON object on stdout,
 * but the runner redirects 2>&1 into the same file, so stray stderr lines
 * can precede or follow it. Strategy:
 *   1. Try the whole trimmed content as JSON (clean logs).
 *   2. Otherwise scan lines from the END, returning the first line that
 *      parses as an object with type === 'result' (or that carries a
 *      `usage` object — older CLI versions omitted `type`).
 *
 * @param {string} content raw log file content
 * @returns {object|null} the parsed result event, or null when absent
 */
export function findResultEvent(content) {
  if (!content || !content.trim()) return null

  const whole = tryParse(content.trim())
  if (isResultEvent(whole)) return whole

  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    const obj = tryParse(line)
    if (isResultEvent(obj)) return obj
  }
  return null
}

function tryParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function isResultEvent(obj) {
  if (!obj || typeof obj !== 'object') return false
  return obj.type === 'result' || (obj.usage && typeof obj.usage === 'object')
}

/**
 * Extract the worker-reported evaluation score from a log.
 *
 * The worker prompt asks each worker to print a JSON summary containing
 * `"score": X.X` in its final message. With --output-format json that
 * message lives (decoded) in the result event's `.result` string; legacy
 * text logs carry it directly. Both paths reduce to the same regex.
 *
 * @param {string} content   raw log content
 * @param {object|null} resultEvent  the event from findResultEvent (optional)
 * @returns {number|null}
 */
export function extractScore(content, resultEvent = null) {
  const haystacks = []
  if (resultEvent && typeof resultEvent.result === 'string') haystacks.push(resultEvent.result)
  if (typeof content === 'string') haystacks.push(content)
  for (const h of haystacks) {
    const m = h.match(/"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/)
    if (m) return Number(m[1])
  }
  return null
}

/**
 * Parse a full worker log into the accounting fields for one usage row.
 * Never throws — a mangled log yields nulls, not a crashed batch.
 *
 * @param {string} content raw log content
 * @returns {{
 *   status: 'completed'|'failed'|'unknown',
 *   score: number|null,
 *   inputTokens: number|null, cacheCreationTokens: number|null,
 *   cacheReadTokens: number|null, outputTokens: number|null,
 *   costUsd: number|null, durationMs: number|null, numTurns: number|null,
 * }}
 */
export function parseWorkerLog(content) {
  const ev = findResultEvent(content)
  const usage = ev?.usage ?? {}
  const num = (v) => (Number.isFinite(v) ? v : null)
  return {
    status: ev ? (ev.is_error ? 'failed' : 'completed') : 'unknown',
    score: extractScore(content, ev),
    inputTokens: num(usage.input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
    costUsd: num(ev?.total_cost_usd),
    durationMs: num(ev?.duration_ms),
    numTurns: num(ev?.num_turns),
  }
}

/**
 * Render one usage TSV row (matching USAGE_TSV_HEADER column order).
 * Nulls become '-' so the TSV stays rectangular and awk-friendly.
 */
export function usageTsvRow({ timestamp, batchId, reportNum, parsed }) {
  const cell = (v) => (v == null ? '-' : String(v))
  return [
    cell(timestamp),
    cell(batchId),
    cell(reportNum),
    cell(parsed.status),
    cell(parsed.score),
    cell(parsed.inputTokens),
    cell(parsed.cacheCreationTokens),
    cell(parsed.cacheReadTokens),
    cell(parsed.outputTokens),
    cell(parsed.costUsd),
    cell(parsed.durationMs),
    cell(parsed.numTurns),
  ].join('\t')
}
