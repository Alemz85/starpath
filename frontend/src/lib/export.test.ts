import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializeRows,
  exportFilename,
  DATABASE_EXPORT_COLUMNS,
} from '@/lib/export'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'

const HEADERS = ['Company', 'Role', 'Match', 'Ease', 'Eligibility', 'Verdict', 'Tier', 'Location', 'Archetype', 'Liveness', 'Added', 'URL']

test('the export column set matches the documented headers', () => {
  assert.deepEqual(DATABASE_EXPORT_COLUMNS.map(c => c.header), HEADERS)
})

test('CSV quotes fields with commas/quotes and uses CRLF line endings', () => {
  const e = makeScoreEntry({ company: 'Acme, Inc.', role: 'ML "Lead"', match: 8.4, ease: 7.0, location: 'Berlin' })
  const out = serializeRows([e], 'csv')
  const [header, body] = out.split('\r\n')
  assert.equal(header, HEADERS.join(','))
  assert.ok(body.includes('"Acme, Inc."'))        // comma → quoted
  assert.ok(body.includes('"ML ""Lead"""'))       // embedded quote → doubled
  assert.ok(out.includes('\r\n'))                   // Excel-friendly CRLF
})

test('Match / Ease / Eligibility / Verdict columns; a blocked row has blank scores and its reason', () => {
  const scored = makeScoreEntry({ company: 'Acme', role: 'PM', match: 8.25, ease: 5.6, eligibility: 'amber', eligibility_flags: 'start_date:amber:start not stated;language:amber:B2 vs C1' })
  const blocked = makeBlockedEntry('German C1 required', { company: 'Globex', role: 'Intern' })
  const [, a, b] = serializeRows([scored, blocked], 'tsv').split('\n')
  const ca = a.split('\t')
  assert.equal(ca[2], '8.25')
  assert.equal(ca[3], '5.6')
  assert.equal(ca[4], 'amber: start not stated; B2 vs C1')
  assert.equal(ca[5], 'stretch')
  const cb = b.split('\t')
  assert.equal(cb[2], '')          // blank, not 0
  assert.equal(cb[3], '')
  assert.equal(cb[4], 'red: German C1 required')
  assert.equal(cb[5], 'blocked')
  assert.equal(cb[6], 'T4')
})

test('TSV has no quoting and collapses interior tabs/newlines to a space', () => {
  const e = makeScoreEntry({ company: 'Acme, Inc.', role: 'Data\tAnalyst', match: 7.1, ease: 7 })
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
