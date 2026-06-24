import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializeRows,
  exportFilename,
  DATABASE_EXPORT_COLUMNS,
} from '@/lib/export'
import { makeScoreEntry } from '@/test-utils/fixtures'

const HEADERS = ['Company', 'Role', 'Score', 'Current Fit', 'Aspirational Fit', 'Tier', 'Location', 'Archetype', 'Liveness', 'Added', 'URL']

test('the export column set matches the documented headers', () => {
  assert.deepEqual(DATABASE_EXPORT_COLUMNS.map(c => c.header), HEADERS)
})

test('CSV quotes fields with commas/quotes and uses CRLF line endings', () => {
  const e = makeScoreEntry({ company: 'Acme, Inc.', role: 'ML "Lead"', overall: 8.4, current_fit: 7.0, location: 'Berlin' })
  const out = serializeRows([e], 'csv')
  const [header, body] = out.split('\r\n')
  assert.equal(header, HEADERS.join(','))
  assert.ok(body.includes('"Acme, Inc."'))        // comma → quoted
  assert.ok(body.includes('"ML ""Lead"""'))       // embedded quote → doubled
  assert.ok(out.includes('\r\n'))                   // Excel-friendly CRLF
})

test('unscored dimensions serialize blank, not 0.0', () => {
  const e = makeScoreEntry({ company: 'Acme', role: 'PM', overall: 0, current_fit: 0, aspirational_fit: 6.2 })
  const [, body] = serializeRows([e], 'csv').split('\r\n')
  const cells = body.split(',')
  assert.equal(cells[2], '')       // Score (overall 0 → blank)
  assert.equal(cells[3], '')       // Current Fit (0 → blank)
  assert.equal(cells[4], '6.2')    // Aspirational Fit
})

test('TSV has no quoting and collapses interior tabs/newlines to a space', () => {
  const e = makeScoreEntry({ company: 'Acme, Inc.', role: 'Data\tAnalyst', overall: 7.1 })
  const out = serializeRows([e], 'tsv')
  const [header, body] = out.split('\n')
  assert.equal(header, HEADERS.join('\t'))
  assert.ok(body.startsWith('Acme, Inc.\t'))   // comma stays unquoted in TSV
  assert.ok(body.includes('Data Analyst'))      // tab collapsed to a space
  assert.ok(!out.includes('\r'))                 // LF-only for clipboard
})

test('exportFilename is dated and well-formed', () => {
  assert.match(exportFilename('csv'), /^starpath-database-\d{4}-\d{2}-\d{2}\.csv$/)
})
