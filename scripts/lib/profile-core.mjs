/**
 * profile-core.mjs — pure logic for multi-profile job searches
 * (design: docs/superpowers/specs/2026-07-07-multi-profile-design.md).
 *
 * A *profile* is one job search: its config, scan keywords, calibration, and
 * its own database. Real files live under `profiles/<slug>/…`; the canonical
 * paths every script / mode prompt / the frontend already use become symlinks
 * into the active profile. Switching profiles re-points the symlinks — the
 * rest of the system keeps working verbatim because it only ever sees "the"
 * database, which is the active profile's.
 *
 * This module is PURE: no filesystem, no process.exit. It owns
 *   - the canonical path sets (which paths fork per profile),
 *   - slug validation + `profiles/active` parsing,
 *   - meta.yml parse/serialize,
 *   - scaffold contents for empty trackers (headers derived from the same
 *     cores the writers use — see the imports below),
 *   - declarative operation plans (init / create / switch / eject) that the
 *     CLI (scripts/profile.mjs) executes, and
 *   - guard evaluation (refuse a switch while unmerged eval output exists).
 *
 * Data-contract note: this file is system layer and contains ZERO user data.
 * Scaffold headers are generic system boilerplate; the only literal slug in
 * the system is the `init` default (`career`), which lives in the CLI.
 */

import { HEADER as DEDUP_INDEX_HEADER } from './dedup-index.mjs';
import { HISTORY_HEADER as SCAN_HISTORY_HEADER } from './merge-staging-core.mjs';

// ── Canonical path sets ─────────────────────────────────────────────────────

/** Directory that holds all profiles (repo-relative, gitignored). */
export const PROFILES_DIR = 'profiles';

/** One-line pointer file naming the active slug (e.g. "career\n"). */
export const ACTIVE_POINTER = 'profiles/active';

/**
 * The 3 config files `create --from` copies as a starting point. Absent in a
 * fresh profile until onboarding fills them in — a dangling canonical symlink
 * reads as "missing" to consumers (exactly the pre-onboarding state), and any
 * write through the dangling link lands in the profile dir as intended.
 */
export const PROFILE_CONFIG_FILES = [
  'user/profile.yml',
  'user/portals.yml',
  'user/_profile.md',
];

/** The 9 per-profile data files, scaffolded with canonical headers at create time. */
export const PROFILE_DATA_FILES = [
  'data/scouting.md',
  'data/applications.md',
  'data/pipeline.md',
  'data/scan-history.tsv',
  'data/score-history.tsv',
  'data/dedup-index.tsv',
  'data/discarded.tsv',
  'data/report-summaries.tsv',
  'data/filter-audit-state.json',
];

/** The 12 per-profile FILES (config + data). */
export const PROFILE_FILES = [...PROFILE_CONFIG_FILES, ...PROFILE_DATA_FILES];

/**
 * The 6 per-profile report DIRECTORIES. `reports/` itself stays a real
 * git-tracked directory (reports/.gitkeep must keep existing at its canonical
 * path); only these content subdirs are symlinked.
 */
export const PROFILE_REPORT_DIRS = [
  'reports/tier-1',
  'reports/tier-2',
  'reports/tier-3',
  'reports/tier-4',
  'reports/positioning',
  'reports/briefs',
];

/** All 18 canonical paths that become symlinks into the active profile. */
export const PROFILE_PATHS = [...PROFILE_FILES, ...PROFILE_REPORT_DIRS];

/** 'dir' for the six report subdirs, 'file' for everything else. */
export function pathKind(canonicalPath) {
  return PROFILE_REPORT_DIRS.includes(canonicalPath) ? 'dir' : 'file';
}

