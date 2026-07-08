import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseApplications,
  parseScouting,
  parsePipeline,
  parseReportPath,
} from '@/lib/parsers/markdown'
// Cross-parser pin (F4): the scripts-side triage parser, imported straight from
// scripts/lib (plain .mjs, no @/ alias) so both implementations are exercised in
// one assertion. Kept in lockstep with scripts/lib/triage-core.test.mjs.
import { parsePendingEntries } from '../../../../scripts/lib/triage-core.mjs'

const APPS = [
  '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
  '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | **Applied** | ✅ | n/d | [#1](r) | hi |',
  '| 2 | 2026-04-28 | Globex | Analyst | 7.1/10 | Bogus | ❌ | n/d | [#2](r) |  |',
].join('\n')

test('parseApplications strips bold, normalizes unknown status, reads the PDF flag', () => {
  const rows = parseApplications(APPS)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].status, 'Applied')   // ** stripped
  assert.equal(rows[0].pdf, true)            // ✅
  assert.equal(rows[0].deadline, 'n/d')
  assert.equal(rows[0].report, '[#1](r)')
  assert.equal(rows[0].notes, 'hi')          // real Notes, not the report link
  assert.equal(rows[1].status, 'Evaluated')  // unknown → Evaluated
  assert.equal(rows[1].pdf, false)           // ❌
})

// F1(b): applications.md rows carry an OPTIONAL Deadline cell. parseApplications
// maps cells by width per row (like tracker-core.mjs parseAppRow), so Report and
// Notes land correctly whether the header is 10-col or the legacy 9-col — and
// even when the header and data rows disagree (the schema-drift corruption:
// merge-tracker.mjs wrote 10-col rows under a 9-col scaffold header).

test('parseApplications: legacy 9-col header + 9-col rows (no Deadline)', () => {
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | [#1](r1) | called Jane |',
  ].join('\n')
  const rows = parseApplications(md)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].deadline, '')            // absent → empty
  assert.equal(rows[0].report, '[#1](r1)')      // NOT slid into a deadline slot
  assert.equal(rows[0].notes, 'called Jane')    // real Notes preserved
})

test('parseApplications: 9-col header + 10-col rows (the merge-tracker drift) still maps Report/Notes', () => {
  // Header says 9 cols; the writer emitted 10 (Deadline present). A header-name
  // map lost the real Notes here — width detection recovers it.
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | 2026-06-30 | [#1](r1) | called Jane |',
  ].join('\n')
  const rows = parseApplications(md)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].deadline, '2026-06-30')
  assert.equal(rows[0].report, '[#1](r1)')
  assert.equal(rows[0].notes, 'called Jane')    // survives the header/row mismatch
})

test('parseApplications: canonical 10-col header + 10-col rows', () => {
  const md = [
    '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
    '| 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Applied | ✅ | 2026-06-30 | [#1](r1) | called Jane |',
  ].join('\n')
  const rows = parseApplications(md)
  assert.equal(rows[0].deadline, '2026-06-30')
  assert.equal(rows[0].report, '[#1](r1)')
  assert.equal(rows[0].notes, 'called Jane')
})

const SCOUTING = [
  '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |',
  '|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|',
  '| 7 | 2026-05-01 | Stripe | Strategy | 3.6/5 | T2+ | 3.7/3.0 | — | Rolling | promote | x |',
].join('\n')

test('parseScouting normalizes the display tier (T2+ → T2-high)', () => {
  const rows = parseScouting(SCOUTING)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].num, 7)
  assert.equal(rows[0].company, 'Stripe')
  assert.equal(rows[0].tier, 'T2-high')
})

test('parsePipeline reads bare, bulleted and local: URLs, flags stale, skips checked', () => {
  const md = [
    'https://job.com/1',
    '- [ ] https://job.com/2 (2020-01-01)',
    '* local:jds/x.md',
    'just some prose, not a url',
    '- [x] https://job.com/3',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 3)
  assert.equal(urls[0].url, 'https://job.com/1')
  assert.equal(urls[1].url, 'https://job.com/2')
  assert.equal(urls[1].addedDate, '2020-01-01')
  assert.equal(urls[1].isStale, true)         // 2020 ≫ 14 days ago
  assert.equal(urls[2].url, 'local:jds/x.md')
  // Bare URLs carry no scanner metadata.
  assert.equal(urls[0].company, undefined)
  assert.equal(urls[0].relevance, undefined)
  // F3: the trailing `(YYYY-MM-DD)` on a pipe-less line is a date, not a
  // company — it's captured as addedDate, never leaked into the company field.
  assert.equal(urls[1].company, undefined)
  assert.equal(urls[1].title, undefined)
})

