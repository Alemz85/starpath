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
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'scripts/cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without cv.md (normal in repo)
  { name: 'scripts/verify-pipeline.mjs', expectExit: 0 },
  { name: 'scripts/normalize-statuses.mjs', expectExit: 0 },
  { name: 'scripts/dedup-tracker.mjs', expectExit: 0 },
  { name: 'scripts/merge-tracker.mjs', expectExit: 0 },
];

for (const { name, allowFail } of scripts) {
  const result = run('node', name.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (result !== null) {
    pass(`${name} runs OK`);
  } else if (allowFail) {
    warn(`${name} exited with error (expected without user data)`);
  } else {
    fail(`${name} crashed`);
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
// node:test unit suite — band boundaries, the bottom-range penalty, the
// intern carve-out, every tier branch. Section 10 below also exercises the
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
// Two layers:
//
// 6a. Static legacy patterns (hardcoded prior-user strings still checked for
//     belt-and-suspenders — these don't depend on user/profile.yml being present).
//
// 6b. Dynamic hygiene guard (scripts/lib/hygiene-guard.mjs) — reads the
//     current user's actual profile.yml + cv.md at test time and asserts
//     that none of those values appear in the system layer (modes/, scripts/,
//     templates/, frontend/src/). Catches newly-added personal data that the
//     static list wouldn't know about. Skips gracefully when user data is
//     absent (e.g. a clean checkout or a worktree without the gitignored files).

console.log('\n6. Personal data leak check');

// 6a — static legacy strings -------------------------------------------------
const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
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

// 6b — dynamic hygiene guard (reads real user data at test time) -------------
{
  const userProfilePath = join(ROOT, 'user', 'profile.yml');
  const userCvPath = join(ROOT, 'user', 'cv.md');

  if (!existsSync(userProfilePath) && !existsSync(userCvPath)) {
    // No user data present (clean checkout / worktree without gitignored files)
    // — skip gracefully rather than false-passing or erroring.
    warn('Skipping dynamic hygiene guard: user/profile.yml + user/cv.md not found (expected in gitignored-only checkout)');
  } else {
    try {
      const { runHygieneGuard } = await import(
        pathToFileURL(join(SCRIPTS_DIR, 'lib', 'hygiene-guard.mjs')).href
      );
      const { violations, warnings } = await runHygieneGuard({ root: ROOT });

      if (violations.length === 0 && warnings.length === 0) {
        pass('Dynamic hygiene guard: no personal data in system layer');
      } else {
        for (const v of violations) {
          fail(
            `Hygiene violation — ${v.file}:${v.line} (${v.pattern.description})\n` +
            `    → "${v.lineText.slice(0, 100)}"`
          );
        }
        for (const w of warnings) {
          warn(
            `Hygiene warning — ${w.file}:${w.line} (${w.pattern.description})\n` +
            `    → "${w.lineText.slice(0, 100)}"`
          );
        }
      }
    } catch (e) {
      fail(`Dynamic hygiene guard crashed: ${e.message}`);
    }
  }
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathResult = run(
  `git grep -n "/Users/" -- '*.mjs' '*.sh' '*.md' '*.go' '*.yml' 2>/dev/null | grep -v README.md | grep -v LICENSE | grep -v CLAUDE.md | grep -v test-all.mjs`
);
if (!absPathResult) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathResult.split('\n').filter(Boolean)) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
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
// These pin known-good inputs so any future change to score-bands.mjs
// or score-listing.mjs that breaks the math gets caught here.

console.log('\n10. Scoring fixtures');

const { scoreListing } = await import(pathToFileURL(join(SCRIPTS_DIR, 'score-listing.mjs')).href);

const FIXTURES = [
  {
    name: 'Google Dublin L4 SWE — high comp, big equity, expensive city',
    input: {
      company: 'Google', role_archetype: 'Software Engineer',
      city: 'Dublin', country: 'IE',
      comp: { base: 105000, bonusPct: 0.15, equityAnnualEur: 34500 },
      tax_override: { rate: 0.32, source: 'fixture' },
      col_override: { baseline_eur: 3050, source: 'fixture' },
      soft_benefits_modifier: 0.5,
      judgment_scores: {
        skills_match: 8, ease_of_entry: 5, strategic_fit: 8,
        growth_mobility: 9, optionality_exit: 10, brand_value: 10,
        sales_trap_risk: 9, work_life_balance: 7, best_cities: 8,
      },
    },
    expect: {
      'salary_adj_for_city.score': 10,
      'salary_adj_for_city.computed.totalComp': 155250,
      'current_fit': 7,
      'aspirational_fit': 9.67,
      // 7×0.7 + 9.67×0.3 = 7.801; +0.2 modifier (Salary≥9) = 8.0 (rounded)
      'overall': 8,
      'tier': 'T2',
    },
  },
  {
    name: 'Barcelona €30K base only — negative savings',
    input: {
      company: 'Generic', role_archetype: 'Business Analyst',
      city: 'Barcelona', country: 'ES',
      comp: { base: 30000 },
      tax_override: { rate: 0.22, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      soft_benefits_modifier: 0,
      judgment_scores: {
        skills_match: 7, ease_of_entry: 7, strategic_fit: 7,
        growth_mobility: 6, optionality_exit: 6, brand_value: 5,
        sales_trap_risk: 7, work_life_balance: 7, best_cities: 10,
      },
    },
    expect: {
      'salary_adj_for_city.score': 3,
      'salary_adj_for_city.computed.savings': -50,
      'current_fit': 7,
      // 6+6+5 / 3 = 5.667
      'aspirational_fit': 5.67,
      // 7×0.7 + 5.67×0.3 = 6.601; -0.4 modifier (Salary≤4) = 6.2
      'overall': 6.2,
      'tier': 'T2',
    },
  },
  {
    name: 'Barcelona €1,200/mo intern — half baseline',
    input: {
      company: 'StartupX', role_archetype: 'Data Analyst Intern',
      city: 'Barcelona', country: 'ES',
      comp: { base: 14400 },  // €1,200/mo × 12
      tax_override: { rate: 0.0, source: 'fixture (intern stipend, post-tax)' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      is_intern: true,
      soft_benefits_modifier: 0,
      judgment_scores: {
        skills_match: 8, ease_of_entry: 8, strategic_fit: 6,
        growth_mobility: 7, optionality_exit: 5, brand_value: 4,
        sales_trap_risk: 8, work_life_balance: 7, best_cities: 10,
      },
    },
    expect: {
      // €1,200/mo - €1,000 (half of 2000 baseline for intern) = €200 → band 4
      'salary_adj_for_city.score': 4,
      'salary_adj_for_city.computed.savings': 200,
      'tier': 'T2',
    },
  },
  {
    name: 'Intern carve-out — Salary Adj ≤ 4 does NOT trigger -0.4 on Overall',
    input: {
      company: 'BargainCo', role_archetype: 'Marketing Intern',
      city: 'Madrid', country: 'ES',
      comp: { base: 9600 },  // €800/mo × 12 — would normally trigger -0.4 modifier
      tax_override: { rate: 0.0, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      is_intern: true,
      soft_benefits_modifier: 0,
      judgment_scores: {
        skills_match: 7, ease_of_entry: 7, strategic_fit: 7,
        growth_mobility: 7, optionality_exit: 7, brand_value: 7,
        sales_trap_risk: 7, work_life_balance: 7, best_cities: 9,
      },
    },
    expect: {
      // €800 - €1,000 (half-baseline) = -€200 → band 2 (-€400 to -€151), would normally trigger -0.4
      'salary_adj_for_city.score': 2,
      // CF=7, AF=7 → base 7.0; intern carve-out suppresses the -0.4 → Overall stays 7.0
      'current_fit': 7,
      'aspirational_fit': 7,
      'overall': 7,
    },
  },
  {
    name: 'Non-intern at same low Salary Adj — DOES trigger -0.4 modifier',
    input: {
      company: 'BargainCo', role_archetype: 'Marketing Analyst',
      city: 'Madrid', country: 'ES',
      comp: { base: 18000 },  // €1,500/mo full-time
      tax_override: { rate: 0.15, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      // is_intern: false (default)
      soft_benefits_modifier: 0,
      judgment_scores: {
        skills_match: 7, ease_of_entry: 7, strategic_fit: 7,
        growth_mobility: 7, optionality_exit: 7, brand_value: 7,
        sales_trap_risk: 7, work_life_balance: 7, best_cities: 9,
      },
    },
    expect: {
      // €18,000 × 0.85 / 12 = €1,275 - €2,000 = -€725 → band 1 (poverty wage)
      'salary_adj_for_city.score': 1,
      // CF=7, AF=7 → base 7.0; full-time SHOULD trigger -0.4 → Overall = 6.6
      'overall': 6.6,
    },
  },
  {
    name: 'Tier 1 fingerprint override — all 6 dims ≥ 8 rolls up to T1',
    input: {
      company: 'Acme', role_archetype: 'Strategy Analyst',
      city: 'Madrid', country: 'ES',
      comp: { base: 45000, bonusPct: 0.10 },
      tax_override: { rate: 0.27, source: 'fixture' },
      col_override: { baseline_eur: 2000, source: 'fixture' },
      soft_benefits_modifier: 0.3,
      judgment_scores: {
        skills_match: 8, ease_of_entry: 8, strategic_fit: 8,
        growth_mobility: 8, optionality_exit: 8, brand_value: 8,
        sales_trap_risk: 9, work_life_balance: 8, best_cities: 9,
      },
    },
    expect: {
      'current_fit': 8,
      'aspirational_fit': 8,
      'tier': 'T1',
      'tier_reason': 'uniform fingerprint: all 6 dims ≥ 8 AND CF/AF ≥ 8.0',
    },
  },
  {
    name: 'Brand calibration stack — affinity +0.6 + extra_brand_bonus +1.0',
    input: {
      company: 'Google', role_archetype: 'Account Strategist',
      city: 'Dublin', country: 'IE',
      comp: { base: 60000, bonusPct: 0.10 },
      tax_override: { rate: 0.30, source: 'fixture' },
      col_override: { baseline_eur: 3000, source: 'fixture' },
      soft_benefits_modifier: 0.5,
      calibration: {
        brand_affinity_companies: ['Google', 'McKinsey', 'BCG', 'EY', 'Accenture', 'Spotify', 'Wise'],
        extra_brand_bonuses: [{ company: 'Google', bonus: 1.0, reason: 'priority target' }],
        dream_companies: [],  // intentionally empty so we test pure +0.6 + +1.0 stacking, not the dream override
        has_structured_onboarding: false,
      },
      judgment_scores: {
        skills_match: 7, ease_of_entry: 5, strategic_fit: 7,
        growth_mobility: 7, optionality_exit: 9, brand_value: 8,
        sales_trap_risk: 6, work_life_balance: 8, best_cities: 8,
      },
    },
    expect: {
      // Brand: raw 8 + 0.6 (affinity) + 1.0 (Google extra_bonus) = 9.6
      'calibrated_dims.brand_value.final': 9.6,
    },
  },
  {
    name: 'Dream-company override — Brand floored to 10 + AF floor to 8',
    input: {
      company: 'Google', role_archetype: 'AI Solutions Consultant',
      city: 'Dublin', country: 'IE',
      comp: { base: 55000 },
      tax_override: { rate: 0.30, source: 'fixture' },
      col_override: { baseline_eur: 3000, source: 'fixture' },
      soft_benefits_modifier: 0,
      calibration: {
        dream_companies: ['Google'],
        has_structured_onboarding: false,
      },
      judgment_scores: {
        skills_match: 6, ease_of_entry: 5, strategic_fit: 6,
        growth_mobility: 6, optionality_exit: 7, brand_value: 5,  // raw 5 to verify dream-company floor to 10
        sales_trap_risk: 6, work_life_balance: 7, best_cities: 8,
      },
    },
    expect: {
      'calibrated_dims.brand_value.final': 10,
      // AF = (6 + 7 + 10) / 3 = 7.67 → dream floor lifts to 8.0
      'aspirational_fit': 8,
    },
  },
  {
    name: 'Lower-tier dream — Brand +1.0 bonus, no override, no AF floor',
    input: {
      company: 'Microsoft', role_archetype: 'Sales Operations Intern',
      city: 'Dublin', country: 'IE',
      comp: { base: 25200 },
      tax_override: { rate: 0.12, source: 'fixture' },
      col_override: { baseline_eur: 3000, source: 'fixture' },
      is_intern: true,
      soft_benefits_modifier: 0,
      calibration: {
        dream_companies: ['Google'],
        lower_tier_dream_companies: ['Mastercard', 'Glovo', 'Celonis', 'Amazon', 'Microsoft'],
        has_structured_onboarding: false,
      },
      judgment_scores: {
        skills_match: 8, ease_of_entry: 5, strategic_fit: 8,
        growth_mobility: 8, optionality_exit: 9, brand_value: 8,  // raw 8 → +1.0 → 9
        sales_trap_risk: 8, work_life_balance: 7, best_cities: 8,
      },
    },
    expect: {
      // Brand: 8 + 1.0 (lower-tier dream) = 9 — stacks but no override to 10
      'calibrated_dims.brand_value.final': 9,
      // AF = (8 + 9 + 9) / 3 = 8.67 — no dream-company AF floor (lower tier doesn't floor)
      'aspirational_fit': 8.67,
      'aspirational_fit_floor': null,
    },
  },
  {
    name: 'Structured onboarding calibration — Growth raw 7 → final 8',
    input: {
      company: 'Acme', role_archetype: 'Data Analyst',
      city: 'Berlin', country: 'DE',
      comp: { base: 45000 },
      tax_override: { rate: 0.36, source: 'fixture' },
      col_override: { baseline_eur: 2200, source: 'fixture' },
      soft_benefits_modifier: 0,
      calibration: {
        has_structured_onboarding: true,
        has_sink_or_swim_signal: false,
      },
      judgment_scores: {
        skills_match: 7, ease_of_entry: 7, strategic_fit: 7,
        growth_mobility: 7, optionality_exit: 7, brand_value: 6,
        sales_trap_risk: 7, work_life_balance: 7, best_cities: 8,
      },
    },
    expect: {
      'calibrated_dims.growth_mobility.final': 8,  // raw 7 + 1.0 onboarding
    },
  },
];

function getDeep(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

for (const fx of FIXTURES) {
  try {
    const result = await scoreListing(fx.input);
    let ok = true;
    const mismatches = [];
    for (const [path, expected] of Object.entries(fx.expect)) {
      const actual = getDeep(result, path);
      if (actual !== expected) { ok = false; mismatches.push(`${path}: got ${actual}, want ${expected}`); }
    }
    if (ok) pass(fx.name);
    else    fail(`${fx.name} — ${mismatches.join('; ')}`);
  } catch (e) {
    fail(`${fx.name} — threw: ${e.message}`);
  }
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
