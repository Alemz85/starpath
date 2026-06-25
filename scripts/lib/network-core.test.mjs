// network-core.test.mjs — unit suite for the referral / networking tracker.
//
// Run: node --test scripts/lib/network-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.
//
// NO HARDCODED USER DATA: every fixture below is fictional (Acme/Globex/Initech,
// "Ada Lovelace", etc.) — it exercises the algorithm, not any real person.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  companyKey,
  normalizeStrength,
  normalizeDegree,
  recencyFactor,
  warmthScore,
  STRENGTH_WEIGHT,
  DEGREE_FACTOR,
  isDataRow,
  parseContactRow,
  parseNetwork,
  parseScore,
  parsePipelineRow,
  parsePipeline,
  matchNetworkToPipeline,
  pathsForCompany,
  pathLabel,
} from './network-core.mjs';

import { companyKey as scoutingCompanyKey } from './scouting-core.mjs';

/* ───── company key ──────────────────────────────────────────────── */

test('companyKey strips non-alphanumerics and lowercases', () => {
  assert.equal(companyKey('Go-Cardless Ltd.'), 'gocardlessltd');
  assert.equal(companyKey('  Acme Corp '), 'acmecorp');
  assert.equal(companyKey(''), '');
  assert.equal(companyKey(null), '');
});

test('companyKey agrees with scouting-core (so network ⨯ pipeline match)', () => {
  // The whole feature relies on the network matcher and the pipeline using the
  // SAME notion of "same company". Lock that contract here.
  for (const name of ['Acme Corp', 'Go-Cardless Ltd.', 'OpenAI', 'N26 GmbH', 'A&B Co.']) {
    assert.equal(companyKey(name), scoutingCompanyKey(name), `mismatch for "${name}"`);
  }
});

/* ───── strength + degree normalization ──────────────────────────── */

test('normalizeStrength maps synonyms; defaults to medium', () => {
  assert.equal(normalizeStrength('strong'), 'strong');
  assert.equal(normalizeStrength('Close friend'), 'strong');
  assert.equal(normalizeStrength('weak'), 'weak');
  assert.equal(normalizeStrength('acquaintance'), 'weak');
  assert.equal(normalizeStrength('medium'), 'medium');
  assert.equal(normalizeStrength(''), 'medium');
  assert.equal(normalizeStrength('ex-colleague'), 'medium'); // bare label → real, medium tie
});

test('normalizeDegree maps 2/2nd/second → 2, everything else → 1', () => {
  assert.equal(normalizeDegree('2'), 2);
  assert.equal(normalizeDegree('2nd'), 2);
  assert.equal(normalizeDegree('second'), 2);
  assert.equal(normalizeDegree('1'), 1);
  assert.equal(normalizeDegree('1st'), 1);
  assert.equal(normalizeDegree(''), 1);
  assert.equal(normalizeDegree('direct'), 1);
});

/* ───── recency + warmth scoring ─────────────────────────────────── */

test('recencyFactor steps down with age; neutral when unknown/future', () => {
  const today = '2026-06-25';
  assert.equal(recencyFactor('2026-06-01', today), 1.0); // <180d
  assert.equal(recencyFactor('2025-10-01', today), 0.85); // ~267d
  assert.equal(recencyFactor('2025-01-01', today), 0.7); // ~540d
  assert.equal(recencyFactor('2023-01-01', today), 0.55); // >730d
  assert.equal(recencyFactor('', today), 1.0); // unknown → neutral
  assert.equal(recencyFactor('n/d', today), 1.0);
  assert.equal(recencyFactor('2099-01-01', today), 1.0); // future → neutral, not penalized
});

