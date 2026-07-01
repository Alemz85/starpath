import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  findResultEvent,
  extractScore,
  parseWorkerLog,
  usageTsvRow,
  USAGE_TSV_HEADER,
} from './batch-usage.mjs'

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 184223,
  num_turns: 41,
  result: 'Done.\n```json\n{\n  "status": "completed",\n  "score": 7.4,\n  "tier": "T2"\n}\n```',
  total_cost_usd: 0.8123,
  usage: {
    input_tokens: 1200,
    cache_creation_input_tokens: 45000,
    cache_read_input_tokens: 310000,
    output_tokens: 5400,
  },
}

// ─── findResultEvent ─────────────────────────────────────────────────────────

test('finds a clean single-object log', () => {
  const ev = findResultEvent(JSON.stringify(RESULT_EVENT))
  assert.equal(ev.total_cost_usd, 0.8123)
})

test('finds the result event amid stderr noise before and after', () => {
  const log = [
    'npm warn config production Use `--omit=dev` instead.',
    '{"type":"system","subtype":"init"}',
    JSON.stringify(RESULT_EVENT),
    'some trailing stderr line',
  ].join('\n')
  const ev = findResultEvent(log)
  assert.equal(ev.num_turns, 41)
})

test('picks the LAST result-shaped line when several JSON lines exist', () => {
  const earlier = { ...RESULT_EVENT, total_cost_usd: 0.1 }
  const log = JSON.stringify(earlier) + '\n' + JSON.stringify(RESULT_EVENT)
  assert.equal(findResultEvent(log).total_cost_usd, 0.8123)
})

test('accepts a usage-bearing object without type (older CLI)', () => {
  const ev = { usage: { input_tokens: 5 }, total_cost_usd: 0.01 }
  assert.equal(findResultEvent(JSON.stringify(ev)).total_cost_usd, 0.01)
})

test('returns null for empty / non-JSON / JSON-without-usage logs', () => {
  assert.equal(findResultEvent(''), null)
  assert.equal(findResultEvent('plain text failure\nexit 1'), null)
  assert.equal(findResultEvent('{"type":"assistant","message":{}}'), null)
})

// ─── extractScore ────────────────────────────────────────────────────────────

test('extracts score from the decoded result string', () => {
  assert.equal(extractScore('', RESULT_EVENT), 7.4)
})

test('falls back to raw content for legacy text logs', () => {
  const legacy = 'blah blah\n{"status": "completed", "score": 8.5, "id": "3"}\n'
  assert.equal(extractScore(legacy, null), 8.5)
})

test('returns null when no score is present anywhere', () => {
  assert.equal(extractScore('no json here', { result: 'nope' }), null)
})

test('prefers the result-event score over stray matches in raw content', () => {
  const content = '{"score": 2.0} earlier noise'
  assert.equal(extractScore(content, RESULT_EVENT), 7.4)
})

// ─── parseWorkerLog ──────────────────────────────────────────────────────────

test('parses a full successful worker log', () => {
  const parsed = parseWorkerLog(JSON.stringify(RESULT_EVENT))
  assert.deepEqual(parsed, {
    status: 'completed',
    score: 7.4,
    inputTokens: 1200,
    cacheCreationTokens: 45000,
    cacheReadTokens: 310000,
    outputTokens: 5400,
    costUsd: 0.8123,
    durationMs: 184223,
    numTurns: 41,
  })
})

test('flags is_error results as failed', () => {
  const ev = { ...RESULT_EVENT, is_error: true, result: 'error: something broke' }
  assert.equal(parseWorkerLog(JSON.stringify(ev)).status, 'failed')
})

test('mangled log yields unknown status and null fields, never throws', () => {
  const parsed = parseWorkerLog('claude: command not found')
  assert.equal(parsed.status, 'unknown')
  assert.equal(parsed.inputTokens, null)
  assert.equal(parsed.costUsd, null)
})

// ─── usageTsvRow ─────────────────────────────────────────────────────────────

test('row column count matches the header and nulls render as dashes', () => {
  const parsed = parseWorkerLog('garbage')
  const row = usageTsvRow({ timestamp: '2026-07-01T10:00:00Z', batchId: '12', reportNum: '045', parsed })
  const cols = row.split('\t')
  assert.equal(cols.length, USAGE_TSV_HEADER.split('\t').length)
  assert.equal(cols[0], '2026-07-01T10:00:00Z')
  assert.equal(cols[3], 'unknown')
  assert.equal(cols[5], '-')
})

test('full row renders every numeric field', () => {
  const parsed = parseWorkerLog(JSON.stringify(RESULT_EVENT))
  const row = usageTsvRow({ timestamp: 't', batchId: '1', reportNum: '001', parsed })
  assert.equal(
    row,
    't\t1\t001\tcompleted\t7.4\t1200\t45000\t310000\t5400\t0.8123\t184223\t41',
  )
})
