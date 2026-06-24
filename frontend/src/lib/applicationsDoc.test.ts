import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  upsertApplicationRow,
  updateApplicationStatus,
  tierFolder,
  splitRow,
  joinRow,
  isTableDataRow,
  isTableSeparator,
  findApplicationRowIndex,
} from '@/lib/applicationsDoc'

// A realistic applications.md the user could have on disk — header, GFM
// separator, and two tracked listings with non-default Status / PDF / Notes
// that the upsert must never clobber.
const DOC = [
  '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
  '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | n/d | [#1](reports/tier-2/Acme - ML Eng.md) | emailed Jane |',
  '| 2 | 2026-04-28 | Globex | Analyst | 7.1/10 | Evaluated | ❌ | 2026-06-30 | [#2](reports/tier-2/Globex - Analyst.md) |  |',
].join('\n')

function row(doc: string, company: string, role: string): string[] | null {
  const i = findApplicationRowIndex(doc.split('\n'), company, role)
  return i === -1 ? null : splitRow(doc.split('\n')[i])
}

// ─── upsert: refresh-in-place (the dedup contract) ────────────────────────────

test('upsert refreshes an existing listing in place without adding a row', () => {
  const next = upsertApplicationRow(DOC, { company: 'Acme', role: 'ML Eng', overall: 9.1, tier: 'T1' })
  // Same number of data rows — no duplicate appended.
  assert.equal(next.split('\n').filter(isTableDataRow).length, 2)
  const cells = row(next, 'Acme', 'ML Eng')!
  assert.equal(cells[4], '9.1/10')        // score refreshed
  assert.equal(cells[5], 'Applied')        // status PRESERVED
  assert.equal(cells[6], '✅')             // pdf PRESERVED
  assert.equal(cells[9], 'emailed Jane')   // notes PRESERVED
})

test('upsert is idempotent when the score is unchanged', () => {
  const next = upsertApplicationRow(DOC, { company: 'Acme', role: 'ML Eng', overall: 8.4, tier: 'T2' })
  assert.equal(next, DOC)
})

test('upsert matches (company, role) case-insensitively', () => {
  const next = upsertApplicationRow(DOC, { company: 'acme', role: 'ml eng', overall: 9.9, tier: 'T1' })
  assert.equal(next.split('\n').filter(isTableDataRow).length, 2)
  assert.equal(row(next, 'Acme', 'ML Eng')![4], '9.9/10')
})

test('upsert refreshes the report link only when a path is supplied', () => {
  const keep = upsertApplicationRow(DOC, { company: 'Globex', role: 'Analyst', overall: 7.1, tier: 'T2' })
  assert.equal(row(keep, 'Globex', 'Analyst')![8], '[#2](reports/tier-2/Globex - Analyst.md)')
  const moved = upsertApplicationRow(DOC, { company: 'Globex', role: 'Analyst', overall: 7.1, tier: 'T1', reportPath: 'reports/tier-1/Globex - Analyst.md' })
  assert.equal(row(moved, 'Globex', 'Analyst')![8], '[#2](reports/tier-1/Globex - Analyst.md)')
})

// ─── upsert: append (new listing) ─────────────────────────────────────────────

test('upsert appends a new listing with the next number and Evaluated status', () => {
  const next = upsertApplicationRow(DOC, { company: 'Initech', role: 'PM', overall: 6.5, tier: 'T3' })
  const rows = next.split('\n').filter(isTableDataRow)
  assert.equal(rows.length, 3)
  const cells = row(next, 'Initech', 'PM')!
  assert.equal(cells[0], '3')              // max(#)+1
  assert.equal(cells[4], '6.5/10')
  assert.equal(cells[5], 'Evaluated')
  assert.equal(cells[6], '❌')
  assert.equal(cells[7], 'n/d')
  assert.equal(cells[8], '[#3](reports/tier-3/Initech - PM.md)')  // derived path
})

test('upsert renders an unscored listing with an em-dash, not 0.0', () => {
  const next = upsertApplicationRow(DOC, { company: 'NewCo', role: 'Intern', overall: 0, tier: 'T4' })
  assert.equal(row(next, 'NewCo', 'Intern')![4], '—')
})

test('upsert seeds the first row when the table has only a header', () => {
  const header = [
    '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
  ].join('\n')
  const next = upsertApplicationRow(header, { company: 'Acme', role: 'PM', overall: 7.7, tier: 'T2' })
  const rows = next.split('\n').filter(isTableDataRow)
  assert.equal(rows.length, 1)
  assert.equal(splitRow(rows[0])[0], '1')
})

// ─── status rewrite ───────────────────────────────────────────────────────────

test('updateApplicationStatus rewrites only the Status cell of the match', () => {
  const next = updateApplicationStatus(DOC, 'Globex', 'Analyst', 'Interview')
  const cells = row(next, 'Globex', 'Analyst')!
  assert.equal(cells[5], 'Interview')
  assert.equal(cells[7], '2026-06-30')  // deadline untouched
  // Other rows are byte-identical.
  assert.equal(row(next, 'Acme', 'ML Eng')!.join('|'), row(DOC, 'Acme', 'ML Eng')!.join('|'))
})

test('updateApplicationStatus returns the input unchanged when no row matches', () => {
  const next = updateApplicationStatus(DOC, 'Nobody', 'Nowhere', 'Offer')
  assert.equal(next, DOC)
})

test('updateApplicationStatus matches case-insensitively', () => {
  const next = updateApplicationStatus(DOC, 'GLOBEX', 'analyst', 'Offer')
  assert.equal(row(next, 'Globex', 'Analyst')![5], 'Offer')
})

// ─── primitives ───────────────────────────────────────────────────────────────

test('tierFolder maps every tier (T2-high collapses to tier-2, junk → tier-4)', () => {
  assert.equal(tierFolder('T1'), 'tier-1')
  assert.equal(tierFolder('T2'), 'tier-2')
  assert.equal(tierFolder('T2-high'), 'tier-2')
  assert.equal(tierFolder('T3'), 'tier-3')
  assert.equal(tierFolder('T4'), 'tier-4')
  assert.equal(tierFolder('???'), 'tier-4')
})

test('row classification excludes the header and separator', () => {
  const lines = DOC.split('\n')
  assert.equal(isTableSeparator(lines[1]), true)
  assert.equal(isTableDataRow(lines[0]), false)  // header (# column)
  assert.equal(isTableDataRow(lines[1]), false)  // separator
  assert.equal(isTableDataRow(lines[2]), true)
})

test('splitRow / joinRow round-trip a data row', () => {
  const cells = splitRow(DOC.split('\n')[2])
  assert.equal(cells.length, 10)
  assert.equal(cells[2], 'Acme')
  assert.equal(joinRow(cells), '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | n/d | [#1](reports/tier-2/Acme - ML Eng.md) | emailed Jane |')
})
