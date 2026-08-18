import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  upsertApplicationRow,
  updateApplicationStatus,
  updateApplicationFields,
  tierFolder,
  splitRow,
  joinRow,
  isTableDataRow,
  isTableSeparator,
  findApplicationRowIndex,
  ensureDeadlineColumn,
} from '@/lib/applicationsDoc'
import { parseApplications } from '@/lib/parsers/markdown'
import { APPLICATIONS_SCAFFOLD } from '../../../scripts/lib/profile-core.mjs'

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

// ─── 9-col → 10-col self-heal (F1c) ───────────────────────────────────────────

// A legacy applications.md exactly as the old 9-col scaffold produced it, with
// one tracked listing carrying a real Note the migration must preserve.
const LEGACY_9COL = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | [#1](reports/tier-2/Acme - ML Eng.md) | emailed Jane |',
].join('\n')

test('ensureDeadlineColumn upgrades a 9-col table to 10-col, padding Deadline with n/d', () => {
  const out = ensureDeadlineColumn(LEGACY_9COL)
  const lines = out.split('\n')
  assert.deepEqual(splitRow(lines[0]), ['#','Date','Company','Role','Score','Status','PDF','Deadline','Report','Notes'])
  assert.equal(isTableSeparator(lines[1]), true)
  const row = splitRow(lines[2])
  assert.equal(row.length, 10)
  assert.equal(row[7], 'n/d')                                        // Deadline padded
  assert.equal(row[8], '[#1](reports/tier-2/Acme - ML Eng.md)')     // Report intact
  assert.equal(row[9], 'emailed Jane')                              // Notes intact
})

test('ensureDeadlineColumn leaves a canonical 10-col table untouched (idempotent)', () => {
  assert.equal(ensureDeadlineColumn(DOC), DOC)
  assert.equal(ensureDeadlineColumn(ensureDeadlineColumn(LEGACY_9COL)), ensureDeadlineColumn(LEGACY_9COL))
})

test('the 9-col scaffold is already canonical 10-col (no migration needed)', () => {
  // profile-core now ships the 10-col scaffold, so a fresh profile never trips
  // the self-heal — the header carries Deadline out of the box.
  assert.match(APPLICATIONS_SCAFFOLD as string, /\| PDF \| Deadline \| Report \| Notes \|/)
  assert.equal(ensureDeadlineColumn(APPLICATIONS_SCAFFOLD as string), APPLICATIONS_SCAFFOLD)
})

test('upsert self-heals a legacy 9-col file: appends a valid 10-col row, preserves notes', () => {
  const next = upsertApplicationRow(LEGACY_9COL, { company: 'Globex', role: 'Analyst', overall: 7.2, tier: 'T2' })
  // Header upgraded to 10 columns.
  assert.match(next.split('\n')[0], /\| PDF \| Deadline \| Report \| Notes \|/)
  // The pre-existing row kept its Note through the migration…
  const acme = parseApplications(next).find(r => r.company === 'Acme')!
  assert.equal(acme.notes, 'emailed Jane')
  assert.equal(acme.report, '[#1](reports/tier-2/Acme - ML Eng.md)')
  // …and the new row is well-formed 10-col.
  const globex = parseApplications(next).find(r => r.company === 'Globex')!
  assert.equal(globex.num, 2)
  assert.equal(globex.deadline, 'n/d')
  assert.equal(globex.report, '[#2](reports/tier-2/Globex - Analyst.md)')
})

