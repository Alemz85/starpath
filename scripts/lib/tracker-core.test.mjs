// tracker-core.test.mjs — unit suite for the applications.md data pipeline.
//
// Run: node --test scripts/lib/tracker-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_STATES,
  STATUS_RANK,
  companyKey,
  companyKeyLoose,
  normalizeRoleForIndex,
  normalizeRole,
  roleFuzzyMatch,
  roleMatchStrict,
  parseScore,
  extractReportNum,
  validateStatus,
  normalizeStatus,
  tierForScore,
  rewriteReportPathForOfertaTier,
  appColumns,
  parseAppRow,
  serializeAppRow,
  parseTsvAddition,
} from './tracker-core.mjs';

const silent = () => {}; // swallow validateStatus warnings in tests

/* ───── company / role keys ──────────────────────────────────────── */

test('companyKey strips all non-alphanumerics including spaces', () => {
  assert.equal(companyKey('Acme Inc.'), 'acmeinc');
  assert.equal(companyKey('ACME-INC'), 'acmeinc');
  assert.equal(companyKey('IQVIA'), 'iqvia');
  // The strict key intentionally merges spaced/unspaced variants.
  assert.equal(companyKey('AcmeInc'), companyKey('Acme Inc'));
});

test('companyKeyLoose preserves internal spaces', () => {
  assert.equal(companyKeyLoose('Acme Inc'), 'acme inc');
  assert.equal(companyKeyLoose('Acme  (EMEA)'), 'acme emea');
  // Distinct from the strict key — documents the known divergence.
  assert.notEqual(companyKeyLoose('Acme Inc'), companyKey('Acme Inc'));
});

test('normalizeRoleForIndex lowercases and collapses whitespace', () => {
  assert.equal(normalizeRoleForIndex('  Senior   Data  Analyst '), 'senior data analyst');
});

test('normalizeRole drops parens/punctuation but keeps slashes', () => {
  assert.equal(normalizeRole('Data Analyst (Python/SQL)'), 'data analyst python/sql');
});

test('roleFuzzyMatch: ≥2 shared long words, substring-tolerant', () => {
  assert.ok(roleFuzzyMatch('Senior Data Analyst', 'Data Analyst Intern'));
  assert.ok(roleFuzzyMatch('Machine Learning Engineer', 'Learning Engineering Lead')); // substring overlap
  assert.ok(!roleFuzzyMatch('Data Analyst', 'Sales Manager'));
  assert.ok(!roleFuzzyMatch('Analyst', 'Analytics')); // only one long word in common
});

test('roleMatchStrict ignores seniority/location stopwords', () => {
  // After stripping "senior"/"engineer"/"tokyo": {data,platform} vs {data,platform} → match
  assert.ok(roleMatchStrict('Senior Data Platform Engineer', 'Data Platform Engineer Tokyo'));
  // "Senior Engineer" vs "Junior Engineer" → all tokens are stopwords → no match
  assert.ok(!roleMatchStrict('Senior Engineer', 'Junior Engineer'));
  // Different functions don't match
  assert.ok(!roleMatchStrict('Data Analyst', 'Account Manager'));
});

/* ───── scalar parsers ───────────────────────────────────────────── */

test('parseScore extracts leading number, tolerates bold and /10', () => {
  assert.equal(parseScore('7.2/10'), 7.2);
  assert.equal(parseScore('**8**'), 8);
  assert.equal(parseScore('N/A'), 0);
  assert.equal(parseScore('—'), 0);
});

test('extractReportNum handles [#N] and [N] forms', () => {
  assert.equal(extractReportNum('[#12](reports/tier-2/x.md)'), 12);
  assert.equal(extractReportNum('[7](reports/tier-3/y.md)'), 7);
  assert.equal(extractReportNum('n/d'), null);
  assert.equal(extractReportNum('—'), null);
});

/* ───── status normalization ─────────────────────────────────────── */

test('validateStatus accepts canonicals and common aliases', () => {
  assert.equal(validateStatus('Applied', silent), 'Applied');
  assert.equal(validateStatus('aplicado', silent), 'Applied');
  assert.equal(validateStatus('rechazada', silent), 'Rejected');
  assert.equal(validateStatus('no aplicar', silent), 'SKIP');
  assert.equal(validateStatus('DUPLICADO #5', silent), 'Discarded');
  assert.equal(validateStatus('**Evaluated** 2026-01-02', silent), 'Evaluated'); // strips bold + date
});

test('validateStatus defaults unknown to Evaluated and warns once', () => {
  let warned = 0;
  const got = validateStatus('Banana', () => { warned++; });
  assert.equal(got, 'Evaluated');
  assert.equal(warned, 1);
});

