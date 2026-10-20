/**
 * scan-history.test.mjs — header-named scan-history schema helpers.
 *
 * Run: node --test scripts/lib/scan-history.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_COLUMNS,
  HISTORY_HEADER_FULL,
  parseHistoryHeader,
  parseHistoryFile,
  upgradeColumns,
  getCell,
  setCells,
  alignRow,
  buildHistoryRow,
  pickDisplayDate,
  fillLocations,
} from './scan-history.mjs';

const OLD = HISTORY_COLUMNS.slice(0, 8);

test('the original 8 columns never move; new ones are appended', () => {
  assert.deepEqual(HISTORY_COLUMNS.slice(0, 8), ['url', 'first_seen', 'portal', 'title', 'company', 'location', 'status', 'scan_dates']);
  assert.deepEqual(HISTORY_COLUMNS.slice(8), ['posted_date', 'deadline', 'posting_id', 'req_id', 'locations']);
  assert.equal(HISTORY_HEADER_FULL.split('\t').length, 13);
});

test('parseHistoryHeader: recognises a header, rejects data lines', () => {
  assert.deepEqual(parseHistoryHeader(HISTORY_HEADER_FULL), HISTORY_COLUMNS);
  assert.deepEqual(parseHistoryHeader(OLD.join('\t')), OLD);
  assert.equal(parseHistoryHeader('https://x.example/a\t2026-01-01'), null);
  assert.equal(parseHistoryHeader(''), null);
});

test('parseHistoryFile: old file keeps its 8-column layout; headerless text falls back to it', () => {
  const old = `${OLD.join('\t')}\nhttps://x.example/a\t2026-01-01\tp\tT\tC\tL\tadded\t2026-01-01\n\n`;
  const f = parseHistoryFile(old);
  assert.deepEqual(f.columns, OLD);
  assert.equal(f.rows.length, 1);
  assert.deepEqual(parseHistoryFile('').columns, OLD);
});

test('upgradeColumns: appends the missing known columns, keeps order and unknown extras', () => {
  assert.deepEqual(upgradeColumns(OLD), HISTORY_COLUMNS);
  assert.deepEqual(upgradeColumns([...OLD, 'custom', 'deadline']).slice(8), ['custom', 'deadline', 'posted_date', 'posting_id', 'req_id', 'locations']);
  assert.deepEqual(upgradeColumns(null), HISTORY_COLUMNS);
});

test('getCell / setCells: by name, padding short rows, tab-safe', () => {
  const short = 'u\td\tp\tT\tC\tL\tadded\t2026-01-01';
  assert.equal(getCell(short, HISTORY_COLUMNS, 'deadline'), '');
  assert.equal(getCell(short, HISTORY_COLUMNS, 'nope'), '');
  const filled = setCells(short, HISTORY_COLUMNS, { deadline: '2026-12-31', locations: 'A\tB|C' });
  assert.equal(filled.split('\t').length, 13);
  assert.equal(getCell(filled, HISTORY_COLUMNS, 'deadline'), '2026-12-31');
  assert.equal(getCell(filled, HISTORY_COLUMNS, 'locations'), 'A B|C');
});

test('alignRow: re-lays a row from one header to another by column name', () => {
  const row = 'u\td\tp\tT\tC\tL\tadded\t2026-01-01';
  const wideRow = alignRow(row, OLD, HISTORY_COLUMNS);
  assert.equal(wideRow.split('\t').length, 13);
  assert.equal(getCell(wideRow, HISTORY_COLUMNS, 'company'), 'C');
  const reordered = alignRow('A\tB', ['company', 'url'], ['url', 'company']);
  assert.equal(reordered, 'B\tA');
  assert.equal(alignRow(row, OLD, OLD), row);
});

test('buildHistoryRow: dates, ids and locations land in their named cells', () => {
  const row = buildHistoryRow({
    url: 'https://x.example/a', source: 'greenhouse-api', title: 'Analyst', company: 'Nimbus Robotics',
    location: 'Germany, Larkspur, Rosewood', postedDate: '2026-10-01', deadline: '2026-11-30',
    postingId: '4417', reqId: 'R-9', locations: ['Larkspur, Germany', 'Rosewood, Germany'],
  }, '2026-10-20');
  const get = (n) => getCell(row, HISTORY_COLUMNS, n);
  assert.equal(get('first_seen'), '2026-10-20');
  assert.equal(get('portal'), 'greenhouse-api');
  assert.equal(get('location'), 'Germany, Larkspur, Rosewood', 'display string is kept as the source gave it');
  assert.equal(get('posted_date'), '2026-10-01');
  assert.equal(get('deadline'), '2026-11-30');
  assert.equal(get('posting_id'), '4417');
  assert.equal(get('req_id'), 'R-9');
  assert.equal(get('locations'), 'Larkspur, Germany|Rosewood, Germany');
  assert.equal(get('scan_dates'), '2026-10-20');
});

test('pickDisplayDate: deadline, else posted date, else scan date', () => {
  assert.deepEqual(pickDisplayDate({ deadline: 'D', postedDate: 'P', firstSeen: 'S' }), { kind: 'deadline', date: 'D' });
  assert.deepEqual(pickDisplayDate({ postedDate: 'P', firstSeen: 'S' }), { kind: 'posted', date: 'P' });
  assert.deepEqual(pickDisplayDate({ firstSeen: 'S' }), { kind: 'scanned', date: 'S' });
  assert.equal(pickDisplayDate({}), null);
});

test('fillLocations: splits `location` into `locations` only where the cell is empty', () => {
  const a = buildHistoryRow({ url: 'u1', source: 'p', title: 'T', company: 'C', location: 'Germany, Larkspur, Rosewood' }, '2026-10-20');
  const b = buildHistoryRow({ url: 'u2', source: 'p', title: 'T', company: 'C', location: 'A; B', locations: ['Kept'] }, '2026-10-20');
  const c = buildHistoryRow({ url: 'u3', source: 'p', title: 'T', company: 'C', location: '' }, '2026-10-20');
  const [ra, rb, rc] = fillLocations([a, b, c], HISTORY_COLUMNS);
  assert.equal(getCell(ra, HISTORY_COLUMNS, 'locations'), 'Larkspur, Germany|Rosewood, Germany');
  assert.equal(getCell(rb, HISTORY_COLUMNS, 'locations'), 'Kept');
  assert.equal(rc, c);
});
