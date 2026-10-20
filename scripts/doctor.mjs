#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops / starpath.
 *
 * Checks all prerequisites and prints a pass/warn/fail checklist. Covers:
 *   1. Runtime prerequisites (Node, dependencies, Playwright chromium)
 *   2. Private root (private/ + the repo-root links, its git repo, remote and
 *      last backup, the public repo's ignore rule, no tracked personal paths,
 *      leak-gate hooks, demo dataset, overrides drift)
 *   3. User-layer onboarding (cv, profile.yml, _profile.md, portals.yml)
 *   4. Data artifacts (scan/score history, scouting, applications, caches…)
 *   5. Multi-profile layout (profiles/active, canonical symlinks, shadows —
 *      all skipped with one OK line on single-profile setups)
 *   6. Capability inventory (modes, CLI tools, JobSpy, story bank, fonts)
 *   7. Glanceable pipeline snapshot (row counts)
 *
 * Sections 3–5 and 7 read through the data root (scripts/lib/data-root.mjs ›
 * dataRootFor): private/ when it exists, else the repo root. Doctor never
 * creates folders: a real data/ next to a data → private/data link would
 * shadow it, so missing links are reported with the fix instead.
 *
 * Pure check logic lives in scripts/lib/doctor-checks.mjs (unit-tested).
 * This file is I/O only: reads files, calls checkers, renders output.
 *
 * Usage: npm run doctor [-- --root <repoRoot>]
 */