test('normalizeStatus moves DUPLICADO/repost context to notes', () => {
  assert.deepEqual(normalizeStatus('DUPLICADO de #3'), { status: 'Discarded', moveToNotes: 'DUPLICADO de #3' });
  assert.deepEqual(normalizeStatus('Repost #88'), { status: 'Discarded', moveToNotes: 'Repost #88' });
});

test('normalizeStatus maps aliases, em-dash, and flags unknowns', () => {
  assert.deepEqual(normalizeStatus('**Applied**'), { status: 'Applied' });
  assert.deepEqual(normalizeStatus('entrevista'), { status: 'Interview' });
  assert.deepEqual(normalizeStatus('MONITOR'), { status: 'SKIP' });
  assert.deepEqual(normalizeStatus('—'), { status: 'Discarded' });
  assert.deepEqual(normalizeStatus('scouting'), { status: 'Scouted' });
  assert.deepEqual(normalizeStatus('totally bogus'), { status: null, unknown: true });
});

test('STATUS_RANK keeps active states above terminal ones', () => {
  assert.ok(STATUS_RANK['applied'] > STATUS_RANK['rejected']);
  assert.ok(STATUS_RANK['offer'] > STATUS_RANK['interview']);
  assert.equal(STATUS_RANK['skip'], 0);
  assert.equal(STATUS_RANK['aplicado'], STATUS_RANK['applied']); // alias parity
});

test('CANONICAL_STATES has no scouting state', () => {
  assert.ok(!CANONICAL_STATES.includes('Scouted'));
  assert.ok(CANONICAL_STATES.includes('Evaluated'));
});

/* ───── tier paths ───────────────────────────────────────────────── */

test('tierForScore maps score bands and the SKIP override', () => {
  assert.equal(tierForScore(9.4, 'Evaluated'), 1);
  assert.equal(tierForScore(7.0, 'Evaluated'), 2);
  assert.equal(tierForScore(6.9, 'Evaluated'), 3);
  assert.equal(tierForScore(9.9, 'SKIP'), 4); // SKIP always tier-4 regardless of score
  assert.equal(tierForScore(0, 'Evaluated'), null);
});

test('rewriteReportPathForOfertaTier rewrites flat paths, leaves tiered/sentinels', () => {
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/Acme.md)', 8.5, 'Evaluated'),
    '[#1](reports/tier-2/Acme.md)',
  );
  // Already tiered → unchanged
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/tier-1/Acme.md)', 9.5, 'Evaluated'),
    '[#1](reports/tier-1/Acme.md)',
  );
  // Sentinels → unchanged
  assert.equal(rewriteReportPathForOfertaTier('—', 8, 'Evaluated'), '—');
  assert.equal(rewriteReportPathForOfertaTier('', 8, 'Evaluated'), '');
  // SKIP → tier-4
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/Acme.md)', 7.2, 'SKIP'),
    '[#1](reports/tier-4/Acme.md)',
  );
});

/* ───── row parsing — the deadline-column regression ─────────────── */

test('appColumns shifts report/notes when deadline present', () => {
  assert.equal(appColumns(true).report, 9);
  assert.equal(appColumns(true).notes, 10);
  assert.equal(appColumns(false).report, 8);
  assert.equal(appColumns(false).notes, 9);
});

test('parseAppRow reads the 10-column (with-deadline) layout correctly', () => {
  // This is the format merge-tracker writes and the format on disk today.
  const line = '| 1 | 2026-05-05 | IQVIA | Oncology Data Analyst | 7.2/10 | SKIP | ❌ | n/d | [#1](reports/tier-2/IQVIA.md) |  |';
  const row = parseAppRow(line);
  assert.equal(row.num, 1);
  assert.equal(row.company, 'IQVIA');
  assert.equal(row.score, '7.2/10');
  assert.equal(row.status, 'SKIP');
  assert.equal(row.hasDeadline, true);
  assert.equal(row.deadline, 'n/d');
  // The bug being fixed: report must be the link, NOT the deadline cell.
  assert.equal(row.report, '[#1](reports/tier-2/IQVIA.md)');
  assert.equal(row.notes, '');
});

test('parseAppRow reads the legacy 9-column (no-deadline) layout', () => {
  const line = '| 4 | 2026-01-01 | Acme | Data Analyst | 8.1/10 | Applied | ✅ | [#4](reports/tier-2/Acme.md) | some note |';
  const row = parseAppRow(line);
  assert.equal(row.hasDeadline, false);
  assert.equal(row.deadline, null);
  assert.equal(row.report, '[#4](reports/tier-2/Acme.md)');
  assert.equal(row.notes, 'some note');
});

