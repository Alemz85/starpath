#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops / starpath.
 *
 * Checks all prerequisites and prints a pass/fail checklist.  Covers:
 *   1. Runtime prerequisites (Node, dependencies, Playwright chromium)
 *   2. User-layer onboarding (cv, profile.yml, _profile.md, portals.yml)
 *   3. Data artifacts (scan/score history, scouting, applications, caches…)
 *   4. Multi-profile layout (profiles/active, canonical symlinks, shadows —
 *      all skipped with one OK line on pre-migration single-profile repos)
 *   5. Capability inventory (modes, CLI tools, JobSpy, story bank)
 *   6. Auto-created output directories
 *   7. Glanceable pipeline snapshot (row counts)
 *
 * Pure check logic lives in scripts/lib/doctor-checks.mjs (unit-tested).
 * This file is I/O only: reads files, calls checkers, renders output.
 *
 * Usage: npm run doctor
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, lstatSync, readlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  buildUserLayerChecks,
  buildArtifactChecks,
  buildCapabilityInventory,
  buildProfileChecks,
  buildPipelineSummary,
  countTsvDataRows,
  countMarkdownTableRows,
  countPendingPipelineItems,
} from './lib/doctor-checks.mjs';
import { PROFILE_PATHS } from './lib/profile-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// ── ANSI colors (only on TTY) ───────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const green  = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red    = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim    = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const bold   = (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s;

// ── Render helpers ──────────────────────────────────────────────────────────
function printSection(title) {
  console.log(`\n${bold(title)}`);
}

function printCheck(result) {
  if (result.pass) {
    const note = result.note ? `  ${dim('→ ' + result.note)}` : '';
    console.log(`${green('✓')} ${result.label}${note ? '\n' + note : ''}`);
  } else {
    console.log(`${red('✗')} ${result.label}`);
    const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
    for (const hint of fixes) {
      if (hint) console.log(`  ${dim('→ ' + hint)}`);
    }
  }
}

// ── File readers (safe — return null on missing/error) ──────────────────────
function readFileSafe(relPath) {
  const full = join(projectRoot, relPath);
  try {
    return existsSync(full) ? readFileSync(full, 'utf-8') : null;
  } catch {
    return null;
  }
}

function countFiles(relDir) {
  const full = join(projectRoot, relDir);
  if (!existsSync(full)) return 0;
  try {
    return readdirSync(full).length;
  } catch {
    return 0;
  }
}

