// Unit tests for scripts/lib/patterns-core.mjs
//
// Plain node:test + node:assert, zero external deps.
// Run: node --test scripts/lib/patterns-core.test.mjs
//       (or `npm test` which runs `node --test "scripts/**/*.test.mjs"`)
//
// Coverage:
//   normalizeStatus        — aliases, casing, bold/date stripping, empty
//   classifyOutcome        — positive / negative / self_filtered / pending
//   parseTracker           — header/separator skipping, column mapping, short rows
//   classifyRemote         — geo-restricted precedence, hybrid, global, regional
//   classifyCompanySize    — numeric thresholds, keyword fallback, unknown
//   extractBlockerType     — soft-gap skip, geo/stack/seniority/onsite/other
//   computeFunnel          — cumulative furthest-stage semantics + conversion rates
//   diagnoseFunnel         — weakest-gate selection, min-base gating, tie-break
//   scoreInfo / scoreStats — v2 "W.. E.." + legacy "X/10" cells via tracker-core,
//                            verdict from W/E (eligibility green), report fallback
//   enrichEntries          — report resolver injection, notes fallback
//   computeVerdictFloor    — worst verdict among progressed applications
//   analyzeOutcomes        — threshold gate, full assembly, funnel-led recs,
//                            actionableRate, verdict-floor + skip recs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStatus,
  classifyOutcome,
  parseTracker,
  classifyRemote,
  classifyCompanySize,
  extractBlockerType,
  computeFunnel,
  diagnoseFunnel,
  enrichEntries,
  analyzeOutcomes,
  scoreInfo,
  scoreStats,
  computeVerdictFloor,
} from './patterns-core.mjs';

/* ───── normalizeStatus ──────────────────────────────────────────────────────*/

test('normalizeStatus: canonical pass-through', () => {
  assert.equal(normalizeStatus('Applied'), 'applied');
  assert.equal(normalizeStatus('Interview'), 'interview');
});

test('normalizeStatus: Spanish aliases fold to canonical', () => {
  assert.equal(normalizeStatus('Aplicado'), 'applied');
  assert.equal(normalizeStatus('Rechazada'), 'rejected');
  assert.equal(normalizeStatus('Entrevista'), 'interview');
  assert.equal(normalizeStatus('Oferta'), 'offer');
});

test('normalizeStatus: strips bold markers and trailing date', () => {
  assert.equal(normalizeStatus('**Applied**'), 'applied');
  assert.equal(normalizeStatus('Applied 2026-06-01 follow-up'), 'applied');
});

test('normalizeStatus: empty / nullish', () => {
  assert.equal(normalizeStatus(''), '');
  assert.equal(normalizeStatus(null), '');
  assert.equal(normalizeStatus(undefined), '');
});

/* ───── classifyOutcome ──────────────────────────────────────────────────────*/

test('classifyOutcome: positive includes applied/responded/interview/offer', () => {
  assert.equal(classifyOutcome('Applied'), 'positive');
  assert.equal(classifyOutcome('Responded'), 'positive');
  assert.equal(classifyOutcome('Interview'), 'positive');
  assert.equal(classifyOutcome('Offer'), 'positive');
});

test('classifyOutcome: negative / self_filtered / pending', () => {
  assert.equal(classifyOutcome('Rejected'), 'negative');
  assert.equal(classifyOutcome('Discarded'), 'negative');
  assert.equal(classifyOutcome('SKIP'), 'self_filtered');
  assert.equal(classifyOutcome('Evaluated'), 'pending');
});

/* ───── parseTracker ─────────────────────────────────────────────────────────*/

// Current on-disk format carries a Deadline cell between PDF and Report (10-col).
const SAMPLE_TRACKER = `| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
|---|------|---------|------|-------|--------|-----|----------|--------|-------|
| 1 | 2026-06-01 | Northwind Analytics | Data Analyst | W8.3 E5.6 | Applied | ✅ | 2026-06-30 | [1](reports/tier-2/northwind.md) | remote EU |
| 2 | 2026-06-02 | Contoso Retail | Strategy | 7.4/10 | Interview | ✅ | Rolling | [2](reports/tier-2/contoso.md) | hybrid |
not a table row
| x | bad | row | skipped | - | - | - | - | - | - |`;

