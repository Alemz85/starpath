#!/usr/bin/env node

/**
 * profile.mjs — manage multiple switchable search profiles.
 * (design: docs/superpowers/specs/2026-07-07-multi-profile-design.md)
 *
 * A profile = one job search (config, scan keywords, calibration, database).
 * Real files live under `profiles/<slug>/…`; the 18 canonical paths every
 * script and the frontend already use are symlinks into the active profile.
 * Exactly one profile is active at a time, globally.
 *
 * All plan/guard/validation logic is pure in scripts/lib/profile-core.mjs
 * (unit-tested); this file is thin I/O per repo convention.
 *
 * Usage:
 *   node scripts/profile.mjs list
 *   node scripts/profile.mjs switch <slug> [--force]
 *   node scripts/profile.mjs create <slug> [--from <slug>] [--label "…"] [--switch]
 *   node scripts/profile.mjs init [<slug>] [--label "…"] [--force]
 *   node scripts/profile.mjs eject [--force]
 *
 * Every command accepts --json (machine consumption; exact shapes in spec §3)
 * and --root <dir> (operate on another repo root — used by tests).
 * Exit code 0 on ok, 1 on refusal/error (JSON still printed with --json).
 */

import {
  existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync,
  renameSync, symlinkSync, unlinkSync, lstatSync, copyFileSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILES_DIR, ACTIVE_POINTER, PROFILE_PATHS, PROFILE_REPORT_DIRS,
  validateSlug, parseActive, serializeActive, parseMeta,
  planInit, planCreate, planSwitch, planEject,
  evaluateGuards, parseBatchStateRows, countPendingPipelineLines,
} from './lib/profile-core.mjs';
import { countMarkdownTableRows } from './lib/doctor-checks.mjs';

/** The one literal slug the system ships: the `init` default. */
const DEFAULT_INIT_SLUG = 'career';

// ── Argument parsing ────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const JSON_MODE = rawArgs.includes('--json');

function argValue(flag) {
  const i = rawArgs.indexOf(flag);
  return i !== -1 && i + 1 < rawArgs.length ? rawArgs[i + 1] : null;
}

const ROOT = argValue('--root') || dirname(dirname(fileURLToPath(import.meta.url)));
const FORCE = rawArgs.includes('--force');