test('parsePipeline: a bare (date) suffix never becomes the company (F3 regression)', () => {
  // Before the fix, splitting the tail on `|` turned "(2020-01-01)" into
  // fields[0] → company, so the Inbox showed a date where a company belongs.
  const md = [
    '- [ ] https://job.com/2 (2020-01-01)',
    '- [ ] https://job.com/3 (2026-07-01) | Real Co | Analyst',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 2)
  // Pipe-less line: date captured, no company/title fabricated.
  assert.equal(urls[0].addedDate, '2020-01-01')
  assert.equal(urls[0].company, undefined)
  assert.equal(urls[0].title, undefined)
  // Pipe-delimited line: date still captured, real company/title preserved.
  assert.equal(urls[1].addedDate, '2026-07-01')
  assert.equal(urls[1].company, 'Real Co')
  assert.equal(urls[1].title, 'Analyst')
})

test('parsePipeline excludes checked-off entries — the Inbox pending count must drop after Filter to Database', () => {
  // Filter to Database checks entries off IN PLACE, preserving the scanner
  // line format. Before this regression test, "- [x] url | Company | Title"
  // still parsed as a pending row, so the pending count never decreased.
  const md = [
    '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Analyst | relevance 4.5 — fresh',
    '- [x] https://boards.greenhouse.io/acme/jobs/2 | Acme | Analyst II | relevance 6.0 — fresh',
    '- [X] https://jobs.lever.co/globex/x1 | Globex | Ops Associate',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 1)
  assert.equal(urls[0].url, 'https://boards.greenhouse.io/acme/jobs/1')
})

test('parsePipeline captures company/title/relevance from scanner-written lines', () => {
  const md = [
    '- [ ] https://boards.greenhouse.io/acme/jobs/9 | Acme | Strategy Analyst | relevance 4.5 — positive phrase, fresh',
    '- [ ] https://jobs.lever.co/globex/x1 | Globex | Senior Ops Lead',
  ].join('\n')
  const urls = parsePipeline(md)
  assert.equal(urls.length, 2)
  assert.equal(urls[0].company, 'Acme')
  assert.equal(urls[0].title, 'Strategy Analyst')
  assert.equal(urls[0].relevance, 4.5)
  assert.equal(urls[0].relevanceNote, 'positive phrase, fresh')
  assert.equal(urls[1].company, 'Globex')
  assert.equal(urls[1].title, 'Senior Ops Lead')
  assert.equal(urls[1].relevance, undefined)
})

test('F4: parsePipeline (frontend) and parsePendingEntries (triage-core) agree on pending URLs', () => {
  // One multi-shape ## Pending block. Both parsers must agree on which URLs are
  // PENDING: unchecked scanner lines are in, checked-off (`- [x]`) lines are out.
  //
  // Known, INTENTIONAL divergences — documented here, mirrored in
  // scripts/lib/triage-core.test.mjs, NOT "fixed":
  //   • triage is `## Pending`-scoped: lines outside the section are ignored by
  //     triage but still parsed by the frontend (it feeds the whole Inbox).
  //   • triage is https-only and requires a `- [ ]` bullet: `local:` entries and
  //     bare (checkbox-less) URLs are Inbox-visible but never triaged.
  // The fixture below stays inside the agreed domain (a single ## Pending
  // section, https, checkbox bullets) so the pending SETS match exactly.
  const md = [
    '## Pending',
    '',
    '- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Analyst | relevance 4.5 — fresh',
    '- [ ] https://jobs.lever.co/globex/x1 | Globex | Ops Associate',
    '- [x] https://boards.greenhouse.io/acme/jobs/2 | Acme | Analyst II | relevance 6.0 — fresh',
  ].join('\n')

  const frontendPending = new Set(parsePipeline(md).map(u => u.url))
  const triagePending = new Set(parsePendingEntries(md).map(e => e.url))
  assert.deepEqual([...frontendPending].sort(), [...triagePending].sort())
  assert.deepEqual([...triagePending].sort(), [
    'https://boards.greenhouse.io/acme/jobs/1',
    'https://jobs.lever.co/globex/x1',
  ])
})

test('parseReportPath extracts company/role/tier and rejects non-report paths', () => {
  const r = parseReportPath('reports/tier-1/Amazon - Business Analyst Intern 2026.md')
  assert.equal(r?.company, 'Amazon')
  assert.equal(r?.role, 'Business Analyst Intern 2026')
  assert.equal(r?.tier, 'T1')
  assert.equal(parseReportPath('user/cv.md'), null)
})
