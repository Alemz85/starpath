import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_USAGE_COLUMNS,
  APP_USAGE_HEADER,
  appUsageRow,
  appendUsageRow,
  formatCost,
  parseResultUsage,
  parseUsageTsv,
  sourceLabel,
  spawnSource,
  sumUsage,
  totalInputTokens,
  weekStart,
  weeklyTotals,
  type SpawnUsage,
} from '@/lib/usage'
import { humanizeJsonlChunk, formatResultStats } from '@/lib/spawnFormat'

const result = (o: object = {}) =>
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 184000, num_turns: 41, total_cost_usd: 0.4213,
    usage: { input_tokens: 120, cache_creation_input_tokens: 40000, cache_read_input_tokens: 316000, output_tokens: 5400 },
    ...o,
  })

const USAGE: SpawnUsage = {
  inputTokens: 120, cacheCreationTokens: 40000, cacheReadTokens: 316000, outputTokens: 5400,
  costUsd: 0.4213, durationMs: 184000, numTurns: 41, isError: false,
}

// ─── the result event ────────────────────────────────────────────────────────

test('parseResultUsage reads the numbers the CLI already reports', () => {
  assert.deepEqual(parseResultUsage(result()), USAGE)
  assert.equal(totalInputTokens(USAGE), 356120)
})

test('parseResultUsage is null for anything but a result event', () => {
  assert.equal(parseResultUsage(JSON.stringify({ type: 'assistant', message: {} })), null)
  assert.equal(parseResultUsage('not json'), null)
  assert.equal(parseResultUsage('null'), null)
})

test('parseResultUsage keeps missing fields null and flags an error result', () => {
  const u = parseResultUsage(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))
  assert.equal(u?.inputTokens, null)
  assert.equal(u?.costUsd, null)
  assert.equal(u?.isError, true)
  assert.equal(parseResultUsage(result({ is_error: true }))?.isError, true)
})

test('the humanizer hands the result usage back without changing its lines', () => {
  const chunk = JSON.stringify({ type: 'system' }) + '\n' + result() + '\n'
  const r = humanizeJsonlChunk('', chunk)
  assert.deepEqual(r.usage, USAGE)
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /^✓ Done — 3m 04s · 41 turns · 356\.1k in \(89% cached\) \/ 5\.4k out · \$0\.42$/)
})

test('the humanizer finds a result split across chunks, and none where there is none', () => {
  const full = result() + '\n'
  const a = humanizeJsonlChunk('', full.slice(0, 30))
  assert.equal(a.usage, undefined)
  const b = humanizeJsonlChunk(a.buffer, full.slice(30))
  assert.deepEqual(b.usage, USAGE)
})

test('the capstone leaves the cost out when the CLI reported none', () => {
  assert.equal(formatResultStats({ duration_ms: 5000 }), '5s')
  assert.equal(formatResultStats({ duration_ms: 5000, total_cost_usd: 0 }), '5s')
})

// ─── what kind of spawn ──────────────────────────────────────────────────────

test('spawnSource tells evaluations, slash commands and the rest apart', () => {
  assert.equal(spawnSource(['--append-system-prompt-file', 'batch/batch-prompt.md', '-p', 'Run the pipeline']), 'app:evaluate')
  assert.equal(spawnSource(['--verbose', '-p', '/career-ops pdf Nimbus Robotics — run end-to-end']), 'app:pdf')
  assert.equal(spawnSource(['-p', '/career-ops interview-prep x']), 'app:interview-prep')
  assert.equal(spawnSource(['-p', 'Convert this CV']), 'app')
  assert.equal(spawnSource([]), 'app')
})

test('sourceLabel names the app actions and falls back to Run', () => {
  assert.equal(sourceLabel('app:evaluate'), 'Evaluation')
  assert.equal(sourceLabel('app:pdf'), 'Tailor CV')
  assert.equal(sourceLabel('batch'), 'Batch')
  assert.equal(sourceLabel('app:something-new'), 'Run')
})

// ─── the ledger file ─────────────────────────────────────────────────────────

test('app-usage.tsv starts with the batch ledger columns, then source and label', () => {
  assert.equal(
    APP_USAGE_HEADER,
    'timestamp\tbatch_id\treport_num\tstatus\tscore\tverdict\tinput_tokens\tcache_creation_tokens\tcache_read_tokens\toutput_tokens\tcost_usd\tduration_ms\tnum_turns\tsource\tlabel',
  )
  assert.equal(APP_USAGE_COLUMNS.length, 15)
})

test('appUsageRow writes one rectangular line, keeping tabs out of the label', () => {
  const row = appUsageRow({ at: Date.parse('2026-10-20T09:05:00Z'), spawnId: 'tailor-1', label: 'Tailor\tCV: Nimbus', source: 'app:pdf', usage: USAGE })
  const cells = row.split('\t')
  assert.equal(cells.length, APP_USAGE_COLUMNS.length)
  assert.equal(cells[0], '2026-10-20T09:05:00.000Z')
  assert.equal(cells[3], 'completed')
  assert.equal(cells[10], '0.4213')
  assert.equal(cells[13], 'app:pdf')
  assert.equal(cells[14], 'Tailor CV: Nimbus')
  assert.equal(appUsageRow({ at: 0, spawnId: 'x', label: 'x', source: 'app', usage: { ...USAGE, isError: true, costUsd: null } }).split('\t')[3], 'failed')
  assert.equal(appUsageRow({ at: 0, spawnId: 'x', label: 'x', source: 'app', usage: { ...USAGE, costUsd: null } }).split('\t')[10], '-')
})

