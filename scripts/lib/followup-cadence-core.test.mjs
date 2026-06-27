// Unit tests for scripts/lib/followup-cadence-core.mjs
//
// Plain node:test + node:assert, zero external deps.
// Run: node --test scripts/lib/followup-cadence-core.test.mjs
//       (or `npm test` which runs `node --test "scripts/**/*.test.mjs"`)
//
// Coverage:
//   normalizeStatus     — bold/Spanish/trailing-date variants → canonical state
//   isIsoDate           — accept/reject
//   daysBetween/addDays — positive, negative, invalid, month/year rollover
//   buildCadence        — override applied_first only on positive int
//   parseApplications   — reuses parseAppRow; 9- and 10-col rows; skips junk
//   parseFollowups      — appNum grouping fields; skips header/short rows
//   extractContacts     — email + best-effort name
//   resolveReportPath   — gated on the exists predicate
//   computeUrgency      — every band for applied/responded/interview
//   computeNextFollowupDate — date arithmetic per status, cold → null
//   analyze             — actionable filter, date threading, sort, metadata,
//                         overdueOnly filter, error path, daysUntilNext tiebreak
//   renderSummary       — error, empty, populated dashboard

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CADENCE,
  buildCadence,
  normalizeStatus,
  ACTIONABLE_STATUSES,
  isIsoDate,
  daysBetween,
  addDays,
  parseApplications,
  parseFollowups,
  extractContacts,
  resolveReportPath,
  computeUrgency,
  computeNextFollowupDate,
  analyze,
  renderSummary,
} from './followup-cadence-core.mjs';

/* ───── normalizeStatus ──────────────────────────────────────────────────────*/

test('normalizeStatus: strips bold and lowercases', () => {
  assert.equal(normalizeStatus('**Applied**'), 'applied');
});

test('normalizeStatus: Spanish aliases map to canonical', () => {
  assert.equal(normalizeStatus('Aplicado'), 'applied');
  assert.equal(normalizeStatus('respondido'), 'responded');
  assert.equal(normalizeStatus('Entrevista'), 'interview');
  assert.equal(normalizeStatus('rechazada'), 'rejected');
  assert.equal(normalizeStatus('descartado'), 'discarded');
});

test('normalizeStatus: strips a trailing date', () => {
  assert.equal(normalizeStatus('Applied 2026-05-01 via email'), 'applied');
});

test('normalizeStatus: passes through an already-canonical value', () => {
  assert.equal(normalizeStatus('interview'), 'interview');
});

test('normalizeStatus: empty / nullish → empty string', () => {
  assert.equal(normalizeStatus(''), '');
  assert.equal(normalizeStatus(null), '');
  assert.equal(normalizeStatus(undefined), '');
});

test('ACTIONABLE_STATUSES is exactly the three live states', () => {
  assert.deepEqual([...ACTIONABLE_STATUSES].sort(), ['applied', 'interview', 'responded']);
});

/* ───── date helpers ─────────────────────────────────────────────────────────*/

test('isIsoDate: accepts YYYY-MM-DD, rejects everything else', () => {
  assert.equal(isIsoDate('2026-06-27'), true);
  assert.equal(isIsoDate('2026-6-7'), false);
  assert.equal(isIsoDate('Rolling'), false);
  assert.equal(isIsoDate(''), false);
  assert.equal(isIsoDate(null), false);
});

test('daysBetween: forward, backward, same-day, rollover', () => {
  assert.equal(daysBetween('2026-06-20', '2026-06-27'), 7);
  assert.equal(daysBetween('2026-06-27', '2026-06-20'), -7);
  assert.equal(daysBetween('2026-06-27', '2026-06-27'), 0);
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1); // month rollover
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1); // year rollover
});

test('daysBetween: invalid input → null', () => {
  assert.equal(daysBetween('nope', '2026-06-27'), null);
  assert.equal(daysBetween('2026-06-27', null), null);
});

test('addDays: positive/negative/rollover', () => {
  assert.equal(addDays('2026-06-27', 7), '2026-07-04');
  assert.equal(addDays('2026-06-27', -7), '2026-06-20');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
});

