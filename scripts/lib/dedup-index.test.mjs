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