// ── 1. Runtime prerequisites ────────────────────────────────────────────────
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'npm dependencies installed' };
  }
  return {
    pass: false,
    label: 'npm dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed (PDF generation ready)' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

// ── 4. Multi-profile layout ─────────────────────────────────────────────────
// Gathers the raw filesystem facts; all judgment lives in buildProfileChecks
// (pure, unit-tested). Pre-migration repos (no profiles/) get one OK line.
function gatherProfilesLayout() {
  const profilesDir = join(projectRoot, 'profiles');
  if (!existsSync(profilesDir)) return { profilesDirExists: false };

  let profileDirs = [];
  try {
    profileDirs = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* unreadable — treated as empty */ }

  const links = PROFILE_PATHS.map((p) => {
    const abs = join(projectRoot, p);
    let present = false, isSymlink = false, linkTarget = null;
    try {
      const st = lstatSync(abs);
      present = true;
      isSymlink = st.isSymbolicLink();
    } catch { /* absent */ }
    if (isSymlink) {
      try { linkTarget = readlinkSync(abs); } catch { /* unreadable link */ }
    }
    return { path: p, present, isSymlink, linkTarget };
  });

  const profileStructures = profileDirs.map((slug) => ({
    slug,
    hasUser:    existsSync(join(profilesDir, slug, 'user')),
    hasData:    existsSync(join(profilesDir, slug, 'data')),
    hasReports: existsSync(join(profilesDir, slug, 'reports')),
    hasMeta:    existsSync(join(profilesDir, slug, 'meta.yml')),
  }));

  let reportsChildren = [];
  try {
    reportsChildren = readdirSync(join(projectRoot, 'reports'));
  } catch { /* reports/ missing — the auto-dir check below recreates it */ }

  return {
    profilesDirExists: true,
    activeRaw: readFileSafe('profiles/active'),
    profileDirs,
    links,
    profileStructures,
    reportsChildren,
  };
}

// ── 6. Auto-created directories ─────────────────────────────────────────────
function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nstarpath / career-ops doctor');
  console.log('============================');

  let failures = 0;
  let warnings = 0;

  const record = (result) => {
    if (!result.pass) failures++;
    printCheck(result);
  };

  // ── 1. Runtime prerequisites ─────────────────────────────────────────────
  printSection('1. Runtime prerequisites');
  record(checkNodeVersion());
  record(checkDependencies());
  record(await checkPlaywright());

  // ── 2. User-layer onboarding ─────────────────────────────────────────────
  printSection('2. User-layer onboarding');
  const userFiles = {
    cv:            readFileSafe('user/cv.md'),
    profileYml:    readFileSafe('user/profile.yml'),
    profileMd:     readFileSafe('user/_profile.md'),
    portalsYml:    readFileSafe('user/portals.yml'),
    articleDigest: readFileSafe('user/article-digest.md'),
  };
  for (const check of buildUserLayerChecks(userFiles)) {
    record(check);
  }

  // ── 3. Data artifacts ────────────────────────────────────────────────────
  printSection('3. Data artifacts');
  const dataFiles = {
    scanHistory:   readFileSafe('data/scan-history.tsv'),
    scoreHistory:  readFileSafe('data/score-history.tsv'),
    scouting:      readFileSafe('data/scouting.md'),
    applications:  readFileSafe('data/applications.md'),
    pipeline:      readFileSafe('data/pipeline.md'),
    outreach:      readFileSafe('data/outreach.md'),
    colCache:      readFileSafe('data/col-cache.tsv'),
    taxCache:      readFileSafe('data/tax-cache.tsv'),
  };
  const companiesCount = countFiles('data/companies');
  for (const check of buildArtifactChecks(dataFiles, { companiesCount })) {
    record(check);
  }

  // ── 4. Multi-profile layout ──────────────────────────────────────────────
  printSection('4. Profiles');
  for (const check of buildProfileChecks(gatherProfilesLayout())) {
    record(check);
  }

  // ── 5. Capability inventory ──────────────────────────────────────────────
  printSection('5. Capability inventory');

  const scriptsDir = join(projectRoot, 'scripts');
  const modesDir   = join(projectRoot, 'modes');
  const scriptExists = (name) => existsSync(join(scriptsDir, name));
  const jobspyVenvReady = existsSync(join(projectRoot, 'scripts/jobspy/.venv'))
    || existsSync(join(projectRoot, 'scripts/jobspy/venv'));

  const modeCount = existsSync(modesDir)
    ? readdirSync(modesDir).filter(f => f.endsWith('.md')).length
    : 0;

  for (const check of buildCapabilityInventory({
    scriptExists,
    modeCount,
    jobspyPyExists:  existsSync(join(projectRoot, 'scripts/jobspy/scan.py')),
    jobspyVenvReady,
    storyBankExists: existsSync(join(projectRoot, 'interview-prep/story-bank.md')),
  })) {
    record(check);
  }

  // ── 6. Output directories (auto-created) ─────────────────────────────────
  printSection('6. Output directories');
  record(checkFonts());
  for (const dir of ['data', 'output', 'reports', 'jds', 'batch']) {
    record(checkAutoDir(dir));
  }

  // ── 7. Pipeline snapshot ─────────────────────────────────────────────────
  const scanned   = dataFiles.scanHistory  ? countTsvDataRows(dataFiles.scanHistory)        : 0;
  const scored    = dataFiles.scoreHistory ? countTsvDataRows(dataFiles.scoreHistory)        : 0;
  const scouted   = dataFiles.scouting     ? countMarkdownTableRows(dataFiles.scouting)      : 0;
  const applied   = dataFiles.applications ? countMarkdownTableRows(dataFiles.applications)  : 0;
  const pending   = dataFiles.pipeline     ? countPendingPipelineItems(dataFiles.pipeline)   : 0;

  // Only print snapshot when there's at least some data
  if (scanned + scored + scouted + applied + pending > 0) {
    printSection('7. Pipeline snapshot');
    const summary = buildPipelineSummary({ scanned, scored, scouted, applied, pending });
    for (const line of summary.lines) {
      console.log(dim(line));
    }
  }

  // ── Result ───────────────────────────────────────────────────────────────
  console.log('');
  if (failures > 0) {
    console.log(`Result: ${red(`${failures} issue${failures === 1 ? '' : 's'} found`)}. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    console.log(`Result: ${green('All checks passed.')} You\'re ready to go! Run \`claude\` to start.`);
    console.log('');
    console.log('Join the community: https://discord.gg/8pRpHETxa4');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