test('parseTracker: maps columns and skips header/separator/non-numeric rows', () => {
  const rows = parseTracker(SAMPLE_TRACKER);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { num: rows[0].num, company: rows[0].company, role: rows[0].role, status: rows[0].status, score: rows[0].score },
    { num: 1, company: 'Northwind Analytics', role: 'Data Analyst', status: 'Applied', score: 'W8.3 E5.6' }
  );
  assert.equal(rows[0].notes, 'remote EU');
  assert.equal(rows[1].company, 'Contoso Retail');
});

// Regression (audit finding 2): the old parser hard-indexed the legacy 9-column
// layout (report = parts[8]), so on a real 10-column row (Deadline between PDF
// and Report) it read the Deadline as the report link and shifted Notes onto the
// report cell. parseTracker now delegates to the deadline-aware parseAppRow.
test('parseTracker: report/notes land in the right fields on a 10-column row', () => {
  const rows = parseTracker(SAMPLE_TRACKER);
  assert.equal(rows[0].report, '[1](reports/tier-2/northwind.md)'); // NOT '2026-06-30'
  assert.equal(rows[0].notes, 'remote EU');                          // NOT the report link
  assert.equal(rows[1].report, '[2](reports/tier-2/contoso.md)');
  assert.equal(rows[1].notes, 'hybrid');
});

// The report link must survive parsing so enrichEntries can resolve it — a
// mis-shifted report cell would break the entire report-backed analysis.
test('parseTracker: 10-column report link stays resolvable for enrichEntries', () => {
  const enriched = enrichEntries(parseTracker(SAMPLE_TRACKER), (p) => ({ archetype: 'X', path: p }));
  assert.equal(enriched[0].report.path, 'reports/tier-2/northwind.md');
});

// Geo-restriction classification must still fire when the restriction lives in
// the Notes cell of a current 10-column row (Notes fallback in enrichEntries).
test('parseTracker + enrichEntries: geo-restriction from Notes on a 10-col row', () => {
  const tracker = `| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
|---|------|---------|------|-------|--------|-----|----------|--------|-------|
| 1 | 2026-06-01 | Fabrikam Labs | Data Analyst | W6.8 E4.2 | Rejected | ❌ | n/d | [1](reports/tier-3/fabrikam.md) | US only |`;
  const enriched = enrichEntries(parseTracker(tracker), null);
  assert.equal(enriched[0].remoteBucket, 'geo-restricted');
});

test('parseTracker: empty input → []', () => {
  assert.deepEqual(parseTracker(''), []);
  assert.deepEqual(parseTracker(null), []);
});

/* ───── classifyRemote ───────────────────────────────────────────────────────*/

test('classifyRemote: geo-restricted beats general remote', () => {
  assert.equal(classifyRemote('Remote, US only'), 'geo-restricted');
  assert.equal(classifyRemote('US residents'), 'geo-restricted');
});

test('classifyRemote: hybrid/onsite, global, regional, unknown', () => {
  assert.equal(classifyRemote('Hybrid Madrid'), 'hybrid/onsite');
  assert.equal(classifyRemote('Work from anywhere'), 'global remote');
  assert.equal(classifyRemote('Fully remote LATAM'), 'regional remote');
  assert.equal(classifyRemote('something else'), 'unknown');
  assert.equal(classifyRemote(''), 'unknown');
});

/* ───── classifyCompanySize ──────────────────────────────────────────────────*/

test('classifyCompanySize: numeric thresholds', () => {
  assert.equal(classifyCompanySize('30 people'), 'startup');
  assert.equal(classifyCompanySize('~200 employees'), 'scaleup');
  assert.equal(classifyCompanySize('5,000 globally'), 'enterprise');
});

test('classifyCompanySize: keyword fallback + unknown', () => {
  assert.equal(classifyCompanySize('founding team'), 'startup');
  assert.equal(classifyCompanySize('large enterprise'), 'enterprise');
  assert.equal(classifyCompanySize(''), 'unknown');
  assert.equal(classifyCompanySize('mid-stage'), 'unknown');
});

/* ───── extractBlockerType ───────────────────────────────────────────────────*/

test('extractBlockerType: soft/nice gaps are skipped', () => {
  assert.equal(extractBlockerType({ description: 'Python preferred', severity: 'nice to have' }), null);
});

