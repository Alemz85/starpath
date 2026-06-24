import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  livenessKey,
  parseDiscarded,
  deriveLiveness,
  countScansThisMonth,
} from '@/lib/scanHistory'

// A fixed clock so the threshold assertions are exact and TZ-independent
// (scan dates parse as UTC midnight; `now` is UTC; getTime() diffs are absolute).
const NOW = new Date('2026-06-24T00:00:00Z')

// ─── livenessKey (canonical entity key) ──────────────────────────────────────

test('livenessKey trims, lowercases, and joins company|role', () => {
  assert.equal(livenessKey('  Acme  ', 'ML Engineer'), 'acme|ml engineer')
  assert.equal(livenessKey('ACME', 'ml engineer'), livenessKey('acme', 'ML ENGINEER'))
})

// ─── parseDiscarded ──────────────────────────────────────────────────────────

test('parseDiscarded collapses the tombstone log to a key set', () => {
  const tsv = [
    'company\trole\tdate',
    'Acme\tML Engineer\t2026-06-01',
    'Globex\tAnalyst\t2026-06-02',
    '\t\t',                 // blank → skipped
    'Initech',              // short → skipped
  ].join('\n')
  const set = parseDiscarded(tsv)
  assert.equal(set.size, 2)
  assert.ok(set.has(livenessKey('Acme', 'ML Engineer')))
  assert.ok(set.has('globex|analyst'))
})

test('parseDiscarded is empty for null/headerless input', () => {
  assert.equal(parseDiscarded(null).size, 0)
  assert.equal(parseDiscarded('company\trole\tdate').size, 0)
})

// ─── deriveLiveness: threshold boundaries ────────────────────────────────────

// Column order is intentionally NOT company-first — deriveLiveness resolves
// columns by header name, so this also guards the indexOf lookup.
function scanRow(company: string, title: string, lastDate: string): string {
  return `https://x\t${company}\t${title}\t2026-01-01|${lastDate}`
}
const HEADER = 'url\tcompany\ttitle\tscan_dates'

function liveness(rows: string[], now = NOW) {
  return deriveLiveness([HEADER, ...rows].join('\n'), now)
}

test('deriveLiveness: < 14 days is active, exactly 14 days is stale', () => {
  const out = liveness([
    scanRow('A', 'Role', '2026-06-11'),  // 13 days → active
    scanRow('B', 'Role', '2026-06-10'),  // exactly 14 days → stale
  ])
  assert.equal(out['a|role'], 'active')
  assert.equal(out['b|role'], 'stale')
})

test('deriveLiveness: < 90 days is stale, exactly 90 days is closed', () => {
  const out = liveness([
    scanRow('C', 'Role', '2026-03-27'),  // 89 days → stale
    scanRow('D', 'Role', '2026-03-26'),  // exactly 90 days → closed
  ])
  assert.equal(out['c|role'], 'stale')
  assert.equal(out['d|role'], 'closed')
})

test('deriveLiveness: a future scan date reads as active', () => {
  const out = liveness([scanRow('E', 'Role', '2026-07-01')])
  assert.equal(out['e|role'], 'active')
})

test('deriveLiveness: uses the last date in a multi-date list', () => {
  // scan_dates "2026-01-01|2026-06-20" → last is 4 days ago → active, even
  // though the first date is ancient.
  const out = liveness([`https://x\tF\tRole\t2026-01-01|2026-06-20`])
  assert.equal(out['f|role'], 'active')
})

test('deriveLiveness: keeps the freshest verdict across duplicate keys', () => {
  const out = liveness([
    scanRow('G', 'Role', '2026-01-01'),  // closed
    scanRow('G', 'Role', '2026-06-20'),  // active
  ])
  assert.equal(out['g|role'], 'active')
})

test('deriveLiveness: skips malformed dates and incomplete rows', () => {
  const out = liveness([
    `https://x\tH\tRole\tnot-a-date`,    // unparseable → skipped
    `https://x\t\tRole\t2026-06-20`,      // no company → skipped
    `https://x\tI\tRole\t`,               // no dates → skipped
  ])
  assert.deepEqual(out, {})
})

test('deriveLiveness: returns {} when required columns are missing', () => {
  assert.deepEqual(deriveLiveness('foo\tbar\nx\ty', NOW), {})
  assert.deepEqual(deriveLiveness(null, NOW), {})
})

// ─── countScansThisMonth ─────────────────────────────────────────────────────

test('countScansThisMonth counts unique dates in the current month only', () => {
  const tsv = [
    'company\ttitle\tscan_dates',
    'A\tRole\t2026-06-01|2026-05-30',   // June 1 counts, May 30 doesn't
    'B\tRole\t2026-06-15',
    'C\tRole\t2026-06-01',              // dup of June 1 → not double-counted
    'D\tRole\t2026-04-10',              // other month
  ].join('\n')
  assert.equal(countScansThisMonth(tsv, NOW), 2)  // {06-01, 06-15}
})

test('countScansThisMonth is 0 without a scan_dates column or data', () => {
  assert.equal(countScansThisMonth('company\ttitle\nA\tRole', NOW), 0)
  assert.equal(countScansThisMonth(null, NOW), 0)
  assert.equal(countScansThisMonth('', NOW), 0)
})