// ── Scaffold contents (canonical headers, single-sourced) ───────────────────
//
// Headers are DERIVED from the cores/prompts that write these files, not
// invented here:
//   - scan-history.tsv  → merge-staging-core.mjs HISTORY_HEADER (imported)
//   - dedup-index.tsv   → dedup-index.mjs HEADER (imported)
//   - score-history.tsv → modes/_shared.md § score-history / batch-prompt.md
//                         Step 6 (parity pinned by profile-core.test.mjs)
//   - scouting.md       → merge-scouting.mjs creation block (merge-scouting
//                         now imports SCOUTING_SCAFFOLD from here)
//   - pipeline.md       → merge-scan-staging.mjs creation shape
//   - applications.md   → CLAUDE.md onboarding header
//   - discarded.tsv     → frontend discardListing() tombstone format
//   - report-summaries.tsv → appenders write bare rows with NO header
//                         (modes/scouting.md § Report Summary Cache), so the
//                         scaffold is an empty file
//   - filter-audit-state.json → scan.mjs writes {lastReportDate}; `{}` = never

/** score-history.tsv header — must match modes/_shared.md + batch/batch-prompt.md. */
export const SCORE_HISTORY_HEADER =
  'date\tarchetype\tskills_match\tease_of_entry\tstrategic_fit\tcurrent_fit\t' +
  'growth_mobility\toptionality_exit\tbrand_value\tsales_trap_risk\t' +
  'aspirational_fit\toverall\tbest_cities\tsalary_adj_city\twork_life_balance\t' +
  'best_fit_roles\tmode\tcompany\trole\ttier\tsource\tlocation\t' +
  'employment_type\tduration\tsalary_raw\turl';

/** discarded.tsv header — matches the frontend tombstone writer. */
export const DISCARDED_HEADER = 'company\trole\tdate';

/** data/scouting.md scaffold — same block merge-scouting.mjs creates from scratch. */
export const SCOUTING_SCAFFOLD =
  '# Scouting Tracker\n\n' +
  'Landscape-mapping inventory. Entries here are NOT active applications — they are observations from `scouting` mode runs.\n\n' +
  '**Promotion path:** Tier 1 entries are flagged `READY` in the Promotion Hint column. Run `node scripts/promote-to-applications.mjs <num>` to move an entry from this file to `data/applications.md` and start the active application flow.\n\n' +
  '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n' +
  '|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|\n';

/**
 * data/applications.md scaffold — canonical 10-column header per CLAUDE.md
 * onboarding. The `Deadline` cell (between PDF and Report) is what
 * merge-tracker.mjs actually writes for every row, so the scaffold must carry
 * it too — a 9-column header under 10-column data rows is the schema drift that
 * slid Report/Notes one cell over in every downstream parser (frontend
 * parseApplications, applicationsDoc upsert). tracker-core.mjs parseAppRow still
 * tolerates the legacy 9-column form on existing files; new profiles start at 10.
 */
export const APPLICATIONS_SCAFFOLD =
  '# Applications Tracker\n\n' +
  'Active applications — entries the candidate has decided to apply to. Statuses are canonical (see `templates/states.yml`).\n\n' +
  '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |\n' +
  '|---|------|---------|------|-------|--------|-----|----------|--------|-------|\n';

/** data/pipeline.md scaffold — same shape merge-scan-staging.mjs creates. */
export const PIPELINE_SCAFFOLD = '# Pipeline — Pending Evaluations\n\n## Pending\n';

/**
 * Scaffold content per data file (config files deliberately have NO scaffold —
 * see PROFILE_CONFIG_FILES). Every entry ends in exactly the bytes a
 * first-time writer of that file would produce, so downstream parsers can't
 * tell a scaffolded profile from an organically-created one.
 */
export const TRACKER_SCAFFOLDS = {
  'data/scouting.md': SCOUTING_SCAFFOLD,
  'data/applications.md': APPLICATIONS_SCAFFOLD,
  'data/pipeline.md': PIPELINE_SCAFFOLD,
  'data/scan-history.tsv': SCAN_HISTORY_HEADER + '\n',
  'data/score-history.tsv': SCORE_HISTORY_HEADER + '\n',
  'data/dedup-index.tsv': DEDUP_INDEX_HEADER + '\n',
  'data/discarded.tsv': DISCARDED_HEADER + '\n',
  'data/report-summaries.tsv': '',
  'data/filter-audit-state.json': '{}\n',
};

// ── Slug + active-pointer + meta.yml ────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Slugs that can never name a profile (they collide with layout files). */
export const RESERVED_SLUGS = ['active'];

