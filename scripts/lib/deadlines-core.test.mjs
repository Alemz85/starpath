// Unit tests for scripts/lib/deadlines-core.mjs
//
// Plain node:test + node:assert, zero external deps.
// Run: node --test scripts/lib/deadlines-core.test.mjs
//       (or `npm test` which runs `node --test "scripts/**/*.test.mjs"`)
//
// Coverage:
//   parseDeadline        — every input category: ISO, year-month, month names,
//                          quarter notation, Rolling variants, n/d, blank
//   daysFromToday        — positive, negative, same-day cases
//   assignBucket         — boundary values for all six buckets
//   parseApplicationsDeadlines  — skips terminal statuses; parses deadline cells
//   parseScoutingDeadlines      — T1/T2 only; skips T3/T4
//   countMissing*               — counts n/d rows only
//   classifyDeadlines            — sorting within buckets; unknown accounting
//   renderDeadlines              — urgent headline; empty buckets skipped;
//                                  no-deadline footer section
//   buildDeadlinesMarkdown       — end-to-end smoke test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeadline,
  daysFromToday,
  assignBucket,
  parseApplicationsDeadlines,
  parseScoutingDeadlines,
  countMissingApplicationsDeadlines,
  countMissingScoutingDeadlines,
  classifyDeadlines,
  renderDeadlines,
  buildDeadlinesMarkdown,
} from './deadlines-core.mjs';

/* ───── parseDeadline ────────────────────────────────────────────────────────*/

test('parseDeadline: exact ISO date', () => {
  const result = parseDeadline('2026-06-30');
  assert.deepEqual(result, { kind: 'date', iso: '2026-06-30' });
});

test('parseDeadline: year-month YYYY-MM → end of month', () => {
  const result = parseDeadline('2026-06');
  assert.equal(result.kind, 'date');
  assert.equal(result.iso, '2026-06-30');
});

test('parseDeadline: year-month Feb is detected correctly', () => {
  const result = parseDeadline('2024-02');
  assert.equal(result.kind, 'date');
  assert.equal(result.iso, '2024-02-29'); // 2024 is a leap year
});

test('parseDeadline: Rolling (case-insensitive)', () => {
  assert.deepEqual(parseDeadline('Rolling'), { kind: 'rolling' });
  assert.deepEqual(parseDeadline('rolling'), { kind: 'rolling' });
  assert.deepEqual(parseDeadline('ROLLING'), { kind: 'rolling' });
});

test('parseDeadline: "open until filled"', () => {
  assert.deepEqual(parseDeadline('open until filled'), { kind: 'rolling' });
});

test('parseDeadline: "ongoing"', () => {
  assert.deepEqual(parseDeadline('ongoing'), { kind: 'rolling' });
});

test('parseDeadline: n/d → unknown', () => {
  assert.equal(parseDeadline('n/d').kind, 'unknown');
});

test('parseDeadline: empty string → unknown', () => {
  assert.equal(parseDeadline('').kind, 'unknown');
});

test('parseDeadline: blank / dash → unknown', () => {
  assert.equal(parseDeadline('-').kind, 'unknown');
  assert.equal(parseDeadline('—').kind, 'unknown');
});

test('parseDeadline: "End of June 2026"', () => {
  const r = parseDeadline('End of June 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-06-30');
});

test('parseDeadline: "end of may 2026" (lowercase)', () => {
  const r = parseDeadline('end of may 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-05-31');
});

test('parseDeadline: "End of June" without year -> unknown (cannot safely resolve)', () => {
  const r = parseDeadline('End of June');
  assert.equal(r.kind, 'unknown');
});

test('parseDeadline: "Q2 2026"', () => {
  const r = parseDeadline('Q2 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-06-30');
});

test('parseDeadline: "end of Q3 2026"', () => {
  const r = parseDeadline('end of Q3 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-09-30');
});

test('parseDeadline: "Q4 2026" → Dec 31', () => {
  const r = parseDeadline('Q4 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-12-31');
});

test('parseDeadline: "Q2" without year → unknown', () => {
  assert.equal(parseDeadline('Q2').kind, 'unknown');
});

test('parseDeadline: "June 2026" (plain month + year)', () => {
  const r = parseDeadline('June 2026');
  assert.equal(r.kind, 'date');
  assert.equal(r.iso, '2026-06-30');
});