test('extractBlockerType: classifies hard blockers', () => {
  assert.equal(extractBlockerType({ description: 'Visa sponsorship not available', severity: 'hard' }), 'geo-restriction');
  assert.equal(extractBlockerType({ description: 'Requires React + Node', severity: 'hard' }), 'stack-mismatch');
  assert.equal(extractBlockerType({ description: 'Senior level required', severity: 'hard' }), 'seniority-mismatch');
  assert.equal(extractBlockerType({ description: 'On-site only', severity: 'hard' }), 'onsite-requirement');
  assert.equal(extractBlockerType({ description: 'Something unmatched', severity: 'hard' }), 'other');
});

/* ───── computeFunnel ────────────────────────────────────────────────────────
 *
 * The crux: furthest-stage semantics. An entry at "interview" must count toward
 * reachedApplied, reachedResponded AND reachedInterview.
 */

function enrichedFromStatuses(statuses) {
  return statuses.map((status, i) => ({
    num: i + 1, status, normalizedStatus: normalizeStatus(status),
    outcome: classifyOutcome(status), score: 'W7.5 E7.5', priority: 7.5, want: 7.5, ease: 7.5, verdict: 'solid', report: null,
    remoteBucket: 'unknown', companySize: 'unknown', date: '2026-06-01', notes: '',
  }));
}

test('computeFunnel: cumulative reached-counts respect furthest-stage', () => {
  // 5 applied, 3 responded, 2 interview, 1 offer, 2 rejected
  const enriched = enrichedFromStatuses([
    'Applied', 'Applied', 'Applied', 'Applied', 'Applied',
    'Responded', 'Responded', 'Responded',
    'Interview', 'Interview',
    'Offer',
    'Rejected', 'Rejected',
  ]);
  const f = computeFunnel(enriched);
  // reachedApplied = applied(5)+responded(3)+interview(2)+offer(1)+rejected(2) = 13
  assert.equal(f.reached.applied, 13);
  // reachedResponded = responded(3)+interview(2)+offer(1) = 6
  assert.equal(f.reached.responded, 6);
  // reachedInterview = interview(2)+offer(1) = 3
  assert.equal(f.reached.interview, 3);
  assert.equal(f.reached.offer, 1);
  // rates
  assert.equal(f.responseRate, Math.round((6 / 13) * 100)); // 46
  assert.equal(f.interviewRate, Math.round((3 / 6) * 100));  // 50
  assert.equal(f.offerRate, Math.round((1 / 3) * 100));      // 33
});

test('computeFunnel: stages array carries reached + per-gate rate', () => {
  const f = computeFunnel(enrichedFromStatuses(['Applied', 'Applied', 'Responded', 'Offer']));
  const byStage = Object.fromEntries(f.stages.map(s => [s.stage, s]));
  assert.equal(byStage.applied.rate, null);          // first gate has no prior
  assert.equal(byStage.applied.reached, 4);
  assert.equal(byStage.responded.reached, 2);        // responded(1)+offer(1)
  assert.equal(byStage.interview.reached, 1);        // offer(1)
  assert.equal(byStage.offer.reached, 1);
});

test('computeFunnel: no applications → null rates, zero reached', () => {
  const f = computeFunnel(enrichedFromStatuses(['Evaluated', 'SKIP']));
  assert.equal(f.reached.applied, 0);
  assert.equal(f.responseRate, null);
  assert.equal(f.interviewRate, null);
  assert.equal(f.offerRate, null);
});

/* ───── diagnoseFunnel ───────────────────────────────────────────────────────*/

test('diagnoseFunnel: picks the weakest meaningful gate', () => {
  // Strong response (8/10=80%), weak interview (1/8=12%): interview is the leak.
  const enriched = enrichedFromStatuses([
    ...Array(2).fill('Applied'),       // applied-but-no-response, terminal-ish via reached
    ...Array(7).fill('Responded'),     // responded, stalled
    'Interview',                       // one got through
  ]);
  const f = computeFunnel(enriched);
  const d = diagnoseFunnel(f, { minBase: 3 });
  assert.equal(d.hasDiagnosis, true);
  assert.equal(d.bottleneck, 'interview');
  assert.match(d.headline, /interview/i);
  assert.ok(d.lever.length > 0);
});

