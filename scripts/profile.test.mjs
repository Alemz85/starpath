// Integration tests for scripts/profile.mjs — real filesystem in a mkdtemp
// mini-repo, driving the CLI end-to-end via `node scripts/profile.mjs --root`.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.
//
// Flow under test (spec §3): init → create --from → switch → guard refusal →
// forced switch → eject. Asserts symlink targets, file contents, the active
// pointer, exact JSON output shapes, and exit codes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync, lstatSync, readlinkSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILE_PATHS, PROFILE_REPORT_DIRS, TRACKER_SCAFFOLDS, relativeLinkTarget,
} from './lib/profile-core.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'profile.mjs');

let root;

/** Run the CLI against the mini-repo; returns { code, json, stdout }. */
function run(...args) {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args, '--root', root], {
      encoding: 'utf-8',
    });
  } catch (err) {
    code = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  let json = null;
  if (args.includes('--json')) {
    try { json = JSON.parse(stdout.trim()); } catch { /* asserted by callers */ }
  }
  return { code, json, stdout };
}

const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const isLink = (rel) => lstatSync(join(root, rel)).isSymbolicLink();
const target = (rel) => readlinkSync(join(root, rel));

// Fixture contents (test-only, no real user data).
const PROFILE_YML = 'name: Test Candidate\ntarget_range: 1000-2000\n';
const PORTALS_YML = 'keywords:\n  - analyst\n';
const PROFILE_MD = '# Customization\n\nfixture archetypes\n';
const SCOUTING_MD =
  '# Scouting Tracker\n\n| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n' +
  '|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|\n' +
  '| 1 | 2026-07-01 | ACME | Analyst | 7.5/10 | T2 | 7.6/7.2 | — | n/d | | fixture row |\n';
const PIPELINE_MD =
  '# Pipeline — Pending Evaluations\n\n## Pending\n\n- [ ] https://x.test/a | ACME | Analyst\n';
const REPORT_MD = '# ACME - Analyst\n\nfixture report body\n';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-cli-'));
  // Mini-repo: some canonical files present, some deliberately absent
  // (data/applications.md, data/discarded.tsv, … must be scaffolded by init).
  mkdirSync(join(root, 'user'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports/tier-1'), { recursive: true });
  mkdirSync(join(root, 'batch/tracker-additions'), { recursive: true });
  mkdirSync(join(root, 'batch/scouting-additions'), { recursive: true });
  writeFileSync(join(root, 'user/profile.yml'), PROFILE_YML);
  writeFileSync(join(root, 'user/portals.yml'), PORTALS_YML);
  writeFileSync(join(root, 'user/_profile.md'), PROFILE_MD);
  writeFileSync(join(root, 'user/cv.md'), '# CV\n\n- shared file, must NOT move\n');
  writeFileSync(join(root, 'data/scouting.md'), SCOUTING_MD);
  writeFileSync(join(root, 'data/pipeline.md'), PIPELINE_MD);
  writeFileSync(join(root, 'data/network.md'), '# Network\n'); // shared, must NOT move
  writeFileSync(join(root, 'reports/.gitkeep'), '');
  writeFileSync(join(root, 'reports/tier-1/ACME - Analyst.md'), REPORT_MD);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Sequential scenario — node:test runs tests in declaration order per file.

test('list before init reports the single-profile layout', () => {
  const { code, json } = run('list', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { active: null, profiles: [] });
});

test('switch before init refuses with not-initialized', () => {
  const { code, json } = run('switch', 'career', '--json');
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'not-initialized');
});

test('init migrates live files, scaffolds the rest, links all 18 paths', () => {
  const { code, json } = run('init', '--label', 'Main search', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: 'career', previous: null });

  // Active pointer written, canonical form.
  assert.equal(read('profiles/active'), 'career\n');

  // Every canonical path is a RELATIVE symlink into the profile.
  for (const p of PROFILE_PATHS) {
    assert.ok(isLink(p), `${p} should be a symlink`);
    assert.equal(target(p), relativeLinkTarget(p, 'career'), p);
  }

  // Moved (not copied) — content readable through the symlink AND at the
  // real profile path.
  assert.equal(read('data/scouting.md'), SCOUTING_MD);
  assert.equal(read('profiles/career/data/scouting.md'), SCOUTING_MD);
  assert.equal(read('profiles/career/user/profile.yml'), PROFILE_YML);
  assert.equal(read('reports/tier-1/ACME - Analyst.md'), REPORT_MD);
  assert.equal(read('profiles/career/reports/tier-1/ACME - Analyst.md'), REPORT_MD);

  // Absent optional trackers scaffolded INSIDE the profile.
  assert.equal(read('data/applications.md'), TRACKER_SCAFFOLDS['data/applications.md']);
  assert.equal(read('data/discarded.tsv'), TRACKER_SCAFFOLDS['data/discarded.tsv']);
  assert.equal(read('data/filter-audit-state.json'), '{}\n');

  // Shared files stayed real files in place.
  assert.ok(!isLink('user/cv.md'));
  assert.ok(!isLink('data/network.md'));
  assert.ok(!isLink('reports')); // reports/ itself stays a real dir
  assert.equal(read('reports/.gitkeep'), '');

  // meta.yml
  assert.match(read('profiles/career/meta.yml'), /label: "Main search"/);
});

