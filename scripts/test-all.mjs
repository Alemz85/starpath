#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for career-ops
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, dashboard, data contract, personal data, paths.
 *
 * Usage:
 *   node scripts/test-all.mjs           # Run all tests
 *   node scripts/test-all.mjs --quick   # Skip dashboard build (faster)
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync } from 'fs';
import { join, dirname, sep } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { isPersonalPath, PRIVATE_DIR } from './lib/data-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SCRIPTS_DIR = __dirname;
const QUICK = process.argv.includes('--quick');

let passed = 0;
let failed = 0;
let warnings = 0;

function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

function run(cmd, args = [], opts = {}) {
  try {
    if (Array.isArray(args) && args.length > 0) {
      return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
    }
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    return null;
  }
}

function fileExists(path) { return existsSync(join(ROOT, path)); }
function readFile(path) { return readFileSync(join(ROOT, path), 'utf-8'); }

console.log('\n🧪 career-ops test suite\n');

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run('node', ['--check', join('scripts', f)]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────
//
// These scripts WRITE the trackers (normalize, dedup, merge), so they never
// run against the real data: they run from a copy of scripts/ inside a temp
// sandbox holding a copy of demo/ (or, without a demo, empty trackers), with
// CAREER_OPS_ROOT and STARPATH_DATA pointing at the sandbox. A script that
// only knows its own location still resolves to the sandbox.

console.log('\n2. Script execution (temp sandbox: copy of demo/, never the real data)');

{
  const SANDBOX = mkdtempSync(join(tmpdir(), 'career-ops-test-'));
  try {
    const demoDir = join(ROOT, 'demo');
    if (existsSync(demoDir)) {
      cpSync(demoDir, SANDBOX, { recursive: true, filter: (src) => !src.startsWith(join(demoDir, 'chat')) });
    } else {
      mkdirSync(join(SANDBOX, 'data'), { recursive: true });
      writeFileSync(join(SANDBOX, 'data', 'applications.md'), [
        '# Applications Tracker', '',
        '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
        '|---|------|---------|------|-------|--------|-----|----------|--------|-------|', '',
      ].join('\n'));
    }
    mkdirSync(join(SANDBOX, 'batch', 'tracker-additions'), { recursive: true });
    cpSync(join(ROOT, 'scripts'), join(SANDBOX, 'scripts'), {
      recursive: true,
      filter: (src) => !src.endsWith('.test.mjs') && !src.includes(`${sep}jobspy`) && !src.includes('__pycache__'),
    });
    cpSync(join(ROOT, 'templates'), join(SANDBOX, 'templates'), { recursive: true });
    writeFileSync(join(SANDBOX, 'CLAUDE.md'), '# test sandbox\n');
    if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(SANDBOX, 'node_modules'), 'dir');

    const sandboxEnv = { ...process.env, CAREER_OPS_ROOT: SANDBOX, STARPATH_DATA: SANDBOX };
    const scripts = [
      { name: 'cv-sync-check.mjs', allowFail: true }, // exits 1 on CV/profile mismatches
      { name: 'verify-pipeline.mjs' },
      { name: 'normalize-statuses.mjs' },
      { name: 'dedup-tracker.mjs' },
      { name: 'merge-tracker.mjs' },
    ];
    const source = existsSync(demoDir) ? 'demo copy' : 'empty trackers';
    for (const { name, allowFail } of scripts) {
      const result = run('node', [join(SANDBOX, 'scripts', name)], { cwd: SANDBOX, env: sandboxEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      if (result !== null) {
        pass(`scripts/${name} runs OK (${source})`);
      } else if (allowFail) {
        warn(`scripts/${name} exited with error (${source})`);
      } else {
        fail(`scripts/${name} crashed (${source})`);
      }
    }
  } finally {
    rmSync(SANDBOX, { recursive: true, force: true });
  }
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(SCRIPTS_DIR, 'liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 3b. BACKEND UNIT TESTS (scoring core) ───────────────────────
//
// The scoring engine (scripts/lib/score-bands.mjs et al.) has a direct
// node:test unit suite — eligibility checks, Match / Ease rollups, the
// intern carve-out, every verdict-grid cell. Section 10 below also exercises the
// end-to-end scoring fixtures through score-listing.mjs; this catches
// per-function regressions the fixtures don't.

console.log('\n3b. Backend unit tests (scoring core)');

{
  const result = run('node', ['--test', 'scripts/**/*.test.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  if (result !== null) {
    pass('backend unit suite passes');
  } else {
    fail('backend unit suite has failures (run `npm test` for detail)');
  }
}

// ── 4. FRONTEND UNIT TESTS ──────────────────────────────────────
//
// The renderer's pure logic (applications.md mutators, entity identity,
// score bands, export serialization, the parsers…) has its own zero-dep
// node:test suite under frontend/. Run it as part of the gate so a renderer
// regression is caught here too. Skips gracefully when the Electron app's
// deps aren't installed (e.g. a backend-only checkout).

console.log('\n4. Frontend unit tests');

const frontendDir = join(ROOT, 'frontend');
if (!existsSync(join(frontendDir, 'node_modules'))) {
  warn('frontend/node_modules missing — `npm install` in frontend/ to enable renderer tests');
} else {
  const result = run('npm', ['--prefix', frontendDir, 'test'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
  if (result !== null) {
    pass('frontend unit suite passes');
  } else {
    fail('frontend unit suite has failures (run `npm test` in frontend/ for detail)');
  }
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'DATA_CONTRACT.md',
  'modes/_shared.md',
  'modes/scouting.md', 'modes/pdf.md', 'modes/scan.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/career-ops/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Nothing personal is tracked: no file under private/ and no personal path
// (user/ data/ reports/ … batch state, profiles/; see data-root.mjs). Only
// the top-level folder is printed — a file name can itself be personal.
{
  const tracked = (run('git', ['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
  const personal = tracked.filter((p) => p === PRIVATE_DIR || p.startsWith(`${PRIVATE_DIR}/`) || isPersonalPath(p));
  if (personal.length === 0) {
    pass(`No tracked file under ${PRIVATE_DIR}/ or a personal path (${tracked.length} tracked files)`);
  } else {
    const byTop = {};
    for (const p of personal) { const top = p.split('/')[0]; byTop[top] = (byTop[top] || 0) + 1; }
    for (const [top, count] of Object.entries(byTop)) {
      fail(`Personal path tracked: ${top}/… (${count} file${count === 1 ? '' : 's'}) — git rm --cached it; it belongs in private/`);
    }
  }
}

// Leak-gate hooks (pre-commit / commit-msg / pre-push) installed? Warn only:
// CI and fresh clones legitimately don't have them.
try {
  const { checkHooks } = await import(pathToFileURL(join(SCRIPTS_DIR, 'install-hooks.mjs')).href);
  const s = checkHooks({ root: ROOT });
  if (s.installed) pass('Leak-gate hooks installed (core.hooksPath=.githooks)');
  else warn(`Leak-gate hooks not installed (core.hooksPath ${s.hooksPath ? `= "${s.hooksPath}"` : 'not set'}) — run: npm run hooks`);
} catch (e) {
  warn(`Could not check the leak-gate hooks: ${e.message}`);
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'user/profile.yml', 'user/_profile.md', 'user/portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────
//
// Three layers:
//
// 6a. Static legacy patterns (hardcoded prior-user strings still checked for
//     belt-and-suspenders — these don't depend on user/profile.yml being present).
//
// 6b. The leak gate's scanner (scripts/lib/hygiene-guard.mjs) over every
//     tracked file: private terms derived at run time from the data root
//     (private/, the main worktree's private/ from a linked worktree, or a
//     legacy user/ + data/) plus the generic patterns. Output is masked.
//     Without private data only the generic patterns run (warning).
//
// 6c. Demo leak check: when private data AND demo/ exist, no private-derived
//     term may appear anywhere under demo/.

console.log('\n6. Personal data leak check');

// 6a — static legacy strings -------------------------------------------------
const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/', // hygiene-guard:allow (legacy upstream strings)
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.es.md', 'README.ja.md', 'README.ko-KR.md',
  'README.pt-BR.md', 'README.ru.md',
  // Standard project files
  'LICENSE', 'CITATION.cff', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'go.mod', 'test-all.mjs',
  // Community / governance files (added in v1.3.0, all legitimately reference the maintainer)
  'CODE_OF_CONDUCT.md', 'GOVERNANCE.md', 'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
  // Dashboard credit string
  'dashboard/internal/ui/screens/pipeline.go',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
const grepPathspec = scanExtensions.map(e => `'*.${e}'`).join(' ');

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    `git grep -n "${pattern}" -- ${grepPathspec} 2>/dev/null`
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      if (file.includes('dashboard/go.mod')) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No static-pattern personal data leaks outside allowed files');
}

// 6b — leak gate over tracked files (private terms from the data root) -------
const GENERIC_CATEGORIES = new Set(['email', 'phone', 'home-path', 'secret', 'salary']);
let leakResult = null;
let guardMod = null;
try {
  guardMod = await import(pathToFileURL(join(SCRIPTS_DIR, 'lib', 'hygiene-guard.mjs')).href);
  leakResult = await guardMod.runHygieneGuard({ root: ROOT });
  const { violations, warnings: guardWarnings, dataRoot, scanned } = leakResult;
  if (dataRoot.kind === 'none') {
    warn('No private data found (private/, main worktree, legacy user/ + data/): private-term leak check skipped, generic patterns only');
  }
  const blocking = violations.filter((v) => v.category !== 'home-path');
  for (const v of blocking) fail(`Leak — ${guardMod.formatHit(v)}`);
  if (blocking.length === 0) {
    const what = dataRoot.kind === 'none' ? 'generic patterns' : `${scanned.terms} private terms + generic patterns`;
    pass(`Leak gate: no blocking hits in ${scanned.files} tracked files (${what})`);
  }
  if (guardWarnings.length) {
    const byCat = {};
    for (const w of guardWarnings) byCat[w.category] = (byCat[w.category] || 0) + 1;
    const summary = Object.entries(byCat).map(([c, n]) => `${c} ${n}`).join(', ');
    warn(`Leak gate: ${guardWarnings.length} warning(s) (${summary}) — review with npm run leak-check`);
  }
} catch (e) {
  fail(`Leak gate crashed: ${e.message}`);
}

// 6c — demo/ must not contain any private-derived term ---------------------
if (leakResult && leakResult.dataRoot.kind !== 'none' && existsSync(join(ROOT, 'demo'))) {
  try {
    const demo = await guardMod.runHygieneGuard({ root: ROOT, include: ['demo'] });
    const priv = demo.hits.filter((h) => !GENERIC_CATEGORIES.has(h.category));
    for (const h of priv) fail(`Demo leak — ${guardMod.formatHit(h)}`);
    if (priv.length === 0) pass(`demo/ contains no private-derived term (${demo.scanned.files} files)`);
  } catch (e) {
    fail(`Demo leak check crashed: ${e.message}`);
  }
} else {
  console.log('  ·  Demo leak check skipped (needs private data and demo/)');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────
//
// /Users/<name>/ and /home/<name>/ in any tracked file (the leak gate's
// generic home-path pattern; placeholders like /Users/you/ are fine, and
// `hygiene-guard:allow` exempts a line).

console.log('\n7. Absolute path check');

if (leakResult) {
  const homePaths = leakResult.violations.filter((v) => v.category === 'home-path');
  if (homePaths.length === 0) pass('No absolute home paths in tracked files');
  for (const v of homePaths) fail(`Absolute path: ${guardMod.formatHit(v)}`);
} else {
  fail('Absolute path check skipped: the leak gate did not run');
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', 'scouting.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
  'interview-prep.md', 'positioning.md', 'db.md', 'deadlines.md',
  'patterns.md', 'followup.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// Check _shared.md references _profile.md
const shared = readFile('modes/_shared.md');
if (shared.includes('_profile.md')) {
  pass('_shared.md references _profile.md');
} else {
  fail('_shared.md does NOT reference _profile.md');
}

// ── 9. CLAUDE.md INTEGRITY ──────────────────────────────────────

console.log('\n9. CLAUDE.md integrity');

const claude = readFile('CLAUDE.md');
const requiredSections = [
  'Data Contract', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (claude.includes(section)) {
    pass(`CLAUDE.md has section: ${section}`);
  } else {
    fail(`CLAUDE.md missing section: ${section}`);
  }
}

// ── 10. Scoring fixtures ────────────────────────────────────────
// These pin known-good inputs so any future change to score-bands.mjs,
// eligibility.mjs or score-listing.mjs that breaks the math gets caught
// here. Scoring v2 (docs/scoring-v2.md): eligibility gate → Match / Ease →
// verdict grid. Companies and candidates are fictional; every fixture
// passes its own eligibility_profile + scoring_weights so the real
// user/profile.yml is never read.

console.log('\n10. Scoring fixtures');

const { scoreListing } = await import(pathToFileURL(join(SCRIPTS_DIR, 'score-listing.mjs')).href);

const FX_TODAY = '2026-10-20';
const FX_PROFILE = {
  available_from: '2026-11-01',
  blocked_windows: [{ from: '2027-01-01', to: '2027-05-31', reason: 'study term' }],
  graduations: [{ degree: 'MSc', date: '2026-10' }],
  languages: [{ language: 'English', level: 'C2' }, { language: 'Spanish', level: 'B2' }],
  work_authorisation: ['EU'],
  duration_months: { min: 3, max: 12 },
  permanent_start_ok_before_block: false,
};
// Green facts for a permanent role that starts after the blocked window.
const FX_GREEN_FACTS = {
  employment: 'permanent',
  start: { earliest: '2027-07-01', latest: null, flexible: false },
  languages: [{ language: 'English', level: 'C1', required: true }],
  work_auth: { requires_existing_right: false, sponsorship: 'unknown', below_sponsorship_salary_floor: false },
};
const FX_INTERN_FACTS = {
  employment: 'internship',
  start: { earliest: '2027-06-15', flexible: false },
  duration_months: 6,
  languages: [{ language: 'English', level: 'C1', required: true }],
};
const fx = (o) => ({
  today: FX_TODAY,
  eligibility_profile: FX_PROFILE,
  scoring_weights: {},
  soft_benefits_modifier: 0,
  eligibility_facts: FX_GREEN_FACTS,
  ...o,
});
const JS = (o = {}) => ({
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7,
  best_cities: 7, work_life_balance: 7,
  skills_match: 7, experience_bar: 7, competition: 7, ...o,
});

const FIXTURES = [
  {
    name: 'Green go — high comp, big equity, expensive city (salary math pinned)',
    input: fx({
      company: 'Northwind Analytics', role_archetype: 'Software Engineer',
      city: 'Dublin', country: 'IE',
      comp: { base: 105000, bonusPct: 0.15, equityAnnualEur: 34500 },
      tax_override: { rate: 0.32, source: 'fixture' },
      col_override: { baseline_eur: 3050, source: 'fixture' },
      soft_benefits_modifier: 0.5,
      judgment_scores: JS({
        growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 8,
        best_cities: 8, work_life_balance: 7,
        skills_match: 8, experience_bar: 7, competition: 7,
      }),
    }),
    expect: {
      'eligibility.status': 'green',
      'salary_adj_for_city.score': 10,
      'salary_adj_for_city.computed.totalComp': 155250,
      // M = (9+9+9+8)/4 = 8.75; hygiene: city 8 → +0.25, salary 10 → +0.25, WLB 7 → 0
      'match.score': 9.25,
      'match.motivators_mean': 8.75,
      // exp(0.35·ln8 + 0.35·ln7 + 0.30·ln7) = 7.33
      'ease.score': 7.33,
      'priority': 8.23,
      'verdict': 'go',
      'tier': 'T1',
      'promotion_hint': 'READY',
    },
  },
  {
    name: 'Amber thin — internship start not stated; negative savings (salary math pinned)',
    input: fx({
      company: 'Fabrikam Consulting', role_archetype: 'Business Analyst',
      city: 'Barcelona', country: 'ES',
      comp: { base: 30000 },
      tax_override: { rate: 0.22, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      eligibility_facts: { ...FX_INTERN_FACTS, start: { earliest: null } },
      judgment_scores: JS({
        growth_mobility: 9, optionality_exit: 8, brand_value: 9, role_content: 8,
        best_cities: 10, work_life_balance: 7,
        skills_match: 8, experience_bar: 6, competition: 6,
      }),
    }),
    expect: {
      'eligibility.status': 'amber',
      'eligibility.amber_count': 1,
      'eligibility.checks.0.check': 'start_date',
      'salary_adj_for_city.score': 3,
      'salary_adj_for_city.computed.savings': -50,
      // M 8.5 + city +0.25 + salary(3) −0.80 = 7.95 → just under the top row
      'match.score': 7.95,
      // geometric 6.64 − 0.5 amber = 6.14
      'ease.geometric': 6.64,
      'ease.amber_penalty': 0.5,
      'ease.score': 6.14,
      'verdict': 'thin',
      'tier': 'T2',
    },
  },
  {
    name: 'Amber stretch — warm-direct referral lifts Competition',
    input: fx({
      company: 'Contoso Mobility', role_archetype: 'Strategy Analyst',
      city: 'Madrid', country: 'ES',
      comp: { base: 45000, bonusPct: 0.10 },
      tax_override: { rate: 0.27, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      referral: 'warm-direct',
      eligibility_facts: { ...FX_GREEN_FACTS, country: 'GB' },   // sponsorship unknown → amber
      judgment_scores: JS({
        growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7,
        best_cities: 8, work_life_balance: 6,
        skills_match: 8, experience_bar: 6, competition: 5,
      }),
    }),
    expect: {
      'eligibility.status': 'amber',
      'calibrated_dims.competition.final': 6,
      'calibrated_dims.competition.adjustments.0.source': 'warm-direct referral',
      'match.score': 8.25,
      'ease.score': 6.14,
      'verdict': 'stretch',
      'tier': 'T2',
      'tier_reason': 'Match 8.25 ≥ 8.0, Ease 6.14 in 5.0–7.0',
      'promotion_hint': 'MONITOR',
    },
  },
  {
    name: 'Red blocked — required language missing; no judgment scores, no comp, no lookups',
    input: {
      today: FX_TODAY,
      eligibility_profile: FX_PROFILE,
      scoring_weights: {},
      company: 'Northwind Analytics', role_archetype: 'Marketing Analyst',
      city: 'Munich', country: 'DE',
      calibration: { dream_companies: ['Northwind Analytics'] },
      eligibility_facts: { ...FX_GREEN_FACTS, languages: [{ language: 'German', level: 'C1', required: true }] },
    },
    expect: {
      'eligibility.status': 'red',
      'verdict': 'blocked',
      'verdict_label': 'Blocked',
      'tier': 'T4',
      'match': null,
      'ease': null,
      'priority': null,
      'salary_adj_for_city': undefined,
      'explanation.verdict': 'blocked',
    },
    check: (r) => typeof r.note === 'string' && r.note.startsWith('Revisit next cycle: language:'),
  },
  {
    name: 'Intern — €1,200/mo stipend at half baseline; salary term is 0 for Match',
    input: fx({
      company: 'Litware Labs', role_archetype: 'Data Analyst Intern',
      city: 'Barcelona', country: 'ES',
      comp: { base: 14400 },   // €1,200/mo × 12
      tax_override: { rate: 0.0, source: 'fixture (intern stipend, post-tax)' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      is_intern: true,
      eligibility_facts: FX_INTERN_FACTS,
      judgment_scores: JS({ best_cities: 10 }),
    }),
    expect: {
      // €1,200 − €1,000 (half of the 2000 baseline) = €200 → band 4
      'salary_adj_for_city.score': 4,
      'salary_adj_for_city.computed.savings': 200,
      'match.hygiene.salary_adj_city': 0,
      // M 7 + city +0.25 (salary ignored)
      'match.score': 7.25,
      'verdict': 'solid',
    },
  },
  {
    name: 'Intern carve-out — €800/mo stipend (salary 2) does not veto Match',
    input: fx({
      company: 'Litware Labs', role_archetype: 'Marketing Intern',
      city: 'Madrid', country: 'ES',
      comp: { base: 9600 },
      tax_override: { rate: 0.0, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      is_intern: true,
      eligibility_facts: FX_INTERN_FACTS,
      judgment_scores: JS({ best_cities: 9 }),
    }),
    expect: {
      // €800 − €1,000 = −€200 → band 2
      'salary_adj_for_city.score': 2,
      'match.score': 7.25,
      'match.vetoes.length': 0,
    },
  },
  {
    name: 'Hygiene veto — non-intern at poverty salary (score 1) caps Match at 5.0',
    input: fx({
      company: 'Litware Labs', role_archetype: 'Marketing Analyst',
      city: 'Madrid', country: 'ES',
      comp: { base: 18000 },
      tax_override: { rate: 0.15, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      judgment_scores: JS({ best_cities: 9 }),
    }),
    expect: {
      // €18,000 × 0.85 / 12 = €1,275 − €2,000 = −€725 → band 1
      'salary_adj_for_city.score': 1,
      'match.raw': 6.05,
      'match.score': 5,
      'match.vetoes.0.dimension': 'salary_adj_city',
      'verdict': 'skip',
      'tier': 'T4',
    },
  },
  {
    name: 'Dream-company floor — Brand stays a CV signal, Match floored to 8.0',
    input: fx({
      company: 'Northwind Analytics', role_archetype: 'Solutions Consultant',
      city: 'Lyon', country: 'FR',
      comp: { base: 40000 },
      tax_override: { rate: 0.25, source: 'fixture' },
      col_override: { baseline_eur: 1800, source: 'fixture' },
      calibration: { dream_companies: ['Northwind Analytics'] },
      judgment_scores: JS({
        growth_mobility: 6, optionality_exit: 6, brand_value: 5, role_content: 6,
        best_cities: 6, work_life_balance: 6,
      }),
    }),
    expect: {
      'calibrated_dims.brand_value.final': 5,   // preference never moves Brand
      // M = (6+6+5+6)/4 = 5.75; salary 6 → 0
      'match.raw': 5.75,
      'match.floor.to': 8,
      'match.score': 8,
      'verdict': 'go',
    },
  },
  {
    name: 'Dream floor loses to the role-content veto',
    input: fx({
      company: 'Northwind Analytics', role_archetype: 'Account Executive',
      city: 'Lyon', country: 'FR',
      comp: { base: 40000 },
      tax_override: { rate: 0.25, source: 'fixture' },
      col_override: { baseline_eur: 1800, source: 'fixture' },
      calibration: { dream_companies: ['Northwind Analytics'] },
      judgment_scores: JS({ role_content: 3 }),
    }),
    expect: {
      'match.uncapped': 8,
      'match.score': 6,
      'match.vetoes.0.kind': 'role_content_veto',
      'verdict': 'skip',
    },
  },
  {
    name: 'Brand calibration — only extra_brand_bonuses move Brand (affinity list does not)',
    input: fx({
      company: 'Contoso Mobility', role_archetype: 'Account Strategist',
      city: 'Dublin', country: 'IE',
      comp: { base: 60000, bonusPct: 0.10 },
      tax_override: { rate: 0.30, source: 'fixture' },
      col_override: { baseline_eur: 3000, source: 'fixture' },
      calibration: {
        brand_affinity_companies: ['Contoso Mobility', 'Fabrikam Consulting'],
        extra_brand_bonuses: [{ company: 'Contoso Mobility', bonus: 1.0, reason: 'household name in the target market' }],
        dream_companies: [],
      },
      judgment_scores: JS({ brand_value: 8 }),
    }),
    expect: {
      'calibrated_dims.brand_value.final': 9,
    },
  },
  {
    name: 'Lower-tier dream — +0.25 Match preference, Brand unchanged, no Match floor',
    input: fx({
      company: 'Litware Labs', role_archetype: 'Operations Analyst',
      city: 'Dublin', country: 'IE',
      comp: { base: 45000 },
      tax_override: { rate: 0.25, source: 'fixture' },
      col_override: { baseline_eur: 3000, source: 'fixture' },
      calibration: { dream_companies: ['Northwind Analytics'], lower_tier_dream_companies: ['Litware Labs'] },
      judgment_scores: JS({ growth_mobility: 6, optionality_exit: 6, brand_value: 6, role_content: 6 }),
    }),
    expect: {
      'calibrated_dims.brand_value.final': 6,
      'match.preference': 0.25,
      'match.floor': null,
    },
  },
  {
    name: 'Structured onboarding calibration — Growth raw 7 → final 8',
    input: fx({
      company: 'Fabrikam Consulting', role_archetype: 'Data Analyst',
      city: 'Berlin', country: 'DE',
      comp: { base: 45000 },
      tax_override: { rate: 0.36, source: 'fixture' },
      col_override: { baseline_eur: 2200, source: 'fixture' },
      calibration: { has_structured_onboarding: true, has_sink_or_swim_signal: false },
      judgment_scores: JS(),
    }),
    expect: {
      'calibrated_dims.growth_mobility.final': 8,
      'dims.growth_mobility': 8,
    },
  },
];

function getDeep(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

for (const fixture of FIXTURES) {
  try {
    const result = await scoreListing(fixture.input);
    let ok = !result.error;
    const mismatches = result.error ? [`error: ${result.error} — ${result.message}`] : [];
    for (const [path, expected] of Object.entries(fixture.expect)) {
      const actual = getDeep(result, path);
      if (actual !== expected) { ok = false; mismatches.push(`${path}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
    }
    if (fixture.check && !fixture.check(result)) { ok = false; mismatches.push('custom check failed'); }
    if (ok) pass(fixture.name);
    else    fail(`${fixture.name} — ${mismatches.join('; ')}`);
  } catch (e) {
    fail(`${fixture.name} — threw: ${e.message}`);
  }
}

// --eligibility-only returns just the gate, with no comp / scores needed.
try {
  const r = await scoreListing(
    { today: FX_TODAY, eligibility_profile: FX_PROFILE, scoring_weights: {}, country: 'DE', eligibility_facts: FX_INTERN_FACTS },
    { eligibilityOnly: true },
  );
  // The gate plus its flags string (score-listing.mjs carries `eligibility_flags`
  // so workers copy it verbatim); nothing that needs comp or scores.
  if (Object.keys(r).sort().join(',') === 'eligibility,eligibility_flags' && r.eligibility.status === 'green') pass('--eligibility-only returns only { eligibility, eligibility_flags }');
  else fail(`--eligibility-only — got keys ${Object.keys(r).join(',')}, status ${r.eligibility?.status}`);
} catch (e) {
  fail(`--eligibility-only — threw: ${e.message}`);
}

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('🟡 Tests passed with warnings — review before pushing\n');
  process.exit(0);
} else {
  console.log('🟢 All tests passed — safe to push/merge\n');
  process.exit(0);
}
