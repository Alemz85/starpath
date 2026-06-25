#!/usr/bin/env node

/**
 * check-story-bank.mjs — Health check + competency-coverage report for the
 * STAR+R interview story bank (interview-prep/story-bank.md).
 *
 * The story bank is the cross-listing asset that modes/interview-prep.md
 * (Step 5) and modes/apply.md both read on every run. This script validates
 * that every story is complete (full STAR+R + a recognized competency theme),
 * surfaces duplicate titles (the dedup-rule violation), and prints a
 * competency-coverage map so the user can see which behavioral competencies
 * still have no story — i.e. their interview blind spots.
 *
 * All logic lives in the pure module scripts/lib/story-bank.mjs (the same one
 * cv-sync-check.mjs and apply.md consume). This file is just the on-disk read
 * + the human/JSON rendering.
 *
 * Usage:
 *   node scripts/check-story-bank.mjs              # human-readable report
 *   node scripts/check-story-bank.mjs --json       # machine-readable
 *   node scripts/check-story-bank.mjs --strict     # exit non-zero on warnings too
 *
 * Exit code: 0 if the bank is structurally valid (errors-free), 1 otherwise.
 * Missing bank is OK (exit 0) — the user simply hasn't built one yet.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { COMPETENCIES, parseStoryBank, validateBank } from './lib/story-bank.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');

const bankPath = join(projectRoot, 'interview-prep', 'story-bank.md');

if (!existsSync(bankPath)) {
  if (asJson) {
    console.log(JSON.stringify({ exists: false, ok: true, storyCount: 0 }, null, 2));
  } else {
    console.log('Story bank not found at interview-prep/story-bank.md.');
    console.log('No stories yet — run interview-prep mode to start building one.');
  }
  process.exit(0);
}

const md = readFileSync(bankPath, 'utf-8');
const stories = parseStoryBank(md);
const report = validateBank(stories);

const totalWarnings = report.perStory.reduce((n, s) => n + s.warnings.length, 0);
const hasErrors = !report.ok;
const exitCode = hasErrors || (strict && totalWarnings > 0) ? 1 : 0;

if (asJson) {
  console.log(JSON.stringify({
    exists: true,
    ok: report.ok,
    storyCount: report.storyCount,
    duplicates: report.duplicates,
    gaps: report.gaps,
    index: report.index,
    perStory: report.perStory,
  }, null, 2));
  process.exit(exitCode);
}

// ── Human-readable report ────────────────────────────────────────────────────
const line = (s = '') => console.log(s);

line(`Story bank: ${report.storyCount} stor${report.storyCount === 1 ? 'y' : 'ies'} in interview-prep/story-bank.md`);
line();

// Per-story validation. report.perStory carries each story's competencies via
// the index, so re-derive a compact tag list for display.
let errorStories = 0;
for (const s of report.perStory) {
  const tags = COMPETENCIES.filter((c) => (report.index[c.id] || []).includes(s.title)).map((c) => c.id);
  if (s.errors.length === 0 && s.warnings.length === 0) {
    line(`  OK   ${s.title}  [${tags.join(', ') || '—'}]`);
  } else {
    if (s.errors.length) errorStories++;
    const mark = s.errors.length ? 'FAIL' : 'WARN';
    line(`  ${mark} ${s.title}  [${tags.join(', ') || '—'}]`);
    for (const e of s.errors) line(`       error:   ${e}`);
    for (const w of s.warnings) line(`       warning: ${w}`);
  }
}

// Duplicate titles (dedup-rule violations).
if (report.duplicates.length) {
  line();
  line('Duplicate titles (interview-prep.md dedup rule says: update, never re-add):');
  for (const d of report.duplicates) {
    line(`  FAIL "${d.title}" appears ${d.count}x (stories ${d.indices.map((i) => i + 1).join(', ')})`);
  }
}

// Competency coverage map.
line();
line('Competency coverage:');
for (const c of COMPETENCIES) {
  const covering = report.index[c.id] || [];
  if (covering.length) {
    line(`  OK  ${c.label.padEnd(26)} ${covering.length} stor${covering.length === 1 ? 'y' : 'ies'}`);
  } else {
    line(`  ·   ${c.label.padEnd(26)} (gap — no story yet)`);
  }
}

if (report.gaps.length) {
  line();
  line(`${report.gaps.length} competenc${report.gaps.length === 1 ? 'y has' : 'ies have'} no story. ` +
       `interview-prep mode will prompt you to build one when a role tests for it.`);
}

line();
if (hasErrors) {
  const parts = [];
  if (errorStories) parts.push(`${errorStories} stor${errorStories === 1 ? 'y' : 'ies'} incomplete`);
  if (report.duplicates.length) parts.push(`${report.duplicates.length} duplicate title(s)`);
  line(`FAIL ${parts.join(' + ')}. Fix before relying on the bank.`);
} else if (totalWarnings > 0) {
  line(`OK — structurally valid. ${totalWarnings} warning(s), non-blocking but worth tightening.`);
} else {
  line('OK — story bank is clean.');
}

process.exit(exitCode);
