// cv-summary.test.mjs — CLI-level staleness matrix for scripts/cv-summary.mjs
// `--if-stale` (audit finding 10c).
//
// cv-summary.mjs resolves ROOT from its own path (it has no --root flag), so to
// drive it against a throwaway repo we copy scripts/ into a temp root and run
// the COPY — then ROOT resolves to the temp dir. The matrix exercises the three
// non-trivial `--if-stale` outcomes:
//   1. fresh mtime + matching profile slug  → skip (artifact untouched)
//   2. fresh mtime + MISMATCHED slug         → regenerate (other profile's summary)
//   3. stale mtime + matching slug           → regenerate (source changed)
//
// Run: node --test scripts/cv-summary.test.mjs   (or `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, utimesSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_SCRIPTS = dirname(fileURLToPath(import.meta.url));

const PRE_EXISTING = '# pre-existing summary body — overwritten iff regenerated\n';

/**
 * Build a throwaway repo with a copied scripts/ dir, a CV + profile, an optional
 * active-profile pointer, and a pre-existing artifact whose profile stamp and
 * mtime (relative to the sources) are chosen by the caller.
 */
function buildRepo({ activeSlug = null, artifactStamp = null, mtimeDeltaSec = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-summary-'));
  cpSync(REAL_SCRIPTS, join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'user'), { recursive: true });
  mkdirSync(join(dir, 'batch'), { recursive: true });
  writeFileSync(join(dir, 'user/cv.md'), '# CV\n\n## Experience\n**Acme** — Analyst | 2024\n');
  writeFileSync(join(dir, 'user/profile.yml'), 'candidate:\n  full_name: Test Candidate\n');
  if (activeSlug) {
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(join(dir, 'profiles/active'), `${activeSlug}\n`);
  }

  const stampLine = artifactStamp ? `<!-- profile: ${artifactStamp} -->\n` : '';
  const artifactPath = join(dir, 'batch/cv-summary.md');
  writeFileSync(artifactPath, stampLine + PRE_EXISTING);

  // Freshness is `artifact.mtime >= max(cv.mtime, profile.mtime)`. Pin the
  // artifact mtime relative to the sources (seconds; utimesSync takes seconds).
  const srcMs = Math.max(
    statSync(join(dir, 'user/cv.md')).mtimeMs,
    statSync(join(dir, 'user/profile.yml')).mtimeMs,
  );
  const artSec = srcMs / 1000 + mtimeDeltaSec;
  utimesSync(artifactPath, artSec, artSec);
  return dir;
}

function runIfStale(dir) {
  return execFileSync(process.execPath, [join(dir, 'scripts/cv-summary.mjs'), '--if-stale'], {
    encoding: 'utf-8',
  }).trim();
}

const artifact = (dir) => readFileSync(join(dir, 'batch/cv-summary.md'), 'utf-8');
const wasRegenerated = (dir) => !artifact(dir).includes('pre-existing summary body');

test('--if-stale: fresh mtime + matching slug → skips (artifact left untouched)', () => {
  const dir = buildRepo({ activeSlug: 'career', artifactStamp: 'career', mtimeDeltaSec: +100 });
  try {
    const out = runIfStale(dir);
    assert.match(out, /fresh — skipped/);
    assert.equal(wasRegenerated(dir), false, 'artifact must be left as-is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--if-stale: fresh mtime + MISMATCHED slug → regenerates for the active profile', () => {
  const dir = buildRepo({ activeSlug: 'career', artifactStamp: 'other-profile', mtimeDeltaSec: +100 });
  try {
    const out = runIfStale(dir);
    assert.match(out, /wrote batch\/cv-summary\.md/);
    assert.equal(wasRegenerated(dir), true, 'a summary from another profile must be rebuilt');
    assert.match(artifact(dir), /<!-- profile: career -->/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--if-stale: stale mtime + matching slug → regenerates (source changed)', () => {
  const dir = buildRepo({ activeSlug: 'career', artifactStamp: 'career', mtimeDeltaSec: -100 });
  try {
    const out = runIfStale(dir);
    assert.match(out, /wrote batch\/cv-summary\.md/);
    assert.equal(wasRegenerated(dir), true, 'an out-of-date summary must be rebuilt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
