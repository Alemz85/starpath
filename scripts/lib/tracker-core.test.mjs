// tracker-core.test.mjs — unit suite for the applications.md data pipeline.
//
// Run: node --test scripts/lib/tracker-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CANONICAL_STATES,
  STATUS_RANK,
  companyKey,
  companyKeyLoose,
  normalizeRoleForIndex,
  normalizeRole,
  roleFuzzyMatch,
  roleMatchStrict,
  parseScoreCell,
  formatScoreCell,
  displayScoreCell,
  scoreCellPriority,
  compareScoreCells,
  describeReEval,
  validateScoreCell,
  extractReportNum,
  validateStatus,
  normalizeStatus,
  tierForScoreCell,
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

test('parseScoreCell: v2 "W8.3 E5.6" → { want, ease }', () => {
  assert.deepEqual(parseScoreCell('W8.3 E5.6'), { want: 8.3, ease: 5.6 });
  assert.deepEqual(parseScoreCell('W8.25 E5'), { want: 8.25, ease: 5 });
  assert.deepEqual(parseScoreCell('**W8.3 E5.6**'), { want: 8.3, ease: 5.6 });
  assert.deepEqual(parseScoreCell('w8 e7'), { want: 8, ease: 7 });
  // tolerated separators
  assert.deepEqual(parseScoreCell('W8.3 · E5.6'), { want: 8.3, ease: 5.6 });
  assert.deepEqual(parseScoreCell('W8.3/E5.6'), { want: 8.3, ease: 5.6 });
  assert.deepEqual(parseScoreCell('W8.3,E5.6'), { want: 8.3, ease: 5.6 });
  assert.deepEqual(parseScoreCell('W8.3E5.6'), { want: 8.3, ease: 5.6 });
});

test('parseScoreCell: legacy "7.4/10" → { legacy }', () => {
  assert.deepEqual(parseScoreCell('7.2/10'), { legacy: 7.2 });
  assert.deepEqual(parseScoreCell('**8**'), { legacy: 8 });
  assert.deepEqual(parseScoreCell('9'), { legacy: 9 });
  assert.deepEqual(parseScoreCell(' 6.5 / 10 '), { legacy: 6.5 });
});