test('init is one-time — second init refuses', () => {
  const { code, json } = run('init', '--json');
  assert.equal(code, 1);
  assert.equal(json.error, 'already-initialized');
});

test('create --from scaffolds trackers and copies the 3 config files', () => {
  const { code, json } = run(
    'create', 'second', '--from', 'career', '--label', 'Second search', '--json'
  );
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: 'career', previous: 'career', created: 'second' });

  // Config copied from career.
  assert.equal(read('profiles/second/user/profile.yml'), PROFILE_YML);
  assert.equal(read('profiles/second/user/portals.yml'), PORTALS_YML);
  assert.equal(read('profiles/second/user/_profile.md'), PROFILE_MD);

  // Trackers scaffolded with canonical headers; report dirs exist.
  assert.equal(read('profiles/second/data/scouting.md'), TRACKER_SCAFFOLDS['data/scouting.md']);
  assert.equal(
    read('profiles/second/data/score-history.tsv'),
    TRACKER_SCAFFOLDS['data/score-history.tsv']
  );
  for (const d of PROFILE_REPORT_DIRS) {
    assert.ok(existsSync(join(root, 'profiles/second', d)), d);
  }

  // Still on career — create never switches without --switch.
  assert.equal(read('profiles/active'), 'career\n');
  assert.equal(target('data/scouting.md'), relativeLinkTarget('data/scouting.md', 'career'));
});

test('create refuses duplicate slugs and bad slugs', () => {
  assert.equal(run('create', 'second', '--json').json.error, 'profile-exists');
  assert.equal(run('create', 'Bad Slug', '--json').json.error, 'invalid-slug');
  assert.equal(run('create', 'active', '--json').json.error, 'invalid-slug');
  const missingFrom = run('create', 'third', '--from', 'nope', '--json');
  assert.equal(missingFrom.code, 1);
  assert.deepEqual(missingFrom.json, {
    ok: false, error: 'unknown-profile', message: "no profile 'nope'",
  });
  assert.ok(!existsSync(join(root, 'profiles/third')));
});

test('switch re-points all 18 symlinks and writes active last', () => {
  const { code, json } = run('switch', 'second', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: 'second', previous: 'career' });

  assert.equal(read('profiles/active'), 'second\n');
  for (const p of PROFILE_PATHS) {
    assert.ok(isLink(p), p);
    assert.equal(target(p), relativeLinkTarget(p, 'second'), p);
  }
  // The canonical view now shows second's (scaffolded) data, career's is intact.
  assert.equal(read('data/scouting.md'), TRACKER_SCAFFOLDS['data/scouting.md']);
  assert.equal(read('profiles/career/data/scouting.md'), SCOUTING_MD);
});

test('switch to unknown profile fails with the spec JSON shape', () => {
  const { code, json } = run('switch', 'nope', '--json');
  assert.equal(code, 1);
  assert.deepEqual(json, { ok: false, error: 'unknown-profile', message: "no profile 'nope'" });
});

