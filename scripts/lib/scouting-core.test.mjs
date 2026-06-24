// scouting-core.test.mjs — unit suite for the data/scouting.md pipeline.
//
// Run: node --test scripts/lib/scouting-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TIERS,
  normalizeTier,
  normalizePromotionHint,
  companyKey,
  normalizeRoleForIndex,
  roleFuzzyMatch,
  parseScore,
  extractReportNum,
  coalesceDeadline,
  rewriteReportPathForTier,
  scoutingColumns,
  parseScoutingRow,
  formatScoutingRow,
  parseScoutingTsv,
} from './scouting-core.mjs';

const silent = () => {};

/* ───── tiers + hints ────────────────────────────────────────────── */

test('normalizeTier accepts canonicals and common spellings', () => {
  assert.equal(normalizeTier('T1', silent), 'T1');
  assert.equal(normalizeTier('**T2**', silent), 'T2');
  assert.equal(normalizeTier('Tier 1', silent), 'T1');
  assert.equal(normalizeTier('tier-3', silent), 'T3');
  assert.equal(normalizeTier('2', silent), 'T2');
});

test('normalizeTier defaults garbage to T4 and warns', () => {
  let warned = 0;
  assert.equal(normalizeTier('banana', () => { warned++; }), 'T4');
  assert.equal(warned, 1);
});

test('normalizePromotionHint defaults by tier and normalizes READY', () => {
  assert.equal(normalizePromotionHint('', 'T1'), 'READY');
  assert.equal(normalizePromotionHint('', 'T2'), '');
  assert.equal(normalizePromotionHint('ready to apply', 'T2'), 'READY');
  assert.equal(normalizePromotionHint('apply if pipeline thin', 'T2'), 'apply if pipeline thin');
  assert.equal(normalizePromotionHint('PROMOTED-12', 'T1'), 'PROMOTED-12');
});

/* ───── keys + scalars ───────────────────────────────────────────── */

test('companyKey / role helpers', () => {
  assert.equal(companyKey('Go-Cardless Ltd.'), 'gocardlessltd');
  assert.equal(normalizeRoleForIndex('  Data   Analyst '), 'data analyst');
  assert.ok(roleFuzzyMatch('Data Analyst (12 month FTC)', 'Senior Data Analyst'));
  assert.ok(!roleFuzzyMatch('Data Analyst', 'Account Executive'));
});

test('parseScore and extractReportNum', () => {
  assert.equal(parseScore('6.7/10'), 6.7);
  assert.equal(parseScore('—'), 0);
  assert.equal(extractReportNum('[#238](reports/tier-2/x.md)'), 238);
  assert.equal(extractReportNum('—'), null);
});

test('coalesceDeadline treats sentinels as absent, keeps first real value', () => {
  assert.equal(coalesceDeadline('n/d', '2026-06-30'), '2026-06-30');
  assert.equal(coalesceDeadline('2026-07-01', '2026-06-30'), '2026-07-01');
  assert.equal(coalesceDeadline('', '—', 'n/d'), 'n/d');
  assert.equal(coalesceDeadline('—', '2026-05-05'), '2026-05-05');
});

/* ───── tier paths ───────────────────────────────────────────────── */

test('rewriteReportPathForTier rewrites flat paths, leaves tiered/sentinels', () => {
  assert.equal(rewriteReportPathForTier('[#1](reports/Acme.md)', 'T2'), '[#1](reports/tier-2/Acme.md)');
  assert.equal(rewriteReportPathForTier('[#1](reports/tier-1/Acme.md)', 'T1'), '[#1](reports/tier-1/Acme.md)');
  assert.equal(rewriteReportPathForTier('—', 'T4'), '—');
});

/* ───── row parsing — the deadline-column regression ─────────────── */

test('scoutingColumns shifts deadline/hint/notes', () => {
  assert.deepEqual(scoutingColumns(true), { num: 1, date: 2, company: 3, role: 4, score: 5, tier: 6, cfAf: 7, report: 8, deadline: 9, hint: 10, notes: 11 });
  assert.deepEqual(scoutingColumns(false), { num: 1, date: 2, company: 3, role: 4, score: 5, tier: 6, cfAf: 7, report: 8, deadline: null, hint: 9, notes: 10 });
});

