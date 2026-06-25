/**
 * dedup-index.test.mjs — suite for the pure (company, role) dedup-index logic
 * extracted from rebuild-dedup-index.mjs.
 *
 * Run: node --test scripts/lib/dedup-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER,
  normalizeCompany,
  normalizeRole,
  isDataRow,
  parseRow,
  collectInto,
  buildIndexLines,
} from './dedup-index.mjs';

// ── normalizeCompany ──────────────────────────────────────────────────────
test('normalizeCompany lowercases and strips all non-alphanumerics', () => {
  assert.equal(normalizeCompany('Acme Corp.'), 'acmecorp');
  assert.equal(normalizeCompany('ACME  corp'), 'acmecorp');
  assert.equal(normalizeCompany('N26 GmbH'), 'n26gmbh');
  assert.equal(normalizeCompany('AT&T'), 'att');
  assert.equal(normalizeCompany('Booking.com'), 'bookingcom');
});

test('normalizeCompany collapses spacing/punctuation variants to one key', () => {
  assert.equal(normalizeCompany('Acme, Inc.'), normalizeCompany('acme inc'));
});

// ── normalizeRole ─────────────────────────────────────────────────────────
test('normalizeRole lowercases, collapses internal whitespace, and trims', () => {
  assert.equal(normalizeRole('Software Engineer'), 'software engineer');
  assert.equal(normalizeRole('  Software   Engineer  '), 'software engineer');
  assert.equal(normalizeRole('PRODUCT manager'), 'product manager');
});

test('normalizeRole keeps punctuation (unlike company)', () => {
  assert.equal(normalizeRole('Sr. Analyst (FP&A)'), 'sr. analyst (fp&a)');
});

// ── isDataRow ─────────────────────────────────────────────────────────────
test('isDataRow accepts a real pipe-delimited entry', () => {
  assert.equal(isDataRow('| 5 | 2026-01-02 | Acme | Engineer | ... |'), true);
});

test('isDataRow rejects header, separator, and non-table lines', () => {
  assert.equal(isDataRow('| # | Date | Company | Role |'), false, 'header');
  assert.equal(isDataRow('|---|---|---|---|'), false, 'separator');
  assert.equal(isDataRow('## Scouting'), false, 'prose heading');
  assert.equal(isDataRow(''), false, 'blank');
});

// ── parseRow ──────────────────────────────────────────────────────────────
test('parseRow extracts { date, company, role } from a valid row', () => {
  assert.deepEqual(
    parseRow('| 12 | 2026-03-04 | Acme Corp | Staff Engineer | T1 | extra |'),
    { date: '2026-03-04', company: 'Acme Corp', role: 'Staff Engineer' }
  );
});

test('parseRow rejects rows with a non-numeric or zero index', () => {
  assert.equal(parseRow('| # | 2026-03-04 | Acme | Engineer | x |'), null, 'header #');
  assert.equal(parseRow('| 0 | 2026-03-04 | Acme | Engineer | x |'), null, 'index 0');
});

test('parseRow rejects rows whose date column is not YYYY-MM-DD', () => {
  assert.equal(parseRow('| 3 | Date | Acme | Engineer | x |'), null);
  assert.equal(parseRow('| 3 | 2026/03/04 | Acme | Engineer | x |'), null);
  assert.equal(parseRow('| 3 | Rolling | Acme | Engineer | x |'), null);
});

test('parseRow rejects rows with too few columns or empty cells', () => {
  assert.equal(parseRow('| 3 | 2026-03-04 | Acme |'), null, 'too few columns');
  assert.equal(parseRow('| 3 | 2026-03-04 |  | Engineer | x |'), null, 'empty company');
});

// ── collectInto: latest-date-wins merge ───────────────────────────────────
test('collectInto folds rows into the map, keeping the latest date per key', () => {
  const map = new Map();
  const content = [
    '| # | Date | Company | Role | Tier |',
    '|---|------|---------|------|------|',
    '| 1 | 2026-01-01 | Acme Corp | Software Engineer | T2 |',
    '| 2 | 2026-05-09 | ACME corp. | software  engineer | T1 |', // same key, newer
    '| 3 | 2026-02-02 | Globex | Analyst | T3 |',
  ].join('\n');

  const count = collectInto(content, map);

  assert.equal(count, 3, 'all three data rows counted');
  assert.equal(map.size, 2, 'the two Acme rows collapse to one key');
  assert.equal(map.get('acmecorp\tsoftware engineer'), '2026-05-09', 'latest date wins');
  assert.equal(map.get('globex\tanalyst'), '2026-02-02');
});

test('collectInto does not regress to an older date when seen out of order', () => {
  const map = new Map();
  collectInto(
    [
      '| 1 | 2026-05-09 | Acme | Engineer | T1 |',
      '| 2 | 2026-01-01 | Acme | Engineer | T2 |', // older, arrives second
    ].join('\n'),
    map
  );
  assert.equal(map.get('acme\tengineer'), '2026-05-09');
});

test('collectInto tolerates empty/undefined content', () => {
  const map = new Map();
  assert.equal(collectInto('', map), 0);
  assert.equal(collectInto(undefined, map), 0);
  assert.equal(map.size, 0);
});

// ── buildIndexLines: cross-file merge + stable sort ───────────────────────
test('buildIndexLines merges multiple files, latest date wins across them', () => {
  const scouting = '| 1 | 2026-01-01 | Acme | Engineer | T2 |';
  const apps = '| 1 | 2026-06-01 | Acme | Engineer | Applied |'; // newer, other file
  const lines = buildIndexLines(scouting, apps);
  assert.deepEqual(lines, ['acme\tengineer\t2026-06-01']);
});

test('buildIndexLines returns keys sorted lexically', () => {
  const content = [
    '| 1 | 2026-01-01 | Zebra | Role | x |',
    '| 2 | 2026-01-01 | Acme | Role | x |',
    '| 3 | 2026-01-01 | Mango | Role | x |',
  ].join('\n');
  const lines = buildIndexLines(content);
  assert.deepEqual(lines, [
    'acme\trole\t2026-01-01',
    'mango\trole\t2026-01-01',
    'zebra\trole\t2026-01-01',
  ]);
});

test('buildIndexLines on no/blank input yields an empty body', () => {
  assert.deepEqual(buildIndexLines(), []);
  assert.deepEqual(buildIndexLines('', undefined), []);
});

// ── header contract ───────────────────────────────────────────────────────
test('HEADER is the canonical three-column TSV header', () => {
  assert.equal(HEADER, 'company_normalized\trole_normalized\tlast_seen_date');
  assert.equal(HEADER.split('\t').length, 3);
});

// ── normalizeCompany — additional edge cases ──────────────────────────────
test('normalizeCompany: empty string stays empty', () => {
  assert.equal(normalizeCompany(''), '');
});

test('normalizeCompany: a name with only non-alphanumeric chars collapses to empty string', () => {
  // Sanity check: a purely-symbolic name (odd, but real data can be dirty) maps
  // to the empty key rather than crashing.
  assert.equal(normalizeCompany('&.!@#-–—'), '');
});

test('normalizeCompany: digits are preserved (numeric brand names)', () => {
  assert.equal(normalizeCompany('42dot'), '42dot');
  assert.equal(normalizeCompany('N26'), 'n26');
});

// ── normalizeRole — additional edge cases ─────────────────────────────────
test('normalizeRole: empty string stays empty', () => {
  assert.equal(normalizeRole(''), '');
});

test('normalizeRole: a role with only whitespace collapses to empty string', () => {
  // Trim leaves nothing; the result should be '' not ' '.
  assert.equal(normalizeRole('   '), '');
});

// ── isDataRow — additional edge cases ────────────────────────────────────
test('isDataRow: a line with "---" anywhere is rejected (separator guard)', () => {
  // The separator guard uses includes('---'), so even an unlikely case like a
  // company name containing "---" would be filtered out. This is intentional
  // defensive behavior.
  assert.equal(isDataRow('| 5 | 2026-01-01 | Co---mpany | Role | x |'), false);
});

test('isDataRow: a line starting with "| #" pattern is rejected (header guard)', () => {
  // Covers the regex branch `^\|\s*#\s*\|`.
  assert.equal(isDataRow('| # | Date | Company | Role |'), false);
  assert.equal(isDataRow('|# | Date | Company | Role |'), false);
});

// ── parseRow — additional edge cases ─────────────────────────────────────
test('parseRow: minimum valid row (exactly 6 pipe-parts, no trailing |)', () => {
  // "| num | date | company | role |" produces 6 parts after split('|').
  // This is the documented minimum for parts.length >= 6.
  assert.deepEqual(
    parseRow('| 1 | 2026-01-01 | Acme | Engineer |'),
    { date: '2026-01-01', company: 'Acme', role: 'Engineer' }
  );
});

test('parseRow: whitespace-only role cell is rejected (falsy after trim)', () => {
  assert.equal(parseRow('| 1 | 2026-01-01 | Acme |   | extra |'), null);
});

test('parseRow: letters-only index (not # but still NaN) is rejected', () => {
  // parseInt('abc') === NaN; the isNaN() guard catches this.
  assert.equal(parseRow('| abc | 2026-01-01 | Acme | Engineer | x |'), null);
});

// ── parseRow — documented quirk (negative index) ──────────────────────────
// BUG (characterization): parseRow currently accepts negative index values
// (e.g. | -1 | ...) because the guard is `isNaN(num) || num === 0` — it
// does not reject negative numbers. This is not a tracker-file format that
// produces negative indices in practice, but it is a latent gap.
test('parseRow: negative index is accepted (characterization — known quirk)', () => {
  // Document the current behavior so a future change to tighten the guard
  // shows up as a failing test, not a silent regression.
  assert.deepEqual(
    parseRow('| -1 | 2026-01-01 | Acme | Engineer | x |'),
    { date: '2026-01-01', company: 'Acme', role: 'Engineer' }
  );
});

// ── collectInto — additional edge cases ───────────────────────────────────
test('collectInto: duplicate rows with the same key and same date are idempotent', () => {
  // Both rows contribute to count, but only one entry lands in the map.
  const map = new Map();
  const count = collectInto(
    '| 1 | 2026-05-01 | Acme | Engineer | T1 |\n| 2 | 2026-05-01 | Acme | Engineer | T1 |',
    map
  );
  assert.equal(count, 2, 'both rows counted');
  assert.equal(map.size, 1, 'same key → one entry');
  assert.equal(map.get('acme\tengineer'), '2026-05-01');
});

test('collectInto: company normalization carries into the map key', () => {
  // Verify that the composed key uses normalizeCompany output, not raw text.
  const map = new Map();
  collectInto('| 1 | 2026-01-01 | Booking.com | Product Manager | T2 |', map);
  assert.ok(map.has('bookingcom\tproduct manager'), 'normalized key in map');
});

test('collectInto: called incrementally on the same map merges across calls', () => {
  // Simulates collecting from two separate files in sequence.
  const map = new Map();
  collectInto('| 1 | 2026-01-01 | Acme | Engineer | T2 |', map);
  collectInto('| 1 | 2026-06-01 | Acme | Engineer | Applied |', map); // newer
  assert.equal(map.get('acme\tengineer'), '2026-06-01', 'latest date wins across incremental calls');
  assert.equal(map.size, 1);
});

// ── buildIndexLines — additional edge cases ───────────────────────────────
test('buildIndexLines: single entry produces one correctly-formatted line', () => {
  const lines = buildIndexLines('| 1 | 2026-01-01 | Acme Corp | Software Engineer | T1 |');
  assert.deepEqual(lines, ['acmecorp\tsoftware engineer\t2026-01-01']);
});

test('buildIndexLines: three files, latest date wins globally across all inputs', () => {
  const f1 = '| 1 | 2026-01-01 | Acme | Eng | x |';
  const f2 = '| 1 | 2026-06-01 | Acme | Eng | x |'; // newest
  const f3 = '| 1 | 2026-03-01 | Acme | Eng | x |'; // middle
  const lines = buildIndexLines(f1, f2, f3);
  assert.deepEqual(lines, ['acme\teng\t2026-06-01']);
});

test('buildIndexLines: output lines are tab-joined key + date (format contract)', () => {
  const lines = buildIndexLines('| 1 | 2026-04-15 | Globex | Analyst | T3 |');
  assert.equal(lines.length, 1);
  const [companyNorm, roleNorm, date] = lines[0].split('\t');
  assert.equal(companyNorm, 'globex');
  assert.equal(roleNorm, 'analyst');
  assert.equal(date, '2026-04-15');
});
