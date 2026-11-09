// scouting-identity.test.mjs — same-listing identity for merge-scouting:
// the pure rules (lib/scouting-identity.mjs) and the merge itself run as a
// child process against a throwaway tree (CAREER_OPS_ROOT). Fixtures are
// fictional.
//
// Run: node --test scripts/lib/scouting-identity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  strictRoleKey, postingKey, cityKey, parseReportHeader, indexScoreHistory, resolveIdentity, compareListing, findSameListing,
} from './scouting-identity.mjs';
import { SCOUTING_SCAFFOLD, APPLICATIONS_SCAFFOLD, SCORE_HISTORY_HEADER } from './profile-core.mjs';
import { parseScoutingRow } from './scouting-core.mjs';
import { parseAppRow } from './tracker-core.mjs';

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));
const GH = (id, extra = '') => `https://boards.greenhouse.io/nimbusrobotics/jobs/${id}${extra}`;

/* ───── pure rules ───────────────────────────────────────────────── */

test('strictRoleKey drops only boilerplate: case, punctuation, gender tags, req ids', () => {
  assert.equal(strictRoleKey('Data Analyst (m/f/d)'), strictRoleKey('data  analyst'));
  assert.equal(strictRoleKey('Data Analyst #123456'), 'data analyst');
  assert.notEqual(strictRoleKey('Data Analyst - Lyon'), strictRoleKey('Data Analyst - Porto'));
  assert.notEqual(strictRoleKey('Insights & Planning Intern'), strictRoleKey('Insights & Planning Summer Intern'));
});

test('postingKey: ATS posting id beats URL noise; other URLs are canonicalized; non-URLs are empty', () => {
  assert.equal(postingKey(GH(1001)), postingKey(GH(1001, '?gh_src=abc#apply')));
  assert.notEqual(postingKey(GH(1001)), postingKey(GH(1002)));
  assert.match(postingKey(GH(1001)), /^id:greenhouse:nimbusrobotics:1001$/);
  assert.equal(postingKey('https://www.tailspin.example/careers/42?utm_source=x'), postingKey('https://tailspin.example/careers/42/'));
  assert.equal(postingKey('—'), '');
  assert.equal(postingKey(''), '');
});

test('cityKey takes the city part, folds case and accents, ignores remote / n/d', () => {
  assert.equal(cityKey('Lyon, France · hybrid 2 days'), 'lyon');
  assert.equal(cityKey('Lyon (hybrid)'), 'lyon');
  assert.equal(cityKey('Málaga, Spain'), 'malaga');
  assert.equal(cityKey('Remote'), '');
  assert.equal(cityKey('n/d'), '');
  assert.equal(cityKey(''), '');
});

test('parseReportHeader reads URL, Location and Date; a "—" URL is empty', () => {
  const h = parseReportHeader('# Scouting: Nimbus Robotics — Data Analyst\n\n**Date:** 2026-06-01\n**Location:** Lyon, France hybrid\n**URL:** https://x.example/j/1\n');
  assert.deepEqual(h, { url: 'https://x.example/j/1', location: 'Lyon, France hybrid', date: '2026-06-01' });
  assert.equal(parseReportHeader('**URL:** —').url, '');
  assert.deepEqual(parseReportHeader(''), { url: '', location: '', date: '' });
});