test('warmthScore = strength × degree × recency, rounded 2dp', () => {
  // strong(3) × 1st(1.0) × recent(1.0) = 3.0 — the warmest possible path.
  assert.equal(warmthScore({ relationship: 'strong', degree: 1, lastContact: '2026-06-01' }, '2026-06-25'), 3.0);
  // weak(1) × 2nd(0.6) × recent(1.0) = 0.6 — a cold, indirect lead.
  assert.equal(warmthScore({ relationship: 'weak', degree: 2, lastContact: '2026-06-01' }, '2026-06-25'), 0.6);
  // medium(2) × 1st(1.0) × stale(0.7) = 1.4
  assert.equal(warmthScore({ relationship: 'medium', degree: 1, lastContact: '2025-01-01' }, '2026-06-25'), 1.4);
  // no date → recency neutral: strong(3) × 2nd(0.6) × 1.0 = 1.8
  assert.equal(warmthScore({ relationship: 'strong', degree: 2 }), 1.8);
});

test('a 1st-degree weak tie still outranks a 2nd-degree strong tie head-to-head only when recency holds', () => {
  // sanity: strong+2nd (1.8) beats weak+1st (1.0) — strength dominates here.
  const a = warmthScore({ relationship: 'strong', degree: 2 });
  const b = warmthScore({ relationship: 'weak', degree: 1 });
  assert.ok(a > b);
});

test('STRENGTH_WEIGHT and DEGREE_FACTOR are the documented constants', () => {
  assert.deepEqual(STRENGTH_WEIGHT, { strong: 3, medium: 2, weak: 1 });
  assert.deepEqual(DEGREE_FACTOR, { 1: 1.0, 2: 0.6 });
});

/* ───── row parsing ──────────────────────────────────────────────── */

test('isDataRow rejects header / separator / non-pipe lines', () => {
  assert.equal(isDataRow('| 1 | Ada | Acme | Eng | strong | 1 |  |  |  |'), true);
  assert.equal(isDataRow('| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |'), false);
  assert.equal(isDataRow('|---|------|---------|-------|--------------|--------|-----|--------------|-------|'), false);
  assert.equal(isDataRow('plain text'), false);
  assert.equal(isDataRow(''), false);
});

test('parseContactRow reads the full 9-column layout', () => {
  const line = '| 1 | Ada Lovelace | Acme Corp | Eng Manager | strong | 1 |  | 2026-06-01 | ex-colleague |';
  const c = parseContactRow(line);
  assert.equal(c.num, 1);
  assert.equal(c.name, 'Ada Lovelace');
  assert.equal(c.company, 'Acme Corp');
  assert.equal(c.companyKey, 'acmecorp');
  assert.equal(c.title, 'Eng Manager');
  assert.equal(c.relationship, 'strong');
  assert.equal(c.degree, 1);
  assert.equal(c.via, '');
  assert.equal(c.lastContact, '2026-06-01');
  assert.equal(c.notes, 'ex-colleague');
});

test('parseContactRow normalizes a 2nd-degree row and keeps Via', () => {
  const line = '| 2 | Grace Hopper | Globex | Director | weak | 2nd | Ada Lovelace | n/d | met at a conf |';
  const c = parseContactRow(line);
  assert.equal(c.degree, 2);
  assert.equal(c.via, 'Ada Lovelace');
  assert.equal(c.relationship, 'weak');
  assert.equal(c.lastContact, ''); // n/d sentinel → absent
});

test('parseContactRow treats em-dash / n/a sentinels as absent', () => {
  const line = '| 3 | Alan Turing | Initech | — | medium | 1 | — | — | — |';
  const c = parseContactRow(line);
  assert.equal(c.title, '');
  assert.equal(c.via, '');
  assert.equal(c.lastContact, '');
  assert.equal(c.notes, '');
});

test('parseContactRow rejects header, separator, non-numeric id, and missing name/company', () => {
  assert.equal(parseContactRow('| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |'), null);
  assert.equal(parseContactRow('|---|---|---|---|---|---|---|---|---|'), null);
  assert.equal(parseContactRow('| x | Ada | Acme | Eng | strong | 1 |  |  |  |'), null); // non-numeric id
  assert.equal(parseContactRow('| 1 |  | Acme | Eng | strong | 1 |  |  |  |'), null); // no name
  assert.equal(parseContactRow('| 1 | Ada |  | Eng | strong | 1 |  |  |  |'), null); // no company
  assert.equal(parseContactRow('| 1 | Ada | Acme |'), null); // too few cells
});