test('addDays: invalid input → null', () => {
  assert.equal(addDays('Rolling', 7), null);
});

/* ───── buildCadence ─────────────────────────────────────────────────────────*/

test('buildCadence: no arg → default applied_first', () => {
  assert.equal(buildCadence(null).applied_first, DEFAULT_CADENCE.applied_first);
  assert.equal(buildCadence(undefined).applied_first, 7);
});

test('buildCadence: positive int overrides applied_first only', () => {
  const c = buildCadence('10');
  assert.equal(c.applied_first, 10);
  assert.equal(c.applied_subsequent, DEFAULT_CADENCE.applied_subsequent);
  assert.equal(c.applied_max_followups, DEFAULT_CADENCE.applied_max_followups);
});

test('buildCadence: zero / negative / garbage → default', () => {
  assert.equal(buildCadence('0').applied_first, 7);
  assert.equal(buildCadence('-3').applied_first, 7);
  assert.equal(buildCadence('abc').applied_first, 7);
});

/* ───── parseApplications ────────────────────────────────────────────────────*/

const APPS_9COL = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-05-05 | Acme | Strategy Analyst | 7.2/10 | Applied | ❌ | [#1](reports/tier-2/Acme.md) | Emailed jane@acme.com at HR |
| 2 | 2026-06-01 | Globex | Data Analyst | 8.1/10 | Evaluated | ❌ | n/d |  |
`;

const APPS_10COL = `| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
|---|------|---------|------|-------|--------|-----|----------|--------|-------|
| 5 | 2026-06-10 | Initech | Ops Analyst | 7.5/10 | Responded | ❌ | 2026-07-30 | [#5](reports/tier-2/Initech.md) | bob@initech.com |
`;

test('parseApplications: parses a 9-column tracker', () => {
  const rows = parseApplications(APPS_9COL);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].num, 1);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].status, 'Applied');
  assert.equal(rows[0].report, '[#1](reports/tier-2/Acme.md)');
});

test('parseApplications: parses a 10-column (deadline) tracker — report cell not misaligned', () => {
  const rows = parseApplications(APPS_10COL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].num, 5);
  assert.equal(rows[0].status, 'Responded');
  // The improvement: report resolves to the actual link cell, not the deadline.
  assert.equal(rows[0].report, '[#5](reports/tier-2/Initech.md)');
  assert.equal(rows[0].notes, 'bob@initech.com');
});

test('parseApplications: skips header/separator/blank', () => {
  const rows = parseApplications(APPS_9COL);
  assert.ok(rows.every((r) => Number.isInteger(r.num)));
});

test('parseApplications: empty content → []', () => {
  assert.deepEqual(parseApplications(''), []);
});

/* ───── parseFollowups ───────────────────────────────────────────────────────*/

const FOLLOWUPS = `# Follow-ups

| # | App# | Date | Company | Role | Channel | Contact | Notes |
|---|------|------|---------|------|---------|---------|-------|
| 1 | 1 | 2026-05-12 | Acme | Strategy Analyst | email | jane@acme.com | first nudge |
| 2 | 1 | 2026-05-20 | Acme | Strategy Analyst | email | jane@acme.com | second nudge |
`;

test('parseFollowups: parses rows and appNum', () => {
  const fus = parseFollowups(FOLLOWUPS);
  assert.equal(fus.length, 2);
  assert.equal(fus[0].appNum, 1);
  assert.equal(fus[1].date, '2026-05-20');
});

test('parseFollowups: empty / short rows → []', () => {
  assert.deepEqual(parseFollowups(''), []);
  assert.deepEqual(parseFollowups('| a | b |'), []);
});

/* ───── extractContacts ──────────────────────────────────────────────────────*/

test('extractContacts: pulls email out of notes', () => {
  const c = extractContacts('Emailed Jane at jane@acme.com');
  assert.equal(c.length, 1);
  assert.equal(c[0].email, 'jane@acme.com');
});

test('extractContacts: none → []', () => {
  assert.deepEqual(extractContacts('no contact here'), []);
  assert.deepEqual(extractContacts(''), []);
});

/* ───── resolveReportPath ────────────────────────────────────────────────────*/

test('resolveReportPath: returns rel path when predicate true', () => {
  const rel = resolveReportPath('[#1](reports/tier-2/Acme.md)', () => true);
  assert.equal(rel, 'reports/tier-2/Acme.md');
});

test('resolveReportPath: null when predicate false or no link', () => {
  assert.equal(resolveReportPath('[#1](reports/tier-2/Acme.md)', () => false), null);
  assert.equal(resolveReportPath('n/d', () => true), null);
});

/* ───── computeUrgency ───────────────────────────────────────────────────────*/

test('computeUrgency applied: 0 sent past first window → overdue', () => {
  assert.equal(computeUrgency('applied', 8, null, 0), 'overdue');
});

test('computeUrgency applied: 0 sent inside window → waiting', () => {
  assert.equal(computeUrgency('applied', 3, null, 0), 'waiting');
});

test('computeUrgency applied: max follow-ups reached → cold', () => {
  assert.equal(computeUrgency('applied', 40, 10, 2), 'cold');
});

test('computeUrgency applied: 1 sent past subsequent window → overdue', () => {
  assert.equal(computeUrgency('applied', 20, 8, 1), 'overdue');
  assert.equal(computeUrgency('applied', 20, 3, 1), 'waiting');
});

test('computeUrgency responded: same day → urgent, stale → overdue', () => {
  assert.equal(computeUrgency('responded', 0, null, 0), 'urgent');
  assert.equal(computeUrgency('responded', 2, null, 0), 'waiting');
  assert.equal(computeUrgency('responded', 5, null, 0), 'overdue');
});

test('computeUrgency interview: thank-you window passed → overdue', () => {
  assert.equal(computeUrgency('interview', 0, null, 0), 'waiting');
  assert.equal(computeUrgency('interview', 2, null, 0), 'overdue');
});

test('computeUrgency: respects a custom cadence', () => {
  const c = buildCadence('10');
  assert.equal(computeUrgency('applied', 8, null, 0, c), 'waiting'); // < 10
  assert.equal(computeUrgency('applied', 10, null, 0, c), 'overdue');
});

/* ───── computeNextFollowupDate ──────────────────────────────────────────────*/

test('computeNextFollowupDate applied: first nudge = appDate + applied_first', () => {
  assert.equal(computeNextFollowupDate('applied', '2026-06-01', null, 0), '2026-06-08');
});

test('computeNextFollowupDate applied: later nudge = lastFollowup + subsequent', () => {
  assert.equal(computeNextFollowupDate('applied', '2026-06-01', '2026-06-08', 1), '2026-06-15');
});

test('computeNextFollowupDate applied: cold → null', () => {
  assert.equal(computeNextFollowupDate('applied', '2026-06-01', '2026-06-20', 2), null);
});

test('computeNextFollowupDate responded / interview', () => {
  assert.equal(computeNextFollowupDate('responded', '2026-06-01', null, 0), '2026-06-04');
  assert.equal(computeNextFollowupDate('interview', '2026-06-01', null, 0), '2026-06-02');
});

/* ───── analyze (end-to-end, pure) ───────────────────────────────────────────*/

const TODAY = '2026-06-27';

test('analyze: no applications → error', () => {
  const r = analyze({ appsContent: '', todayIso: TODAY });
  assert.equal(r.error, 'No applications found in tracker.');
});

test('analyze: only actionable statuses are tracked; date threaded deterministically', () => {
  const r = analyze({ appsContent: APPS_9COL, todayIso: TODAY });
  // Acme is Applied (actionable); Globex is Evaluated (not actionable).
  assert.equal(r.metadata.totalTracked, 2);
  assert.equal(r.metadata.actionable, 1);
  const acme = r.entries.find((e) => e.company === 'Acme');
  assert.ok(acme);
  assert.equal(acme.daysSinceApplication, daysBetween('2026-05-05', TODAY));
  // 0 follow-ups, way past the 7-day first window → overdue.
  assert.equal(acme.urgency, 'overdue');
  assert.equal(acme.nextFollowupDate, '2026-05-12');
  assert.ok(acme.daysUntilNext < 0); // already past
});

test('analyze: --today override changes the verdict (backdating)', () => {
  // Backdate to inside the first-nudge window → waiting instead of overdue.
  const r = analyze({ appsContent: APPS_9COL, todayIso: '2026-05-07' });
  const acme = r.entries.find((e) => e.company === 'Acme');
  assert.equal(acme.urgency, 'waiting');
});

test('analyze: follow-up count + last follow-up wire through', () => {
  const r = analyze({
    appsContent: APPS_9COL,
    followupsContent: FOLLOWUPS,
    todayIso: TODAY,
  });
  const acme = r.entries.find((e) => e.company === 'Acme');
  assert.equal(acme.followupCount, 2);
  // 2 follow-ups = applied_max_followups → cold.
  assert.equal(acme.urgency, 'cold');
  assert.equal(acme.nextFollowupDate, null);
});

test('analyze: overdueOnly filters to overdue+urgent', () => {
  const apps = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-05-05 | Acme | Strategy Analyst | 7.2/10 | Applied | ❌ | n/d |  |
| 2 | 2026-06-27 | Globex | Data Analyst | 8.1/10 | Applied | ❌ | n/d |  |
`;
  const full = analyze({ appsContent: apps, todayIso: TODAY });
  assert.equal(full.entries.length, 2); // one overdue (Acme), one waiting (Globex, day 0)
  const only = analyze({ appsContent: apps, todayIso: TODAY, overdueOnly: true });
  assert.equal(only.entries.length, 1);
  assert.equal(only.entries[0].company, 'Acme');
});

