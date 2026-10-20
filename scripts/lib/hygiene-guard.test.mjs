/**
 * hygiene-guard.test.mjs — unit tests for the leak gate's scanner.
 *
 * Every fixture is FICTIONAL (Quillfeather Dynamics, Northfield Business
 * School, Robin Quarry…). Temp folders and temp git repos only; the real
 * repo and its private data are never read.
 *
 * Run: node --test scripts/lib/hygiene-guard.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildPatterns, buildTerms, runHygieneGuard, extractPersonalData, parseCv, maskTerm,
  createMatcher, scanLine, resolveGuardDataRoot, parseUnifiedDiff, parseLeakTerms,
  parseReportName, isFamousBrand, formatHit, trackerPairs, networkNames,
} from './hygiene-guard.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'hygiene-guard.mjs');

// Tests must never touch the real repo: drop inherited git state (a hook
// runner sets GIT_DIR / GIT_INDEX_FILE) and the user's git config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
delete process.env.STARPATH_DATA;
const SCRATCH = mkdtempSync(join(tmpdir(), 'hg-test-'));
writeFileSync(join(SCRATCH, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(SCRATCH, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
});
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

let n = 0;
function tmp(prefix = 'd') {
  const d = join(SCRATCH, `${prefix}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}
function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo(files = { 'README.md': '# Demo repo\n' }) {
  const root = tmp('repo');
  g(root, 'init', '-q', '-b', 'main');
  write(root, { '.gitignore': '/private/\n/data\n', ...files });
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
  return root;
}

// ── Fictional private data ──────────────────────────────────────────────────

const CV_NEW = `# Robin Quarry

**Contact:** robin.quarry@mailbox.example | +44 7700 900123

## Education

### Northfield Business School — MSc in Analytics
Lakeside University (home school) & Example School (exchange) — Lyon
September 2025 – October 2026

### BSc in Economics — Riverbend University
2019 – 2023

## Experience

### Harbourline Logistics — Data Intern
- Built a demand dashboard.

### Analyst — Pinecrest Advisory
- Ran pricing studies.

## Projects

### Tidewatch Forecaster — demand model for a regional retailer
- Gradient boosting.

## Technical Skills
- **Programming:** Python
`;

const CV_BOLD = `# Jane Testuser
**Contact:** +1 555 123 4567 | jane@example.test

## Education
### MSc Business
**Testford Business School** — City, Country
September 2024 – June 2025

## Experience
### Analyst
**Acme Corp** — City | Jan 2024 – Jun 2024
- **Tools:** Excel
### Consultant
**Stack**: none here

## Projects
### Data Analysis
**Testford Capstone** via Testford
`;

function writePrivateRoot(root) {
  write(root, {
    'user/profile.yml': [
      'candidate:',
      '  full_name: "Robin A. Quarry"',
      '  email: "robin.quarry@mailbox.example"',
      '  phone: "+44 7700 900123"',
      '  linkedin: "linkedin.com/in/robinquarry"',
      '',
    ].join('\n'),
    'user/cv.md': CV_NEW,
    'data/network.md': [
      '| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |',
      '|---|------|---------|-------|--------------|--------|-----|--------------|-------|',
      '| 1 | Morgan Fieldfare | Quillfeather Dynamics | PM | friend | 1st | — | 2026-05-01 | |',
      '| 2 | Sol | Elsewhere | Eng | friend | 1st | — | — | |',
      '',
    ].join('\n'),
    'data/applications.md': [
      '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
      '| 1 | 2026-05-05 | **Quillfeather Dynamics** | Orbital Logistics Analyst (Lyon) | W8 E7 | Applied | ❌ | | [1](reports/tier-1/x.md) | |',
      '| 2 | 2026-05-06 | Google | Data Analyst | W7 E6 | Evaluated | ❌ | | | |',
      '',
    ].join('\n'),
    'data/scouting.md': [
      '| # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes |',
      '|---|------|---------|------|------|------|------|-------------|--------|----------|----------------|-------|',
      '| 3 | 2026-05-07 | Brindlewood Labs | Senior Data Analyst | 7 | 6 | T2 | green | | | | |',
      '',
    ].join('\n'),
    'reports/tier-2/Copperfin Systems - Treasury Analyst.md': '# report\n',
    'reports/tier-3/12-saltmarsh-energy-grid-planner-2026-05-01.md': '# report\n',
    'interview-prep/Quillfeather Dynamics - Orbital Logistics Analyst (Lyon).md': '# prep\n',
    'interview-prep/story-bank.md': '# stories\n',
    'profiles/second/data/scouting.md': [
      '| # | Date | Company | Role |',
      '|---|------|---------|------|',
      '| 9 | 2026-06-01 | Juniper Kettleworks | Brand Manager |',
      '',
    ].join('\n'),
    'leak-terms.txt': [
      '# extra terms the gate cannot infer',
      '42 Wrenfield Lane',
      'Sol Varga',
      '!Brindlewood Labs',
      '',
    ].join('\n'),
  });
}

// ── Masking ────────────────────────────────────────────────────────────────

describe('maskTerm', () => {
  it('keeps the first and last character with five dots', () => {
    assert.equal(maskTerm('Quillfeather Dynamics'), 'Q·····s');
    assert.equal(maskTerm('Abc'), 'A·····c');
    assert.equal(maskTerm('X'), 'X·····');
    assert.equal(maskTerm(''), '·····');
  });
});

// ── CV parsing ─────────────────────────────────────────────────────────────

describe('parseCv', () => {
  it('reads the ### heading format (schools, institutions line, employers, projects)', () => {
    const cv = parseCv(CV_NEW);
    assert.equal(cv.name, 'Robin Quarry');
    assert.deepEqual(cv.schools.sort(), ['Example School', 'Lakeside University', 'Northfield Business School', 'Riverbend University']);
    assert.deepEqual(cv.employers.sort(), ['Harbourline Logistics', 'Pinecrest Advisory']);
    assert.deepEqual(cv.projects, ['Tidewatch Forecaster']);
    assert.ok(cv.graduationDates.includes('October 2026') && cv.graduationDates.includes('Oct 2026'));
  });

  it('reads the older **bold** format and ignores labels', () => {
    const cv = parseCv(CV_BOLD);
    assert.deepEqual(cv.schools, ['Testford Business School']);
    assert.deepEqual(cv.employers, ['Acme Corp']);
    assert.deepEqual(cv.projects, ['Testford Capstone']);
    assert.ok(!cv.employers.includes('Tools') && !cv.employers.includes('Stack'));
  });

  it('drops generic headings and template placeholders', () => {
    const cv = parseCv('## Experience\n### [Role Title]\n**[Organization]** — [City, Country]\n## Projects\n### Personal Project — side thing\n');
    assert.deepEqual(cv.employers, []);
    assert.deepEqual(cv.projects, []);
  });
});

// ── Tables, report names, leak-terms ───────────────────────────────────────

describe('source parsers', () => {
  it('trackerPairs reads Company / Role columns, strips markdown, skips empty cells', () => {
    const pairs = trackerPairs('| # | Company | Role |\n|---|---|---|\n| 1 | **Acme Corp** | [Ops Lead](x) |\n| 2 | — | x |\n');
    assert.deepEqual(pairs, [{ company: 'Acme Corp', role: 'Ops Lead' }]);
  });
  it('networkNames reads the Name column', () => {
    assert.deepEqual(networkNames('| # | Name |\n|---|---|\n| 1 | Morgan Fieldfare |\n'), ['Morgan Fieldfare']);
  });
  it('parseReportName handles "{Company} - {Role}" and "{num}-{slug}-{date}"', () => {
    assert.deepEqual(parseReportName('Copperfin Systems - Treasury Analyst'),
      { name: 'Copperfin Systems - Treasury Analyst', company: 'Copperfin Systems', role: 'Treasury Analyst' });
    assert.equal(parseReportName('12-saltmarsh-energy-grid-planner-2026-05-01').name, 'saltmarsh energy grid planner');
    assert.equal(parseReportName('story-bank'), null);
  });
  it('parseLeakTerms: one per line, # comments, !term allows', () => {
    assert.deepEqual(parseLeakTerms('# c\nA Term\n\n!Other Term\n  spaced  \n'), { extra: ['A Term', 'spaced'], allow: ['Other Term'] });
  });
  it('isFamousBrand ignores legal and regional suffixes', () => {
    assert.ok(isFamousBrand('Google'));
    assert.ok(isFamousBrand('Google Ireland Ltd'));
    assert.ok(!isFamousBrand('Google DeepMind Fellowship'));
    assert.ok(!isFamousBrand('Quillfeather Dynamics'));
  });
});

// ── Term extraction from a private root ────────────────────────────────────

describe('extractPersonalData + buildTerms (temp private root)', () => {
  let root;
  let pd;
  let built;
  const term = (key) => built.terms.find((t) => t.key === key);
  before(() => {
    root = tmp('private');
    writePrivateRoot(root);
    pd = extractPersonalData(root);
    built = buildTerms(pd);
  });

  it('reads identity from profile.yml', () => {
    assert.equal(pd.fullName, 'Robin A. Quarry');
    assert.equal(term('robin a quarry').id, 'full_name');
    assert.equal(term('robin quarry').id, 'name_pair');
    assert.equal(term('robin quarry mailbox example').category, 'identity');
    assert.equal(term('robinquarry').category, 'identity');
  });

  it('reads schools, employers and projects from the CV', () => {
    assert.equal(term('northfield business school').category, 'school');
    assert.equal(term('lakeside university').category, 'school');
    assert.equal(term('harbourline logistics').category, 'employer');
    assert.equal(term('tidewatch forecaster').category, 'project');
  });

  it('reads people from network.md (multi-word names only)', () => {
    assert.equal(term('morgan fieldfare').category, 'person');
    assert.equal(term('sol'), undefined);
  });

  it('reads companies and roles from both trackers, every profile and file names', () => {
    assert.equal(term('quillfeather dynamics').category, 'company');
    assert.equal(term('quillfeather dynamics').standalone, true);
    assert.equal(term('juniper kettleworks').category, 'company');
    assert.equal(term('copperfin systems').category, 'company');
    assert.equal(term('copperfin systems treasury analyst').category, 'report');
    assert.equal(term('saltmarsh energy grid planner').category, 'report');
    const role = term('orbital logistics analyst lyon');
    assert.equal(role.category, 'role');
    assert.equal(role.standalone, true, 'distinctive role (≥ 3 words, non-generic) blocks alone');
    assert.equal(term('orbital logistics analyst').standalone, true, 'variant without the parenthetical');
    assert.equal(term('data analyst').standalone, false, 'short role counts only in a pair');
    assert.equal(term('google').severity, 'warn', 'famous brand alone only warns');
    assert.ok(built.pairs.some((p) => p.companyKey === 'google' && p.roleKey === 'data analyst'));
  });

  it('adds leak-terms.txt extras and honours !term', () => {
    assert.equal(term('42 wrenfield lane').category, 'extra');
    assert.equal(term('sol varga').category, 'extra');
    assert.equal(term('brindlewood labs'), undefined, '!term removes a derived term');
    assert.ok(!built.pairs.some((p) => p.companyKey === 'brindlewood labs'));
    assert.equal(term('senior data analyst').standalone, false, 'all-generic role stays pair-only');
  });

  it('ignores terms shorter than 3 characters', () => {
    const t = buildTerms({ companies: ['EY', 'Ab'], extraTerms: ['Q1'] });
    assert.equal(t.terms.length, 0);
  });

  it('missing data root → nothing extracted', () => {
    const empty = extractPersonalData(join(root, 'nope'));
    assert.equal(empty.fullName, null);
    assert.equal(buildTerms(empty).terms.length, 0);
    assert.equal(buildPatterns(empty).length, 0);
  });
});

// ── Matching semantics ─────────────────────────────────────────────────────

describe('scanLine', () => {
  const pd = {
    fullName: 'Robin Quarry', firstName: 'Robin', lastName: 'Quarry',
    schools: ['Northfield Business School'],
    companies: ['Quillfeather Dynamics', 'Google', 'Brindle'],
    roles: ['Orbital Logistics Analyst (Lyon)', 'Data Analyst'],
    pairs: [{ company: 'Google', role: 'Data Analyst' }],
    extraTerms: ['wrenfield'],
  };
  const built = buildTerms(pd);
  const ctx = { matcher: createMatcher(built), patterns: [], generic: true };
  const cats = (line, file) => scanLine(line, ctx, { file }).map((h) => `${h.category}:${h.severity}`);

  it('blocks a company in prose and matches slugs and other casing', () => {
    assert.deepEqual(cats('We applied to Quillfeather Dynamics last week.'), ['company:block']);
    assert.deepEqual(cats('see reports/quillfeather-dynamics-analyst.md'), ['company:block']);
    assert.deepEqual(cats('QUILLFEATHER   DYNAMICS'), ['company:block']);
  });

  it('single-word terms are case-sensitive', () => {
    assert.deepEqual(cats('The Brindle team'), ['company:block']);
    assert.deepEqual(cats('a brindle-coloured cat'), []);
    assert.deepEqual(cats('BRINDLE'), ['company:block']);
  });

  it('folds diacritics', () => {
    assert.deepEqual(cats('Quillfeäther Dynamics'), ['company:block']);
  });

  it('famous brands alone warn; company+role on one line blocks', () => {
    assert.deepEqual(cats('Rubric: Google is tier 1'), ['company:warn']);
    assert.deepEqual(cats('Google — Data Analyst, applied'), ['company+role:block']);
    assert.deepEqual(cats('a Data Analyst role'), []);
  });

  it('distinctive role strings block alone', () => {
    assert.deepEqual(cats('Orbital Logistics Analyst (Lyon) opening'), ['role:block']);
  });

  it('schools block in prose but only warn in a markdown table row', () => {
    assert.deepEqual(cats('you finish Northfield Business School next year'), ['school:block']);
    assert.deepEqual(cats('| **Northfield Business School** | UK | Yes |'), ['school:warn']);
  });

  it('extra terms are case-insensitive', () => {
    assert.deepEqual(cats('WrenField'), ['extra:block']);
  });

  it('skips lines with the allow marker and the package.json author line', () => {
    assert.deepEqual(cats('Quillfeather Dynamics // hygiene-guard:allow'), []);
    assert.deepEqual(cats('  "author": "Robin Quarry <someone@realmail.example>",', 'package.json'), []);
    assert.deepEqual(cats('  "description": "by Robin Quarry",', 'package.json'), ['identity:block']);
  });

  it('runs the generic patterns too', () => {
    assert.deepEqual(cats('mail robin@realmail.org'), ['email:block']); // hygiene-guard:allow
    assert.deepEqual(cats('target €67K'), ['salary:warn']);
  });
});

describe('buildPatterns (regex API)', () => {
  const MOCK_PD = {
    fullName: 'Jane Testuser', firstName: 'Jane', lastName: 'Testuser',
    email: 'jane@example.test', phone: '+1 555 123 4567', phoneDigits: '15551234567',
    schools: ['Testford Business School', 'International University'],
    employers: ['Acme Corp'], projectNames: ['Testford Capstone'],
    graduationDates: ['June 2025', 'Jun 2025', 'September 2026', 'Sep 2026'],
  };
  const pats = buildPatterns(MOCK_PD);
  const byId = (id) => pats.find((p) => p.id === id);

  it('full name, email and phone patterns', () => {
    assert.ok(byId('full_name').regex.test('Jane Testuser applied'));
    assert.ok(!byId('full_name').regex.test('Jane Smith applied'));
    assert.ok(byId('email').regex.test('contact jane@example.test for info'));
    assert.ok(!byId('email').regex.test('contact you@other.example for info'));
    assert.ok(byId('phone_full').regex.test('+1 555 123 4567'));
    const p = byId('phone_partial');
    assert.ok(p.regex.test('555 123 4567') && p.regex.test('555-123-4567'));
    assert.ok(!p.regex.test('555 987 6543'));
  });

  it('descriptions are masked, never the full term', () => {
    for (const p of pats) {
      for (const v of ['Jane Testuser', 'jane@example.test', 'Testford Business School', '555 123 4567']) {
        assert.ok(!p.description.includes(v), `${p.id} description leaks "${v}"`);
      }
    }
    assert.equal(byId('full_name').description, '[identity] J·····r');
  });

  it('graduation-date patterns: both month forms, user-addressed prose only', () => {
    assert.ok(byId('grad_date_june_2025') && byId('grad_date_jun_2025'));
    assert.ok(byId('grad_date_sep_2026').regex.test('you finish the Testford Business School MSc in Sep 2026'));
    assert.ok(!byId('grad_date_sep_2026').regex.test('// year suffixes: "(2025-2026)", "Start September 2026"'));
  });

  it('a non-generic CV school blocks; a generic one is dropped', () => {
    assert.ok(pats.some((p) => p.category === 'school' && p.regex.test('Testford Business School')));
    assert.ok(!pats.some((p) => p.category === 'school' && p.regex.test('International University')));
  });
});

// ── Data root resolution ───────────────────────────────────────────────────

describe('resolveGuardDataRoot', () => {
  const has = (...paths) => (p) => paths.includes(p);
  it('env, then <checkout>/private, then the main worktree, then legacy, then none', () => {
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: { STARPATH_DATA: '/ext' }, exists: has('/ext', '/w/private'), commonDir: null }),
      { root: '/ext', kind: 'external', source: 'env' });
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: { STARPATH_DATA: 'demo' }, exists: has('/w/demo', '/w/private'), commonDir: null }),
      { root: '/w/private', kind: 'private', source: 'checkout' }, 'the demo is fictional: ignored');
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: {}, exists: has('/w/private'), commonDir: '/main/.git' }),
      { root: '/w/private', kind: 'private', source: 'checkout' });
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: {}, exists: has('/main/private'), commonDir: '/main/.git' }),
      { root: '/main/private', kind: 'private', source: 'main-worktree' });
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: {}, exists: has('/w/user'), commonDir: null }),
      { root: '/w', kind: 'legacy', source: 'checkout' });
    assert.deepEqual(resolveGuardDataRoot({ root: '/w', env: {}, exists: has(), commonDir: null }),
      { root: null, kind: 'none', source: 'none' });
  });

  it('finds the main checkout\'s private/ from a real linked worktree', () => {
    const main = makeRepo();
    writePrivateRoot(join(main, 'private'));
    const wt = join(tmp('wt'), 'linked');
    g(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
    const r = resolveGuardDataRoot({ root: wt, env: {} });
    assert.equal(r.kind, 'private');
    assert.equal(r.source, 'main-worktree');
    assert.ok(r.root.endsWith('/private'));
  });
});

// ── Unified diff parser ────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('returns added lines with new-file line numbers and every touched path', () => {
    const diff = [
      'diff --git a/docs/a.md b/docs/a.md',
      'index 1..2 100644',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -3,0 +4,2 @@ ctx',
      '+first added',
      '++plus-prefixed content',
      '@@ -10 +12 @@',
      '-old',
      '+replaced',
      'diff --git a/img.png b/img.png',
      'new file mode 100644',
      'Binary files /dev/null and b/img.png differ',
      'diff --git a/x y.md b/x y.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/x y.md',
      '@@ -0,0 +1 @@',
      '+hello',
      '\\ No newline at end of file',
    ].join('\n');
    const { lines, paths } = parseUnifiedDiff(diff);
    assert.deepEqual(lines, [
      { file: 'docs/a.md', line: 4, text: 'first added' },
      { file: 'docs/a.md', line: 5, text: '+plus-prefixed content' },
      { file: 'docs/a.md', line: 12, text: 'replaced' },
      { file: 'x y.md', line: 1, text: 'hello' },
    ]);
    assert.deepEqual(paths, ['docs/a.md', 'img.png', 'x y.md']);
  });
});

// ── Scan modes against a temp git repo ─────────────────────────────────────

describe('runHygieneGuard — git modes (temp repo + temp private/)', () => {
  let repo;
  before(() => {
    repo = makeRepo({ 'README.md': '# Demo\nNothing personal here.\n', 'docs/old.md': 'Quillfeather Dynamics was here before\n' });
    writePrivateRoot(join(repo, 'private'));
  });

  it('tracked mode scans tracked files only, with the checkout\'s private/', async () => {
    write(repo, { 'notes-untracked.md': 'Quillfeather Dynamics\n' });
    const r = await runHygieneGuard({ root: repo });
    assert.equal(r.dataRoot.kind, 'private');
    assert.equal(r.scanned.mode, 'tracked');
    assert.deepEqual(r.violations.map((v) => `${v.file}:${v.line} ${v.category}`), ['docs/old.md:1 company']);
    rmSync(join(repo, 'notes-untracked.md'));
  });

  it('staged mode: only added lines, right line numbers, personal paths refused', async () => {
    write(repo, {
      'docs/new.md': 'line one\nOrbital Logistics Analyst (Lyon) is the role\n',
      'docs/old.md': 'Quillfeather Dynamics was here before\nand a clean new line\n',
      'data/applications-copy.md': 'anything\n',
    });
    g(repo, 'add', 'docs/new.md', 'docs/old.md');
    g(repo, 'add', '-f', 'data/applications-copy.md');
    const r = await runHygieneGuard({ root: repo, staged: true });
    const got = r.violations.map((v) => `${v.file}:${v.line} ${v.category}`).sort();
    assert.deepEqual(got, ['data/…:0 personal-path', 'docs/new.md:2 role']);
    g(repo, 'reset', '-q');
    rmSync(join(repo, 'data'), { recursive: true, force: true });
    g(repo, 'checkout', '-q', '--', 'docs/old.md');
    rmSync(join(repo, 'docs/new.md'));
  });

  it('range mode: added lines and commit messages of the range only', async () => {
    const base = g(repo, 'rev-parse', 'HEAD');
    write(repo, { 'docs/r1.md': 'clean\n' });
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'docs: notes after the Morgan Fieldfare call');
    write(repo, { 'docs/r2.md': 'x\nGoogle Data Analyst offer\n' });
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'docs: more');
    const head = g(repo, 'rev-parse', 'HEAD');
    const r = await runHygieneGuard({ root: repo, range: `${base}..${head}` });
    assert.equal(r.scanned.commits, 2);
    const got = r.violations.map((v) => `${v.kind}|${v.file}|${v.line}|${v.category}|${v.commit?.slice(0, 7)}`).sort();
    assert.deepEqual(got, [
      `file|docs/r2.md|2|company+role|${head.slice(0, 7)}`,
      `message|null|1|person|${g(repo, 'rev-parse', '--short=7', 'HEAD~1')}`,
    ].sort());
    assert.ok(!r.violations.some((v) => v.file === 'docs/old.md'), 'pre-existing content outside the range is not rescanned');
    // `<sha> --not --remotes` with no remotes = the whole history
    const all = await runHygieneGuard({ root: repo, range: [head, '--not', '--remotes'] });
    assert.ok(all.violations.some((v) => v.file === 'docs/old.md'));
    g(repo, 'reset', '-q', '--hard', base);
  });

  it('message mode skips comments and everything below the scissors line', async () => {
    const f = join(tmp('msg'), 'COMMIT_EDITMSG');
    writeFileSync(f, [
      'feat: thing',
      '',
      '# Quillfeather Dynamics in a comment is ignored',
      'Mentions Copperfin Systems',
      '# ------------------------ >8 ------------------------',
      '+Quillfeather Dynamics in the verbose diff',
    ].join('\n'));
    const r = await runHygieneGuard({ root: repo, message: f });
    assert.deepEqual(r.violations.map((v) => `${v.kind}:${v.line}:${v.category}`), ['message:4:company']);
  });

  it('generic-only ignores private terms', async () => {
    write(repo, { 'docs/g.md': 'Quillfeather Dynamics\nping robin@realmail.org\n' }); // hygiene-guard:allow
    g(repo, 'add', 'docs/g.md');
    const r = await runHygieneGuard({ root: repo, staged: true, genericOnly: true });
    assert.equal(r.dataRoot.kind, 'none');
    assert.deepEqual(r.violations.map((v) => v.category), ['email']);
    g(repo, 'reset', '-q');
    rmSync(join(repo, 'docs/g.md'));
  });

  it('file names are scanned and masked in the output', async () => {
    write(repo, { 'docs/Quillfeather Dynamics notes.md': 'clean\n' });
    g(repo, 'add', '-A');
    const r = await runHygieneGuard({ root: repo, staged: true });
    assert.equal(r.violations.length, 1);
    const line = formatHit(r.violations[0]);
    assert.ok(!line.includes('Quillfeather'), line);
    assert.match(line, /^docs\/Q·····d \(file name\)  \[company\]  Q·····s$/);
    g(repo, 'reset', '-q');
    rmSync(join(repo, 'docs/Quillfeather Dynamics notes.md'));
  });

  it('no data root → generic checks only', async () => {
    const bare = makeRepo({ 'a.md': 'Quillfeather Dynamics\n' });
    const r = await runHygieneGuard({ root: bare });
    assert.equal(r.dataRoot.kind, 'none');
    assert.equal(r.violations.length, 0);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  it('prints masked hits only, exits 1 on a block, --json has no terms', () => {
    const repo = makeRepo();
    writePrivateRoot(join(repo, 'private'));
    write(repo, { 'docs/leak.md': 'Robin Quarry interviewed at Quillfeather Dynamics for Orbital Logistics Analyst (Lyon)\n' });
    g(repo, 'add', '-A');
    const run = (...args) => spawnSync(process.execPath, [GUARD, '--root', repo, ...args], { encoding: 'utf-8' });
    const r = run('--staged');
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1);
    assert.match(out, /docs\/leak\.md:1 {2}\[company\+role\] {2}Q·····s \+ O·····n/);
    assert.match(out, /docs\/leak\.md:1 {2}\[identity\] {2}R·····y/);
    for (const secret of ['Quillfeather', 'Robin Quarry', 'Orbital Logistics']) assert.ok(!out.includes(secret), `output leaks ${secret}`);
    const j = run('--staged', '--json');
    assert.equal(j.status, 1);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.mode, 'staged');
    assert.ok(parsed.blocking >= 2);
    assert.ok(!j.stdout.includes('Quillfeather'));
    const bad = run('--bogus');
    assert.equal(bad.status, 2);
  });

  it('warns once when no private data is found', () => {
    const repo = makeRepo();
    const r = spawnSync(process.execPath, [GUARD, '--root', repo], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no private data found: generic checks only/);
  });
});

// ── Legacy layout (plain folder, user/ + data/ at the root) ────────────────

async function makeFakeRepo(files) {
  const root = tmp('fake');
  write(root, {
    'user/profile.yml': 'candidate:\n  full_name: "Jane Testuser"\n  email: "jane@example.test"\n  phone: "+1 555 123 4567"\n',
    'user/cv.md': CV_BOLD,
    ...files,
  });
  return root;
}

describe('runHygieneGuard — legacy layout, plain folder', () => {
  it('passes when system files have no personal data', async () => {
    const root = await makeFakeRepo({
      'modes/_shared.md': '## Scoring\nThe agent reads user/cv.md at evaluation time.\n',
      'scripts/score.mjs': '// Generic scoring logic\nexport function score() { return 7; }\n',
    });
    const result = await runHygieneGuard({ root });
    assert.equal(result.dataRoot.kind, 'legacy');
    assert.equal(result.violations.length, 0);
  });

  it('never scans the personal folders themselves', async () => {
    const root = await makeFakeRepo({});
    const result = await runHygieneGuard({ root });
    assert.equal(result.violations.length, 0, 'user/cv.md is the source, not a leak');
  });

  it('catches the full name in a mode file', async () => {
    const root = await makeFakeRepo({ 'modes/example.md': '## Example\nFor a candidate like Jane Testuser, the score would be 8.\n' });
    const v = (await runHygieneGuard({ root })).violations.find((x) => x.pattern.id === 'full_name');
    assert.ok(v);
    assert.equal(v.file, 'modes/example.md');
  });

  it('catches the email in a template and the phone digits in a placeholder', async () => {
    const root = await makeFakeRepo({
      'templates/cv.html': '<p>Contact: jane@example.test</p>\n',
      'frontend/src/PhoneField.tsx': 'const field = <input placeholder="555 123 4567" />\n',
    });
    const r = await runHygieneGuard({ root });
    assert.ok(r.violations.find((v) => v.pattern.id === 'email' && v.file === 'templates/cv.html'));
    assert.ok(r.violations.find((v) => v.pattern.id === 'phone_partial' && v.file === 'frontend/src/PhoneField.tsx'));
  });

  it('catches a graduation date with the school in prose', async () => {
    const root = await makeFakeRepo({ 'modes/interview-prep.md': 'Remember that you finish the MSc in Jun 2025.\n' });
    const r = await runHygieneGuard({ root });
    assert.ok(r.violations.find((v) => v.pattern.id === 'grad_date_jun_2025'));
  });

  it('a school in a reference table only warns', async () => {
    const root = await makeFakeRepo({ 'modes/_shared.md': '| School | Market |\n|---|---|\n| **Testford Business School** | UK |\n' });
    const r = await runHygieneGuard({ root });
    assert.equal(r.violations.length, 0);
    assert.ok(r.warnings.find((w) => w.category === 'school'));
  });

  it('generic second-person voice and salary examples are not violations', async () => {
    const root = await makeFakeRepo({ 'modes/scouting.md': 'Address the candidate as "you".\nExample: "your target salary is €40K".\n' });
    const r = await runHygieneGuard({ root });
    assert.equal(r.violations.length, 0);
    assert.deepEqual(r.warnings.map((w) => w.category), ['salary']);
  });

  it('respects the hygiene-guard:allow marker', async () => {
    const root = await makeFakeRepo({ 'scripts/fixtures.mjs': '// Jane Testuser fixture // hygiene-guard:allow\n' });
    assert.equal((await runHygieneGuard({ root })).violations.length, 0);
  });

  it('root docs (CLAUDE.md) and batch/ files are scanned and block', async () => {
    const root = await makeFakeRepo({
      'CLAUDE.md': 'For a candidate like Jane Testuser.\n',
      'batch/batch-prompt.md': 'Contact the candidate at jane@example.test.\n',
    });
    const r = await runHygieneGuard({ root });
    assert.ok(r.violations.find((v) => v.file === 'CLAUDE.md' && v.pattern.id === 'full_name'));
    assert.ok(r.violations.find((v) => v.file === 'batch/batch-prompt.md' && v.pattern.id === 'email'));
  });

  it('include: scans only the given folders (the demo check)', async () => {
    const root = await makeFakeRepo({ 'demo/data/applications.md': '| 1 | Acme Corp | Analyst |\n', 'modes/x.md': 'Acme Corp\n' });
    const r = await runHygieneGuard({ root, include: ['demo'] });
    assert.equal(r.scanned.mode, 'paths');
    assert.deepEqual(r.violations.map((v) => v.file), ['demo/data/applications.md']);
  });

  it('tracked symlinks are scanned by their target', async () => {
    const root = await makeFakeRepo({});
    mkdirSync(join(root, 'docs'), { recursive: true });
    symlinkSync('/Users/jtestuser/notes', join(root, 'docs', 'link')); // hygiene-guard:allow
    const r = await runHygieneGuard({ root });
    assert.deepEqual(r.violations.map((v) => `${v.file}:${v.category}`), ['docs/link:home-path']);
  });

  it('gracefully handles missing user data', async () => {
    const root = tmp('empty');
    write(root, { 'modes/test.md': 'Some content here.\n' });
    const result = await runHygieneGuard({ root });
    assert.equal(result.personalData.fullName, null);
    assert.equal(result.patterns.length, 0);
    assert.equal(result.violations.length, 0);
    assert.equal(result.dataRoot.kind, 'none');
  });
});