test('diagnoseFunnel: gates below min-base are ignored', () => {
  // Only 2 applications total — below the default minBase of 3 → no diagnosis.
  const f = computeFunnel(enrichedFromStatuses(['Applied', 'Rejected']));
  const d = diagnoseFunnel(f, { minBase: 3 });
  assert.equal(d.hasDiagnosis, false);
  assert.match(d.reason, /not enough/i);
});

test('diagnoseFunnel: ties break toward the earlier (upstream) gate', () => {
  // Construct equal 50% response and 50% interview rates; response gate wins.
  // applied base 4, responded 2 (50%); responded base 2, interview 1 (50%).
  const enriched = enrichedFromStatuses([
    'Applied', 'Applied',   // applied, no response
    'Responded',            // responded, stalled
    'Interview',            // responded→interview
  ]);
  const f = computeFunnel(enriched);
  // reachedApplied = 4, reachedResponded = 2 → 50%; reachedInterview = 1 → 50%
  const d = diagnoseFunnel(f, { minBase: 2 });
  assert.equal(d.hasDiagnosis, true);
  assert.equal(d.bottleneck, 'response');
});

test('diagnoseFunnel: impact is high when the weakest rate is very low', () => {
  const enriched = enrichedFromStatuses([
    ...Array(10).fill('Applied'),
    'Responded', // 1/11 response ≈ 9%
  ]);
  const f = computeFunnel(enriched);
  const d = diagnoseFunnel(f, { minBase: 3 });
  assert.equal(d.bottleneck, 'response');
  assert.equal(d.impact, 'high');
});

/* ───── enrichEntries ────────────────────────────────────────────────────────*/

test('enrichEntries: resolves report link via injected loader + notes fallback', () => {
  const entries = [
    { num: 1, date: '2026-06-01', company: 'Northwind Analytics', role: 'Analyst', score: 'W8.4 E7.2',
      status: 'Applied', pdf: '✅', report: '[1](reports/tier-2/northwind.md)', notes: 'US only' },
    { num: 2, date: '2026-06-02', company: 'Contoso Retail', role: 'Strat', score: '8/10',
      status: 'Interview', pdf: '✅', report: 'n/a', notes: '' },
  ];
  const loadReport = (rel) => rel === 'reports/tier-2/northwind.md'
    ? { archetype: 'Data Analyst', remote: null, teamSize: '40 people', gaps: [] }
    : null;
  const enriched = enrichEntries(entries, loadReport);
  assert.equal(enriched[0].report.archetype, 'Data Analyst');
  assert.equal(enriched[0].outcome, 'positive');
  // remote fell back to notes ("US only") → geo-restricted
  assert.equal(enriched[0].remoteBucket, 'geo-restricted');
  assert.equal(enriched[0].companySize, 'startup'); // 40 people
  // entry 2 has no parseable report link → null report
  assert.equal(enriched[1].report, null);
  assert.equal(enriched[1].normalizedStatus, 'interview');
  // score info: raw cell kept; v2 → W/E/verdict/priority; legacy → label + legacyScore only
  assert.equal(enriched[0].score, 'W8.4 E7.2');
  assert.equal(enriched[0].scoreLabel, 'W8.4 · E7.2');
  assert.equal(enriched[0].verdict, 'go');
  assert.equal(enriched[0].priority, 7.78);
  assert.equal(enriched[1].scoreLabel, '8/10');
  assert.equal(enriched[1].priority, null); // a v1 Overall is not on Priority's scale
  assert.equal(enriched[1].legacyScore, 8);
  assert.equal(enriched[1].verdict, null);
});

/* ───── scoreInfo / scoreStats ───────────────────────────────────────────────*/

test('scoreInfo: v2 cell → Want/Ease/Priority + grid verdict (eligibility green)', () => {
  assert.deepEqual(scoreInfo('W8.3 E5.6'), {
    scoreLabel: 'W8.3 · E5.6', priority: 6.82, want: 8.3, ease: 5.6, legacyScore: null, verdict: 'stretch',
  });
  assert.equal(scoreInfo('W7.0 E7.5').verdict, 'solid');
  assert.equal(scoreInfo('W6.0 E9.0').verdict, 'skip');
});

