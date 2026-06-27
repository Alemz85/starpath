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
//   enrichEntries          — report resolver injection, notes fallback
//   analyzeOutcomes        — threshold gate, full assembly, funnel-led recs

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

const SAMPLE_TRACKER = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | Data Analyst | 7.5/10 | Applied | ✅ | [1](reports/tier-2/acme.md) | remote EU |
| 2 | 2026-06-02 | Globex | Strategy | 8.0/10 | Interview | ✅ | [2](reports/tier-2/globex.md) | hybrid |
not a table row
| x | bad | row | skipped | - | - | - | - | - |`;

test('parseTracker: maps columns and skips header/separator/non-numeric rows', () => {
  const rows = parseTracker(SAMPLE_TRACKER);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { num: rows[0].num, company: rows[0].company, role: rows[0].role, status: rows[0].status, score: rows[0].score },
    { num: 1, company: 'Acme', role: 'Data Analyst', status: 'Applied', score: '7.5/10' }
  );
  assert.equal(rows[0].notes, 'remote EU');
  assert.equal(rows[1].company, 'Globex');
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
    outcome: classifyOutcome(status), score: 7, report: null,
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
    { num: 1, date: '2026-06-01', company: 'Acme', role: 'Analyst', score: '7.5/10',
      status: 'Applied', pdf: '✅', report: '[1](reports/tier-2/acme.md)', notes: 'US only' },
    { num: 2, date: '2026-06-02', company: 'Globex', role: 'Strat', score: '8/10',
      status: 'Interview', pdf: '✅', report: 'n/a', notes: '' },
  ];
  const loadReport = (rel) => rel === 'reports/tier-2/acme.md'
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
});

/* ───── analyzeOutcomes ──────────────────────────────────────────────────────*/

test('analyzeOutcomes: empty → error', () => {
  const r = analyzeOutcomes([]);
  assert.match(r.error, /No applications/);
});

test('analyzeOutcomes: under threshold → guidance error', () => {
  const enriched = enrichEntries(
    parseTracker(`| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
| 1 | 2026-06-01 | A | R | 7/10 | Applied | ✅ | n/a | x |
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
| 1 | 2026-06-01 | A | Analyst | 7.5/10 | Applied | ✅ | n/a | remote EU |
| 2 | 2026-06-02 | B | Analyst | 7.6/10 | Applied | ✅ | n/a | remote EU |
| 3 | 2026-06-03 | C | Analyst | 7.7/10 | Rejected | ✅ | n/a | remote EU |
| 4 | 2026-06-04 | D | Analyst | 7.8/10 | Rejected | ✅ | n/a | remote EU |
| 5 | 2026-06-05 | E | Analyst | 8.0/10 | Responded | ✅ | n/a | remote EU |
| 6 | 2026-06-06 | F | Analyst | 8.2/10 | Interview | ✅ | n/a | remote EU |`;
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
});
