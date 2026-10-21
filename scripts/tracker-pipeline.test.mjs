// tracker-pipeline.test.mjs — end-to-end suite for the scoring-v2 tracker
// scripts: merge-scouting, promote-to-applications, merge-tracker,
// dedup-tracker, verify-pipeline, parse-batch-result.
//
// Each script is run as a child process against a throwaway tree (the scripts
// honour CAREER_OPS_ROOT), so this exercises the real file I/O + exit codes on
// top of the pure cores covered by lib/*-core.test.mjs. Fixtures are fictional.
//
// Run: node --test scripts/tracker-pipeline.test.mjs   (or `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCOUTING_SCAFFOLD, APPLICATIONS_SCAFFOLD, SCORE_HISTORY_HEADER } from './lib/profile-core.mjs';
import { parseScoutingRow } from './lib/scouting-core.mjs';
import { parseAppRow } from './lib/tracker-core.mjs';
import { acquireLockSync } from './lib/dir-lock.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'starpath-tracker-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports/tier-1'), { recursive: true });
  mkdirSync(join(root, 'reports/tier-2'), { recursive: true });
  mkdirSync(join(root, 'batch/scouting-additions'), { recursive: true });
  mkdirSync(join(root, 'batch/tracker-additions'), { recursive: true });
  writeFileSync(join(root, 'data/scouting.md'), SCOUTING_SCAFFOLD);
  writeFileSync(join(root, 'data/applications.md'), APPLICATIONS_SCAFFOLD);
  return root;
}

