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

import { deniedTools } from './worker-capabilities.mjs'

export const USAGE_TSV_HEADER = [
  'timestamp',
  'batch_id',
  'report_num',
  'status',
  'score',
  'verdict',
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
 * Pull one scalar JSON field out of the worker's final summary. With
 * --output-format json the summary lives (decoded) in the result event's
 * `.result` string; legacy text logs carry it directly. Both paths reduce to
 * the same regex; the event string wins over stray matches in raw content.
 */
function extractField(content, resultEvent, re) {
  const haystacks = []
  if (resultEvent && typeof resultEvent.result === 'string') haystacks.push(resultEvent.result)
  if (typeof content === 'string') haystacks.push(content)
  for (const h of haystacks) {
    const m = h.match(re)
    if (m) return m[1]
  }
  return null
}

/**
 * Extract the worker-reported Priority from a log (docs/scoring-v2.md §8.6:
 * the final JSON's `score` key now carries Priority = sqrt(want × ease)).
 *
 * The worker prompt asks each worker to print a JSON summary containing
 * `"score": X.XX` in its final message. A Blocked listing reports
 * `"score": null`, which — like a missing key — yields null here; use
 * extractVerdict() / isBlocked() to tell the two apart.
 *
 * @param {string} content   raw log content
 * @param {object|null} resultEvent  the event from findResultEvent (optional)
 * @returns {number|null}
 */
export function extractScore(content, resultEvent = null) {
  const v = extractField(content, resultEvent, /"score"\s*:\s*([0-9]+(?:\.[0-9]+)?)/)
  return v === null ? null : Number(v)
}

/**
 * Extract the worker-reported verdict key (go|stretch|growth|solid|thin|skip|
 * blocked) from the final JSON, lower-cased; null when absent.
 */
export function extractVerdict(content, resultEvent = null) {
  const v = extractField(content, resultEvent, /"verdict"\s*:\s*"([A-Za-z_-]+)"/)
  return v === null ? null : v.toLowerCase()
}

/** Extract the worker-reported eligibility status (green|amber|red); null when absent. */
export function extractEligibility(content, resultEvent = null) {
  const v = extractField(content, resultEvent, /"eligibility"\s*:\s*"(green|amber|red)/i)
  return v === null ? null : v.toLowerCase()
}

/**
 * True when the worker reported a Blocked listing (verdict "blocked" or red
 * eligibility). Blocked rows carry no Priority, so the runner's min-score gate
 * must treat them as failing and the average must exclude them.
 */
export function isBlocked(verdict, eligibility) {
  return verdict === 'blocked' || eligibility === 'red'
}

/**
 * What the worker said about its own run in the final JSON summary
 * (batch-prompt.md Step 8): `"status": "completed | skipped_duplicate | failed"`
 * and `"error"`. A worker that could not fetch the JD, or found the posting
 * closed, exits 0 and reports `"status": "failed"` here, so the exit code alone
 * cannot tell success from failure. The LAST status wins (the summary is the
 * final JSON object; earlier objects, e.g. `other` flags, use other words).
 *
 * @returns {{status: 'completed'|'failed'|'skipped_duplicate'|null, error: string|null}}
 */
export function extractReported(content, resultEvent = null) {
  const haystacks = []
  if (resultEvent && typeof resultEvent.result === 'string') haystacks.push(resultEvent.result)
  if (typeof content === 'string') haystacks.push(content)
  for (const h of haystacks) {
    const statuses = [...h.matchAll(/"status"\s*:\s*"(completed|failed|skipped_duplicate)"/g)]
    if (statuses.length === 0) continue
    const last = statuses[statuses.length - 1]
    const status = last[1]
    // The summary's own `error` follows its `status`; an earlier object's does not count.
    const after = h.slice(last.index + last[0].length)
    const err = /"error"\s*:\s*(null|"(?:[^"\\]|\\.)*")/.exec(after)
    let error = null
    if (err && err[1] !== 'null') {
      try { error = String(JSON.parse(err[1])).replace(/\s+/g, ' ').trim().slice(0, 200) || null } catch { /* keep null */ }
    }
    return { status, error }
  }
  return { status: null, error: null }
}

/** Does a worker's failure reason say the posting is closed (nothing to retry)? */
export function isClosedPostingReason(error) {
  return /posting (is |was )?(closed|expired|removed)|no longer (open|available|accepting)|(position|role|job) (has been |is )?(filled|closed)|\bexpired\b/i.test(String(error ?? ''))
}

/**
 * How the batch runner should record a worker that exited 0:
 *   'failed'    the final summary says failed (JD unreachable, denied call, …): retryable
 *   'closed'    it failed because the posting is closed: skipped, not retried
 *   'duplicate' it skipped the listing as already evaluated
 *   'completed' anything else (including a log with no summary: see evalNoResult)
 */
export function reportedOutcome(reported) {
  if (reported?.status === 'failed') return isClosedPostingReason(reported.error) ? 'closed' : 'failed'
  if (reported?.status === 'skipped_duplicate') return 'duplicate'
  return 'completed'
}

/**
 * Parse a full worker log into the accounting fields for one usage row.
 * Never throws — a mangled log yields nulls, not a crashed batch.
 *
 * @param {string} content raw log content
 * @returns {{
 *   status: 'completed'|'failed'|'unknown',
 *   reported: string|null, reportedError: string|null, outcome: 'completed'|'failed'|'closed'|'duplicate',
 *   score: number|null, verdict: string|null, blocked: boolean,
 *   inputTokens: number|null, cacheCreationTokens: number|null,
 *   cacheReadTokens: number|null, outputTokens: number|null,
 *   costUsd: number|null, durationMs: number|null, numTurns: number|null,
 *   denied: string[],
 * }}
 */
export function parseWorkerLog(content) {
  const ev = findResultEvent(content)
  const usage = ev?.usage ?? {}
  const num = (v) => (Number.isFinite(v) ? v : null)
  const verdict = extractVerdict(content, ev)
  // A refused tool call fails the worker (worker-capabilities.mjs).
  const denied = deniedTools(ev)
  const reported = extractReported(content, ev)
  const outcome = reportedOutcome(reported)
  return {
    status: ev ? (ev.is_error || denied.length > 0 || outcome === 'failed' || outcome === 'closed' ? 'failed' : 'completed') : 'unknown',
    reported: reported.status,
    reportedError: reported.error,
    outcome,
    score: extractScore(content, ev),
    verdict,
    blocked: isBlocked(verdict, extractEligibility(content, ev)),
    inputTokens: num(usage.input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
    costUsd: num(ev?.total_cost_usd),
    durationMs: num(ev?.duration_ms),
    numTurns: num(ev?.num_turns),
    denied,
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
    cell(parsed.verdict),
    cell(parsed.inputTokens),
    cell(parsed.cacheCreationTokens),
    cell(parsed.cacheReadTokens),
    cell(parsed.outputTokens),
    cell(parsed.costUsd),
    cell(parsed.durationMs),
    cell(parsed.numTurns),
  ].join('\t')
}