test('parseAppRow rejects headers, separators, and non-numeric ids', () => {
  assert.equal(parseAppRow('| # | Date | Company | Role | Score | Status | PDF | Report | Notes |'), null);
  assert.equal(parseAppRow('|---|------|---------|------|-------|--------|-----|--------|-------|'), null);
  assert.equal(parseAppRow('not a table row'), null);
  assert.equal(parseAppRow('| 0 | … |'), null); // num 0 is not a real entry
});

test('serializeAppRow round-trips a parsed row, and a status edit rewrites only the status', () => {
  const line = '| 1 | 2026-05-05 | IQVIA | Oncology Data Analyst | 7.2/10 | SKIP | ❌ | n/d | [#1](reports/tier-2/IQVIA.md) |  |';
  const row = parseAppRow(line);
  // Editing via the resolved column index must not disturb the report/notes cells.
  row.cells[row.cols.status] = 'Applied';
  const out = serializeAppRow(row.cells);
  const reparsed = parseAppRow(out);
  assert.equal(reparsed.status, 'Applied');
  assert.equal(reparsed.report, '[#1](reports/tier-2/IQVIA.md)'); // unchanged
  assert.equal(reparsed.deadline, 'n/d'); // unchanged
});

test('regression: writing notes by index lands in notes, not the report cell', () => {
  // Reproduces the normalize-statuses bug: on a 10-col row, hardcoding
  // notes=cells[9] clobbers the report link. With the resolved index it's safe.
  const line = '| 2 | 2026-05-05 | Acme | Data Analyst | 6.0/10 | Discarded | ❌ | 2026-06-30 | [#2](reports/tier-3/Acme.md) |  |';
  const row = parseAppRow(line);
  row.cells[row.cols.notes] = 'DUPLICADO de #1';
  const reparsed = parseAppRow(serializeAppRow(row.cells));
  assert.equal(reparsed.notes, 'DUPLICADO de #1');
  assert.equal(reparsed.report, '[#2](reports/tier-3/Acme.md)'); // report survived
  assert.equal(reparsed.deadline, '2026-06-30');
});

/* ───── TSV additions ────────────────────────────────────────────── */

test('parseTsvAddition: canonical 10-col TSV (status before score)', () => {
  const tsv = '14\t2026-06-01\tAcme\tData Analyst\tEvaluated\t8.5/10\t❌\t2026-06-30\t[#14](reports/Acme.md)\tnice fit';
  const a = parseTsvAddition(tsv, '14-acme.tsv', silent);
  assert.equal(a.num, 14);
  assert.equal(a.status, 'Evaluated');
  assert.equal(a.score, '8.5/10');
  assert.equal(a.deadline, '2026-06-30');
  // tier derived from score 8.5 → tier-2, rewritten from the flat path
  assert.equal(a.report, '[#14](reports/tier-2/Acme.md)');
  assert.equal(a.notes, 'nice fit');
});

test('parseTsvAddition: tolerates the legacy score-before-status column swap', () => {
  // col4 is a score, col5 a status → heuristic swaps them back.
  const tsv = '15\t2026-06-01\tAcme\tData Analyst\t9.1/10\tApplied\t❌\t[#15](reports/Acme.md)\tnote';
  const a = parseTsvAddition(tsv, '15-acme.tsv', silent);
  assert.equal(a.status, 'Applied');
  assert.equal(a.score, '9.1/10');
  // 9-col (no deadline) form
  assert.equal(a.deadline, 'n/d');
  assert.equal(a.report, '[#15](reports/tier-1/Acme.md)'); // 9.1 → tier-1
  assert.equal(a.notes, 'note');
});

test('parseTsvAddition: pipe-delimited markdown row fallback', () => {
  const row = '| 16 | 2026-06-02 | Acme | Data Analyst | 6.5/10 | Evaluated | ❌ | [#16](reports/Acme.md) | x |';
  const a = parseTsvAddition(row, '16-acme.tsv', silent);
  assert.equal(a.num, 16);
  assert.equal(a.status, 'Evaluated');
  assert.equal(a.report, '[#16](reports/tier-3/Acme.md)'); // 6.5 → tier-3
});

test('parseTsvAddition: returns null on malformed/empty input', () => {
  assert.equal(parseTsvAddition('', 'x.tsv', silent), null);
  assert.equal(parseTsvAddition('only\tthree\tfields', 'x.tsv', silent), null);
  assert.equal(parseTsvAddition('NaN\t2026\tA\tR\tEvaluated\t8/10\t❌\t[#1](r.md)\tn', 'x.tsv', silent), null);
});