test('parseDeadline: "6mo" (promo hint) → unknown', () => {
  assert.equal(parseDeadline('6mo').kind, 'unknown');
});

/* ───── daysFromToday ────────────────────────────────────────────────────────*/

test('daysFromToday: same day = 0', () => {
  assert.equal(daysFromToday('2026-06-25', '2026-06-25'), 0);
});

test('daysFromToday: 5 days into the future', () => {
  assert.equal(daysFromToday('2026-06-30', '2026-06-25'), 5);
});

test('daysFromToday: 3 days in the past', () => {
  assert.equal(daysFromToday('2026-06-22', '2026-06-25'), -3);
});

test('daysFromToday: crosses month boundary', () => {
  assert.equal(daysFromToday('2026-07-01', '2026-06-25'), 6);
});

test('daysFromToday: crosses year boundary', () => {
  assert.equal(daysFromToday('2027-01-01', '2026-12-31'), 1);
});

/* ───── assignBucket ─────────────────────────────────────────────────────────*/

test('assignBucket: 0 days → urgent', () => assert.equal(assignBucket(0), 'urgent'));
test('assignBucket: 7 days → urgent (boundary)', () => assert.equal(assignBucket(7), 'urgent'));
test('assignBucket: 8 days → near', () => assert.equal(assignBucket(8), 'near'));
test('assignBucket: 30 days → near (boundary)', () => assert.equal(assignBucket(30), 'near'));
test('assignBucket: 31 days → medium', () => assert.equal(assignBucket(31), 'medium'));
test('assignBucket: 60 days → medium (boundary)', () => assert.equal(assignBucket(60), 'medium'));
test('assignBucket: 61 days → far', () => assert.equal(assignBucket(61), 'far'));
test('assignBucket: -1 → missed', () => assert.equal(assignBucket(-1), 'missed'));
test('assignBucket: -100 → missed', () => assert.equal(assignBucket(-100), 'missed'));

/* ───── parseApplicationsDeadlines ──────────────────────────────────────────*/

const APPS_MD = `# Applications

| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
|---|------|---------|------|-------|--------|-----|----------|--------|-------|
| 1 | 2026-05-01 | Acme | Analyst | 8.0/10 | Applied | ✅ | 2026-07-15 | — |  |
| 2 | 2026-05-05 | Beta | PM | 7.5/10 | Interview | ❌ | Rolling | — |  |
| 3 | 2026-05-10 | Gamma | Lead | 6.0/10 | Discarded | ❌ | 2026-07-01 | — |  |
| 4 | 2026-05-12 | Delta | Intern | 7.0/10 | Evaluated | ✅ | n/d | — |  |
| 5 | 2026-05-15 | Epsilon | SWE | 5.5/10 | SKIP | ❌ | 2026-08-01 | — |  |
| 6 | 2026-05-20 | Zeta | Ops | 9.0/10 | Applied | ✅ | 2026-06-20 | — |  |
`;

test('parseApplicationsDeadlines: returns entries with known deadlines', () => {
  const entries = parseApplicationsDeadlines(APPS_MD);
  // Row 1: Applied + date → included
  // Row 2: Interview + Rolling → included
  // Row 3: Discarded → excluded
  // Row 4: Evaluated + n/d → excluded (no deadline)
  // Row 5: SKIP → excluded
  // Row 6: Applied + date → included
  assert.equal(entries.length, 3);
});

test('parseApplicationsDeadlines: company and role are correct', () => {
  const entries = parseApplicationsDeadlines(APPS_MD);
  const companies = entries.map(e => e.company);
  assert.ok(companies.includes('Acme'));
  assert.ok(companies.includes('Beta'));
  assert.ok(companies.includes('Zeta'));
});

test('parseApplicationsDeadlines: source is "applications"', () => {
  const entries = parseApplicationsDeadlines(APPS_MD);
  assert.ok(entries.every(e => e.source === 'applications'));
});

test('parseApplicationsDeadlines: parsed kind matches values', () => {
  const entries = parseApplicationsDeadlines(APPS_MD);
  const acme = entries.find(e => e.company === 'Acme');
  assert.equal(acme.parsed.kind, 'date');
  const beta = entries.find(e => e.company === 'Beta');
  assert.equal(beta.parsed.kind, 'rolling');
});