/**
 * Validate a profile slug: `^[a-z0-9][a-z0-9-]{0,31}$`, 'active' reserved.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    return { valid: false, reason: 'slug is required' };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      valid: false,
      reason: `invalid slug '${slug}' — must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits, hyphens; max 32 chars)`,
    };
  }
  if (RESERVED_SLUGS.includes(slug)) {
    return { valid: false, reason: `'${slug}' is a reserved name` };
  }
  return { valid: true };
}

/**
 * Parse the contents of `profiles/active` → the active slug, or null when
 * the content is empty/invalid. Tolerates surrounding whitespace and a
 * trailing newline (the canonical form is `<slug>\n`).
 */
export function parseActive(content) {
  if (typeof content !== 'string') return null;
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return validateSlug(line).valid ? line : null;
}

/** Serialize the active pointer file content for a slug. */
export function serializeActive(slug) {
  return `${slug}\n`;
}

/**
 * Parse a profile's meta.yml (two scalar keys, line-based on purpose —
 * scripts/ are zero-dep and this file is machine-written by serializeMeta).
 * @returns {{ label: string|null, created: string|null }}
 */
export function parseMeta(text) {
  const meta = { label: null, created: null };
  if (typeof text !== 'string') return meta;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = raw.match(/^(label|created):\s*(.*?)\s*$/);
    if (!m || meta[m[1]] != null) continue;
    let value = m[2];
    const quoted = value.match(/^"(.*)"$/);
    if (quoted) value = quoted[1].replace(/\\"/g, '"');
    if (value) meta[m[1]] = value;
  }
  return meta;
}

