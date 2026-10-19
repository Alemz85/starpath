// scouting-core.test.mjs — unit suite for the data/scouting.md pipeline
// (scoring v2: 12 columns — Want, Ease, Tier, Eligibility; docs/scoring-v2.md §8.2).
//
// Run: node --test scripts/lib/scouting-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_TIERS,
  VERDICT_TIERS,
  verdictFromCells,
  normalizeTier,
  promotionHintForVerdict,
  normalizePromotionHint,
  toNumber,
  isValidScoreCell,
  eligibilityStatus,
  parseEligibilityCell,
  formatEligibilityCell,
  companyKey,
  normalizeRoleForIndex,
  roleFuzzyMatch,
  extractReportNum,
  coalesceDeadline,
  rewriteReportPathForTier,
  scoutingColumns,
  isV2ScoutingHeader,
  parseScoutingRow,
  formatScoutingRow,
  parseScoutingTsv,
  reEvalNote,
  shouldReplaceScoutingRow,
  buildReEvalRow,
  validateScoutingRow,
} from './scouting-core.mjs';

const silent = () => {};

const V2_HEADER = '| # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes |';

/* ───── verdict grid (mirror of score-bands.mjs) ─────────────────── */

test('verdictFromCells walks the full grid (spec §4)', () => {
  const g = (want, ease, eligibility = 'green') => verdictFromCells({ want, ease, eligibility });
  assert.deepEqual(g(8.0, 7.0), { verdict: 'go', tier: 'T1' });
  assert.deepEqual(g(9, 5.0), { verdict: 'stretch', tier: 'T2' });
  assert.deepEqual(g(8.5, 4.99), { verdict: 'growth', tier: 'T3' });
  assert.deepEqual(g(7.99, 7.0), { verdict: 'solid', tier: 'T2' });
  assert.deepEqual(g(6.5, 5.0), { verdict: 'thin', tier: 'T2' });
  assert.deepEqual(g(7, 4.9), { verdict: 'skip', tier: 'T4' });
  assert.deepEqual(g(6.49, 9), { verdict: 'skip', tier: 'T4' });
  assert.deepEqual(g(3, 3), { verdict: 'skip', tier: 'T4' });
});

test('verdictFromCells: red eligibility and missing cells are blocked / T4', () => {
  assert.deepEqual(verdictFromCells({ want: 9, ease: 9, eligibility: 'red' }), { verdict: 'blocked', tier: 'T4' });
  assert.deepEqual(verdictFromCells({ want: 9, ease: 9, eligibility: 'red: German C1 required' }), { verdict: 'blocked', tier: 'T4' });
  assert.deepEqual(verdictFromCells({ want: '—', ease: '—', eligibility: 'green' }), { verdict: 'blocked', tier: 'T4' });
  assert.deepEqual(verdictFromCells({}), { verdict: 'blocked', tier: 'T4' });
});

test('verdictFromCells accepts cell strings and amber cells', () => {
  assert.equal(verdictFromCells({ want: '8.25', ease: '5.6', eligibility: 'amber: start date not stated' }).verdict, 'stretch');
});

test('VERDICT_TIERS covers every verdict key', () => {
  assert.deepEqual(Object.keys(VERDICT_TIERS).sort(), ['blocked', 'go', 'growth', 'skip', 'solid', 'stretch', 'thin']);
});

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

test('promotion hint by verdict: READY for go, MONITOR for stretch/solid, else blank', () => {
  assert.equal(promotionHintForVerdict('go'), 'READY');
  assert.equal(promotionHintForVerdict('stretch'), 'MONITOR');
  assert.equal(promotionHintForVerdict('solid'), 'MONITOR');
  for (const v of ['growth', 'thin', 'skip', 'blocked']) assert.equal(promotionHintForVerdict(v), '');
});

test('normalizePromotionHint defaults from the verdict and normalizes READY/MONITOR', () => {
  assert.equal(normalizePromotionHint('', 'go'), 'READY');
  assert.equal(normalizePromotionHint('', 'stretch'), 'MONITOR');
  assert.equal(normalizePromotionHint('', 'thin'), '');
  assert.equal(normalizePromotionHint('ready to apply', 'solid'), 'READY');
  assert.equal(normalizePromotionHint('monitor weekly', 'go'), 'MONITOR');
  assert.equal(normalizePromotionHint('apply if pipeline thin', 'thin'), 'apply if pipeline thin');
  assert.equal(normalizePromotionHint('PROMOTED-12', 'go'), 'PROMOTED-12');
});