test('upsert refresh on a self-healed file updates Report, never Notes', () => {
  // Refresh the existing Acme row with a new report path. Pre-fix this wrote
  // cells[8] into a 9-col row's NOTES cell; post-migration cells[8] is Report.
  const next = upsertApplicationRow(LEGACY_9COL, {
    company: 'Acme', role: 'ML Eng', overall: 9.0, tier: 'T1',
    reportPath: 'reports/tier-1/Acme - ML Eng.md',
  })
  const acme = parseApplications(next).find(r => r.company === 'Acme')!
  assert.equal(acme.score, '9.0/10')                               // score refreshed
  assert.equal(acme.report, '[#1](reports/tier-1/Acme - ML Eng.md)')  // Report moved
  assert.equal(acme.notes, 'emailed Jane')                          // Notes untouched
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

// ─── updateApplicationFields (multi-cell patch) ───────────────────────────────

test('patching writes only the named cells and preserves the rest', () => {
  const next = updateApplicationFields(DOC, 'Globex', 'Analyst', {
    status: 'Applied', deadline: '2026-07-15', notes: 'sent via portal',
  })
  const cells = row(next, 'Globex', 'Analyst')!
  assert.equal(cells[5], 'Applied')
  assert.equal(cells[7], '2026-07-15')
  assert.equal(cells[9], 'sent via portal')
  // Untouched columns.
  assert.equal(cells[0], '2')
  assert.equal(cells[1], '2026-04-28')
  assert.equal(cells[4], '7.1/10')
  assert.equal(cells[6], '❌')
  assert.equal(cells[8], '[#2](reports/tier-2/Globex - Analyst.md)')
  // The other listing is untouched.
  assert.deepEqual(row(next, 'Acme', 'ML Eng'), row(DOC, 'Acme', 'ML Eng'))
})

test('an omitted key leaves that cell alone rather than blanking it', () => {
  const next = updateApplicationFields(DOC, 'Acme', 'ML Eng', { status: 'Interview' })
  const cells = row(next, 'Acme', 'ML Eng')!
  assert.equal(cells[5], 'Interview')
  assert.equal(cells[7], 'n/d')            // deadline preserved
  assert.equal(cells[9], 'emailed Jane')   // notes preserved
})

test('an empty patch or an unknown listing returns the document unchanged', () => {
  assert.equal(updateApplicationFields(DOC, 'Acme', 'ML Eng', {}), DOC)
  assert.equal(updateApplicationFields(DOC, 'Nobody', 'Nothing', { status: 'Applied' }), DOC)
})

test('matching a listing is case-insensitive, like every other mutator', () => {
  const next = updateApplicationFields(DOC, 'acme', 'ml eng', { notes: 'lowercased lookup' })
  assert.equal(row(next, 'Acme', 'ML Eng')![9], 'lowercased lookup')
})

test('patching a legacy 9-column file upgrades it instead of eating the report link', () => {
  const legacy = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | [#1](reports/tier-2/Acme - ML Eng.md) | emailed Jane |',
  ].join('\n')
  const next = updateApplicationFields(legacy, 'Acme', 'ML Eng', { deadline: '2026-07-15' })
  const cells = row(next, 'Acme', 'ML Eng')!
  assert.equal(cells.length, 10)
  assert.equal(cells[7], '2026-07-15')
  assert.equal(cells[8], '[#1](reports/tier-2/Acme - ML Eng.md)')  // report link intact
  assert.equal(cells[9], 'emailed Jane')                            // notes intact
})

test('upsert then patch is the chat-proposal write path and lands one clean row', () => {
  const upserted = upsertApplicationRow(DOC, {
    company: 'Initech', role: 'Data Analyst', overall: 7.8, tier: 'T2',
  })
  const next = updateApplicationFields(upserted, 'Initech', 'Data Analyst', {
    status: 'Applied', deadline: 'Rolling', notes: 'from chat',
  })
  assert.equal(next.split('\n').filter(isTableDataRow).length, 3)
  const cells = row(next, 'Initech', 'Data Analyst')!
  assert.equal(cells.length, 10)
  assert.equal(cells[0], '3')
  assert.equal(cells[3], 'Data Analyst')
  assert.equal(cells[4], '7.8/10')
  assert.equal(cells[5], 'Applied')
  assert.equal(cells[7], 'Rolling')
  assert.equal(cells[9], 'from chat')
  // Confirming the same proposal twice refreshes in place — never a duplicate.
  const again = updateApplicationFields(
    upsertApplicationRow(next, { company: 'Initech', role: 'Data Analyst', overall: 7.8, tier: 'T2' }),
    'Initech', 'Data Analyst', { status: 'Applied', deadline: 'Rolling', notes: 'from chat' },
  )
  assert.equal(again.split('\n').filter(isTableDataRow).length, 3)
  assert.equal(again, next)
})

test('the parser reads back a patched row', () => {
  const next = updateApplicationFields(DOC, 'Globex', 'Analyst', {
    status: 'Offer', deadline: 'Rolling', notes: 'negotiating',
  })
  const parsed = parseApplications(next).find(a => a.company === 'Globex')!
  assert.equal(parsed.status, 'Offer')
  assert.equal(parsed.deadline, 'Rolling')
  assert.equal(parsed.notes, 'negotiating')
  assert.equal(parsed.score, '7.1/10')
})