/** Serialize meta.yml. `created` is an ISO date string (YYYY-MM-DD). */
export function serializeMeta({ label, created }) {
  const escaped = String(label ?? '').replace(/"/g, '\\"');
  return `label: "${escaped}"\ncreated: ${created}\n`;
}

// ── Path math ───────────────────────────────────────────────────────────────

/** Repo-relative real path of a canonical path inside a profile. */
export function profileRelPath(slug, canonicalPath) {
  return `${PROFILES_DIR}/${slug}/${canonicalPath}`;
}

/**
 * RELATIVE symlink target for a canonical path, so the repo can move on disk:
 * `data/scouting.md` → `../profiles/<slug>/data/scouting.md`. Every canonical
 * path is exactly one directory deep, but this computes the depth anyway.
 */
export function relativeLinkTarget(canonicalPath, slug) {
  const depth = canonicalPath.split('/').length - 1;
  return '../'.repeat(depth) + profileRelPath(slug, canonicalPath);
}

/**
 * True when a symlink at `canonicalPath` with raw readlink value `linkTarget`
 * resolves to that same canonical path inside `profiles/<slug>/`. Accepts
 * both relative targets (the form the CLI writes) and absolute ones (checked
 * by suffix, since the repo root is unknown to pure code).
 */
export function linkResolvesIntoProfile(canonicalPath, linkTarget, slug) {
  if (typeof linkTarget !== 'string' || !linkTarget) return false;
  const expected = profileRelPath(slug, canonicalPath);
  const normalized = linkTarget.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    // Absolute target — compare by suffix.
    const clean = normalized.replace(/\/+$/, '');
    return clean === '/' + expected || clean.endsWith('/' + expected);
  }
  // Relative target — resolve against the link's parent dir with pure math.
  const parts = canonicalPath.split('/').slice(0, -1); // dir of the link
  for (const seg of normalized.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return false; // escapes the repo root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/') === expected;
}

// ── Operation plans ─────────────────────────────────────────────────────────
//
// Plans are declarative op lists the CLI executes in order. Vocabulary:
//   { op: 'ensure-dir',          path }
//   { op: 'write-meta',          path, content }
//   { op: 'scaffold-if-missing', path, content }
//   { op: 'copy-if-exists',      from, to }
//   { op: 'adopt',               canonical, to, kind, scaffold }   (init only)
//   { op: 'symlink',             linkPath, target, kind }          (atomic re-point)
//   { op: 'restore',             linkPath, from, kind }            (eject only)
//   { op: 'write-active',        slug }                            (always LAST on init/switch)
//   { op: 'remove-active' }                                        (always LAST on eject)
//
// 'adopt' = move-or-scaffold: if the canonical path is a real file/dir it is
// MOVED (fs.renameSync — never copied) into the profile; if absent, the
// profile-side file is scaffolded (or mkdir'd for report dirs) so the symlink
// never dangles for data paths. Config files have scaffold:null — absent
// config = onboarding pending, and that must survive the migration verbatim.

/** Shared skeleton: the profile's three top-level dirs. */
function ensureProfileDirs(slug) {
  return ['user', 'data', 'reports'].map((d) => ({
    op: 'ensure-dir',
    path: `${PROFILES_DIR}/${slug}/${d}`,
  }));
}

/** The 18 symlink ops re-pointing every canonical path into `slug`. */
function symlinkOps(slug) {
  return PROFILE_PATHS.map((p) => ({
    op: 'symlink',
    linkPath: p,
    target: relativeLinkTarget(p, slug),
    kind: pathKind(p),
  }));
}

/**
 * Plan the one-time migration: move live files into `profiles/<slug>/`,
 * scaffold whatever is absent, create the 18 symlinks, write the active
 * pointer LAST (a crash mid-init leaves no active file → doctor flags it,
 * eject/init can resume).
 */
export function planInit(slug, { label = null, date }) {
  return [
    ...ensureProfileDirs(slug),
    {
      op: 'write-meta',
      path: `${PROFILES_DIR}/${slug}/meta.yml`,
      content: serializeMeta({ label: label || slug, created: date }),
    },
    // Move (or scaffold) every canonical path first; only then link. If a
    // move fails midway no symlink has been created yet, so the repo is
    // still in a recognizable pre-migration state.
    ...PROFILE_PATHS.map((p) => ({
      op: 'adopt',
      canonical: p,
      to: profileRelPath(slug, p),
      kind: pathKind(p),
      scaffold: TRACKER_SCAFFOLDS[p] ?? null,
    })),
    ...symlinkOps(slug),
    { op: 'write-active', slug },
  ];
}

/**
 * Plan creating a new (inactive) profile: meta.yml, empty trackers with the
 * exact canonical headers, all six report subdirs; `from` copies the three
 * config files from an existing profile as the starting point. Does NOT
 * switch — the CLI chains planSwitch when `--switch` is passed.
 */
export function planCreate(slug, { from = null, label = null, date }) {
  const ops = [
    ...ensureProfileDirs(slug),
    {
      op: 'write-meta',
      path: `${PROFILES_DIR}/${slug}/meta.yml`,
      content: serializeMeta({ label: label || slug, created: date }),
    },
    ...PROFILE_DATA_FILES.map((p) => ({
      op: 'scaffold-if-missing',
      path: profileRelPath(slug, p),
      content: TRACKER_SCAFFOLDS[p],
    })),
    ...PROFILE_REPORT_DIRS.map((p) => ({
      op: 'ensure-dir',
      path: profileRelPath(slug, p),
    })),
  ];
  if (from) {
    for (const p of PROFILE_CONFIG_FILES) {
      ops.push({
        op: 'copy-if-exists',
        from: profileRelPath(from, p),
        to: profileRelPath(slug, p),
      });
    }
  }
  return ops;
}

/**
 * Plan switching the active profile: atomically re-point the 18 symlinks,
 * then write `profiles/active` LAST (spec §3 — a crash mid-switch leaves the
 * pointer at the previous profile; doctor detects the mixed links).
 */
export function planSwitch(slug) {
  return [...symlinkOps(slug), { op: 'write-active', slug }];
}

/**
 * Plan the full rollback: replace each canonical symlink with the real
 * file/dir moved back out of the active profile, then delete the active
 * pointer. Other profile dirs stay untouched on disk.
 */
export function planEject(activeSlug) {
  return [
    ...PROFILE_PATHS.map((p) => ({
      op: 'restore',
      linkPath: p,
      from: profileRelPath(activeSlug, p),
      kind: pathKind(p),
    })),
    { op: 'remove-active' },
  ];
}

// ── Guards ──────────────────────────────────────────────────────────────────

/**
 * Parse batch/batch-state.tsv (written by batch/batch-runner.sh; header
 * `id\turl\tstatus\t…`) into `{ id, status }` rows. Column positions are
 * resolved from the header row so a column addition doesn't silently break
 * the guard; falls back to the runner's fixed layout (id=0, status=2).
 */
export function parseBatchStateRows(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t').map((c) => c.trim().toLowerCase());
  const hasHeader = header.includes('id') && header.includes('status');
  const idIdx = hasHeader ? header.indexOf('id') : 0;
  const statusIdx = hasHeader ? header.indexOf('status') : 2;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cols = line.split('\t');
    return {
      id: (cols[idIdx] || '').trim(),
      status: (cols[statusIdx] || '').trim(),
    };
  });
}

