/**
 * merge-staging-core.test.mjs — suite for the pure JobSpy staging→canonical
 * merge math extracted from merge-scan-staging.mjs.
 *
 * Run: node --test scripts/lib/merge-staging-core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_HEADER,
  companyRoleKey,
  dataLines,
  indexHistory,
  appendScanDate,
  mergeHistory,
  parsePipelineLine,
  filterPipelineLines,
} from './merge-staging-core.mjs';

// scan-history.tsv: url, first_seen, portal, title, company, location, status, scan_dates
const row = (url, title, company, scanDates = '2026-06-01') =>
  [url, '2026-06-01', 'jobspy-indeed', title, company, 'Dublin', 'added', scanDates].join('\t');

// ── companyRoleKey ─────────────────────────────────────────────────────────
test('companyRoleKey normalizes company (strip punctuation) and role (collapse ws)', () => {
  assert.equal(companyRoleKey('Acme Corp.', 'Data  Analyst'), 'acmecorp\tdata analyst');
  assert.equal(companyRoleKey('ACME corp', 'data analyst'), 'acmecorp\tdata analyst');
});

test('companyRoleKey collapses spacing/punctuation variants to one key', () => {
  assert.equal(
    companyRoleKey('Acme, Inc.', 'Data Analyst'),
    companyRoleKey('acme inc', 'DATA   ANALYST')
  );
});

test('companyRoleKey returns empty string when either side is blank', () => {
  assert.equal(companyRoleKey('', 'Analyst'), '');
  assert.equal(companyRoleKey('Acme', ''), '');
  assert.equal(companyRoleKey('   ', 'Analyst'), '', 'whitespace-only company normalizes empty');
});

// ── dataLines ──────────────────────────────────────────────────────────────
test('dataLines drops the header and blank lines by default', () => {
  const text = `${HISTORY_HEADER}\n${row('u1', 'Analyst', 'Acme')}\n\n${row('u2', 'Engineer', 'Globex')}\n`;
  const lines = dataLines(text);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('u1'));
});

test('dataLines with hasHeader:false keeps every non-blank line', () => {
  assert.deepEqual(dataLines('a\nb\n\n', { hasHeader: false }), ['a', 'b']);
});

test('dataLines tolerates empty/undefined input', () => {
  assert.deepEqual(dataLines(''), []);
  assert.deepEqual(dataLines(undefined), []);
});

// ── indexHistory ───────────────────────────────────────────────────────────
test('indexHistory maps URLs to row indices and collects company/role keys', () => {
  const rows = [row('u1', 'Analyst', 'Acme'), row('u2', 'Engineer', 'Globex')];
  const { urlToIndex, companyRoleSeen } = indexHistory(rows);
  assert.equal(urlToIndex.get('u1'), 0);
  assert.equal(urlToIndex.get('u2'), 1);
  assert.ok(companyRoleSeen.has('acme\tanalyst'));
  assert.ok(companyRoleSeen.has('globex\tengineer'));
});

// ── appendScanDate ─────────────────────────────────────────────────────────
test('appendScanDate appends a new date to the scan_dates column', () => {
  const updated = appendScanDate(row('u1', 'Analyst', 'Acme', '2026-06-01'), '2026-06-10');
  assert.equal(updated.split('\t')[7], '2026-06-01|2026-06-10');
});

test('appendScanDate is idempotent for a date already present', () => {
  const updated = appendScanDate(row('u1', 'Analyst', 'Acme', '2026-06-01'), '2026-06-01');
  assert.equal(updated.split('\t')[7], '2026-06-01');
});

test('appendScanDate pads short rows up to the scan_dates column', () => {
  const short = ['u1', '2026-06-01', 'jobspy', 'Analyst', 'Acme'].join('\t');
  const updated = appendScanDate(short, '2026-06-10').split('\t');
  assert.equal(updated.length, 8);
  assert.equal(updated[7], '2026-06-10');
});

// ── mergeHistory: the core dedup behavior ──────────────────────────────────
test('mergeHistory appends a genuinely new row', () => {
  const existing = [row('u1', 'Analyst', 'Acme')];
  const staging = [row('u2', 'Engineer', 'Globex')];
  const r = mergeHistory(existing, staging, '2026-06-10');
  assert.equal(r.appended, 1);
  assert.equal(r.rows.length, 2);
  assert.ok(r.acceptedKeys.has('globex\tengineer'));
});

test('mergeHistory bumps scan_dates for a known URL (re-seen)', () => {
  const existing = [row('u1', 'Analyst', 'Acme', '2026-06-01')];
  const staging = [row('u1', 'Analyst', 'Acme')];
  const r = mergeHistory(existing, staging, '2026-06-10');
  assert.equal(r.updatedScanDates, 1);
  assert.equal(r.appended, 0);
  assert.equal(r.rows[0].split('\t')[7], '2026-06-01|2026-06-10');
});

test('mergeHistory DROPS the same (company, role) under a different URL', () => {
  // The whole point: Acme/Analyst already in history under u1; the aggregator
  // surfaces it again under a fresh Google redirect URL u2 → must be dropped.
  const existing = [row('u1', 'Analyst', 'Acme')];
  const staging = [row('https://google.com/redirect?x=2', 'Analyst', 'Acme')];
  const r = mergeHistory(existing, staging, '2026-06-10');
  assert.equal(r.appended, 0, 'no new row appended');
  assert.equal(r.droppedDuplicateRole, 1, 'counted as a cross-URL duplicate');
  assert.equal(r.rows.length, 1);
});

test('mergeHistory drops intra-run duplicates: same role, two new URLs', () => {
  const existing = [];
  const staging = [
    row('https://indeed.com/v?jk=1', 'Data Analyst', 'Globex'),
    row('https://google.com/r?u=2', 'Data  Analyst', 'GLOBEX'), // same key, diff URL
  ];
  const r = mergeHistory(existing, staging, '2026-06-10');
  assert.equal(r.appended, 1, 'only the first survives');
  assert.equal(r.droppedDuplicateRole, 1);
});

test('mergeHistory keeps two genuinely different roles at the same company', () => {
  const r = mergeHistory(
    [],
    [row('u1', 'Data Analyst', 'Acme'), row('u2', 'Strategy Analyst', 'Acme')],
    '2026-06-10'
  );
  assert.equal(r.appended, 2, 'different roles are not duplicates');
});

test('mergeHistory still appends rows with a blank company (no key collapse)', () => {
  // Defensive: a row with no derivable key should not be silently dropped.
  const r = mergeHistory(
    [],
    [
      ['u1', '2026-06-01', 'jobspy', 'Analyst', '', 'Dublin', 'added', '2026-06-01'].join('\t'),
      ['u2', '2026-06-01', 'jobspy', 'Analyst', '', 'Dublin', 'added', '2026-06-01'].join('\t'),
    ],
    '2026-06-10'
  );
  assert.equal(r.appended, 2, 'no key → URL dedup only, both kept');
  assert.equal(r.droppedDuplicateRole, 0);
});

test('mergeHistory skips lines with no URL', () => {
  const r = mergeHistory([], ['\t2026-06-01\tjobspy\tAnalyst\tAcme'], '2026-06-10');
  assert.equal(r.appended, 0);
});

test('mergeHistory does not mutate the input rows array', () => {
  const existing = [row('u1', 'Analyst', 'Acme')];
  const before = existing.slice();
  mergeHistory(existing, [row('u2', 'Engineer', 'Globex')], '2026-06-10');
  assert.deepEqual(existing, before, 'caller array untouched');
});

// ── parsePipelineLine ──────────────────────────────────────────────────────
test('parsePipelineLine extracts url, company, title', () => {
  assert.deepEqual(
    parsePipelineLine('- [ ] https://x.com/job | Acme Corp | Data Analyst'),
    { url: 'https://x.com/job', company: 'Acme Corp', title: 'Data Analyst' }
  );
});

test('parsePipelineLine handles a checked box and missing company/title', () => {
  assert.deepEqual(parsePipelineLine('- [x] https://x.com/job'), {
    url: 'https://x.com/job',
    company: '',
    title: '',
  });
});

test('parsePipelineLine returns null for non-pipeline lines', () => {
  assert.equal(parsePipelineLine('## Pending'), null);
  assert.equal(parsePipelineLine('random text'), null);
});

// ── filterPipelineLines ────────────────────────────────────────────────────
test('filterPipelineLines keeps a fresh line', () => {
  const r = filterPipelineLines(['- [ ] https://x.com/1 | Acme | Analyst']);
  assert.equal(r.appended, 1);
  assert.deepEqual(r.toAppend, ['- [ ] https://x.com/1 | Acme | Analyst']);
});

test('filterPipelineLines drops a URL already in pipeline/applications', () => {
  const r = filterPipelineLines(
    ['- [ ] https://x.com/1 | Acme | Analyst'],
    { seenUrls: new Set(['https://x.com/1']) }
  );
  assert.equal(r.appended, 0);
  assert.equal(r.droppedUrl, 1);
});

test('filterPipelineLines drops a (company, role) already present in history', () => {
  // Mirrors the script wiring: seenKeys is seeded with the (company, role)
  // keys already on disk in scan-history before this run, so the pipeline line
  // for the SAME job re-surfaced under a different aggregator URL is suppressed.
  const r = filterPipelineLines(
    ['- [ ] https://google.com/r?u=2 | Acme | Analyst'],
    { seenKeys: new Set(['acme\tanalyst']) }
  );
  assert.equal(r.appended, 0);
  assert.equal(r.droppedDuplicateRole, 1);
});

test('filterPipelineLines dedups two staging lines with same role, different URLs', () => {
  const r = filterPipelineLines([
    '- [ ] https://indeed.com/1 | Globex | Data Analyst',
    '- [ ] https://google.com/2 | GLOBEX | data  analyst',
  ]);
  assert.equal(r.appended, 1);
  assert.equal(r.droppedDuplicateRole, 1);
});

test('filterPipelineLines does not mutate the caller-provided seen sets', () => {
  const seenUrls = new Set(['https://x.com/1']);
  const seenKeys = new Set(['acme\tanalyst']);
  filterPipelineLines(['- [ ] https://x.com/2 | Globex | Engineer'], { seenUrls, seenKeys });
  assert.equal(seenUrls.size, 1, 'seenUrls untouched');
  assert.equal(seenKeys.size, 1, 'seenKeys untouched');
});

// ── header contract ────────────────────────────────────────────────────────
test('HISTORY_HEADER matches the canonical scan-history column order', () => {
  assert.equal(
    HISTORY_HEADER,
    'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates'
  );
  assert.equal(HISTORY_HEADER.split('\t').length, 8);
});