test('switch to the already-active profile is an ok no-op', () => {
  const { code, json } = run('switch', 'second', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: 'second', previous: 'second' });
});

test('guards refuse a switch while unmerged scouting TSVs exist', () => {
  writeFileSync(join(root, 'batch/scouting-additions/001-acme.tsv'), '1\trow\n');
  const { code, json } = run('switch', 'career', '--json');
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'guards');
  assert.deepEqual(json.guardFailures, ['unmerged TSVs in batch/scouting-additions (1 file)']);
  // Nothing moved.
  assert.equal(read('profiles/active'), 'second\n');
});

test('guards also catch in-flight batch workers and JobSpy staging', () => {
  writeFileSync(
    join(root, 'batch/batch-state.tsv'),
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' +
    '1\thttps://x.test/a\tprocessing\t2026-07-07T10:00:00Z\t-\t001\t-\t-\t0\n'
  );
  writeFileSync(join(root, 'data/scan-history.jobspy.tsv'), 'url\tfirst_seen\n');
  const { json } = run('switch', 'career', '--json');
  assert.equal(json.error, 'guards');
  assert.deepEqual(json.guardFailures, [
    'unmerged TSVs in batch/scouting-additions (1 file)',
    'in-flight batch workers in batch/batch-state.tsv (1 processing)',
    'unmerged JobSpy staging: data/scan-history.jobspy.tsv',
  ]);
  // Clean up the extra tripwires; keep the scouting TSV for the --force test.
  unlinkSync(join(root, 'batch/batch-state.tsv'));
  unlinkSync(join(root, 'data/scan-history.jobspy.tsv'));
});

test('switch --force overrides the guards', () => {
  const { code, json } = run('switch', 'career', '--force', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: 'career', previous: 'second' });
  assert.equal(read('data/scouting.md'), SCOUTING_MD);
  unlinkSync(join(root, 'batch/scouting-additions/001-acme.tsv'));
});

test('list reports both profiles with labels, active flag, and counts', () => {
  const { code, json } = run('list', '--json');
  assert.equal(code, 0);
  assert.equal(json.active, 'career');
  assert.equal(json.profiles.length, 2);

  const career = json.profiles.find((p) => p.slug === 'career');
  assert.equal(career.label, 'Main search');
  assert.equal(career.active, true);
  assert.deepEqual(career.counts, { scouting: 1, applications: 0, pipeline: 1, reports: 1 });

  const second = json.profiles.find((p) => p.slug === 'second');
  assert.equal(second.label, 'Second search');
  assert.equal(second.active, false);
  assert.deepEqual(second.counts, { scouting: 0, applications: 0, pipeline: 0, reports: 0 });
});

test('eject restores real files and removes the active pointer', () => {
  const { code, json } = run('eject', '--json');
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, active: null, previous: 'career' });

  assert.ok(!existsSync(join(root, 'profiles/active')));
  for (const p of PROFILE_PATHS) {
    assert.ok(existsSync(join(root, p)), `${p} should exist after eject`);
    assert.ok(!isLink(p), `${p} should be a real path after eject`);
  }
  // Round-trip: original content survived init → switches → eject.
  assert.equal(read('data/scouting.md'), SCOUTING_MD);
  assert.equal(read('user/profile.yml'), PROFILE_YML);
  assert.equal(read('reports/tier-1/ACME - Analyst.md'), REPORT_MD);
  // Scaffolded-at-init files came back out as real files too.
  assert.equal(read('data/applications.md'), TRACKER_SCAFFOLDS['data/applications.md']);

  // The inactive profile dir is left untouched on disk.
  assert.equal(read('profiles/second/user/profile.yml'), PROFILE_YML);

  // And list is back to the pre-init shape… but profiles/ still exists with
  // profile dirs, so active is null while the dirs remain listed.
  const { json: listJson } = run('list', '--json');
  assert.equal(listJson.active, null);
  assert.equal(listJson.profiles.length, 2);
});

test('eject without an active pointer refuses', () => {
  const { code, json } = run('eject', '--json');
  assert.equal(code, 1);
  assert.equal(json.error, 'not-initialized');
});