test('analyze: sorts urgent before overdue before waiting; more-overdue first within band', () => {
  const apps = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-05-05 | Older | R | 7/10 | Applied | ❌ | n/d |  |
| 2 | 2026-06-10 | Newer | R | 7/10 | Applied | ❌ | n/d |  |
| 3 | 2026-06-27 | Live | R | 7/10 | Responded | ❌ | n/d |  |
`;
  const r = analyze({ appsContent: apps, todayIso: TODAY });
  // Responded same-day = urgent → first. Then the two overdue applieds, with the
  // more-overdue (Older, next-date further in the past → smaller daysUntilNext) first.
  assert.equal(r.entries[0].company, 'Live');
  assert.equal(r.entries[0].urgency, 'urgent');
  assert.equal(r.entries[1].company, 'Older');
  assert.equal(r.entries[2].company, 'Newer');
  assert.ok(r.entries[1].daysUntilNext <= r.entries[2].daysUntilNext);
});

test('analyze: report path resolution honors the predicate', () => {
  const r = analyze({
    appsContent: APPS_9COL,
    todayIso: TODAY,
    reportExists: (rel) => rel === 'reports/tier-2/Acme.md',
  });
  const acme = r.entries.find((e) => e.company === 'Acme');
  assert.equal(acme.reportPath, 'reports/tier-2/Acme.md');
});

test('analyze: skips an actionable row with an unparseable date', () => {
  const apps = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | n/d | Acme | R | 7/10 | Applied | ❌ | n/d |  |
`;
  const r = analyze({ appsContent: apps, todayIso: TODAY });
  assert.equal(r.metadata.totalTracked, 1);
  assert.equal(r.metadata.actionable, 0);
});

/* ───── renderSummary ────────────────────────────────────────────────────────*/

test('renderSummary: error path', () => {
  const out = renderSummary({ error: 'No applications found in tracker.' });
  assert.match(out, /No applications found/);
});

test('renderSummary: populated dashboard shows the scoreboard and a row', () => {
  const r = analyze({ appsContent: APPS_9COL, todayIso: TODAY });
  const out = renderSummary(r);
  assert.match(out, /Follow-up Cadence Dashboard — 2026-06-27/);
  assert.match(out, /overdue/);
  assert.match(out, /Acme/);
});

test('renderSummary: no actionable entries → guidance line', () => {
  const r = analyze({ appsContent: APPS_10COL.replace('Responded', 'Evaluated'), todayIso: TODAY });
  const out = renderSummary(r);
  assert.match(out, /No active applications to track/);
});
