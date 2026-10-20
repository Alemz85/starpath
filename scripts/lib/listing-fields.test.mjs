/**
 * listing-fields.test.mjs — deadline parsing and multi-city location splitting.
 * All names are fictional.
 *
 * Run: node --test scripts/lib/listing-fields.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeadline,
  extractDeadlineFromText,
  resolveDeadline,
  splitLocations,
  formatLocations,
  parseLocationsCell,
  anyLocationAllowed,
  cleanId,
} from './listing-fields.mjs';
import { buildLocationFilter } from '../scan-core.mjs';

// ── parseDeadline ──────────────────────────────────────────────────────────

test('parseDeadline: ISO dates and timestamps -> YYYY-MM-DD', () => {
  assert.equal(parseDeadline('2026-12-31'), '2026-12-31');
  assert.equal(parseDeadline(' 2026-12-31 '), '2026-12-31');
  assert.equal(parseDeadline('2026-12-31T23:59:00Z'), '2026-12-31');
  assert.equal(parseDeadline('2026-12-31T23:59:00.000+01:00'), '2026-12-31');
  assert.equal(parseDeadline('2026-02-28'), '2026-02-28');
  assert.equal(parseDeadline('2028-02-29'), '2028-02-29'); // leap day
});

test('parseDeadline: ambiguous, non-ISO or impossible values are absent, never guessed', () => {
  for (const bad of [
    '03/04/2026', '3.4.2026', '31/12/2026', '12/31/2026', 'March 3, 2026', '3 March 2026',
    'Rolling', 'ASAP', 'n/d', '', '2026-13-01', '2026-02-30', '2027-02-29', '2026-00-10',
    '1999-12-31', '2101-01-01', '2026-12-31T25:00:00Z', '20261231', '2026/12/31',
    1767225600000, null, undefined, {}, ['2026-12-31'],
  ]) assert.equal(parseDeadline(bad), null, String(bad));
});

// ── extractDeadlineFromText ────────────────────────────────────────────────

test('extractDeadlineFromText: finds an explicit ISO deadline after a cue', () => {
  assert.equal(extractDeadlineFromText('Please apply by 2026-11-30 at the latest.'), '2026-11-30');
  assert.equal(extractDeadlineFromText('<p>Application deadline: <strong>2026-11-30</strong></p>'), '2026-11-30');
  assert.equal(extractDeadlineFromText('Closing date - 2026-11-30.'), '2026-11-30');
  assert.equal(extractDeadlineFromText('Applications close on 2026-11-30'), '2026-11-30');
  assert.equal(extractDeadlineFromText('The role closes 2026-11-30.'), '2026-11-30');
});

test('extractDeadlineFromText: non-ISO, no cue, impossible or conflicting dates -> null', () => {
  assert.equal(extractDeadlineFromText('Application deadline: 30/11/2026'), null);
  assert.equal(extractDeadlineFromText('Apply by the end of November'), null);
  assert.equal(extractDeadlineFromText('Start date: 2026-09-01. Founded 2014.'), null);
  assert.equal(extractDeadlineFromText('Application deadline: 2026-02-30'), null);
  assert.equal(extractDeadlineFromText('Apply by 2026-10-01 (early) or closing date: 2026-10-15'), null);
  assert.equal(extractDeadlineFromText('Apply by 2026-10-01 and again closing date: 2026-10-01'), '2026-10-01', 'same date twice is not a conflict');
  assert.equal(extractDeadlineFromText(''), null);
  assert.equal(extractDeadlineFromText(null), null);
});

test('resolveDeadline: structured fields win, then the body; garbage fields are skipped', () => {
  assert.equal(resolveDeadline(['Rolling', '2026-12-01'], 'Apply by 2026-11-01'), '2026-12-01');
  assert.equal(resolveDeadline([null, 'tbd'], 'Apply by 2026-11-01'), '2026-11-01');
  assert.equal(resolveDeadline([], ''), null);
});

// ── splitLocations ─────────────────────────────────────────────────────────

test('splitLocations: one country with several cities in one comma-joined string', () => {
  assert.deepEqual(
    splitLocations('Germany, Larkspur, Rosewood'),
    ['Larkspur, Germany', 'Rosewood, Germany'],
  );
  assert.deepEqual(
    splitLocations('Larkspur, Rosewood, Germany'),
    ['Larkspur, Germany', 'Rosewood, Germany'],
  );
});

test('splitLocations: three-plus comma parts are separate cities even without a country', () => {
  assert.deepEqual(splitLocations('Aldervale, Brightmoor, Corvane'), ['Aldervale', 'Brightmoor', 'Corvane']);
});

test('splitLocations: "City, Country" and "City, ST" stay one location', () => {
  assert.deepEqual(splitLocations('Aldervale, Germany'), ['Aldervale, Germany']);
  assert.deepEqual(splitLocations('Springfield, TX'), ['Springfield, TX']);
  assert.deepEqual(splitLocations('Aldervale'), ['Aldervale']);
});

test('splitLocations: two bare cities split only when the caller knows both places', () => {
  assert.deepEqual(splitLocations('Aldervale, Brightmoor'), ['Aldervale, Brightmoor']);
  assert.deepEqual(
    splitLocations('Aldervale, Brightmoor', { knownPlaces: ['aldervale', 'brightmoor'] }),
    ['Aldervale', 'Brightmoor'],
  );
});

test('splitLocations: hard separators, parentheses and de-duplication', () => {
  assert.deepEqual(splitLocations('Aldervale; Brightmoor | Corvane'), ['Aldervale', 'Brightmoor', 'Corvane']);
  assert.deepEqual(splitLocations('Aldervale / Brightmoor'), ['Aldervale', 'Brightmoor']);
  assert.deepEqual(splitLocations('Springfield, TX & Shelbyville, OH'), ['Springfield, TX', 'Shelbyville, OH']);
  assert.deepEqual(splitLocations('Aldervale (Germany, hybrid)'), ['Aldervale (Germany, hybrid)']);
  assert.deepEqual(splitLocations(['Aldervale', 'aldervale', 'Brightmoor']), ['Aldervale', 'Brightmoor']);
  assert.deepEqual(splitLocations(''), []);
  assert.deepEqual(splitLocations(null), []);
  assert.deepEqual(splitLocations(' ; , '), []);
});

test('splitLocations: caps a runaway list', () => {
  const many = Array.from({ length: 50 }, (_, i) => `City${i}`).join('; ');
  assert.equal(splitLocations(many).length, 20);
});

test('formatLocations / parseLocationsCell round-trip, and strip separators', () => {
  const list = ['Larkspur, Germany', 'Rosewood, Germany'];
  assert.equal(formatLocations(list), 'Larkspur, Germany|Rosewood, Germany');
  assert.deepEqual(parseLocationsCell(formatLocations(list)), list);
  assert.equal(formatLocations(['A|B\tC']), 'A B C');
  assert.deepEqual(parseLocationsCell(''), []);
});

// ── per-city filtering ─────────────────────────────────────────────────────

test('anyLocationAllowed: a role open in several cities is kept when ANY city is allowed', () => {
  const filter = buildLocationFilter(['aldervale', 'germany']);
  const locations = splitLocations('Zenith Bay, Quillon Heights, Aldervale', { knownPlaces: [] });
  assert.deepEqual(locations, ['Zenith Bay', 'Quillon Heights', 'Aldervale']);
  assert.equal(anyLocationAllowed(locations, filter), true);
  assert.equal(anyLocationAllowed(['Zenith Bay', 'Quillon Heights'], filter), false);
  assert.equal(anyLocationAllowed([], filter), true, 'no location = unknown = keep');
});

test('anyLocationAllowed: a country shared by the cities is carried onto each', () => {
  const filter = buildLocationFilter(['germany']);
  // The country appears once in the source string; each split location keeps it.
  const locs = splitLocations('Germany, Larkspur, Rosewood');
  assert.equal(locs.every((l) => filter(l)), true);
});

// ── ids ────────────────────────────────────────────────────────────────────

test('cleanId: numbers and strings become tab-free strings; junk is empty', () => {
  assert.equal(cleanId(4417), '4417');
  assert.equal(cleanId(' abc\t123\n'), 'abc 123');
  assert.equal(cleanId(null), '');
  assert.equal(cleanId(NaN), '');
  assert.equal(cleanId('x'.repeat(500)).length, 120);
});