test('parseNetwork parses a whole doc, skipping noise', () => {
  const doc = `# Network

| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
|---|------|---------|-------|--------------|--------|-----|--------------|-------|
| 1 | Ada Lovelace | Acme Corp | Eng Manager | strong | 1 |  | 2026-06-01 | ex-colleague |
| 2 | Grace Hopper | Globex | Director | medium | 2 | Ada Lovelace | n/d | conf |

some trailing prose that is not a row`;
  const contacts = parseNetwork(doc);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].name, 'Ada Lovelace');
  assert.equal(contacts[1].degree, 2);
});

test('parseNetwork handles empty / null input', () => {
  assert.deepEqual(parseNetwork(''), []);
  assert.deepEqual(parseNetwork(null), []);
  assert.deepEqual(parseNetwork('# Network\n\n(no contacts yet)'), []);
});

/* ───── pipeline parsing ─────────────────────────────────────────── */

test('parseScore pulls the leading numeric', () => {
  assert.equal(parseScore('7.2/10'), 7.2);
  assert.equal(parseScore('**8**'), 8);
  assert.equal(parseScore('—'), 0);
  assert.equal(parseScore(''), 0);
});

test('parsePipelineRow reads applications/scouting leading shape', () => {
  const appRow = '| 1 | 2026-05-05 | Acme Corp | Data Analyst | 7.2/10 | SKIP | ❌ | n/d |  |';
  const r = parsePipelineRow(appRow, 'application');
  assert.equal(r.company, 'Acme Corp');
  assert.equal(r.companyKey, 'acmecorp');
  assert.equal(r.role, 'Data Analyst');
  assert.equal(r.score, 7.2);
  assert.equal(r.source, 'application');
});

test('parsePipelineRow rejects header / separator / non-date rows', () => {
  assert.equal(parsePipelineRow('| # | Date | Company | Role | Score | Status |', 'application'), null);
  assert.equal(parsePipelineRow('|---|------|---------|------|-------|--------|', 'application'), null);
  assert.equal(parsePipelineRow('| 1 | not-a-date | Acme | Role | 7/10 |', 'application'), null);
  assert.equal(parsePipelineRow('plain', 'application'), null);
});

test('parsePipeline dedups by company+role, prefers application source then higher score', () => {
  const apps = `| # | Date | Company | Role | Score | Status |
| 1 | 2026-05-05 | Acme Corp | Data Analyst | 7.2/10 | Applied |`;
  const scouting = `| # | Date | Company | Role | Score | Tier |
| 10 | 2026-06-01 | Acme Corp | Data Analyst | 8.0/10 | T2 |
| 11 | 2026-06-01 | Globex | ML Engineer | 9.1/10 | T1 |
| 12 | 2026-06-02 | Globex | ML Engineer | 6.0/10 | T3 |`;
  const pipe = parsePipeline(apps, scouting);
  // Acme/Data Analyst: same key in both → application wins (even though scouting score is higher).
  const acme = pipe.find((p) => p.companyKey === 'acmecorp');
  assert.equal(acme.source, 'application');
  assert.equal(acme.score, 7.2);
  // Globex/ML Engineer: two scouting rows → higher score (9.1) wins.
  const globex = pipe.find((p) => p.companyKey === 'globex');
  assert.equal(globex.score, 9.1);
  // 3 distinct (company+role) keys → but only 2 after dedup of Globex + 1 Acme = 2.
  assert.equal(pipe.length, 2);
});

/* ───── the match: network ⨯ pipeline ────────────────────────────── */