test('parseScoutingRow reads the 11-column (with-deadline) layout correctly', () => {
  // Real on-disk shape. The bug being guarded: hint must NOT read the deadline,
  // and the real notes must NOT be dropped.
  const line = '| 238 | 2026-06-24 | GoCardless | Data Analyst (12 month FTC) | 6.7/10 | T2 | 7.0/6.0 | [#238](reports/tier-2/GoCardless.md) | 2026-06-30 | READY | rich eval summary |';
  const r = parseScoutingRow(line);
  assert.equal(r.num, 238);
  assert.equal(r.hasDeadline, true);
  assert.equal(r.report, '[#238](reports/tier-2/GoCardless.md)');
  assert.equal(r.deadline, '2026-06-30');
  assert.equal(r.hint, 'READY');
  assert.equal(r.notes, 'rich eval summary'); // not dropped, not the hint
});

test('parseScoutingRow reads the legacy 10-column (no-deadline) layout', () => {
  const line = '| 5 | 2026-01-01 | Acme | Data Analyst | 8.1/10 | T2 | 8.0/7.0 | [#5](reports/tier-2/Acme.md) | READY | a note |';
  const r = parseScoutingRow(line);
  assert.equal(r.hasDeadline, false);
  assert.equal(r.deadline, 'n/d');
  assert.equal(r.report, '[#5](reports/tier-2/Acme.md)');
  assert.equal(r.hint, 'READY');
  assert.equal(r.notes, 'a note');
});

test('parseScoutingRow rejects headers, separators, non-numeric ids', () => {
  assert.equal(parseScoutingRow('| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |'), null);
  assert.equal(parseScoutingRow('|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|'), null);
  assert.equal(parseScoutingRow('plain text'), null);
});

test('formatScoutingRow round-trips, and flipping the hint preserves deadline + notes', () => {
  const line = '| 238 | 2026-06-24 | GoCardless | Data Analyst | 6.7/10 | T2 | 7.0/6.0 | [#238](reports/tier-2/GoCardless.md) | 2026-06-30 | READY | rich eval |';
  const r = parseScoutingRow(line);
  r.cells[r.cols.hint] = 'PROMOTED-42';
  const reparsed = parseScoutingRow(formatScoutingRow({ ...r, hint: r.cells[r.cols.hint] }));
  assert.equal(reparsed.hint, 'PROMOTED-42');
  assert.equal(reparsed.deadline, '2026-06-30'); // preserved
  assert.equal(reparsed.notes, 'rich eval'); // preserved
  assert.equal(reparsed.report, '[#238](reports/tier-2/GoCardless.md)');
});

/* ───── TSV additions ────────────────────────────────────────────── */

test('parseScoutingTsv: canonical 11-col addition', () => {
  const tsv = '300\t2026-06-25\tNimbus\tML Engineer\t9.1/10\tT1\t9.0/8.5\t[#300](reports/Nimbus.md)\t2026-07-15\t\tstrong fit';
  const a = parseScoutingTsv(tsv, '300-nimbus.tsv', silent);
  assert.equal(a.num, 300);
  assert.equal(a.tier, 'T1');
  assert.equal(a.deadline, '2026-07-15');
  assert.equal(a.report, '[#300](reports/tier-1/Nimbus.md)'); // flat → tier-1
  assert.equal(a.hint, 'READY'); // blank hint + T1 → READY
  assert.equal(a.notes, 'strong fit');
});

test('parseScoutingTsv: legacy 10-col addition (no deadline)', () => {
  const tsv = '301\t2026-06-25\tAcme\tData Analyst\t6.0/10\tT3\t6.0/6.0\t[#301](reports/Acme.md)\tmonitor only\tmid';
  const a = parseScoutingTsv(tsv, '301-acme.tsv', silent);
  assert.equal(a.deadline, 'n/d');
  assert.equal(a.hint, 'monitor only');
  assert.equal(a.notes, 'mid');
  assert.equal(a.report, '[#301](reports/tier-3/Acme.md)');
});

test('parseScoutingTsv: returns null on malformed/empty', () => {
  assert.equal(parseScoutingTsv('', 'x.tsv', silent), null);
  assert.equal(parseScoutingTsv('a\tb\tc', 'x.tsv', silent), null);
  assert.equal(parseScoutingTsv('NaN\td\tc\tr\t8/10\tT1\t8/8\t[#1](r.md)\tx\ty\tz', 'x.tsv', silent), null);
});

test('VALID_TIERS is the canonical 4', () => {
  assert.deepEqual(VALID_TIERS, ['T1', 'T2', 'T3', 'T4']);
});