test('parseApplicationsDeadlines: empty content returns []', () => {
  assert.deepEqual(parseApplicationsDeadlines(''), []);
});

/* ───── parseScoutingDeadlines ───────────────────────────────────────────────*/

const SCOUTING_MD = `# Scouting

| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |
|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|
| 10 | 2026-06-01 | AlphaT1 | Analyst | 9.0/10 | T1 | 8.0/9.0 | — | 2026-07-31 |  |  |
| 11 | 2026-06-02 | BetaT2 | PM | 7.5/10 | T2 | 7.3/7.8 | — | Rolling |  |  |
| 12 | 2026-06-03 | GammaT3 | Lead | 6.0/10 | T3 | 6.0/6.0 | — | 2026-08-01 |  |  |
| 13 | 2026-06-04 | DeltaT4 | Intern | 5.0/10 | T4 | 5.0/5.0 | — | 2026-08-15 |  |  |
| 14 | 2026-06-05 | EpsilonT2 | SWE | 7.0/10 | T2 | 7.0/7.0 | — | n/d |  |  |
`;

test('parseScoutingDeadlines: includes T1 and T2 with known deadlines only', () => {
  const entries = parseScoutingDeadlines(SCOUTING_MD);
  // Row 10: T1 + date → included
  // Row 11: T2 + Rolling → included
  // Row 12: T3 → excluded
  // Row 13: T4 → excluded
  // Row 14: T2 + n/d → excluded (no deadline)
  assert.equal(entries.length, 2);
});

test('parseScoutingDeadlines: source is "scouting"', () => {
  const entries = parseScoutingDeadlines(SCOUTING_MD);
  assert.ok(entries.every(e => e.source === 'scouting'));
});

test('parseScoutingDeadlines: tier is preserved', () => {
  const entries = parseScoutingDeadlines(SCOUTING_MD);
  const t1 = entries.find(e => e.company === 'AlphaT1');
  assert.equal(t1.tier, 'T1');
  const t2 = entries.find(e => e.company === 'BetaT2');
  assert.equal(t2.tier, 'T2');
});

/* ───── countMissing* ────────────────────────────────────────────────────────*/

test('countMissingApplicationsDeadlines: counts active rows with n/d deadline', () => {
  const count = countMissingApplicationsDeadlines(APPS_MD);
  // Row 4 (Evaluated, n/d) → counted
  // Row 3 (Discarded) → excluded from count
  // Row 5 (SKIP) → excluded from count
  assert.equal(count, 1);
});

test('countMissingScoutingDeadlines: counts T1/T2 rows with n/d only', () => {
  const count = countMissingScoutingDeadlines(SCOUTING_MD);
  // Row 14 (T2, n/d) → counted; rows 12/13 (T3/T4) → excluded
  assert.equal(count, 1);
});

test('countMissingApplicationsDeadlines: empty returns 0', () => {
  assert.equal(countMissingApplicationsDeadlines(''), 0);
});

test('countMissingScoutingDeadlines: empty returns 0', () => {
  assert.equal(countMissingScoutingDeadlines(''), 0);
});

/* ───── classifyDeadlines ────────────────────────────────────────────────────*/

const TODAY = '2026-06-25';

function makeEntry(company, deadlineIso, source = 'scouting') {
  return {
    source,
    num: 1,
    company,
    role: 'Analyst',
    tier: 'T1',
    status: 'Applied',
    deadline: deadlineIso,
    parsed: parseDeadline(deadlineIso),
  };
}

test('classifyDeadlines: urgent bucket for ≤7 days', () => {
  const entries = [makeEntry('Urgent', '2026-06-28')]; // 3 days from 2026-06-25
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.buckets.urgent.length, 1);
  assert.equal(r.buckets.urgent[0].company, 'Urgent');
  assert.equal(r.buckets.urgent[0].daysLeft, 3);
});

test('classifyDeadlines: near bucket for 8-30 days', () => {
  const entries = [makeEntry('NearCo', '2026-07-10')]; // 15 days
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.buckets.near.length, 1);
});

test('classifyDeadlines: missed bucket for past deadlines', () => {
  const entries = [makeEntry('OldCo', '2026-06-01')]; // 24 days ago
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.buckets.missed.length, 1);
  assert.equal(r.buckets.missed[0].daysLeft, -24);
});

test('classifyDeadlines: rolling bucket', () => {
  const entries = [makeEntry('RollCo', 'Rolling')];
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.buckets.rolling.length, 1);
});