function fixture() {
  const network = `| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
|---|------|---------|-------|--------------|--------|-----|--------------|-------|
| 1 | Ada Lovelace | Acme Corp | Eng Manager | strong | 1 |  | 2026-06-01 | ex-colleague, hiring |
| 2 | Grace Hopper | Acme Corp | Recruiter | weak | 1 |  | 2024-01-01 | met once |
| 3 | Alan Turing | Globex | Director | medium | 2 | Ada Lovelace | n/d | conf intro possible |
| 4 | Katherine Johnson | Umbrella Inc | VP Data | strong | 1 |  | 2026-06-10 | not in my pipeline |`;
  const apps = `| # | Date | Company | Role | Score | Status |
| 1 | 2026-05-05 | Acme Corp | Data Analyst | 7.2/10 | Applied |`;
  const scouting = `| # | Date | Company | Role | Score | Tier |
| 10 | 2026-06-01 | Globex | ML Engineer | 9.1/10 | T1 |
| 11 | 2026-06-01 | Initech | Strategy Analyst | 8.5/10 | T2 |`;
  return { network, apps, scouting };
}

test('matchNetworkToPipeline pairs contacts to pipeline companies and ranks paths', () => {
  const { network, apps, scouting } = fixture();
  const contacts = parseNetwork(network);
  const pipeline = parsePipeline(apps, scouting);
  const res = matchNetworkToPipeline(contacts, pipeline, '2026-06-25');

  // Acme (2 contacts, in pipeline) and Globex (1 contact, in pipeline) match.
  // Umbrella has a contact but is NOT in pipeline → orphan. Initech is in
  // pipeline but has NO contact → gap.
  assert.equal(res.counts.matchedCompanies, 2);
  assert.equal(res.counts.contactsMatched, 3); // Ada + Grace + Alan
  assert.equal(res.counts.gaps, 1); // Initech
  assert.equal(res.counts.orphanContacts, 1); // Katherine @ Umbrella

  // Within Acme, the warm 1st-degree (Ada) ranks above the cold weak tie (Grace).
  const acme = res.matches.find((m) => m.companyKey === 'acmecorp');
  assert.equal(acme.contacts[0].name, 'Ada Lovelace');
  assert.equal(acme.contacts[1].name, 'Grace Hopper');
  assert.ok(acme.contacts[0].warmth > acme.contacts[1].warmth);

  // Matches are globally ranked warmest-path-first: Acme's Ada (3.0, 1st/strong)
  // beats Globex's Alan (2nd-degree medium → 1.2).
  assert.equal(res.matches[0].companyKey, 'acmecorp');
  assert.equal(res.matches[1].companyKey, 'globex');

  // The gap is Initech, and it carries its role + score so the user knows it's
  // worth finding someone for.
  assert.equal(res.gaps[0].company, 'Initech');
  assert.equal(res.gaps[0].topScore, 8.5);

  // Orphan lead is Katherine — a warm tie at a company not yet targeted.
  assert.equal(res.orphanContacts[0].name, 'Katherine Johnson');
});

test('matchNetworkToPipeline gaps are ranked by best role score (most worth a contact first)', () => {
  const network = `| 1 | Ada | Acme | Eng | strong | 1 |  | 2026-06-01 | x |`;
  const scouting = `| 10 | 2026-06-01 | Globex | A | 6.0/10 | T3 |
| 11 | 2026-06-01 | Initech | B | 9.0/10 | T1 |
| 12 | 2026-06-01 | Umbrella | C | 7.5/10 | T2 |`;
  const res = matchNetworkToPipeline(parseNetwork(network), parsePipeline('', scouting), '2026-06-25');
  assert.deepEqual(res.gaps.map((g) => g.company), ['Initech', 'Umbrella', 'Globex']);
});

test('matchNetworkToPipeline on empty inputs is a clean zero state', () => {
  const res = matchNetworkToPipeline([], [], '2026-06-25');
  assert.deepEqual(res.counts, { matchedCompanies: 0, contactsMatched: 0, gaps: 0, orphanContacts: 0 });
  assert.deepEqual(res.matches, []);
  assert.deepEqual(res.gaps, []);
  assert.deepEqual(res.orphanContacts, []);
});

/* ───── per-company query ────────────────────────────────────────── */