/** Positional args = everything that isn't a flag or a flag's value. */
function positionals() {
  const flagsWithValue = new Set(['--root', '--from', '--label']);
  const out = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (flagsWithValue.has(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

// ── Output + exit helpers ───────────────────────────────────────────────────

function emit(json, humanLines, exitCode) {
  if (JSON_MODE) {
    console.log(JSON.stringify(json));
  } else {
    for (const line of humanLines) console.log(line);
  }
  process.exit(exitCode);
}

function fail(error, message) {
  emit({ ok: false, error, message }, [`error: ${message}`], 1);
}

function failGuards(guardFailures) {
  emit(
    { ok: false, error: 'guards', guardFailures },
    [
      'Refusing — unmerged/in-flight work would leak across profiles:',
      ...guardFailures.map((g) => `  ✗ ${g}`),
      'Merge or finish it first, or re-run with --force to override.',
    ],
    1
  );
}

// ── Filesystem gather helpers ───────────────────────────────────────────────

function readActive() {
  const p = join(ROOT, ACTIVE_POINTER);
  if (!existsSync(p)) return null;
  return parseActive(readFileSync(p, 'utf-8'));
}

function profileDirExists(slug) {
  const p = join(ROOT, PROFILES_DIR, slug);
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

function listProfileSlugs() {
  const dir = join(ROOT, PROFILES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Gather the pure guard inputs from disk (see evaluateGuards). */
function gatherGuardInputs() {
  const tsvsIn = (relDir) => {
    try {
      return readdirSync(join(ROOT, relDir), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.tsv'))
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  const statePath = join(ROOT, 'batch/batch-state.tsv');
  return {
    trackerAdditionTsvs: tsvsIn('batch/tracker-additions'),
    scoutingAdditionTsvs: tsvsIn('batch/scouting-additions'),
    batchStateRows: existsSync(statePath)
      ? parseBatchStateRows(readFileSync(statePath, 'utf-8'))
      : [],
    jobspyHistoryStagingPresent: existsSync(join(ROOT, 'data/scan-history.jobspy.tsv')),
    jobspyPipelineStagingPresent: existsSync(join(ROOT, 'data/pipeline.jobspy.md')),
  };
}

/** Refusal strings from the switch/init/eject guards ([] when --force). */
function guardFailures() {
  if (FORCE) return [];
  return evaluateGuards(gatherGuardInputs());
}

/**
 * Canonical paths that exist but are NOT symlinks. On an initialized repo
 * these are shadows (a writer replaced the link with a real file) and
 * re-pointing over them would destroy data — always a hard error on switch,
 * never overridable.
 */
function findShadows() {
  return PROFILE_PATHS.filter((p) => {
    try { return !lstatSync(join(ROOT, p)).isSymbolicLink(); } catch { return false; }
  });
}

// ── Plan execution ──────────────────────────────────────────────────────────

/**
 * Re-point (or create) a symlink atomically: build a temp link next to the
 * destination, then fs.renameSync over the old one (atomic on POSIX). The
 * canonical path is never in a "missing" state during a switch.
 */
function atomicSymlink(linkPath, target, kind) {
  const linkAbs = join(ROOT, linkPath);
  let st = null;
  try { st = lstatSync(linkAbs); } catch { /* absent — fine */ }
  if (st && !st.isSymbolicLink()) {
    throw new Error(`refusing to replace real path with a symlink: ${linkPath}`);
  }
  mkdirSync(dirname(linkAbs), { recursive: true });
  const tmp = `${linkAbs}.profile-tmp-${process.pid}`;
  try { unlinkSync(tmp); } catch { /* no stale tmp */ }
  symlinkSync(target, tmp, kind === 'dir' ? 'dir' : 'file');
  renameSync(tmp, linkAbs);
}

/**
 * Execute a declarative plan from profile-core. Returns warnings (non-fatal
 * observations, e.g. eject skipping a shadowed path).
 */
function executePlan(ops) {
  const warnings = [];
  for (const op of ops) {
    switch (op.op) {
      case 'ensure-dir':
        mkdirSync(join(ROOT, op.path), { recursive: true });
        break;

      case 'write-meta':
        mkdirSync(dirname(join(ROOT, op.path)), { recursive: true });
        writeFileSync(join(ROOT, op.path), op.content, 'utf-8');
        break;

      case 'scaffold-if-missing': {
        const p = join(ROOT, op.path);
        if (!existsSync(p)) {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, op.content, 'utf-8');
        }
        break;
      }

      case 'copy-if-exists': {
        const from = join(ROOT, op.from);
        if (existsSync(from)) {
          const to = join(ROOT, op.to);
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
        }
        break;
      }

      case 'adopt': {
        // init move-or-scaffold: MOVE a real canonical file/dir into the
        // profile (fs.renameSync — same filesystem, never a copy); scaffold
        // when the canonical path is absent. Idempotent for resume: an
        // already-created symlink or an already-moved file is left alone.
        const canonicalAbs = join(ROOT, op.canonical);
        const destAbs = join(ROOT, op.to);
        let st = null;
        try { st = lstatSync(canonicalAbs); } catch { /* absent */ }
        if (st && !st.isSymbolicLink()) {
          mkdirSync(dirname(destAbs), { recursive: true });
          renameSync(canonicalAbs, destAbs);
        } else if (!existsSync(destAbs)) {
          if (op.kind === 'dir') {
            mkdirSync(destAbs, { recursive: true });
          } else if (op.scaffold != null) {
            mkdirSync(dirname(destAbs), { recursive: true });
            writeFileSync(destAbs, op.scaffold, 'utf-8');
          }
          // scaffold === null (config files): absent stays absent — the
          // canonical symlink dangles, which consumers read as "missing"
          // (the pre-onboarding state), and writes through the dangling
          // link land inside the profile.
        }
        break;
      }

      case 'symlink':
        atomicSymlink(op.linkPath, op.target, op.kind);
        break;

      case 'restore': {
        // eject: remove the symlink, move the profile's real file/dir back.
        const linkAbs = join(ROOT, op.linkPath);
        const fromAbs = join(ROOT, op.from);
        let st = null;
        try { st = lstatSync(linkAbs); } catch { /* absent */ }
        if (st && st.isSymbolicLink()) {
          unlinkSync(linkAbs);
        } else if (st) {
          // Real-file shadow at the canonical path — it holds the newest
          // writes, so keep it and leave the profile copy in place.
          warnings.push(
            `kept real file at ${op.linkPath} (shadow) — profile copy left at ${op.from}`
          );
          break;
        }
        if (existsSync(fromAbs)) {
          mkdirSync(dirname(linkAbs), { recursive: true });
          renameSync(fromAbs, linkAbs);
        }
        break;
      }

      case 'write-active':
        mkdirSync(join(ROOT, PROFILES_DIR), { recursive: true });
        writeFileSync(join(ROOT, ACTIVE_POINTER), serializeActive(op.slug), 'utf-8');
        break;

      case 'remove-active':
        rmSync(join(ROOT, ACTIVE_POINTER), { force: true });
        break;

      default:
        throw new Error(`unknown plan op: ${op.op}`);
    }
  }
  return warnings;
}

// ── Commands ────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cmdList() {
  const active = readActive();
  const slugs = listProfileSlugs();

  const profiles = slugs.map((slug) => {
    const base = join(ROOT, PROFILES_DIR, slug);
    const readSafe = (rel) => {
      const p = join(base, rel);
      try { return existsSync(p) ? readFileSync(p, 'utf-8') : null; } catch { return null; }
    };
    const meta = parseMeta(readSafe('meta.yml') || '');
    let reports = 0;
    for (const dir of PROFILE_REPORT_DIRS) {
      const p = join(base, dir);
      if (!existsSync(p)) continue;
      try {
        reports += readdirSync(p).filter((f) => f.endsWith('.md')).length;
      } catch { /* unreadable dir — count 0 */ }
    }
    return {
      slug,
      label: meta.label || slug,
      created: meta.created || null,
      active: slug === active,
      counts: {
        scouting: countMarkdownTableRows(readSafe('data/scouting.md') || ''),
        applications: countMarkdownTableRows(readSafe('data/applications.md') || ''),
        pipeline: countPendingPipelineLines(readSafe('data/pipeline.md') || ''),
        reports,
      },
    };
  });

  const human = [];
  if (profiles.length === 0) {
    human.push('No profiles — single-profile layout. Run: npm run profile -- init');
  } else {
    human.push(`Profiles (active: ${active ?? 'none'})`);
    for (const p of profiles) {
      const marker = p.active ? '*' : ' ';
      const c = p.counts;
      human.push(
        `${marker} ${p.slug} — "${p.label}" (created ${p.created ?? 'n/d'}) · ` +
        `scouting ${c.scouting} · applications ${c.applications} · pipeline ${c.pipeline} · reports ${c.reports}`
      );
    }
  }
  emit({ active, profiles }, human, 0);
}

function cmdSwitch(slug) {
  if (!slug) fail('usage', 'usage: profile switch <slug> [--force]');
  const v = validateSlug(slug);
  if (!v.valid) fail('invalid-slug', v.reason);

  const previous = readActive();
  if (previous == null) {
    fail('not-initialized', 'no profiles/active — run: npm run profile -- init');
  }
  if (!profileDirExists(slug)) fail('unknown-profile', `no profile '${slug}'`);

  if (slug === previous) {
    emit({ ok: true, active: slug, previous }, [`already on '${slug}'`], 0);
  }

  const guards = guardFailures();
  if (guards.length > 0) failGuards(guards);

  const shadows = findShadows();
  if (shadows.length > 0) {
    fail(
      'shadow',
      `real files found at canonical paths (a writer replaced the symlink): ${shadows.join(', ')} — ` +
      `merge each into profiles/${previous}/<path> and delete the shadow, then retry`
    );
  }

  executePlan(planSwitch(slug));
  emit({ ok: true, active: slug, previous }, [`switched: ${previous} → ${slug}`], 0);
}

function cmdCreate(slug) {
  if (!slug) fail('usage', 'usage: profile create <slug> [--from <slug>] [--label "…"] [--switch]');
  const v = validateSlug(slug);
  if (!v.valid) fail('invalid-slug', v.reason);

  const previous = readActive();
  if (previous == null) {
    fail('not-initialized', 'no profiles/active — run: npm run profile -- init  before creating more profiles');
  }
  if (profileDirExists(slug)) fail('profile-exists', `profile '${slug}' already exists`);

  const from = argValue('--from');
  if (from != null) {
    const fv = validateSlug(from);
    if (!fv.valid) fail('invalid-slug', fv.reason);
    if (!profileDirExists(from)) fail('unknown-profile', `no profile '${from}'`);
  }

  const doSwitch = rawArgs.includes('--switch');
  if (doSwitch) {
    const guards = guardFailures();
    if (guards.length > 0) failGuards(guards);
  }

  executePlan(planCreate(slug, { from, label: argValue('--label'), date: todayIso() }));

  let active = previous;
  if (doSwitch) {
    const shadows = findShadows();
    if (shadows.length > 0) {
      fail(
        'shadow',
        `created '${slug}' but not switching — real files found at canonical paths: ${shadows.join(', ')}`
      );
    }
    executePlan(planSwitch(slug));
    active = slug;
  }

  emit(
    { ok: true, active, previous, created: slug },
    [
      `created profile '${slug}'${from ? ` (config copied from '${from}')` : ''}`,
      // --from copies portals.yml VERBATIM — including the source search's
      // tracked_companies. That's a starting point, not a recommendation:
      // a differently-targeted search should prune the inherited pool.
      ...(from ? [
        `note: user/portals.yml was copied verbatim from '${from}' — its tracked_companies, title filters, and queries describe THAT search. Prune/retarget them for this one.`,
      ] : []),
      doSwitch ? `switched: ${previous} → ${slug}` : `active profile unchanged ('${active}') — switch with: npm run profile -- switch ${slug}`,
    ],
    0
  );
}

function cmdInit(slugArg) {
  const slug = slugArg || DEFAULT_INIT_SLUG;
  const v = validateSlug(slug);
  if (!v.valid) fail('invalid-slug', v.reason);

  if (existsSync(join(ROOT, ACTIVE_POINTER))) {
    fail('already-initialized', `profiles/active already exists (active: '${readActive() ?? 'invalid'}') — init runs once`);
  }

  const guards = guardFailures();
  if (guards.length > 0) failGuards(guards);

  executePlan(planInit(slug, { label: argValue('--label'), date: todayIso() }));
  emit(
    { ok: true, active: slug, previous: null },
    [`initialized multi-profile layout — live files moved into profiles/${slug}/, 18 canonical paths are now symlinks`],
    0
  );
}

function cmdEject() {
  const active = readActive();
  if (active == null) {
    fail('not-initialized', 'no profiles/active — nothing to eject');
  }
  if (!profileDirExists(active)) {
    fail('unknown-profile', `profiles/active points at missing profile '${active}'`);
  }

  const guards = guardFailures();
  if (guards.length > 0) failGuards(guards);

  const warnings = executePlan(planEject(active));
  emit(
    { ok: true, active: null, previous: active },
    [
      `ejected '${active}' — canonical paths are real files again; other profile dirs left on disk`,
      ...warnings.map((w) => `  warning: ${w}`),
    ],
    0
  );
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const [command, ...rest] = positionals();

switch (command) {
  case 'list':   cmdList(); break;
  case 'switch': cmdSwitch(rest[0]); break;
  case 'create': cmdCreate(rest[0]); break;
  case 'init':   cmdInit(rest[0]); break;
  case 'eject':  cmdEject(); break;
  default:
    fail(
      'usage',
      `unknown command '${command ?? ''}' — usage: profile <list|switch|create|init|eject> [args] [--json]`
    );
}