/**
 * Evaluate the switch/init/eject guards over PURE inputs (the CLI gathers
 * them from disk). Returns an array of one-line human-readable refusal
 * strings — empty array = safe to proceed. `--force` in the CLI bypasses
 * these, nothing else does.
 *
 * The three guards (spec §3):
 *  1. Unmerged eval output: any *.tsv directly in batch/tracker-additions/
 *     or batch/scouting-additions/ (their merged/ subdirs don't count) —
 *     merging after a switch would write another profile's rows into the
 *     newly-active trackers.
 *  2. In-flight batch workers per batch/batch-state.tsv (status
 *     'processing') — a live worker would keep writing through re-pointed
 *     symlinks into the wrong profile.
 *  3. Unmerged JobSpy aggregator staging files — same cross-profile
 *     contamination risk via merge-scan-staging.mjs.
 *
 * @param {object} inputs
 * @param {string[]} [inputs.trackerAdditionTsvs]  *.tsv filenames directly in batch/tracker-additions/
 * @param {string[]} [inputs.scoutingAdditionTsvs] *.tsv filenames directly in batch/scouting-additions/
 * @param {Array<{id:string,status:string}>} [inputs.batchStateRows] parsed batch-state rows
 * @param {boolean} [inputs.jobspyHistoryStagingPresent]  data/scan-history.jobspy.tsv exists
 * @param {boolean} [inputs.jobspyPipelineStagingPresent] data/pipeline.jobspy.md exists
 * @returns {string[]} refusal reasons (empty = pass)
 */
export function evaluateGuards({
  trackerAdditionTsvs = [],
  scoutingAdditionTsvs = [],
  batchStateRows = [],
  jobspyHistoryStagingPresent = false,
  jobspyPipelineStagingPresent = false,
} = {}) {
  const failures = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  if (trackerAdditionTsvs.length > 0) {
    failures.push(
      `unmerged TSVs in batch/tracker-additions (${plural(trackerAdditionTsvs.length, 'file')})`
    );
  }
  if (scoutingAdditionTsvs.length > 0) {
    failures.push(
      `unmerged TSVs in batch/scouting-additions (${plural(scoutingAdditionTsvs.length, 'file')})`
    );
  }

  const inFlight = batchStateRows.filter((r) => r.status === 'processing').length;
  if (inFlight > 0) {
    failures.push(`in-flight batch workers in batch/batch-state.tsv (${inFlight} processing)`);
  }

  if (jobspyHistoryStagingPresent) {
    failures.push('unmerged JobSpy staging: data/scan-history.jobspy.tsv');
  }
  if (jobspyPipelineStagingPresent) {
    failures.push('unmerged JobSpy staging: data/pipeline.jobspy.md');
  }

  return failures;
}

// ── Small counters for `profile list` ───────────────────────────────────────

/**
 * Count pending inbox entries in a pipeline.md text: unchecked checkbox
 * lines carrying a URL (`- [ ] https://… | Company | Title`). Checked lines
 * (`- [x]`) are processed history, not pipeline load.
 */
export function countPendingPipelineLines(content) {
  if (typeof content !== 'string' || !content) return 0;
  return content.split('\n').filter((l) => /^-\s*\[ \]\s*https?:\/\//.test(l.trim())).length;
}