test('unknown command exits 1 with a usage error', () => {
  const { code, json } = run('bogus', '--json');
  assert.equal(code, 1);
  assert.equal(json.error, 'usage');
});

/* ───── Safety-path scenarios (audit finding 10) ─────────────────────────────
 *
 * These build their OWN throwaway mini-repos so they don't perturb the shared
 * sequential scenario above (which ends ejected). Each seeds a repo, runs the
 * real CLI end-to-end, and asserts a single safety property.
 */

function seedAndInit() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-cli-safety-'));
  mkdirSync(join(dir, 'user'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'reports/tier-1'), { recursive: true });
  mkdirSync(join(dir, 'batch/tracker-additions'), { recursive: true });
  mkdirSync(join(dir, 'batch/scouting-additions'), { recursive: true });
  writeFileSync(join(dir, 'user/profile.yml'), PROFILE_YML);
  writeFileSync(join(dir, 'user/portals.yml'), PORTALS_YML);
  writeFileSync(join(dir, 'user/_profile.md'), PROFILE_MD);
  writeFileSync(join(dir, 'user/cv.md'), '# CV\n');
  writeFileSync(join(dir, 'data/scouting.md'), SCOUTING_MD);
  writeFileSync(join(dir, 'data/pipeline.md'), PIPELINE_MD);
  writeFileSync(join(dir, 'reports/.gitkeep'), '');
  writeFileSync(join(dir, 'reports/tier-1/ACME - Analyst.md'), REPORT_MD);
  execFileSync(process.execPath, [CLI, 'init', '--root', dir], { encoding: 'utf-8' });
  return dir;
}

function runAt(dir, ...args) {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args, '--root', dir], { encoding: 'utf-8' });
  } catch (err) {
    code = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  let json = null;
  if (args.includes('--json')) {
    try { json = JSON.parse(stdout.trim()); } catch { /* asserted by callers */ }
  }
  return { code, json, stdout };
}

test('switch refuses (error: shadow) when a canonical symlink is shadowed by a real file, and moves nothing', () => {
  const dir = seedAndInit();
  try {
    runAt(dir, 'create', 'second', '--from', 'career');
    // A write-temp-then-rename bug would replace the symlink with a real file.
    const shadowed = join(dir, 'data/applications.md');
    unlinkSync(shadowed);
    writeFileSync(shadowed, '# shadow real file — must block the switch\n');

    const { code, json } = runAt(dir, 'switch', 'second', '--json');
    assert.equal(code, 1);
    assert.equal(json.error, 'shadow');

    // Nothing moved: active pointer still career, other links still into career,
    // and the shadow file is left in place untouched.
    assert.equal(readFileSync(join(dir, 'profiles/active'), 'utf-8'), 'career\n');
    assert.equal(
      readlinkSync(join(dir, 'data/scouting.md')),
      relativeLinkTarget('data/scouting.md', 'career'),
    );
    assert.match(readFileSync(shadowed, 'utf-8'), /shadow real file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create --from --switch scaffolds, re-points every symlink, returns { created, active: slug }', () => {
  const dir = seedAndInit();
  try {
    const { code, json } = runAt(dir, 'create', 'third', '--from', 'career', '--switch', '--json');
    assert.equal(code, 0);
    assert.equal(json.created, 'third');
    assert.equal(json.active, 'third');
    assert.equal(json.previous, 'career');

    // Active pointer flipped to the new profile.
    assert.equal(readFileSync(join(dir, 'profiles/active'), 'utf-8'), 'third\n');
    // Config copied verbatim from the --from source.
    assert.equal(readFileSync(join(dir, 'profiles/third/user/profile.yml'), 'utf-8'), PROFILE_YML);
    // Trackers scaffolded with canonical headers inside the new profile.
    assert.equal(
      readFileSync(join(dir, 'profiles/third/data/scouting.md'), 'utf-8'),
      TRACKER_SCAFFOLDS['data/scouting.md'],
    );
    // Every canonical symlink now re-points into 'third'.
    for (const p of PROFILE_PATHS) {
      assert.ok(lstatSync(join(dir, p)).isSymbolicLink(), p);
      assert.equal(readlinkSync(join(dir, p)), relativeLinkTarget(p, 'third'), p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