const historyText = (rows) => {
  const cols = SCORE_HISTORY_HEADER.split('\t');
  return [SCORE_HISTORY_HEADER, ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n';
};

test('resolveIdentity: report first (only when its date is the row date), then score-history; several listings → ambiguous', () => {
  const history = indexScoreHistory(historyText([
    { date: '2026-06-01', company: 'Nimbus Robotics', role: 'Data Analyst', url: GH(1), location: 'Lyon' },
    { date: '2026-06-02', company: 'Nimbus Robotics', role: 'Data Analyst', url: GH(2), location: 'Porto' },
    { date: '2026-06-02', company: 'Nimbus Robotics', role: 'Data Analyst', url: GH(3), location: 'Lyon' },
  ]));
  const row = { company: 'Nimbus Robotics', role: 'Data Analyst', date: '2026-06-01' };
  assert.deepEqual(resolveIdentity(row, { report: { url: GH(9), location: 'Nantes', date: '2026-06-01' }, history }),
    { key: postingKey(GH(9)), city: 'nantes', ambiguous: false, source: 'report' });
  // a report dated otherwise belongs to another evaluation: fall back to score-history
  assert.equal(resolveIdentity(row, { report: { url: GH(9), location: '', date: '2026-07-01' }, history }).key, postingKey(GH(1)));
  assert.equal(resolveIdentity(row, { history }).city, 'lyon');
  const twoThatDay = resolveIdentity({ ...row, date: '2026-06-02' }, { history });
  assert.equal(twoThatDay.key, '');
  assert.equal(twoThatDay.ambiguous, true);
  assert.deepEqual(resolveIdentity(row, {}), { key: '', city: '', ambiguous: false, source: '' });
  assert.equal(indexScoreHistory('garbage').size, 0);
});

const side = (num, role, identity = {}, company = 'Nimbus Robotics') => ({ num, company, role, date: '2026-06-01', identity: { key: '', city: '', ambiguous: false, ...identity } });

test('compareListing: posting identity decides, then the number, then exact role + city', () => {
  const k1 = postingKey(GH(1));
  const k2 = postingKey(GH(2));
  assert.equal(compareListing(side(5, 'Data Analyst II', { key: k1 }), side(1, 'Data Analyst', { key: k1 })).verdict, 'same');
  assert.equal(compareListing(side(1, 'Data Analyst', { key: k2 }), side(1, 'Data Analyst', { key: k1 })).verdict, 'different', 'a different URL beats a shared number');
  assert.equal(compareListing(side(7, 'Operations Analyst'), side(7, 'Ops Analyst')).verdict, 'same');
  assert.equal(compareListing(side(7, 'Ops Analyst', {}, 'Tailspin Toys'), side(7, 'Ops Analyst')).verdict, 'unrelated', 'a number alone never crosses companies');
  assert.equal(compareListing(side(8, 'Data Analyst (m/f/d)'), side(1, 'Data Analyst')).verdict, 'same');
  assert.equal(compareListing(side(8, 'Data Analyst', { city: 'porto' }), side(1, 'Data Analyst', { city: 'lyon' })).verdict, 'different');
  assert.equal(compareListing(side(8, 'Data Analyst', { city: 'lyon' }), side(1, 'Data Analyst', { city: 'lyon' })).verdict, 'same');
  assert.equal(compareListing(side(8, 'Data Analyst', { ambiguous: true }), side(1, 'Data Analyst')).verdict, 'ambiguous');
  assert.equal(compareListing(side(8, 'Senior Data Analyst'), side(1, 'Data Analyst')).verdict, 'ambiguous', 'a prefix match alone never overwrites');
  assert.equal(compareListing(side(8, 'Sales Intern'), side(1, 'Data Analyst')).verdict, 'unrelated');
});

test('findSameListing prefers the strongest evidence and reports look-alikes when nothing is the same', () => {
  const k1 = postingKey(GH(1));
  const rows = [side(1, 'Data Analyst'), side(2, 'Data Analyst Lyon', { key: k1 })];
  assert.equal(findSameListing(side(9, 'Data Analyst', { key: k1 }), rows).row.num, 2);
  const none = findSameListing(side(9, 'Senior Data Analyst'), [side(1, 'Data Analyst'), side(3, 'Sales Intern')]);
  assert.equal(none.row, null);
  assert.deepEqual(none.conflicts.map((c) => [c.row.num, c.verdict]), [[1, 'ambiguous']]);
});

/* ───── merge-scouting end to end ────────────────────────────────── */

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'starpath-scout-id-'));
  for (const d of ['data', 'reports/tier-1', 'reports/tier-2', 'batch/scouting-additions']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'data/scouting.md'), SCOUTING_SCAFFOLD);
  writeFileSync(join(root, 'data/applications.md'), APPLICATIONS_SCAFFOLD);
  return root;
}
const env = (root) => ({ ...process.env, CAREER_OPS_ROOT: root });
function merge(root) {
  const r = spawnSync('node', [join(SCRIPTS, 'merge-scouting.mjs')], { env: env(root), encoding: 'utf-8' });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, out);
  return out;
}
const rows = (root) => readFileSync(join(root, 'data/scouting.md'), 'utf-8').split('\n').map(parseScoutingRow).filter(Boolean);
const report = (root, rel, { date, url = '—', location = 'n/d' }) =>
  writeFileSync(join(root, rel), `# Scouting: x — y\n\n**Date:** ${date}\n**Location:** ${location}\n**Tier:** T2\n**URL:** ${url}\n`);