test('classifyDeadlines: unknown entries increase counts.unknown', () => {
  const entries = [makeEntry('NdCo', 'n/d')];
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.counts.unknown, 1);
  assert.equal(Object.values(r.buckets).flat().length, 0);
});

test('classifyDeadlines: urgent bucket sorted ascending daysLeft', () => {
  const entries = [
    makeEntry('A', '2026-06-30'), // 5 days
    makeEntry('B', '2026-06-27'), // 2 days
    makeEntry('C', '2026-07-01'), // 6 days
  ];
  const r = classifyDeadlines(entries, TODAY);
  const days = r.buckets.urgent.map(e => e.daysLeft);
  assert.deepEqual(days, [2, 5, 6]);
});

test('classifyDeadlines: missed bucket sorted most-recently-missed first', () => {
  const entries = [
    makeEntry('OldA', '2026-06-10'), // -15d
    makeEntry('OldB', '2026-06-20'), // -5d (more recent)
  ];
  const r = classifyDeadlines(entries, TODAY);
  assert.equal(r.buckets.missed[0].company, 'OldB');
  assert.equal(r.buckets.missed[1].company, 'OldA');
});

/* ───── renderDeadlines ──────────────────────────────────────────────────────*/

test('renderDeadlines: includes date header', () => {
  const entries = [makeEntry('TestCo', '2026-06-28')];
  const classified = classifyDeadlines(entries, TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.match(out, /Deadlines — 2026-06-25/);
});

test('renderDeadlines: shows urgent headline', () => {
  const entries = [
    makeEntry('UrgentA', '2026-06-27'), // 2d
  ];
  const classified = classifyDeadlines(entries, TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.match(out, /URGENT/);
  assert.match(out, /UrgentA/);
});

test('renderDeadlines: skips empty buckets silently', () => {
  const entries = [makeEntry('FarCo', '2026-09-01')]; // > 60 days
  const classified = classifyDeadlines(entries, TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.ok(!out.includes('THIS MONTH'));
  assert.ok(!out.includes('URGENT'));
  assert.ok(out.includes('FURTHER OUT'));
});

test('renderDeadlines: includes rolling section when present', () => {
  const entries = [makeEntry('RollCo', 'Rolling')];
  const classified = classifyDeadlines(entries, TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.match(out, /ROLLING/);
});

test('renderDeadlines: shows no-deadline footer when ndApps>0', () => {
  const classified = classifyDeadlines([], TODAY);
  const out = renderDeadlines(classified, 3, 1);
  assert.match(out, /NO DEADLINE DATA/);
  assert.match(out, /3 active applications/);
  assert.match(out, /1 T1\/T2 scouting entr/);
});

test('renderDeadlines: shows empty message when truly nothing', () => {
  const classified = classifyDeadlines([], TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.match(out, /No deadline data found/);
});

test('renderDeadlines: MISSED section present for past deadline', () => {
  const entries = [makeEntry('PastCo', '2026-06-01')];
  const classified = classifyDeadlines(entries, TODAY);
  const out = renderDeadlines(classified, 0, 0);
  assert.match(out, /MISSED/);
  assert.match(out, /PastCo/);
});

/* ───── buildDeadlinesMarkdown (end-to-end smoke test) ──────────────────────*/

test('buildDeadlinesMarkdown: integrates both sources and renders output', () => {
  const out = buildDeadlinesMarkdown(APPS_MD, SCOUTING_MD, TODAY);

  // Should have a header
  assert.match(out, /Deadlines — 2026-06-25/);

  // Acme from APPS_MD (Applied, 2026-07-15 = 20 days = "near")
  assert.match(out, /Acme/);

  // Beta from APPS_MD (Interview, Rolling)
  assert.match(out, /ROLLING/);

  // Zeta (Applied, 2026-06-20) was 5 days ago → MISSED
  assert.match(out, /MISSED/);

  // AlphaT1 from scouting (T1, 2026-07-31 = 36 days = medium)
  assert.match(out, /AlphaT1/);

  // BetaT2 (T2, Rolling)
  assert.match(out, /BetaT2/);

  // No-deadline footer: 1 active app (Evaluated row #4) + 1 T2 scouting row (#14)
  assert.match(out, /NO DEADLINE DATA/);
});