test('parseScoreCell: sentinels and garbage → null', () => {
  for (const bad of ['N/A', 'DUP', '—', '-', '', '  ', 'W8.3', 'E5.6', 'W E', 'abc', null, undefined]) {
    assert.equal(parseScoreCell(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('formatScoreCell / displayScoreCell', () => {
  assert.equal(formatScoreCell(8.3, 5.6), 'W8.3 E5.6');
  assert.equal(formatScoreCell('8.25', '5.0'), 'W8.25 E5');
  assert.equal(displayScoreCell('W8.3 E5.6'), 'W8.3 · E5.6');
  assert.equal(displayScoreCell('7.4/10'), '7.4/10');
  assert.equal(displayScoreCell('9'), '9/10');
  assert.equal(displayScoreCell('N/A'), 'N/A');
  // round trip
  assert.deepEqual(parseScoreCell(formatScoreCell(8.3, 5.6)), { want: 8.3, ease: 5.6 });
});

test('scoreCellPriority: sqrt(want × ease) for v2, the number for legacy, null otherwise', () => {
  assert.equal(scoreCellPriority('W9 E4'), 6);
  assert.equal(scoreCellPriority('W8.3 E5.6'), 6.82);
  assert.equal(scoreCellPriority('7.4/10'), 7.4);
  assert.equal(scoreCellPriority('N/A'), null);
});

test('compareScoreCells: higher priority wins, v2 beats legacy on a tie', () => {
  assert.ok(compareScoreCells('W9 E7', 'W8 E6') > 0);
  assert.ok(compareScoreCells('W8 E6', 'W9 E7') < 0);
  assert.equal(compareScoreCells('W8 E8', 'W8 E8'), 0);
  // 6/10 legacy vs W9 E4 (priority 6) → tie → v2 wins
  assert.ok(compareScoreCells('W9 E4', '6/10') > 0);
  assert.ok(compareScoreCells('6/10', 'W9 E4') < 0);
  // cross-model: legacy 8.0 beats a lower-priority v2 cell
  assert.ok(compareScoreCells('8.0/10', 'W7 E6') > 0);
  // unparseable ranks below everything
  assert.ok(compareScoreCells('W5 E5', 'N/A') > 0);
  assert.ok(compareScoreCells('N/A', '3/10') < 0);
  assert.equal(compareScoreCells('N/A', 'DUP'), 0);
});

test('describeReEval: W/E deltas for v2 pairs, old→new display otherwise', () => {
  assert.equal(describeReEval('W7.1 E5', 'W8.3 E5.6'), '(W 7.1→8.3, E 5→5.6)');
  assert.equal(describeReEval('7.4/10', 'W8.3 E5.6'), '(7.4/10→W8.3 · E5.6)');
});

test('validateScoreCell accepts v2, legacy, and N/A / DUP; rejects the rest', () => {
  assert.equal(validateScoreCell('W8.3 E5.6'), null);
  assert.equal(validateScoreCell('7.4/10'), null);
  assert.equal(validateScoreCell('N/A'), null);
  assert.equal(validateScoreCell('DUP'), null);
  assert.match(validateScoreCell('—'), /invalid score format/);
  assert.match(validateScoreCell('8.3/E5.6'), /invalid score format/);
  assert.match(validateScoreCell('W11 E5'), /out of range/);
  assert.match(validateScoreCell('W5 E0.5'), /out of range/);
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

// Full drift pin (audit finding 8): CANONICAL_STATES must equal the `label:` set
// declared in templates/states.yml (the documented source of truth) — exactly,
// no more, no less. A new state added to the YAML without updating the code (or
// vice-versa) fails here. Parsed without a YAML dependency: the labels are flat
// scalars, so a line regex is sufficient and keeps this test zero-dep.
test('CANONICAL_STATES exactly matches templates/states.yml labels', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const yml = readFileSync(join(here, '..', '..', 'templates', 'states.yml'), 'utf-8');
  const labels = [...yml.matchAll(/^\s*label:\s*(.+?)\s*$/gm)]
    .map(m => m[1].replace(/^["']|["']$/g, '').trim());
  assert.deepEqual(new Set(labels), new Set(CANONICAL_STATES));
  assert.equal(labels.length, CANONICAL_STATES.length, 'no duplicate labels / no count drift');
});

/* ───── tier paths ───────────────────────────────────────────────── */

test('tierForScoreCell: v2 cells go through the verdict grid, SKIP wins, legacy/unparseable → null', () => {
  assert.equal(tierForScoreCell('W8.5 E7.5', 'Evaluated'), 1); // go
  assert.equal(tierForScoreCell('W8.5 E5.5', 'Evaluated'), 2); // stretch
  assert.equal(tierForScoreCell('W8.5 E3', 'Evaluated'), 3); // growth
  assert.equal(tierForScoreCell('W7 E7.5', 'Applied'), 2); // solid
  assert.equal(tierForScoreCell('W6 E9', 'Evaluated'), 4); // skip
  assert.equal(tierForScoreCell('W9.9 E9.9', 'SKIP'), 4); // SKIP always tier-4
  assert.equal(tierForScoreCell('7.4/10', 'Evaluated'), null); // legacy: v1 cut-offs are retired
  assert.equal(tierForScoreCell('N/A', 'Evaluated'), null);
});

test('rewriteReportPathForOfertaTier rewrites flat paths, leaves tiered/sentinels', () => {
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/Acme.md)', 'W8.5 E5.5', 'Evaluated'),
    '[#1](reports/tier-2/Acme.md)',
  );
  // Already tiered → unchanged
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/tier-1/Acme.md)', 'W9.5 E8', 'Evaluated'),
    '[#1](reports/tier-1/Acme.md)',
  );
  // Sentinels → unchanged
  assert.equal(rewriteReportPathForOfertaTier('—', 'W8 E8', 'Evaluated'), '—');
  assert.equal(rewriteReportPathForOfertaTier('', 'W8 E8', 'Evaluated'), '');
  // SKIP → tier-4
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/Acme.md)', 'W7 E6', 'SKIP'),
    '[#1](reports/tier-4/Acme.md)',
  );
  // Legacy cell → no derivable tier → left untouched
  assert.equal(
    rewriteReportPathForOfertaTier('[#1](reports/Acme.md)', '7.2/10', 'Evaluated'),
    '[#1](reports/Acme.md)',
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

test('parseTsvAddition: canonical 10-col TSV (status before score, v2 cell)', () => {
  const tsv = '14\t2026-06-01\tAcme\tData Analyst\tEvaluated\tW8.5 E5.5\t❌\t2026-06-30\t[#14](reports/Acme.md)\tnice fit';
  const a = parseTsvAddition(tsv, '14-acme.tsv', silent);
  assert.equal(a.num, 14);
  assert.equal(a.status, 'Evaluated');
  assert.equal(a.score, 'W8.5 E5.5');
  assert.equal(a.deadline, '2026-06-30');
  // W8.5 E5.5 = stretch → tier-2, rewritten from the flat path
  assert.equal(a.report, '[#14](reports/tier-2/Acme.md)');
  assert.equal(a.notes, 'nice fit');
});

test('parseTsvAddition: canonicalizes the v2 score spelling', () => {
  const tsv = '14\t2026-06-01\tAcme\tData Analyst\tEvaluated\tW 8.50 · E5.5\t❌\t2026-06-30\t[#14](reports/tier-2/Acme.md)\tx';
  const a = parseTsvAddition(tsv, '14-acme.tsv', silent);
  assert.equal(a.score, 'W8.5 E5.5');
});

test('parseTsvAddition: tolerates the legacy score-before-status column swap', () => {
  // col4 is a score, col5 a status → heuristic swaps them back (v2 cell).
  const tsv = '15\t2026-06-01\tAcme\tData Analyst\tW9 E8\tApplied\t❌\t[#15](reports/Acme.md)\tnote';
  const a = parseTsvAddition(tsv, '15-acme.tsv', silent);
  assert.equal(a.status, 'Applied');
  assert.equal(a.score, 'W9 E8');
  // 9-col (no deadline) form
  assert.equal(a.deadline, 'n/d');
  assert.equal(a.report, '[#15](reports/tier-1/Acme.md)'); // go → tier-1
  assert.equal(a.notes, 'note');
});

test('parseTsvAddition: legacy "X.X/10" scores are still accepted (path left flat)', () => {
  const tsv = '17\t2026-06-01\tAcme\tData Analyst\tEvaluated\t8.5/10\t❌\t2026-06-30\t[#17](reports/Acme.md)\told';
  const a = parseTsvAddition(tsv, '17-acme.tsv', silent);
  assert.equal(a.score, '8.5/10');
  assert.equal(a.report, '[#17](reports/Acme.md)');
});

test('parseTsvAddition: pipe-delimited markdown row fallback', () => {
  const row = '| 16 | 2026-06-02 | Acme | Data Analyst | W6.5 E5.2 | Evaluated | ❌ | [#16](reports/Acme.md) | x |';
  const a = parseTsvAddition(row, '16-acme.tsv', silent);
  assert.equal(a.num, 16);
  assert.equal(a.status, 'Evaluated');
  assert.equal(a.report, '[#16](reports/tier-2/Acme.md)'); // thin → tier-2
});

test('parseTsvAddition: N/A and DUP score sentinels pass validation', () => {
  const a = parseTsvAddition('18\t2026-06-01\tAcme\tR\tDiscarded\tN/A\t❌\tn/d\t—\tdup', 'x', silent);
  assert.equal(a.score, 'N/A');
});

test('parseTsvAddition: skips unparseable scores (a blocked "—" or a v1-era shape error)', () => {
  let warned = 0;
  const warn = () => { warned++; };
  assert.equal(parseTsvAddition('19\t2026-06-01\tAcme\tR\tEvaluated\t—\t❌\tn/d\t—\tx', 'x', warn), null);
  assert.equal(parseTsvAddition('20\t2026-06-01\tAcme\tR\tEvaluated\tbanana\t❌\tn/d\t—\tx', 'x', warn), null);
  assert.ok(warned >= 2);
});

test('parseTsvAddition: returns null on malformed/empty input', () => {
  assert.equal(parseTsvAddition('', 'x.tsv', silent), null);
  assert.equal(parseTsvAddition('only\tthree\tfields', 'x.tsv', silent), null);
  assert.equal(parseTsvAddition('NaN\t2026\tA\tR\tEvaluated\tW8 E8\t❌\t[#1](r.md)\tn', 'x.tsv', silent), null);
});