const addition = (root, file, cols) => writeFileSync(join(root, 'batch/scouting-additions', file), cols.join('\t'));
const scored = (num, date, company, role, rel, notes, m = '8', e = '6') =>
  [String(num), date, company, role, m, e, 'T2', 'amber: x', rel ? `[${num}](${rel})` : '—', 'n/d', '', notes];
const writeHistory = (root, list) => writeFileSync(join(root, 'data/score-history.tsv'), historyText(list));

test('incident 1: a longer title on a different posting is its own row; the original row is untouched', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Nimbus Robotics - Junior Solutions Engineer - Horizon Track.md';
    report(root, p1, { date: '2026-06-01', url: GH(1001) });
    addition(root, '20.tsv', scored(20, '2026-06-01', 'Nimbus Robotics', 'Junior Solutions Engineer - Horizon Track', p1, 'original'));
    merge(root);
    const p2 = 'reports/tier-2/Nimbus Robotics - Junior Solutions Engineer Nordics Dutch-Speaking - Horizon Track.md';
    report(root, p2, { date: '2026-06-05', url: GH(1002) });
    addition(root, '21.tsv', scored(21, '2026-06-05', 'Nimbus Robotics', 'Junior Solutions Engineer (Nordics/Dutch-Speaking) - Horizon Track', p2, 'dutch track', '7', '5'));
    const out = merge(root);
    const r = rows(root);
    assert.equal(r.length, 2, out);
    const original = r.find((x) => x.num === 20);
    assert.equal(original.role, 'Junior Solutions Engineer - Horizon Track');
    assert.equal(original.notes, 'original');
    assert.equal(original.match, '8');
    assert.equal(r.find((x) => x.num === 21).role, 'Junior Solutions Engineer (Nordics/Dutch-Speaking) - Horizon Track');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incident 2: a near-identical title in another city keeps its reserved number as a new row', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Tailspin Toys - Insights & Planning Intern.md';
    report(root, p1, { date: '2026-06-01', location: 'Lyon, France hybrid' });
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Tailspin Toys', 'Insights & Planning Intern', p1, 'lyon'));
    merge(root);
    const claim = () => JSON.parse(spawnSync('node', [join(SCRIPTS, 'reserve-report-num.mjs'), '--json'], { env: env(root), encoding: 'utf-8' }).stdout).num;
    const reserved = claim();
    const p2 = 'reports/tier-2/Tailspin Toys - Insights & Planning Summer Intern.md';
    report(root, p2, { date: '2026-06-03', location: 'Porto, Portugal on-site' });
    addition(root, `${reserved}.tsv`, scored(reserved, '2026-06-03', 'Tailspin Toys', 'Insights & Planning Summer Intern', p2, 'porto', '7', '7'));
    const out = merge(root);
    const r = rows(root);
    assert.equal(r.length, 2, out);
    assert.equal(r.find((x) => x.num === 1).notes, 'lyon');
    assert.equal(r.find((x) => x.num === reserved).role, 'Insights & Planning Summer Intern');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incident 3: same title, other city and URL (Blocked, no report) is a new row; re-merging the old one is skipped as stale', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Nimbus Robotics - Strategy Analyst.md';
    report(root, p1, { date: '2026-06-01', url: GH(501), location: 'Lyon, France' });
    const oldCols = scored(1, '2026-06-01', 'Nimbus Robotics', 'Strategy Analyst', p1, 'lyon scored');
    addition(root, '1.tsv', oldCols);
    merge(root);
    writeHistory(root, [
      { date: '2026-06-01', company: 'Nimbus Robotics', role: 'Strategy Analyst', url: GH(501), location: 'Lyon, France' },
      { date: '2026-06-04', company: 'Nimbus Robotics', role: 'Strategy Analyst', url: GH(502), location: 'Porto, Portugal' },
    ]);
    addition(root, '2.tsv', ['2', '2026-06-04', 'Nimbus Robotics', 'Strategy Analyst', '—', '—', 'T4', 'red: work permit', '—', 'n/d', '', 'porto blocked']);
    let out = merge(root);
    let r = rows(root);
    assert.equal(r.length, 2, out);
    assert.equal(r.find((x) => x.num === 1).notes, 'lyon scored');
    assert.equal(r.find((x) => x.num === 2).eligibility, 'red: work permit');
    // the Lyon TSV merged again: same listing as #1 (same URL), older than nothing → no change; never lands on #2
    addition(root, '1-again.tsv', oldCols);
    out = merge(root);
    r = rows(root);
    assert.equal(r.length, 2, out);
    assert.equal(r.find((x) => x.num === 2).notes, 'porto blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a report file overwritten by a same-titled listing does not make the two the same listing', () => {
  const root = makeRoot();
  try {
    const p = 'reports/tier-2/Nimbus Robotics - Strategy Analyst.md';
    report(root, p, { date: '2026-06-01', url: GH(501), location: 'Lyon' });
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Nimbus Robotics', 'Strategy Analyst', p, 'lyon'));
    merge(root);
    writeHistory(root, [{ date: '2026-06-01', company: 'Nimbus Robotics', role: 'Strategy Analyst', url: GH(501), location: 'Lyon' }]);
    report(root, p, { date: '2026-06-01', url: GH(777), location: 'Porto' }); // same day, same file name, other posting
    addition(root, '2.tsv', scored(2, '2026-06-01', 'Nimbus Robotics', 'Strategy Analyst', p, 'porto'));
    const out = merge(root);
    assert.equal(rows(root).length, 2, out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same URL: a re-evaluation updates in place even with a reworded title and a new number', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Nimbus Robotics - Data Analyst.md';
    report(root, p1, { date: '2026-06-01', url: GH(9) });
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Nimbus Robotics', 'Data Analyst', p1, 'v1'));
    merge(root);
    const p2 = 'reports/tier-2/Nimbus Robotics - Data Analyst Business Intelligence.md';
    report(root, p2, { date: '2026-07-01', url: GH(9, '?gh_src=feed') });
    addition(root, '5.tsv', scored(5, '2026-07-01', 'Nimbus Robotics', 'Data Analyst, Business Intelligence', p2, 'v2', '7.5', '6'));
    const out = merge(root);
    const r = rows(root);
    assert.equal(r.length, 1, out);
    assert.equal(r[0].num, 1);
    assert.equal(r[0].match, '7.5');
    assert.match(r[0].notes, /^Re-eval \(M 8→7\.5, E 6→6\)\. v2$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same row number: updates in place when neither side has a URL', () => {
  const root = makeRoot();
  try {
    addition(root, '4.tsv', scored(4, '2026-06-01', 'Tailspin Toys', 'Ops Analyst', null, 'v1'));
    merge(root);
    addition(root, '4b.tsv', scored(4, '2026-06-08', 'Tailspin Toys', 'Operations Analyst', null, 'v2', '9', '7'));
    const out = merge(root);
    const r = rows(root);
    assert.equal(r.length, 1, out);
    assert.equal(r[0].role, 'Operations Analyst');
    assert.equal(r[0].match, '9');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy rows without a URL: same company + role + city still update; an older addition is skipped as stale', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Tailspin Toys - Data Analyst.md';
    report(root, p1, { date: '2026-06-01', location: 'Lyon, France' });
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Tailspin Toys', 'Data Analyst', p1, 'v1'));
    merge(root);
    const p2 = 'reports/tier-2/Tailspin Toys - Data Analyst (re-eval).md';
    report(root, p2, { date: '2026-06-10', location: 'Lyon (hybrid)' });
    addition(root, '9.tsv', scored(9, '2026-06-10', 'Tailspin Toys', 'Data Analyst (m/f/d)', p2, 'v2', '7', '7'));
    let out = merge(root);
    let r = rows(root);
    assert.equal(r.length, 1, out);
    assert.equal(r[0].num, 1);
    assert.equal(r[0].match, '7');
    addition(root, '10.tsv', scored(10, '2026-05-01', 'Tailspin Toys', 'Data Analyst', null, 'stale', '9', '9'));
    out = merge(root);
    r = rows(root);
    assert.equal(r.length, 1, out);
    assert.equal(r[0].match, '7');
    assert.match(out, /Skip: Tailspin Toys — Data Analyst/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ambiguous: a similar title with no URL adds a row and warns, naming both rows', () => {
  const root = makeRoot();
  try {
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Nimbus Robotics', 'Business Analyst', null, 'v1'));
    merge(root);
    addition(root, '2.tsv', scored(2, '2026-06-02', 'Nimbus Robotics', 'Business Analyst Graduate Programme', 'reports/tier-2/missing.md', 'v2'));
    const out = merge(root);
    const r = rows(root);
    assert.equal(r.length, 2, out);
    assert.equal(r.find((x) => x.num === 1).notes, 'v1');
    assert.match(out, /Possible duplicate: new #2 Nimbus Robotics — Business Analyst Graduate Programme \(2026-06-02\) vs existing #1 Nimbus Robotics — Business Analyst \(2026-06-01\)/);
    assert.ok(existsSync(join(root, 'batch/scouting-additions/merged/2.tsv')));
    assert.equal(readdirSync(join(root, 'batch/scouting-additions')).filter((f) => f.endsWith('.tsv')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a listing kept apart from a look-alike does not refresh the application of the other one', () => {
  const root = makeRoot();
  try {
    const p1 = 'reports/tier-2/Nimbus Robotics - Strategy Analyst.md';
    report(root, p1, { date: '2026-06-01', url: GH(501), location: 'Lyon' });
    addition(root, '1.tsv', scored(1, '2026-06-01', 'Nimbus Robotics', 'Strategy Analyst', p1, 'lyon'));
    merge(root);
    writeFileSync(join(root, 'data/applications.md'), APPLICATIONS_SCAFFOLD.trimEnd() + '\n' +
      `| 7 | 2026-06-02 | Nimbus Robotics | Strategy Analyst | M8 E6 | Applied | ❌ | n/d | [1](${p1}) | applied |\n`);
    writeHistory(root, [{ date: '2026-06-09', company: 'Nimbus Robotics', role: 'Strategy Analyst', url: GH(502), location: 'Porto' }]);
    addition(root, '2.tsv', scored(2, '2026-06-09', 'Nimbus Robotics', 'Strategy Analyst', null, 'porto', '6.5', '5'));
    const out = merge(root);
    assert.equal(rows(root).length, 2, out);
    const app = readFileSync(join(root, 'data/applications.md'), 'utf-8').split('\n').map(parseAppRow).find((x) => x && x.num === 7);
    assert.equal(app.score, 'M8 E6', out);
    assert.notEqual(rows(root).find((x) => x.num === 2).hint, 'PROMOTED-7');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