test('appendUsageRow adds the header to a new file and the line to an existing one', () => {
  assert.equal(appendUsageRow(null, 'a'), APP_USAGE_HEADER + '\na\n')
  assert.equal(appendUsageRow('', 'a'), APP_USAGE_HEADER + '\na\n')
  assert.equal(appendUsageRow(APP_USAGE_HEADER + '\na\n', 'b'), APP_USAGE_HEADER + '\na\nb\n')
  assert.equal(appendUsageRow(APP_USAGE_HEADER + '\na', 'b'), APP_USAGE_HEADER + '\na\nb\n')
})

// ─── reading both ledgers ────────────────────────────────────────────────────

const BATCH =
  'timestamp\tbatch_id\treport_num\tstatus\tscore\tverdict\tinput_tokens\tcache_creation_tokens\tcache_read_tokens\toutput_tokens\tcost_usd\tduration_ms\tnum_turns\n' +
  '2026-10-19T10:00:00Z\t7\t031\tcompleted\t7.2\tgo\t90\t30000\t270000\t4000\t0.31\t120000\t30\n' +
  '2026-10-19T11:00:00Z\t8\t-\tunknown\t-\t-\t-\t-\t-\t-\t-\t-\t-\n' +
  'garbage line without a timestamp\n'

test('parseUsageTsv reads the batch ledger by header name, newest first', () => {
  const rows = parseUsageTsv(BATCH)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, 'Batch 8')
  assert.equal(rows[0].costUsd, null)
  assert.equal(rows[0].inputTokens, 0)
  assert.equal(rows[1].label, 'Batch report 031')
  assert.equal(rows[1].source, 'batch')
  assert.equal(rows[1].inputTokens, 300090)
  assert.equal(rows[1].outputTokens, 4000)
  assert.equal(rows[1].costUsd, 0.31)
  assert.ok(Math.abs(rows[1].cachedShare - 270000 / 300090) < 1e-9)
})

test('parseUsageTsv reads app rows, and extra columns do not shift the rest', () => {
  const row = appUsageRow({ at: Date.parse('2026-10-20T08:00:00Z'), spawnId: 'add-1', label: 'Add listing', source: 'app:evaluate', usage: USAGE })
  const [r] = parseUsageTsv(APP_USAGE_HEADER + '\n' + row + '\n', 'app')
  assert.equal(r.label, 'Add listing')
  assert.equal(r.source, 'app:evaluate')
  assert.equal(r.status, 'completed')
  assert.equal(r.durationMs, 184000)
  assert.equal(r.costUsd, 0.4213)
})

test('parseUsageTsv copes with an empty, headerless or header-only file', () => {
  assert.deepEqual(parseUsageTsv(null), [])
  assert.deepEqual(parseUsageTsv(''), [])
  assert.deepEqual(parseUsageTsv(APP_USAGE_HEADER + '\n'), [])
  assert.deepEqual(parseUsageTsv('no\theader\nx\ty\n'), [])
})

// ─── weekly totals ───────────────────────────────────────────────────────────

test('weekStart is Monday 00:00 local', () => {
  const wed = new Date(2026, 9, 21, 15, 30).getTime()
  assert.equal(weekStart(wed), new Date(2026, 9, 19).getTime())
  const sun = new Date(2026, 9, 25, 23, 59).getTime()
  assert.equal(weekStart(sun), new Date(2026, 9, 19).getTime())
  const mon = new Date(2026, 9, 19, 0, 0).getTime()
  assert.equal(weekStart(mon), mon)
})

const entry = (at: number, over: Partial<ReturnType<typeof parseUsageTsv>[number]> = {}) => ({
  at, source: 'app', label: 'x', status: 'completed', inputTokens: 1000, outputTokens: 100, cachedShare: 0, costUsd: 0.5, durationMs: 1, ...over,
})

test('weeklyTotals splits this week from last week and counts unpriced runs', () => {
  const now = new Date(2026, 9, 21, 12).getTime()
  const mon = new Date(2026, 9, 19).getTime()
  const entries = [
    entry(now - 1000),
    entry(mon + 1000, { costUsd: null }),
    entry(mon - 1000, { costUsd: 2 }),                       // Sunday night: last week
    entry(new Date(2026, 9, 13, 9).getTime(), { costUsd: 1 }),
    entry(new Date(2026, 9, 5, 9).getTime(), { costUsd: 9 }), // two weeks back: neither
  ]
  const { thisWeek, lastWeek } = weeklyTotals(entries, now)
  assert.deepEqual(thisWeek, { runs: 2, inputTokens: 2000, outputTokens: 200, costUsd: 0.5, unpriced: 1 })
  assert.deepEqual(lastWeek, { runs: 2, inputTokens: 2000, outputTokens: 200, costUsd: 3, unpriced: 0 })
  assert.deepEqual(sumUsage([]), { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpriced: 0 })
})

test('formatCost', () => {
  assert.equal(formatCost(null), '—')
  assert.equal(formatCost(0.004), '<$0.01')
  assert.equal(formatCost(0), '$0.00')
  assert.equal(formatCost(12.345), '$12.35')
})