test('pathsForCompany returns ranked contacts + matching roles', () => {
  const { network, apps, scouting } = fixture();
  const contacts = parseNetwork(network);
  const pipeline = parsePipeline(apps, scouting);

  const acme = pathsForCompany('acme corp', contacts, pipeline, '2026-06-25');
  assert.equal(acme.found, true);
  assert.equal(acme.inPipeline, true);
  assert.equal(acme.contacts[0].name, 'Ada Lovelace'); // warmest first
  assert.equal(acme.roles[0].role, 'Data Analyst');

  // A pipeline company with no contact: found=false but inPipeline=true.
  const initech = pathsForCompany('Initech', contacts, pipeline, '2026-06-25');
  assert.equal(initech.found, false);
  assert.equal(initech.inPipeline, true);

  // A contact's company that isn't targeted: found=true, inPipeline=false.
  const umbrella = pathsForCompany('Umbrella Inc', contacts, pipeline, '2026-06-25');
  assert.equal(umbrella.found, true);
  assert.equal(umbrella.inPipeline, false);

  // Total unknown: both false.
  const none = pathsForCompany('Nonexistent Co', contacts, pipeline, '2026-06-25');
  assert.equal(none.found, false);
  assert.equal(none.inPipeline, false);
});

test('pathsForCompany matches by normalized key (punctuation/case-insensitive)', () => {
  const contacts = parseNetwork('| 1 | Ada | Go-Cardless Ltd. | Eng | strong | 1 |  |  | x |');
  const r = pathsForCompany('gocardless ltd', contacts, [], '2026-06-25');
  assert.equal(r.found, true);
  assert.equal(r.contacts[0].name, 'Ada');
});

/* ───── label ────────────────────────────────────────────────────── */