test('scoreInfo: legacy cell has no Priority (v1 Overall is off-scale), no verdict without a v2 report', () => {
  assert.deepEqual(scoreInfo('7.4/10'), {
    scoreLabel: '7.4/10', priority: null, want: null, ease: null, legacyScore: 7.4, verdict: null,
  });
  // A v2 report header fills Want/Ease (and so the verdict) for a legacy cell.
  const fromReport = scoreInfo('7.4/10', { scores: { want: 8.2, ease: 7.1 } });
  assert.equal(fromReport.verdict, 'go');
  assert.equal(fromReport.priority, 7.63); // √(8.2 × 7.1) from the v2 report, never the v1 number
  // A stated verdict alone is used when the report has no Want/Ease.
  assert.equal(scoreInfo('7.4/10', { scores: {}, verdict: 'thin' }).verdict, 'thin');
});

test('scoreInfo: unparseable / empty cells are missing, never 0', () => {
  for (const c of ['', 'N/A', '—', null, undefined]) {
    const i = scoreInfo(c);
    assert.equal(i.priority, null);
    assert.equal(i.verdict, null);
    assert.equal(i.scoreLabel, null);
  }
});

test('scoreStats: Priority / Want / Ease averages, verdict tally, actionableRate', () => {
  const rows = ['W8.4 E7.2', 'W8.2 E5.5', 'W7.0 E5.5', '7.0/10', 'N/A'].map(c => scoreInfo(c));
  const st = scoreStats(rows);
  assert.equal(st.count, 3);                // legacy + N/A have no Priority
  assert.deepEqual(st.excluded, { legacy: 1, unscored: 1 });
  assert.equal(st.maxPriority, scoreInfo('W8.4 E7.2').priority);
  assert.equal(st.wantEaseCount, 3);        // legacy has no W/E
  assert.equal(st.avgWant, round2((8.4 + 8.2 + 7.0) / 3));
  assert.equal(st.verdicts.go, 1);
  assert.equal(st.verdicts.stretch, 1);
  assert.equal(st.verdicts.thin, 1);
  assert.equal(st.actionableRate, 67);      // 2 of 3 known verdicts
  const empty = scoreStats([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.avgPriority, null);
  assert.equal(empty.actionableRate, null);
});

function round2(n) { return Math.round(n * 100) / 100; }

/* ───── computeVerdictFloor ──────────────────────────────────────────────────*/

test('computeVerdictFloor: worst verdict among progressed rows + rows below it', () => {
  const rows = [
    { normalizedStatus: 'interview', verdict: 'go' },
    { normalizedStatus: 'responded', verdict: 'solid' },
    { normalizedStatus: 'offer', verdict: 'stretch' },
    { normalizedStatus: 'rejected', verdict: 'thin' },
    { normalizedStatus: 'applied', verdict: 'skip' },
    { normalizedStatus: 'applied', verdict: 'go' },
    { normalizedStatus: 'responded', verdict: null }, // legacy, no verdict → ignored
  ];
  const f = computeVerdictFloor(rows);
  assert.equal(f.lowest, 'solid');
  assert.equal(f.lowestLabel, 'Solid');
  assert.equal(f.progressedCount, 3);
  assert.equal(f.belowFloor, 2); // thin + skip
  assert.match(f.reasoning, /Solid or better/);
});

test('computeVerdictFloor: no progressed verdicts → null floor', () => {
  const f = computeVerdictFloor([{ normalizedStatus: 'applied', verdict: 'go' }]);
  assert.equal(f.lowest, null);
  assert.equal(f.progressedCount, 0);
});

/* ───── analyzeOutcomes ──────────────────────────────────────────────────────*/

test('analyzeOutcomes: empty → error', () => {
  const r = analyzeOutcomes([]);
  assert.match(r.error, /No applications/);
});

test('analyzeOutcomes: under threshold → guidance error', () => {
  const enriched = enrichEntries(
    parseTracker(`| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
| 1 | 2026-06-01 | A | R | W7 E7 | Applied | ✅ | n/a | x |
| 2 | 2026-06-02 | B | R | 7/10 | Applied | ✅ | n/a | x |`),
    null
  );
  const r = analyzeOutcomes(enriched, { minThreshold: 5 });
  assert.match(r.error, /Not enough data/);
  assert.equal(r.current, 2);
  assert.equal(r.threshold, 5);
});

test('analyzeOutcomes: full assembly surfaces the conversion funnel + funnel-led rec', () => {
  // 6 applications: a clear response-stage leak (most never respond).
  const tracker = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
| 1 | 2026-06-01 | A | Analyst | W8.4 E7.2 | Applied | ✅ | n/a | remote EU |
| 2 | 2026-06-02 | B | Analyst | W8.1 E5.5 | Applied | ✅ | n/a | remote EU |
| 3 | 2026-06-03 | C | Analyst | W7.0 E5.5 | Rejected | ✅ | n/a | remote EU |
| 4 | 2026-06-04 | D | Analyst | 7.8/10 | Rejected | ✅ | n/a | remote EU |
| 5 | 2026-06-05 | E | Analyst | W8.6 E7.4 | Responded | ✅ | n/a | remote EU |
| 6 | 2026-06-06 | F | Analyst | W7.2 E8.0 | Interview | ✅ | n/a | remote EU |`;
  const enriched = enrichEntries(parseTracker(tracker), null);
  const r = analyzeOutcomes(enriched, { minThreshold: 5 });
  assert.equal(r.error, undefined);
  assert.equal(r.metadata.total, 6);
  // conversion funnel present and consistent
  assert.equal(r.conversionFunnel.reached.applied, 6);   // all 6 left "evaluated"
  assert.equal(r.conversionFunnel.reached.responded, 2); // responded(1)+interview(1)
  assert.equal(r.conversionFunnel.reached.interview, 1);
  assert.ok(r.funnelDiagnosis.hasDiagnosis);
  assert.equal(r.funnelDiagnosis.bottleneck, 'response'); // 2/6 = 33% is the weakest gate
  // the funnel diagnosis leads the recommendations
  assert.ok(r.recommendations.length >= 1);
  assert.equal(r.recommendations[0].action, r.funnelDiagnosis.headline);
  // v2 score aggregates: 5 rows with a verdict (go, stretch, thin, go, solid); legacy row has none
  assert.deepEqual(
    { go: r.verdictMix.go, stretch: r.verdictMix.stretch, solid: r.verdictMix.solid, thin: r.verdictMix.thin },
    { go: 2, stretch: 1, solid: 1, thin: 1 },
  );
  assert.equal(r.actionableRate, 80); // 4 of 5
  assert.equal(r.scoreComparison.positive.count, 4);
  assert.equal(r.scoreComparison.negative.count, 1);           // the legacy 7.8 is excluded…
  assert.equal(r.scoreComparison.negative.excluded.legacy, 1);  // …and counted
  assert.equal(r.scoreComparison.negative.wantEaseCount, 1);
  assert.equal(r.scoreComparison.negative.actionableRate, 0);  // the one known verdict is thin
  assert.equal(r.archetypeBreakdown[0].actionableRate, 80);
  assert.equal(r.verdictFloor.lowest, 'solid');               // progressed: go (E), solid (F)
  assert.equal(r.verdictFloor.progressedCount, 2);
  // v1 fields are gone
  assert.equal(r.scoreThreshold, undefined);
  assert.equal(r.scoreComparison.positive.avg, undefined);
});

test('analyzeOutcomes: verdict-floor and skip-application recommendations', () => {
  const tracker = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
| 1 | 2026-06-01 | A | Analyst | W8.4 E7.2 | Interview | ✅ | n/a | x |
| 2 | 2026-06-02 | B | Analyst | W8.1 E7.5 | Responded | ✅ | n/a | x |
| 3 | 2026-06-03 | C | Analyst | W7.4 E7.6 | Offer | ✅ | n/a | x |
| 4 | 2026-06-04 | D | Analyst | W6.0 E8.0 | Rejected | ✅ | n/a | x |
| 5 | 2026-06-05 | E | Analyst | W5.5 E6.0 | Applied | ✅ | n/a | x |
| 6 | 2026-06-06 | F | Analyst | W7.0 E5.5 | Applied | ✅ | n/a | x |`;
  const r = analyzeOutcomes(enrichEntries(parseTracker(tracker), null), { minThreshold: 5 });
  assert.equal(r.verdictFloor.lowest, 'solid');
  assert.equal(r.verdictFloor.belowFloor, 3); // skip, skip, thin
  assert.equal(r.skipApplications, 2);
  const actions = r.recommendations.map(x => x.action).join('\n');
  assert.match(actions, /verdict Solid or better/);
  assert.match(actions, /Stop applying to Skip-verdict roles -- 2 applications/);
  assert.doesNotMatch(actions, /\/5|\/10/);
});