import { existsSync, readdirSync, readFileSync, lstatSync, readlinkSync, statSync, realpathSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import {
  buildUserLayerChecks,
  buildArtifactChecks,
  buildCapabilityInventory,
  buildProfileChecks,
  buildPrivateRootChecks,
  findTrackedPersonal,
  buildPipelineSummary,
  countTsvDataRows,
  countMarkdownTableRows,
  countPendingPipelineItems,
} from './lib/doctor-checks.mjs';
import { PROFILE_PATHS } from './lib/profile-core.mjs';
import { LINKED_PATHS, PRIVATE_DIR, DEMO_DIR, dataRootFor, resolveDataRoot } from './lib/data-root.mjs';
import { MOVE_ONLY_PATHS, classifyRootPath, linkOk } from './lib/private-core.mjs';
import { gatherOverrideReport, overridesDataRoot } from './overrides.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const projectRoot = rootArg !== -1 && process.argv[rootArg + 1]
  ? resolve(process.argv[rootArg + 1])
  : dirname(__dirname);
/** Where user/, data/, reports/ … actually live (private/, or the repo root). */
const dataRoot = dataRootFor(projectRoot);

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
  if (result.pass && result.warn) {
    console.log(`${yellow('!')} ${result.label}`);
    const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
    for (const hint of fixes) {
      if (hint) console.log(`  ${dim('→ ' + hint)}`);
    }
  } else if (result.pass) {
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
// Personal files are read through the data root, never the repo root.
function readFileSafe(relPath) {
  const full = join(dataRoot, relPath);
  try {
    return existsSync(full) ? readFileSync(full, 'utf-8') : null;
  } catch {
    return null;
  }
}

function countFiles(relDir) {
  const full = join(dataRoot, relDir);
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
  const profilesDir = join(dataRoot, 'profiles');
  if (!existsSync(profilesDir)) return { profilesDirExists: false };

  let profileDirs = [];
  try {
    profileDirs = readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { /* unreadable — treated as empty */ }

  const links = PROFILE_PATHS.map((p) => {
    const abs = join(dataRoot, p);
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
    reportsChildren = readdirSync(join(dataRoot, 'reports'));
  } catch { /* reports/ missing — nothing to classify */ }

  return {
    profilesDirExists: true,
    activeRaw: readFileSafe('profiles/active'),
    profileDirs,
    links,
    profileStructures,
    reportsChildren,
  };
}

// ── 2. Private root ─────────────────────────────────────────────────────────
// Raw facts only; judgment lives in buildPrivateRootChecks (pure, tested).

function git(args, cwd) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim() };
}

function safeRealpath(p) {
  try { return realpathSync(p); } catch { return null; }
}

/** Is `dir` the top of its own git work tree? */
function isRepoTop(dir) {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  return top.code === 0 && safeRealpath(top.stdout) === safeRealpath(dir);
}

function lstatType(abs) {
  let st;
  try { st = lstatSync(abs); } catch { return 'absent'; }
  if (st.isSymbolicLink()) return 'symlink';
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

function statType(abs) {
  try {
    const st = statSync(abs);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch {
    return lstatType(abs) === 'absent' ? 'absent' : 'other';
  }
}

function gatherPrivateRoot() {
  const privAbs = join(projectRoot, PRIVATE_DIR);
  const privateExists = statType(privAbs) === 'dir';
  const repoRoots = [...new Set([projectRoot, safeRealpath(projectRoot)].filter(Boolean))];

  const links = LINKED_PATHS.map((entry) => {
    const abs = join(projectRoot, entry.path);
    const type = lstatType(abs);
    const root = { type, linkTarget: null, targetExists: false };
    if (type === 'symlink') {
      try { root.linkTarget = readlinkSync(abs); } catch { /* unreadable */ }
      root.targetExists = existsSync(abs);
    }
    const state = classifyRootPath(entry, root, repoRoots);
    const privType = statType(join(privAbs, entry.path));
    return { path: entry.path, kind: entry.kind, state, ok: linkOk(entry.kind, state, privType), target: root.linkTarget };
  });
  const legacyPaths = [
    ...links.filter((l) => l.state === 'real').map((l) => l.path),
    ...MOVE_ONLY_PATHS.filter((e) => lstatType(join(projectRoot, e.path)) === 'dir').map((e) => e.path),
  ];

  let gitFacts = null;
  if (privateExists) {
    if (existsSync(join(privAbs, '.git')) && isRepoTop(privAbs)) {
      const branch = git(['symbolic-ref', '--short', 'HEAD'], privAbs);
      const remotes = git(['remote'], privAbs).stdout.split('\n').filter(Boolean);
      const remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
      const remote = remoteName ? git(['remote', 'get-url', remoteName], privAbs) : null;
      const last = git(['log', '-1', '--format=%ct'], privAbs);
      const ahead = git(['rev-list', '--count', '@{u}..HEAD'], privAbs);
      gitFacts = {
        isRepo: true,
        branch: branch.code === 0 ? branch.stdout : null,
        remote: remote && remote.code === 0 ? remote.stdout : null,
        uncommitted: git(['status', '--porcelain'], privAbs).stdout.split('\n').filter(Boolean).length,
        lastCommitAt: last.code === 0 && last.stdout ? Number(last.stdout) * 1000 : null,
        unpushed: ahead.code === 0 ? Number(ahead.stdout) || 0 : null,
      };
    } else {
      gitFacts = { isRepo: false };
    }
  }

  const publicRepo = isRepoTop(projectRoot);
  let ignored = null;
  let trackedPersonal = [];
  let hooksPath = null;
  if (publicRepo) {
    // Trailing slash: /private/ only matches directories, and it may not exist yet.
    ignored = git(['check-ignore', '-q', `${PRIVATE_DIR}/`], projectRoot).code === 0;
    const files = spawnSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    trackedPersonal = findTrackedPersonal((files.stdout || '').split('\0'));
    const hp = git(['config', 'core.hooksPath'], projectRoot);
    hooksPath = hp.code === 0 && hp.stdout ? hp.stdout : null;
  }

  let overrides = null;
  try {
    const ovRoot = overridesDataRoot(projectRoot);
    if (ovRoot) overrides = gatherOverrideReport({ repoRoot: projectRoot, dataRoot: ovRoot }).entries;
  } catch { /* unreadable overrides — reported as none */ }

  return {
    privateExists,
    links,
    legacyPaths,
    dataRoot: resolveDataRoot({ repoRoot: projectRoot }),
    git: gitFacts,
    now: Date.now(),
    publicRepo,
    ignored,
    trackedPersonal,
    hooksPath,
    demoPresent: existsSync(join(projectRoot, DEMO_DIR, 'user', 'profile.yml')),
    overrides,
  };
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
    else if (result.warn) warnings++;
    printCheck(result);
  };

  // ── 1. Runtime prerequisites ─────────────────────────────────────────────
  printSection('1. Runtime prerequisites');
  record(checkNodeVersion());
  record(checkDependencies());
  record(await checkPlaywright());

  // ── 2. Private root ──────────────────────────────────────────────────────
  printSection('2. Private root');
  for (const check of buildPrivateRootChecks(gatherPrivateRoot())) {
    record(check);
  }

  // ── 3. User-layer onboarding ─────────────────────────────────────────────
  printSection('3. User-layer onboarding');
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

  // ── 4. Data artifacts ────────────────────────────────────────────────────
  printSection('4. Data artifacts');
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

  // ── 5. Multi-profile layout ──────────────────────────────────────────────
  printSection('5. Profiles');
  for (const check of buildProfileChecks(gatherProfilesLayout())) {
    record(check);
  }

  // ── 6. Capability inventory ──────────────────────────────────────────────
  printSection('6. Capability inventory');

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
    storyBankExists: existsSync(join(dataRoot, 'interview-prep/story-bank.md')),
  })) {
    record(check);
  }
  record(checkFonts());

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
  const warned = warnings > 0 ? ` ${yellow(`${warnings} warning${warnings === 1 ? '' : 's'}`)}.` : '';
  if (failures > 0) {
    console.log(`Result: ${red(`${failures} issue${failures === 1 ? '' : 's'} found`)}.${warned} Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    console.log(`Result: ${green('All checks passed.')}${warned} You\'re ready to go! Run \`claude\` to start.`);
    console.log('');
    console.log('Join the community: https://discord.gg/8pRpHETxa4');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