function run(script, args, root) {
  const r = spawnSync('node', [join(SCRIPTS, script), ...args], {
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: 'utf-8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf-8');
const scoutingRows = (root) => read(root, 'data/scouting.md').split('\n').map(parseScoutingRow).filter(Boolean);
const appRows = (root) => read(root, 'data/applications.md').split('\n').map(parseAppRow).filter(Boolean);

const tsv = (...cols) => cols.join('\t');
const addScouting = (root, file, ...cols) => writeFileSync(join(root, 'batch/scouting-additions', file), tsv(...cols));

const GO = ['1', '2026-06-20', 'Nimbus Robotics', 'Strategy Analyst', '8.5', '7.5', 'T1', 'green', '[#1](reports/Nimbus.md)', '2026-07-15', '', 'strong fit'];
const BLOCKED = ['2', '2026-06-20', 'Contoso Labs', 'Graduate Programme', '—', '—', 'T4', 'red: study term overlap', '—', 'n/d', '', 'Revisit next cycle: dream company'];
const STRETCH = ['3', '2026-06-21', 'Fabrikam Energy', 'Ops Analyst', '8.25', '5.6', 'T2', 'amber: start date not stated', '[#3](reports/Fabrikam.md)', 'n/d', '', ''];

/* ───── merge-scouting ───────────────────────────────────────────── */

test('merge-scouting: adds v2 rows, blocked rows keep "—", hints derive from the verdict', () => {
  const root = makeRoot();
  try {
    addScouting(root, '001-nimbus.tsv', ...GO);
    addScouting(root, '002-contoso.tsv', ...BLOCKED);
    addScouting(root, '003-fabrikam.tsv', ...STRETCH);
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const rows = scoutingRows(root);
    assert.equal(rows.length, 3);
    const nimbus = rows.find((r) => r.company === 'Nimbus Robotics');
    assert.equal(nimbus.match, '8.5');
    assert.equal(nimbus.hint, 'READY');
    assert.equal(nimbus.report, '[#1](reports/tier-1/Nimbus.md)');
    const contoso = rows.find((r) => r.company === 'Contoso Labs');
    assert.equal(contoso.match, '—');
    assert.equal(contoso.ease, '—');
    assert.equal(contoso.tier, 'T4');
    assert.equal(contoso.hint, '');
    assert.equal(contoso.eligibilityStatus, 'red');
    const fab = rows.find((r) => r.company === 'Fabrikam Energy');
    assert.equal(fab.hint, 'MONITOR');
    assert.equal(fab.eligibility, 'amber: start date not stated');
    // TSVs are archived, dedup index appended
    assert.deepEqual(readdirSync(join(root, 'batch/scouting-additions')).filter((f) => f.endsWith('.tsv')), []);
    assert.equal(read(root, 'data/dedup-index.tsv').trim().split('\n').length, 4); // header + 3
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: a red listing the profile scored through keeps its Match / Ease (still T4, no hint)', () => {
  const root = makeRoot();
  try {
    addScouting(root, '004-scored.tsv', '4', '2026-06-20', 'Nimbus Robotics', 'Data Intern', '8.5', '7.8', 'T4', 'red: starts during the study term', '—', 'n/d', 'READY', 'scored through');
    addScouting(root, '005-half.tsv', '5', '2026-06-20', 'Contoso Labs', 'Ops Intern', '8', '—', 'T4', 'red: x', '—', 'n/d', '', '');
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const rows = scoutingRows(root);
    assert.equal(rows.length, 1, 'the half-scored row is skipped');
    const r = rows[0];
    assert.deepEqual([r.match, r.ease, r.tier, r.hint, r.eligibilityStatus], ['8.5', '7.8', 'T4', '', 'red']);
    assert.match(out, /needs both Match and Ease/);
    assert.equal(run('verify-pipeline.mjs', [], root).out.includes('must have both Match and Ease'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: one file may hold a whole run (one addition per line); a bad line is skipped alone', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'batch/scouting-additions', 'run-a.tsv'), [tsv(...GO), tsv(...BLOCKED), 'not a row', tsv(...STRETCH), ''].join('\n'));
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const rows = scoutingRows(root);
    assert.deepEqual(rows.map((r) => r.company).sort(), ['Contoso Labs', 'Fabrikam Energy', 'Nimbus Robotics']);
    assert.equal(rows.find((r) => r.company === 'Nimbus Robotics').notes, 'strong fit', 'no row glued into another one');
    assert.match(out, /run-a\.tsv line 3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: a re-scored listing that is already an application refreshes that row and is marked PROMOTED', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'data/applications.md'), APPLICATIONS_SCAFFOLD.trimEnd() + '\n' +
      '| 7 | 2026-06-01 | Nimbus Robotics | Strategy Analyst | 7.4/10 | Applied | ❌ | n/d | — | applied |\n' +
      '| 8 | 2026-05-01 | Nimbus Robotics | Open Day (student event) | N/A | Rejected | ❌ | n/d | — | event |\n');
    addScouting(root, '004-nimbus.tsv', '4', '2026-06-20', 'Nimbus Robotics', 'Strategy Analyst', '8.5', '7.5', 'T1', 'green', '[4](reports/tier-1/Nimbus Robotics - Strategy Analyst.md)', 'n/d', '', 'applied already');
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const apps = appRows(root);
    const applied = apps.find((r) => r.num === 7);
    assert.equal(applied.score, 'M8.5 E7.5');
    assert.equal(applied.report, '[4](reports/tier-1/Nimbus Robotics - Strategy Analyst.md)');
    assert.equal(apps.find((r) => r.num === 8).score, 'N/A'); // sibling application untouched
    const row = scoutingRows(root).find((r) => r.company === 'Nimbus Robotics');
    assert.equal(row.hint, 'PROMOTED-7');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: parallel re-scores that share a number each update their own row', () => {
  const root = makeRoot();
  try {
    addScouting(root, '001-a.tsv', '7', '2026-06-01', 'Nimbus Robotics', 'Intern Applied AI Consulting (Italy)', '8.5', '6.3', 'T2', 'amber: degree field', '[7](reports/tier-2/Nimbus Robotics - Intern Applied AI Consulting Italy.md)', 'n/d', '', 'ai v1');
    addScouting(root, '002-b.tsv', '8', '2026-06-01', 'Nimbus Robotics', 'Associate Value Engineer', '8.25', '5.3', 'T2', 'amber: experience', '[8](reports/tier-2/Nimbus Robotics - Associate Value Engineer.md)', 'n/d', '', 've v1');
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    // Two workers in parallel both picked #13.
    addScouting(root, '003-a.tsv', '13', '2026-06-02', 'Nimbus Robotics', 'Intern Applied AI Consulting (Italy)', '8', '6.3', 'T2', 'amber: degree field', '[13](reports/tier-2/Nimbus Robotics - Intern Applied AI Consulting Italy.md)', 'n/d', '', 'ai v2');
    addScouting(root, '004-b.tsv', '13', '2026-06-02', 'Nimbus Robotics', 'Associate Value Engineer', '8', '5.3', 'T2', 'amber: experience', '[13](reports/tier-2/Nimbus Robotics - Associate Value Engineer.md)', 'n/d', '', 've v2');
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const rows = scoutingRows(root);
    assert.equal(rows.length, 2);
    const ai = rows.find((r) => r.num === 7);
    const ve = rows.find((r) => r.num === 8);
    assert.equal(ai.role, 'Intern Applied AI Consulting (Italy)');
    assert.equal(ai.match, '8');
    assert.match(ai.report, /^\[7\]\(reports\/tier-2\/Nimbus Robotics - Intern Applied AI Consulting Italy\.md\)$/);
    assert.equal(ve.role, 'Associate Value Engineer');
    assert.equal(ve.match, '8');
    assert.match(ve.report, /^\[8\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: sibling listings at one company get their own rows, never chain into one', () => {
  const root = makeRoot();
  try {
    addScouting(root, '001-a.tsv', '12', '2026-06-01', 'Nimbus Robotics', 'Associate Consultant Intern, Summer 2027 – Lyon, France', '7.85', '7.15', 'T2', 'amber: internship length not stated', '[12](reports/tier-2/Nimbus Robotics - Associate Consultant Intern.md)', 'n/d', '', 'original');
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    // One run brings four sibling listings sharing "Intern / Summer / 2027 / Lyon / France".
    addScouting(root, '002.tsv', '13', '2026-06-02', 'Nimbus Robotics', 'Product Management Intern, Summer 2027 - Lyon, France', '7.6', '7.77', 'T2', 'amber: x', '—', 'n/d', '', 'pm');
    addScouting(root, '003.tsv', '14', '2026-06-02', 'Nimbus Robotics', 'Global Markets Intern, Summer 2027 - Lyon, France', '7.1', '7.77', 'T2', 'amber: x', '—', 'n/d', '', 'gm');
    addScouting(root, '004.tsv', '15', '2026-06-02', 'Nimbus Robotics', 'Associate Consultant, Launch Program 2027 – Lyon/Nantes, France', '8.2', '7.01', 'T1', 'amber: x', '—', 'n/d', '', 'launch');
    addScouting(root, '005.tsv', '16', '2026-06-02', 'Nimbus Robotics', 'Associate Consultant Intern, Summer 2027 – Lyon, France (m/f/d)', '7.9', '7.15', 'T2', 'amber: internship length not stated', '—', 'n/d', '', 're-eval');
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const rows = scoutingRows(root);
    assert.equal(rows.length, 4, out);
    const original = rows.find((r) => r.num === 12);
    assert.equal(original.role, 'Associate Consultant Intern, Summer 2027 – Lyon, France (m/f/d)', 'the boilerplate variant re-evaluates #12');
    assert.equal(original.match, '7.9');
    assert.ok(rows.some((r) => r.role.startsWith('Product Management Intern')));
    assert.ok(rows.some((r) => r.role.startsWith('Global Markets Intern')));
    assert.ok(rows.some((r) => r.role.startsWith('Associate Consultant, Launch Program')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: a newer evaluation replaces the row (even lower) and notes M/E movement; stale ones are skipped', () => {
  const root = makeRoot();
  try {
    addScouting(root, '001-nimbus.tsv', ...GO);
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);

    // newer + LOWER → replaces
    addScouting(root, '010-nimbus.tsv', '10', '2026-07-01', 'Nimbus Robotics', 'Strategy Analyst', '7.2', '6.0', 'T2', 'amber: duration not stated', '[#10](reports/Nimbus2.md)', 'n/d', '', 'second look');
    let r = run('merge-scouting.mjs', [], root);
    assert.equal(r.code, 0, r.out);
    let rows = scoutingRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].num, 1); // keeps the original entry number
    assert.equal(rows[0].match, '7.2');
    assert.equal(rows[0].tier, 'T2');
    assert.equal(rows[0].deadline, '2026-07-15'); // survives a re-eval that omits it
    assert.equal(rows[0].hint, ''); // M7.2 E6 is `thin`: no READY/MONITOR hint
    assert.match(rows[0].notes, /^Re-eval \(M 8\.5→7\.2, E 7\.5→6\)\. second look$/);

    // older than the existing row → skipped, row untouched
    addScouting(root, '011-nimbus.tsv', '11', '2026-06-01', 'Nimbus Robotics', 'Strategy Analyst', '9', '9', 'T1', 'green', '[#11](reports/Nimbus3.md)', 'n/d', '', 'stale');
    r = run('merge-scouting.mjs', [], root);
    assert.equal(r.code, 0, r.out);
    rows = scoutingRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].match, '7.2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: a v1-shaped TSV is skipped with a warning, not merged', () => {
  const root = makeRoot();
  try {
    addScouting(root, '001-old.tsv', '5', '2026-06-20', 'Old Co', 'Analyst', '7.4/10', 'T2', '7.0/7.5', '[#5](reports/Old.md)', '2026-07-01', 'READY', 'v1 era');
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    assert.match(out, /Skipping/);
    assert.equal(scoutingRows(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: refuses to append under a pre-v2 scouting.md header', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'data/scouting.md'),
      '# Scouting\n\n| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|\n');
    addScouting(root, '001-nimbus.tsv', ...GO);
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 1);
    assert.match(out, /pre-v2 header/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ───── promote-to-applications ──────────────────────────────────── */

test('promote: copies Match/Ease into a "M.. E.." score cell, tier + eligibility into Notes, tags the scouting row', () => {
  const root = makeRoot();
  try {
    addScouting(root, '003-fabrikam.tsv', ...STRETCH);
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    const { code, out } = run('promote-to-applications.mjs', ['3'], root);
    assert.equal(code, 0, out);
    const apps = appRows(root);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].score, 'M8.25 E5.6');
    assert.equal(apps[0].status, 'Evaluated');
    assert.equal(apps[0].report, '[#3](reports/tier-2/Fabrikam.md)');
    assert.match(apps[0].notes, /^Promoted from scouting #3 \(T2, amber: start date not stated\)\./);
    assert.equal(scoutingRows(root)[0].hint, 'PROMOTED-1'); // application #1
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('promote: refuses a Blocked row and writes nothing', () => {
  const root = makeRoot();
  try {
    addScouting(root, '002-contoso.tsv', ...BLOCKED);
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    const before = read(root, 'data/applications.md');
    const { code, out } = run('promote-to-applications.mjs', ['2'], root);
    assert.equal(code, 1);
    assert.match(out, /Blocked/);
    assert.equal(read(root, 'data/applications.md'), before);
    assert.equal(scoutingRows(root)[0].hint, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ───── merge-tracker + dedup-tracker ────────────────────────────── */

const APP_HEADER = APPLICATIONS_SCAFFOLD;
const appsWith = (root, ...lines) => writeFileSync(join(root, 'data/applications.md'), APP_HEADER + lines.join('\n') + '\n');
const addTracker = (root, file, ...cols) => writeFileSync(join(root, 'batch/tracker-additions', file), tsv(...cols));

test('merge-tracker: v2 addition adds a M/E row and rewrites a flat report path via the verdict grid', () => {
  const root = makeRoot();
  try {
    addTracker(root, '7-nimbus.tsv', '7', '2026-06-22', 'Nimbus Robotics', 'Strategy Analyst', 'Evaluated', 'M8.5 E7.5', '❌', '2026-07-15', '[#7](reports/Nimbus.md)', 'fresh');
    const { code, out } = run('merge-tracker.mjs', [], root);
    assert.equal(code, 0, out);
    const apps = appRows(root);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].score, 'M8.5 E7.5');
    assert.equal(apps[0].report, '[#7](reports/tier-1/Nimbus.md)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-tracker: higher Priority replaces (with a M/E re-eval note), lower is skipped, v2 beats legacy on a tie', () => {
  const root = makeRoot();
  try {
    appsWith(root,
      '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst | M7 E6 | Applied | ✅ | n/d | [#1](reports/tier-2/N.md) | orig |',
      '| 2 | 2026-06-01 | Contoso Labs | Data Analyst Programme | 6/10 | Evaluated | ❌ | n/d | [#2](reports/tier-3/C.md) | legacy |',
    );
    // 1: M8.5 E7.5 (priority 7.98) > M7 E6 (6.48) → update, status preserved
    addTracker(root, '10-nimbus.tsv', '10', '2026-06-22', 'Nimbus Robotics', 'Strategy Analyst', 'Evaluated', 'M8.5 E7.5', '❌', 'n/d', '[#10](reports/tier-1/N2.md)', 'better');
    // 2: M9 E4 (priority 6.0) ties legacy 6/10 → v2 wins
    addTracker(root, '11-contoso.tsv', '11', '2026-06-22', 'Contoso Labs', 'Data Analyst Programme', 'Evaluated', 'M9 E4', '❌', 'n/d', '[#11](reports/tier-3/C2.md)', 'tie');
    let r = run('merge-tracker.mjs', [], root);
    assert.equal(r.code, 0, r.out);
    let apps = appRows(root);
    const nimbus = apps.find((a) => a.num === 1);
    assert.equal(nimbus.score, 'M8.5 E7.5');
    assert.equal(nimbus.status, 'Applied');
    assert.match(nimbus.notes, /^Re-eval 2026-06-22 \(M 7→8\.5, E 6→7\.5\)\. better/);
    const contoso = apps.find((a) => a.num === 2);
    assert.equal(contoso.score, 'M9 E4');
    assert.match(contoso.notes, /\(6\/10→M9 · E4\)/);

    // lower than the stored → skipped
    addTracker(root, '12-nimbus.tsv', '12', '2026-06-23', 'Nimbus Robotics', 'Strategy Analyst', 'Evaluated', 'M6 E6', '❌', 'n/d', '[#12](reports/tier-4/N3.md)', 'worse');
    r = run('merge-tracker.mjs', [], root);
    assert.equal(r.code, 0, r.out);
    apps = appRows(root);
    assert.equal(apps.find((a) => a.num === 1).score, 'M8.5 E7.5');
    assert.equal(apps.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dedup-tracker: keeps the highest-Priority duplicate and the most advanced status', () => {
  const root = makeRoot();
  try {
    appsWith(root,
      '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst Intern | M7 E6 | Applied | ✅ | n/d | [#1](reports/tier-2/N.md) |  |',
      '| 2 | 2026-06-10 | Nimbus Robotics | Strategy Analyst Intern | M8.5 E7.5 | Evaluated | ❌ | n/d | [#2](reports/tier-1/N.md) |  |',
      '| 3 | 2026-06-10 | Contoso Labs | Ops Analyst | 7.4/10 | Evaluated | ❌ | n/d | [#3](reports/tier-2/C.md) |  |',
    );
    const { code, out } = run('dedup-tracker.mjs', [], root);
    assert.equal(code, 0, out);
    const apps = appRows(root);
    assert.deepEqual(apps.map((a) => a.num).sort(), [2, 3]);
    assert.equal(apps.find((a) => a.num === 2).status, 'Applied'); // promoted from the removed row
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ───── verify-pipeline ──────────────────────────────────────────── */

test('verify-pipeline: a clean v2 tree passes, using the Deadline-aware report column', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'reports/tier-1/Nimbus.md'), '# r\n');
    addScouting(root, '001-nimbus.tsv', ...GO);
    addScouting(root, '002-contoso.tsv', ...BLOCKED);
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    appsWith(root, '| 1 | 2026-06-22 | Nimbus Robotics | Strategy Analyst | M8.5 E7.5 | Evaluated | ❌ | 2026-07-15 | [#1](reports/tier-1/Nimbus.md) | ok |');
    writeFileSync(join(root, 'data/score-history.tsv'), SCORE_HISTORY_HEADER + '\n');
    const { code, out } = run('verify-pipeline.mjs', [], root);
    assert.equal(code, 0, out);
    assert.match(out, /All scouting rows valid/);
    assert.match(out, /All scores valid/);
    assert.match(out, /All report links valid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline: flags a broken application report link (not the deadline cell) and bad scores', () => {
  const root = makeRoot();
  try {
    appsWith(root,
      '| 1 | 2026-06-22 | Nimbus Robotics | Strategy Analyst | M8.5 E7.5 | Evaluated | ❌ | 2026-07-15 | [#1](reports/tier-1/Missing.md) | ok |',
      '| 2 | 2026-06-22 | Contoso Labs | Analyst | 8.5 | Evaluated | ❌ | n/d | — |  |',
      '| 3 | 2026-06-22 | Fabrikam Energy | Analyst | M11 E5 | Evaluated | ❌ | n/d | — |  |',
      '| 4 | 2026-06-22 | Tailspin Toys | Analyst | — | Evaluated | ❌ | n/d | — |  |',
    );
    const { code, out } = run('verify-pipeline.mjs', [], root);
    assert.equal(code, 1);
    assert.match(out, /#1: Report not found: reports\/tier-1\/Missing\.md/);
    assert.match(out, /#3: score "M11 E5" out of range/);
    assert.match(out, /#4: invalid score format/);
    assert.doesNotMatch(out, /#2:/); // bare legacy number is accepted
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline: validates v2 scouting cells and rejects v1-shaped rows / headers', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'data/scouting.md'), SCOUTING_SCAFFOLD + [
      '| 1 | 2026-06-20 | A Co | R | 8.5 | 7.5 | T1 | green | — | n/d | READY |  |',
      '| 2 | 2026-06-20 | B Co | R | 8.5 | 7.5 | T9 | green | — | n/d |  |  |',
      '| 3 | 2026-06-20 | C Co | R | — | — | T2 | red: x | — | n/d |  |  |',
      '| 4 | 2026-06-20 | D Co | R | 8.5 | 7.5 | T1 | maybe | — | n/d |  |  |',
      '| 5 | 2026-06-20 | E Co | R | 6.7/10 | T2 | 7.0/6.0 | — | n/d | READY | v1 |',
      '| 6 | 2026-06-20 | F Co | R | 7 | 7 | T1 | green | — | n/d |  |  |',
    ].join('\n') + '\n');
    const { code, out } = run('verify-pipeline.mjs', [], root);
    assert.equal(code, 1);
    assert.match(out, /scouting #2: invalid tier "T9"/);
    assert.match(out, /scouting #3: red \(blocked\) row must be T4, got T2/);
    assert.match(out, /scouting #4: invalid Eligibility "maybe"/);
    assert.match(out, /scouting #5: row does not have the 12 v2 columns/);
    assert.match(out, /scouting #6: tier T1 disagrees with the verdict grid/); // warning
    assert.doesNotMatch(out, /scouting #1:/);

    writeFileSync(join(root, 'data/scouting.md'), '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n|---|---|---|---|---|---|---|---|---|---|---|\n');
    const v1 = run('verify-pipeline.mjs', [], root);
    assert.equal(v1.code, 1);
    assert.match(v1.out, /pre-v2 header/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline: checks score-history by header name', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'data/score-history.tsv'), 'date\tcompany\trole\tarchetype\toverall\n2026-06-01\tA\tR\tX\t7\n');
    const { code, out } = run('verify-pipeline.mjs', [], root);
    assert.equal(code, 1);
    assert.match(out, /score-history\.tsv header is missing required v2 column\(s\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ───── parse-batch-result ───────────────────────────────────────── */

test('parse-batch-result: prints Priority + verdict; a blocked listing prints "-" score and "blocked"', () => {
  const root = makeRoot();
  try {
    const ev = (resultText) => JSON.stringify({ type: 'result', is_error: false, duration_ms: 10, num_turns: 2, total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 }, result: resultText });
    writeFileSync(join(root, 'ok.log'), ev('```json\n{"match": 8.25, "ease": 5.6, "eligibility": "amber", "verdict": "stretch", "tier": "T2", "score": 6.8}\n```'));
    writeFileSync(join(root, 'blocked.log'), ev('```json\n{"match": null, "ease": null, "eligibility": "red", "verdict": "blocked", "tier": "T4", "score": null}\n```'));
    const ok = spawnSync('node', [join(SCRIPTS, 'parse-batch-result.mjs'), join(root, 'ok.log')], { encoding: 'utf-8' }).stdout.trim().split('\t');
    assert.equal(ok.length, 13);
    assert.equal(ok[0], 'completed');
    assert.equal(ok[1], '6.8');
    assert.equal(ok[9], 'stretch');
    assert.equal(ok[10], '-', 'no refused calls');
    assert.equal(ok[11], 'completed', 'no failure reported');
    assert.equal(ok[12], '-');
    const bl = spawnSync('node', [join(SCRIPTS, 'parse-batch-result.mjs'), join(root, 'blocked.log')], { encoding: 'utf-8' }).stdout.trim().split('\t');
    assert.equal(bl[1], '-');
    assert.equal(bl[9], 'blocked');
    const missing = spawnSync('node', [join(SCRIPTS, 'parse-batch-result.mjs'), join(root, 'nope.log')], { encoding: 'utf-8' }).stdout.trim().split('\t');
    assert.equal(missing.length, 13);
    assert.equal(missing[0], 'unknown');
    // A worker that exits 0 but reports failure in its final JSON; a closed posting is told apart.
    writeFileSync(join(root, 'failed.log'), ev('```json\n{"status": "failed", "score": null, "error": "JD unreachable"}\n```'));
    writeFileSync(join(root, 'closed.log'), ev('```json\n{"status": "failed", "score": null, "error": "posting closed"}\n```'));
    const failed = spawnSync('node', [join(SCRIPTS, 'parse-batch-result.mjs'), join(root, 'failed.log')], { encoding: 'utf-8' }).stdout.trim().split('\t');
    assert.equal(failed[0], 'failed');
    assert.equal(failed[11], 'failed');
    assert.equal(failed[12], 'JD unreachable');
    const closed = spawnSync('node', [join(SCRIPTS, 'parse-batch-result.mjs'), join(root, 'closed.log')], { encoding: 'utf-8' }).stdout.trim().split('\t');
    assert.equal(closed[11], 'closed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sanity: the scripts under test exist', () => {
  for (const f of ['merge-scouting', 'promote-to-applications', 'merge-tracker', 'dedup-tracker', 'verify-pipeline', 'parse-batch-result', 'set-status', 'reserve-report-num']) {
    assert.ok(existsSync(join(SCRIPTS, `${f}.mjs`)), f);
  }
});

/* ───── write safety: reserved numbers, origin rows, profile links ── */

function linkProfile(root) {
  // Move the trackers into a profile and link them back, as with profiles.
  mkdirSync(join(root, 'profiles/main/data'), { recursive: true });
  for (const f of ['scouting.md', 'applications.md']) {
    writeFileSync(join(root, 'profiles/main/data', f), read(root, `data/${f}`));
    rmSync(join(root, 'data', f));
    symlinkSync(`../profiles/main/data/${f}`, join(root, 'data', f));
  }
}

test('merge-scouting: a reserved number merged after a higher one keeps its number; links stay links', () => {
  const root = makeRoot();
  try {
    linkProfile(root);
    const env = { ...process.env, CAREER_OPS_ROOT: root };
    const claim = () => JSON.parse(spawnSync('node', [join(SCRIPTS, 'reserve-report-num.mjs'), '--json'], { env, encoding: 'utf-8' }).stdout).num;
    const early = claim();
    const late = claim();
    assert.deepEqual([early, late], [1, 2]);
    // the later evaluation finishes and merges first
    addScouting(root, `${late}-fab.tsv`, String(late), ...STRETCH.slice(1));
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    addScouting(root, `${early}-nimbus.tsv`, String(early), ...GO.slice(1));
    const { code, out } = run('merge-scouting.mjs', [], root);
    assert.equal(code, 0, out);
    const nums = Object.fromEntries(scoutingRows(root).map((r) => [r.company, r.num]));
    assert.deepEqual(nums, { 'Nimbus Robotics': early, 'Fabrikam Energy': late });
    assert.ok(lstatSync(join(root, 'data/scouting.md')).isSymbolicLink(), 'scouting.md is still a link');
    assert.equal(readdirSync(join(root, 'profiles/main/data/.reserved-nums/scouting')).length, 0, 'merged numbers released');
    assert.ok(!existsSync(join(root, 'profiles/main/data/.scouting.md.lock')), 'lock released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-scouting: an unreserved stale number is still renumbered past the max', () => {
  const root = makeRoot();
  try {
    addScouting(root, '005-nimbus.tsv', '5', ...GO.slice(1));
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    addScouting(root, '003-fab.tsv', '3', ...STRETCH.slice(1));
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    assert.equal(scoutingRows(root).find((r) => r.company === 'Fabrikam Energy').num, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('merge-tracker: new rows get an origin row in the status log; applications.md stays a link', () => {
  const root = makeRoot();
  try {
    linkProfile(root);
    addTracker(root, '7-nimbus.tsv', '7', '2026-06-22', 'Nimbus Robotics', 'Strategy Analyst', 'Evaluated', 'M8.5 E7.5', '❌', 'n/d', '[#7](reports/tier-1/N.md)', 'fresh');
    const { code, out } = run('merge-tracker.mjs', [], root);
    assert.equal(code, 0, out);
    assert.ok(lstatSync(join(root, 'data/applications.md')).isSymbolicLink());
    const log = readFileSync(join(root, 'profiles/main/data/status-log.tsv'), 'utf-8').trim().split('\n');
    assert.equal(log[0].split('\t')[0], 'num');
    const [num, date, company, , from, to, , source] = log[1].split('\t');
    assert.deepEqual([num, date, company, from, to, source], ['7', '2026-06-22', 'Nimbus Robotics', '', 'Evaluated', 'merge-tracker']);
    // backfill sees the origin row and adds nothing for #7
    const bf = spawnSync('node', [join(SCRIPTS, 'set-status.mjs'), 'backfill', '--json'], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8' });
    assert.deepEqual(JSON.parse(bf.stdout), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ───── older tracker writers: lock, atomic write, status log ────── */

const ledgerRows = (root) => {
  const lines = read(root, 'profiles/main/data/status-log.tsv').trim().split('\n');
  const header = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [header[i], v])));
};

test('normalize-statuses: rewrites through the profile link, logs the change, leaves no lock', () => {
  const root = makeRoot();
  try {
    appsWith(root, '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst | M7 E6 | **Applied** | ✅ | n/d | [#1](reports/tier-2/N.md) |  |');
    linkProfile(root);
    const { code, out } = run('normalize-statuses.mjs', [], root);
    assert.equal(code, 0, out);
    assert.ok(lstatSync(join(root, 'data/applications.md')).isSymbolicLink(), 'applications.md is still a link');
    assert.equal(appRows(root)[0].status, 'Applied');
    const [entry] = ledgerRows(root);
    assert.deepEqual([entry.num, entry.company, entry.from, entry.to, entry.source], ['1', 'Nimbus Robotics', '**Applied**', 'Applied', 'normalize']);
    assert.ok(!existsSync(join(root, 'profiles/main/data/.applications.md.lock')), 'lock released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normalize-statuses: waits for the tracker lock, then writes', async () => {
  const root = makeRoot();
  try {
    appsWith(root, '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst | M7 E6 | **Applied** | ✅ | n/d | [#1](reports/tier-2/N.md) |  |');
    const lock = acquireLockSync(lockPathForTest(root), { label: 'test holder' });
    let finished = false;
    const child = spawn('node', [join(SCRIPTS, 'normalize-statuses.mjs')], { env: { ...process.env, CAREER_OPS_ROOT: root } });
    const exited = new Promise((resolve) => child.on('exit', (c) => { finished = true; resolve(c); }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(finished, false, 'script is waiting on the lock');
    assert.equal(appRows(root)[0].status, '**Applied**', 'nothing written while the lock is held');
    lock.release();
    assert.equal(await exited, 0);
    assert.equal(appRows(root)[0].status, 'Applied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
const lockPathForTest = (root) => join(root, 'data/.applications.md.lock');

test('dedup-tracker: a promoted status is logged; applications.md stays a link', () => {
  const root = makeRoot();
  try {
    appsWith(root,
      '| 1 | 2026-06-01 | Nimbus Robotics | Strategy Analyst Intern | M7 E6 | Applied | ✅ | n/d | [#1](reports/tier-2/N.md) |  |',
      '| 2 | 2026-06-10 | Nimbus Robotics | Strategy Analyst Intern | M8.5 E7.5 | Evaluated | ❌ | n/d | [#2](reports/tier-1/N.md) |  |',
    );
    linkProfile(root);
    const { code, out } = run('dedup-tracker.mjs', [], root);
    assert.equal(code, 0, out);
    assert.ok(lstatSync(join(root, 'data/applications.md')).isSymbolicLink());
    assert.deepEqual(appRows(root).map((a) => [a.num, a.status]), [[2, 'Applied']]);
    const [entry] = ledgerRows(root);
    assert.deepEqual([entry.num, entry.from, entry.to, entry.source], ['2', 'Evaluated', 'Applied', 'dedup']);
    assert.ok(!existsSync(join(root, 'profiles/main/data/.applications.md.lock')), 'lock released');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('promote: writes through the profile links, gives the new row an origin entry, leaves no locks', () => {
  const root = makeRoot();
  try {
    addScouting(root, '003-fabrikam.tsv', ...STRETCH);
    assert.equal(run('merge-scouting.mjs', [], root).code, 0);
    linkProfile(root);
    const { code, out } = run('promote-to-applications.mjs', ['3'], root);
    assert.equal(code, 0, out);
    assert.ok(lstatSync(join(root, 'data/applications.md')).isSymbolicLink());
    assert.ok(lstatSync(join(root, 'data/scouting.md')).isSymbolicLink());
    assert.equal(appRows(root)[0].company, 'Fabrikam Energy');
    const [entry] = ledgerRows(root);
    assert.deepEqual([entry.num, entry.company, entry.from, entry.to, entry.source], ['1', 'Fabrikam Energy', '', 'Evaluated', 'promote']);
    for (const f of ['.applications.md.lock', '.scouting.md.lock']) assert.ok(!existsSync(join(root, 'profiles/main/data', f)), `${f} released`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('company keys: two different non-Latin companies stay two applications in merge-tracker', () => {
  const root = makeRoot();
  try {
    addTracker(root, '1-a.tsv', '1', '2026-06-22', 'Северный Ветер', 'Analyst', 'Evaluated', 'M7 E7', '❌', 'n/d', '[#1](reports/tier-2/A.md)', '');
    addTracker(root, '2-b.tsv', '2', '2026-06-22', 'Полярная Звезда', 'Analyst', 'Evaluated', 'M7 E7', '❌', 'n/d', '[#2](reports/tier-2/B.md)', '');
    assert.equal(run('merge-tracker.mjs', [], root).code, 0);
    assert.equal(appRows(root).length, 2, 'two different non-Latin companies are two applications');
    const index = read(root, 'data/dedup-index.tsv');
    assert.ok(!/^\t/m.test(index), 'no empty company key in the dedup index');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline: two different non-Latin companies with the same role are not flagged as duplicates', () => {
  const root = makeRoot();
  try {
    appsWith(root,
      '| 1 | 2026-06-01 | Северный Ветер | Analyst | M7 E6 | Applied | ❌ | n/d | — |  |',
      '| 2 | 2026-06-02 | Полярная Звезда | Analyst | M7 E6 | Applied | ❌ | n/d | — |  |',
    );
    const { out } = run('verify-pipeline.mjs', [], root);
    assert.ok(!/Possible duplicates/.test(out), out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verify-pipeline: accepts listings parked for a browser read, warns on a broken one', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, 'data/pipeline.md'), [
      '# Pipeline — Pending Evaluations', '', '## Pending',
      '- [ ] https://jobs.example.com/contoso/ops-1 | Contoso | Ops Analyst | JD saved: jds/contoso-ops-analyst.md (browser read 2026-10-21)',
      '', '## Needs a browser read',
      '- [!] BROWSER READ | https://jobs.example.com/nimbus/strategy-2 | Nimbus Robotics | Strategy Analyst | 2026-10-21: HTTP 403 to every script',
      '', '## Processed', '',
    ].join('\n'));
    mkdirSync(join(root, 'jds'));
    writeFileSync(join(root, 'jds/contoso-ops-analyst.md'), 'posting\n');
    const clean = run('verify-pipeline.mjs', [], root);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /1 listing parked for a browser read/);
    assert.doesNotMatch(clean.out, /pipeline\.md:/);

    rmSync(join(root, 'jds/contoso-ops-analyst.md'));
    writeFileSync(join(root, 'data/pipeline.md'), read(root, 'data/pipeline.md').replace('## Processed', '- [!] BROWSER READ | missing fields\n\n## Processed'));
    const warned = run('verify-pipeline.mjs', [], root);
    assert.equal(warned.code, 0, 'warnings, not errors');
    assert.match(warned.out, /parked line does not parse/);
    assert.match(warned.out, /says "JD saved: jds\/contoso-ops-analyst\.md" but that file is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