test('pathLabel explains the path in plain words', () => {
  assert.equal(
    pathLabel({ name: 'Ada', title: 'Eng Manager', relationship: 'strong', degree: 1, via: '' }),
    'Ada · Eng Manager — strong tie, 1st-degree (direct)',
  );
  assert.equal(
    pathLabel({ name: 'Alan', title: '', relationship: 'medium', degree: 2, via: 'Ada' }),
    'Alan — medium tie, 2nd-degree via Ada',
  );
  assert.equal(
    pathLabel({ name: 'Grace', title: 'Director', relationship: 'weak', degree: 2, via: '' }),
    'Grace · Director — weak tie, 2nd-degree (needs an intro)',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Additional edge-case coverage (extension round)
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ───── normalizeStrength: uncommon synonyms ─────────────────────────────── */

test('normalizeStrength recognizes "tight" → strong, "distant" → weak, "ok" → medium', () => {
  assert.equal(normalizeStrength('tight'), 'strong');
  assert.equal(normalizeStrength('well connected'), 'strong');
  assert.equal(normalizeStrength('distant'), 'weak');
  assert.equal(normalizeStrength('cold intro'), 'weak');
  assert.equal(normalizeStrength('ok'), 'medium');
  assert.equal(normalizeStrength('moderate'), 'medium');
  assert.equal(normalizeStrength('some rapport'), 'medium');
});

test('normalizeStrength returns medium for null and non-string input', () => {
  assert.equal(normalizeStrength(null), 'medium');
  assert.equal(normalizeStrength(undefined), 'medium');
  assert.equal(normalizeStrength(42), 'medium'); // coerced to "42" → no match → medium
});

/* ───── normalizeDegree: capitalized "Second" ────────────────────────────── */

test('normalizeDegree accepts capitalized "Second" and "Second degree"', () => {
  assert.equal(normalizeDegree('Second'), 2);
  assert.equal(normalizeDegree('Second degree'), 2);
});

test('normalizeDegree defaults to 1 for unexpected values', () => {
  assert.equal(normalizeDegree('3'), 1);   // third-degree is not a concept here
  assert.equal(normalizeDegree('third'), 1);
  assert.equal(normalizeDegree(null), 1);
});

/* ───── recencyFactor: exact boundary values ─────────────────────────────── */

test('recencyFactor boundary: exactly 180 days → 1.0, exactly 181 days → 0.85', () => {
  // Build reference dates deterministically to avoid test flakiness.
  const today = '2026-06-25';
  // 180 days before 2026-06-25 = 2025-12-27
  const exactly180 = '2025-12-27';
  assert.equal(recencyFactor(exactly180, today), 1.0);
  // 181 days before = 2025-12-26
  const exactly181 = '2025-12-26';
  assert.equal(recencyFactor(exactly181, today), 0.85);
});

test('recencyFactor boundary: exactly 365 days → 0.85, exactly 366 days → 0.7', () => {
  const today = '2026-06-25';
  // 365 days before 2026-06-25 = 2025-06-25
  const exactly365 = '2025-06-25';
  assert.equal(recencyFactor(exactly365, today), 0.85);
  // 366 days before = 2025-06-24
  const exactly366 = '2025-06-24';
  assert.equal(recencyFactor(exactly366, today), 0.7);
});

test('recencyFactor boundary: exactly 730 days → 0.7, 731 days → 0.55', () => {
  const today = '2026-06-25';
  // 730 days before 2026-06-25 = 2024-06-25 (accounting for the 2024 leap year).
  const exactly730 = '2024-06-25';
  assert.equal(recencyFactor(exactly730, today), 0.7);
  // 731 days before = 2024-06-24.
  const exactly731 = '2024-06-24';
  assert.equal(recencyFactor(exactly731, today), 0.55);
});

/* ───── parseContactRow: edge cases ──────────────────────────────────────── */

test('parseContactRow returns null when name is n/d sentinel', () => {
  // n/d cleans to '' → treated as missing name.
  const line = '| 1 | n/d | Acme | Eng | strong | 1 |  |  |  |';
  assert.equal(parseContactRow(line), null);
});

test('parseContactRow returns null when company is em-dash sentinel', () => {
  const line = '| 1 | Ada Lovelace | — | Eng | strong | 1 |  |  |  |';
  assert.equal(parseContactRow(line), null);
});

test('parseContactRow handles a row with more than 9 data cells (extra trailing cells ignored)', () => {
  // Markdown rows can have extra trailing cells — parser should not crash.
  const line = '| 1 | Ada | Acme | Eng | strong | 1 |  | 2026-01-01 | notes | extra | more |';
  const c = parseContactRow(line);
  assert.ok(c !== null);
  assert.equal(c.name, 'Ada');
  assert.equal(c.notes, 'notes');
});

/* ───── parseScore: edge cases ───────────────────────────────────────────── */

test('parseScore handles bold-wrapped scores and scores with no denominator', () => {
  assert.equal(parseScore('**7.5**'), 7.5);
  assert.equal(parseScore('9'), 9);
  assert.equal(parseScore('7.2/10'), 7.2);
});

test('parseScore returns 0 for non-numeric content', () => {
  assert.equal(parseScore('TBD'), 0);
  assert.equal(parseScore(null), 0);
  assert.equal(parseScore('—'), 0);
});

/* ───── parsePipeline: scouting-vs-scouting score collision ─────────────── */

test('parsePipeline: among two scouting rows for the same role, higher score wins', () => {
  const scouting = `| 10 | 2026-06-01 | Initech | Strategy Analyst | 6.0/10 | T3 |
| 11 | 2026-06-02 | Initech | Strategy Analyst | 8.5/10 | T2 |`;
  const pipe = parsePipeline('', scouting);
  assert.equal(pipe.length, 1);
  assert.equal(pipe[0].score, 8.5);
});

test('parsePipeline: application source wins over scouting even when scouting score is higher', () => {
  const apps = `| 1 | 2026-05-01 | TechCo | PM | 7.0/10 | Applied |`;
  const scouting = `| 5 | 2026-06-01 | TechCo | PM | 9.5/10 | T1 |`;
  const pipe = parsePipeline(apps, scouting);
  assert.equal(pipe.length, 1);
  assert.equal(pipe[0].source, 'application');
  assert.equal(pipe[0].score, 7.0);
});

/* ───── matchNetworkToPipeline: multiple roles per company ───────────────── */

test('matchNetworkToPipeline surfaces multiple roles per matched company, sorted by score', () => {
  const network = `| 1 | Ada | MegaCorp | PM | strong | 1 |  | 2026-06-01 | x |`;
  const scouting = `| 1 | 2026-06-01 | MegaCorp | Data Scientist | 9.0/10 | T1 |
| 2 | 2026-06-02 | MegaCorp | Data Analyst | 7.5/10 | T2 |
| 3 | 2026-06-03 | MegaCorp | Junior Analyst | 6.0/10 | T3 |`;
  const res = matchNetworkToPipeline(parseNetwork(network), parsePipeline('', scouting), '2026-06-25');
  assert.equal(res.counts.matchedCompanies, 1);
  const match = res.matches[0];
  assert.equal(match.roles.length, 3);
  // Highest score first.
  assert.equal(match.roles[0].role, 'Data Scientist');
  assert.equal(match.roles[0].score, 9.0);
  assert.equal(match.topScore, 9.0);
});

/* ───── matchNetworkToPipeline: multiple contacts at same company ─────────── */

test('matchNetworkToPipeline ranks contacts within a company by warmth', () => {
  const network = `| 1 | Strong Friend | Alpha Co | CEO | strong | 1 |  | 2026-06-01 | x |
| 2 | Weak Acquaintance | Alpha Co | HR | weak | 2 |  | 2024-01-01 | y |
| 3 | Medium Colleague | Alpha Co | Eng | medium | 1 |  | n/d | z |`;
  const scouting = `| 1 | 2026-06-01 | Alpha Co | Data Engineer | 8.5/10 | T1 |`;
  const res = matchNetworkToPipeline(parseNetwork(network), parsePipeline('', scouting), '2026-06-25');
  const match = res.matches[0];
  assert.equal(match.contacts.length, 3);
  // Strong+1st+recent (3.0) > Medium+1st+neutral (2.0) > Weak+2nd+stale (0.6×0.55≈0.33)
  assert.equal(match.contacts[0].name, 'Strong Friend');
  assert.equal(match.contacts[2].name, 'Weak Acquaintance');
  assert.ok(match.contacts[0].warmth > match.contacts[1].warmth);
  assert.ok(match.contacts[1].warmth > match.contacts[2].warmth);
});

/* ───── matchNetworkToPipeline: orphan contacts ranked by warmth ─────────── */

test('matchNetworkToPipeline ranks orphan contacts warmest-first', () => {
  const network = `| 1 | Cold Lead | OffPipeline Inc | Analyst | weak | 2 |  | 2020-01-01 | x |
| 2 | Hot Lead | OffPipeline Inc | Director | strong | 1 |  | 2026-06-01 | y |`;
  const res = matchNetworkToPipeline(parseNetwork(network), parsePipeline('', ''), '2026-06-25');
  assert.equal(res.counts.orphanContacts, 2);
  // Hot Lead (strong+1st+recent = 3.0) before Cold Lead (weak+2nd+old ≈ 0.3)
  assert.equal(res.orphanContacts[0].name, 'Hot Lead');
  assert.equal(res.orphanContacts[1].name, 'Cold Lead');
});

/* ───── companyKey: idempotent + handles special chars ───────────────────── */

test('companyKey is idempotent and strips dots, &, spaces, slashes', () => {
  const k = companyKey('Go-Cardless Ltd.');
  assert.equal(companyKey(k), k); // idempotent — already normalized
  assert.equal(companyKey('A&B / C'), 'abc');
  assert.equal(companyKey('N26 GmbH'), 'n26gmbh');
});

/* ───── pathLabel: no title ─────────────────────────────────────────────── */

test('pathLabel omits title segment when title is empty', () => {
  const label = pathLabel({ name: 'Ada', title: '', relationship: 'strong', degree: 1, via: '' });
  // No " · <title>" in the output when title is empty.
  assert.ok(!label.includes(' · '));
  assert.equal(label, 'Ada — strong tie, 1st-degree (direct)');
});