/* ───── cell parsers ─────────────────────────────────────────────── */

test('toNumber / isValidScoreCell', () => {
  assert.equal(toNumber('8.25'), 8.25);
  assert.equal(toNumber('**8**'), 8);
  assert.equal(toNumber('8.25/10'), 8.25);
  assert.equal(toNumber('—'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(7), 7);
  assert.equal(isValidScoreCell('5.6'), true);
  assert.equal(isValidScoreCell('—'), true);
  assert.equal(isValidScoreCell('0.5'), false);
  assert.equal(isValidScoreCell('11'), false);
  assert.equal(isValidScoreCell(''), false);
  assert.equal(isValidScoreCell('n/a'), false);
});

test('eligibility cell parse / format', () => {
  assert.equal(eligibilityStatus('green'), 'green');
  assert.equal(eligibilityStatus('**Amber**: x'), 'amber');
  assert.equal(eligibilityStatus('reddit'), null);
  assert.equal(eligibilityStatus('maybe'), null);
  assert.deepEqual(parseEligibilityCell('green'), { status: 'green', reasons: [] });
  assert.deepEqual(parseEligibilityCell('amber: start date not stated; duration not stated'), {
    status: 'amber', reasons: ['start date not stated', 'duration not stated'],
  });
  assert.deepEqual(parseEligibilityCell('red: German C1 required'), { status: 'red', reasons: ['German C1 required'] });
  assert.equal(parseEligibilityCell('purple'), null);
  assert.equal(formatEligibilityCell('green'), 'green');
  assert.equal(formatEligibilityCell('amber', ['a', 'b']), 'amber: a; b');
  assert.equal(formatEligibilityCell('red', 'blocked window'), 'red: blocked window');
});

/* ───── keys + scalars ───────────────────────────────────────────── */

test('companyKey / role helpers', () => {
  assert.equal(companyKey('Go-Cardless Ltd.'), 'gocardlessltd');
  assert.equal(normalizeRoleForIndex('  Data   Analyst '), 'data analyst');
  assert.ok(roleFuzzyMatch('Data Analyst (12 month FTC)', 'Senior Data Analyst'));
  assert.ok(!roleFuzzyMatch('Data Analyst', 'Account Executive'));
});

test('extractReportNum', () => {
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

/* ───── row parsing ──────────────────────────────────────────────── */

test('scoutingColumns is the fixed 12-column layout', () => {
  assert.deepEqual(scoutingColumns(), {
    num: 1, date: 2, company: 3, role: 4, want: 5, ease: 6, tier: 7, eligibility: 8,
    report: 9, deadline: 10, hint: 11, notes: 12,
  });
});

test('isV2ScoutingHeader distinguishes v2 from the v1 header', () => {
  assert.equal(isV2ScoutingHeader(V2_HEADER), true);
  assert.equal(isV2ScoutingHeader('| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |'), false);
  assert.equal(isV2ScoutingHeader('| 1 | 2026-01-01 | Acme |'), false);
});

const ROW = '| 238 | 2026-06-24 | Northwind Labs | Data Analyst (12 month FTC) | 7.1 | 6.0 | T2 | amber: start date not stated | [#238](reports/tier-2/Northwind.md) | 2026-06-30 | MONITOR | rich eval summary |';

test('parseScoutingRow reads every v2 column', () => {
  const r = parseScoutingRow(ROW);
  assert.equal(r.num, 238);
  assert.equal(r.company, 'Northwind Labs');
  assert.equal(r.want, '7.1');
  assert.equal(r.ease, '6.0');
  assert.equal(r.wantNum, 7.1);
  assert.equal(r.easeNum, 6);
  assert.equal(r.tier, 'T2');
  assert.equal(r.eligibility, 'amber: start date not stated');
  assert.equal(r.eligibilityStatus, 'amber');
  assert.equal(r.report, '[#238](reports/tier-2/Northwind.md)');
  assert.equal(r.deadline, '2026-06-30');
  assert.equal(r.hint, 'MONITOR');
  assert.equal(r.notes, 'rich eval summary');
});

test('parseScoutingRow reads a blocked row ("—" Want/Ease)', () => {
  const r = parseScoutingRow('| 9 | 2026-06-25 | Contoso | Graduate Analyst | — | — | T4 | red: German C1 required | — | n/d |  | Revisit next cycle: dream company |');
  assert.equal(r.wantNum, null);
  assert.equal(r.easeNum, null);
  assert.equal(r.eligibilityStatus, 'red');
  assert.equal(r.report, '—');
  assert.equal(r.hint, '');
  assert.equal(r.notes, 'Revisit next cycle: dream company');
});

test('parseScoutingRow rejects headers, separators, non-numeric ids and every v1 shape', () => {
  assert.equal(parseScoutingRow(V2_HEADER), null);
  assert.equal(parseScoutingRow('|---|------|---------|------|------|------|------|-------------|--------|----------|----------------|-------|'), null);
  assert.equal(parseScoutingRow('plain text'), null);
  // v1 11-column (Score/Tier/CF-AF/Report/Deadline/Hint/Notes) and 10-column rows are not readable.
  assert.equal(parseScoutingRow('| 238 | 2026-06-24 | GoCardless | Data Analyst | 6.7/10 | T2 | 7.0/6.0 | [#238](reports/tier-2/G.md) | 2026-06-30 | READY | note |'), null);
  assert.equal(parseScoutingRow('| 5 | 2026-01-01 | Acme | Data Analyst | 8.1/10 | T2 | 8.0/7.0 | [#5](reports/tier-2/A.md) | READY | a note |'), null);
});

test('formatScoutingRow round-trips, and flipping the hint preserves deadline + notes', () => {
  const r = parseScoutingRow(ROW);
  assert.equal(formatScoutingRow(r), ROW);
  const reparsed = parseScoutingRow(formatScoutingRow({ ...r, hint: 'PROMOTED-42' }));
  assert.equal(reparsed.hint, 'PROMOTED-42');
  assert.equal(reparsed.deadline, '2026-06-30');
  assert.equal(reparsed.notes, 'rich eval summary');
  assert.equal(reparsed.eligibility, 'amber: start date not stated');
});

test('formatScoutingRow neutralizes literal pipes in free-text cells', () => {
  const line = formatScoutingRow({ ...parseScoutingRow(ROW), notes: 'a | b', eligibility: 'amber: x | y' });
  const r = parseScoutingRow(line);
  assert.equal(r.notes, 'a / b');
  assert.equal(r.eligibility, 'amber: x / y');
  assert.equal(r.report, '[#238](reports/tier-2/Northwind.md)');
});

/* ───── TSV additions ────────────────────────────────────────────── */

test('parseScoutingTsv: canonical 12-col addition', () => {
  const tsv = '300\t2026-06-25\tNimbus\tML Engineer\t8.4\t7.2\tT1\tgreen\t[#300](reports/Nimbus.md)\t2026-07-15\t\tstrong fit';
  const a = parseScoutingTsv(tsv, '300-nimbus.tsv', silent);
  assert.equal(a.num, 300);
  assert.equal(a.want, '8.4');
  assert.equal(a.ease, '7.2');
  assert.equal(a.tier, 'T1');
  assert.equal(a.eligibility, 'green');
  assert.equal(a.deadline, '2026-07-15');
  assert.equal(a.report, '[#300](reports/tier-1/Nimbus.md)'); // flat → tier-1
  assert.equal(a.hint, 'READY'); // blank hint + go verdict
  assert.equal(a.notes, 'strong fit');
});

test('parseScoutingTsv: blank hint defaults MONITOR for stretch/solid, blank otherwise', () => {
  const mk = (want, ease, tier) => `1\t2026-06-25\tA\tR\t${want}\t${ease}\t${tier}\tgreen\t[#1](reports/A.md)\tn/d\t\tn`;
  assert.equal(parseScoutingTsv(mk(8.5, 5.5, 'T2'), 'x', silent).hint, 'MONITOR'); // stretch
  assert.equal(parseScoutingTsv(mk(7.0, 7.5, 'T2'), 'x', silent).hint, 'MONITOR'); // solid
  assert.equal(parseScoutingTsv(mk(7.0, 5.5, 'T2'), 'x', silent).hint, ''); // thin
  assert.equal(parseScoutingTsv(mk(9.0, 3.0, 'T3'), 'x', silent).hint, ''); // growth
});

test('parseScoutingTsv: tolerates absent trailing hint/notes cells', () => {
  const a = parseScoutingTsv('301\t2026-06-25\tAcme\tAnalyst\t7.0\t7.5\tT2\tgreen\t[#301](reports/Acme.md)\tn/d', 'x', silent);
  assert.equal(a.hint, 'MONITOR');
  assert.equal(a.notes, '');
  assert.equal(a.report, '[#301](reports/tier-2/Acme.md)');
});

test('parseScoutingTsv: amber eligibility is preserved verbatim', () => {
  const a = parseScoutingTsv('302\t2026-06-25\tAcme\tAnalyst\t8.1\t6.0\tT2\tamber: start date not stated; duration not stated\t[#302](reports/Acme.md)\tn/d\t\t', 'x', silent);
  assert.equal(a.eligibility, 'amber: start date not stated; duration not stated');
});

test('parseScoutingTsv: blocked listing is forced into the blocked shape', () => {
  const a = parseScoutingTsv('303\t2026-06-25\tContoso\tGrad Analyst\t—\t—\tT4\tred: study term overlap\t—\tn/d\tREADY\tRevisit next cycle: dream', 'x', silent);
  assert.equal(a.want, '—');
  assert.equal(a.ease, '—');
  assert.equal(a.tier, 'T4');
  assert.equal(a.hint, ''); // never READY on a blocked row
  assert.equal(a.report, '—');
  // Even if a writer left numbers on a red row, the shape is forced.
  const b = parseScoutingTsv('304\t2026-06-25\tContoso\tGrad Analyst\t9\t9\tT1\tred: x\t—\tn/d\t\t', 'x', silent);
  assert.equal(b.want, '—');
  assert.equal(b.tier, 'T4');
});

test('parseScoutingTsv: derives the tier from the grid when the cell is blank', () => {
  const a = parseScoutingTsv('305\t2026-06-25\tA\tR\t8.5\t7.5\t\tgreen\t[#305](reports/A.md)\tn/d\t\t', 'x', silent);
  assert.equal(a.tier, 'T1');
  assert.equal(a.report, '[#305](reports/tier-1/A.md)');
});

test('parseScoutingTsv: rejects malformed / empty / v1-shaped input', () => {
  assert.equal(parseScoutingTsv('', 'x.tsv', silent), null);
  assert.equal(parseScoutingTsv('a\tb\tc', 'x.tsv', silent), null);
  assert.equal(parseScoutingTsv('NaN\td\tc\tr\t8\t8\tT1\tgreen\t[#1](r.md)\tx\ty\tz', 'x.tsv', silent), null);
  // v1 11-col: score "6.7/10" in the Want slot is out of range, CF/AF in the eligibility slot is unparseable
  assert.equal(parseScoutingTsv('300\t2026-06-25\tNimbus\tML Engineer\t9.1/10\tT1\t9.0/8.5\t[#300](reports/Nimbus.md)\t2026-07-15\t\tstrong fit', 'x.tsv', silent), null);
  // non-red row with blocked cells
  assert.equal(parseScoutingTsv('306\t2026-06-25\tA\tR\t—\t—\tT4\tgreen\t—\tn/d\t\t', 'x', silent), null);
  // bad eligibility
  assert.equal(parseScoutingTsv('307\t2026-06-25\tA\tR\t8\t8\tT1\tmaybe\t—\tn/d\t\t', 'x', silent), null);
  // out of range
  assert.equal(parseScoutingTsv('308\t2026-06-25\tA\tR\t11\t8\tT1\tgreen\t—\tn/d\t\t', 'x', silent), null);
});

/* ───── re-evaluation merge ──────────────────────────────────────── */

const OLD = parseScoutingRow('| 12 | 2026-06-01 | Nimbus | ML Engineer | 7.1 | 5.0 | T2 | green | [#12](reports/tier-2/N.md) | 2026-07-15 | MONITOR | first eval |');
const NEWER = {
  num: 99, date: '2026-07-01', company: 'Nimbus', role: 'ML Engineer', want: '8.3', ease: '5.6', tier: 'T2',
  eligibility: 'amber: start date not stated', report: '[#99](reports/tier-2/N2.md)', deadline: 'n/d', hint: 'MONITOR', notes: 'second eval',
};

test('reEvalNote renders W a→b, E c→d (and "—" for blocked sides)', () => {
  assert.equal(reEvalNote(OLD, NEWER), 'Re-eval (W 7.1→8.3, E 5→5.6)');
  assert.equal(reEvalNote({ want: '—', ease: '—' }, NEWER), 'Re-eval (W —→8.3, E —→5.6)');
  assert.equal(reEvalNote(OLD, { want: '—', ease: '—' }), 'Re-eval (W 7.1→—, E 5→—)');
});

test('shouldReplaceScoutingRow: newer or same-day wins, older is stale', () => {
  assert.equal(shouldReplaceScoutingRow(OLD, NEWER), true);
  assert.equal(shouldReplaceScoutingRow(OLD, { ...NEWER, date: '2026-06-01' }), true);
  assert.equal(shouldReplaceScoutingRow(OLD, { ...NEWER, date: '2026-05-31' }), false);
});

test('shouldReplaceScoutingRow replaces even when the new score is LOWER (point-in-time model)', () => {
  const lower = { ...NEWER, want: '6.0', ease: '4.0', tier: 'T4', hint: '' };
  assert.equal(shouldReplaceScoutingRow(OLD, lower), true);
  const merged = buildReEvalRow(OLD, lower);
  assert.equal(merged.want, '6.0');
  assert.equal(merged.notes, 'Re-eval (W 7.1→6, E 5→4). second eval');
});

test('buildReEvalRow: keeps entry number, takes new cells, annotates notes', () => {
  const m = buildReEvalRow(OLD, NEWER);
  assert.equal(m.num, 12);
  assert.equal(m.date, '2026-07-01');
  assert.equal(m.want, '8.3');
  assert.equal(m.ease, '5.6');
  assert.equal(m.eligibility, 'amber: start date not stated');
  assert.equal(m.report, '[#99](reports/tier-2/N2.md)');
  assert.equal(m.notes, 'Re-eval (W 7.1→8.3, E 5→5.6). second eval');
  // The posting's known close date survives a re-eval that omits it.
  assert.equal(m.deadline, '2026-07-15');
});

test('buildReEvalRow: a PROMOTED-n hint is preserved', () => {
  const promoted = { ...OLD, hint: 'PROMOTED-7' };
  assert.equal(buildReEvalRow(promoted, NEWER).hint, 'PROMOTED-7');
  assert.equal(buildReEvalRow(OLD, NEWER).hint, 'MONITOR');
});

test('buildReEvalRow output serializes to a parseable 12-column row', () => {
  const r = parseScoutingRow(formatScoutingRow(buildReEvalRow(OLD, NEWER)));
  assert.equal(r.num, 12);
  assert.equal(r.wantNum, 8.3);
  assert.equal(r.deadline, '2026-07-15');
});

/* ───── row validation ───────────────────────────────────────────── */

const row = (over = {}) => ({ ...parseScoutingRow(ROW), ...over });

test('validateScoutingRow: a clean row has no findings', () => {
  assert.deepEqual(validateScoutingRow(row()), { errors: [], warnings: [] });
  const blocked = parseScoutingRow('| 9 | 2026-06-25 | Contoso | Grad | — | — | T4 | red: x | — | n/d |  |  |');
  assert.deepEqual(validateScoutingRow(blocked), { errors: [], warnings: [] });
});

test('validateScoutingRow: structural errors', () => {
  assert.ok(validateScoutingRow(row({ tier: 'T9' })).errors.some(e => /tier/.test(e)));
  assert.ok(validateScoutingRow(row({ want: '6.7/10x' })).errors.some(e => /Want/.test(e)));
  assert.ok(validateScoutingRow(row({ ease: '14' })).errors.some(e => /Ease/.test(e)));
  assert.ok(validateScoutingRow(row({ eligibility: 'maybe' })).errors.some(e => /Eligibility/.test(e)));
  assert.ok(validateScoutingRow(row({ want: '—', ease: '—' })).errors.some(e => /only valid for a red/.test(e)));
  const redWithScores = row({ eligibility: 'red: x', tier: 'T2' });
  const errs = validateScoutingRow(redWithScores).errors;
  assert.ok(errs.some(e => /Want and Ease/.test(e)));
  assert.ok(errs.some(e => /T4/.test(e)));
});

test('validateScoutingRow: tier vs grid disagreement is a warning, not an error', () => {
  const r = validateScoutingRow(row({ tier: 'T1' })); // W7.1 E6.0 is "thin" → T2
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /grid says T2/);
});

test('VALID_TIERS is the canonical 4', () => {
  assert.deepEqual(VALID_TIERS, ['T1', 'T2', 'T3', 'T4']);
});
