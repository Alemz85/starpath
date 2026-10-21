#!/usr/bin/env node
/**
 * merge-scouting.mjs — Merge batch scouting additions into data/scouting.md
 *
 * Sibling of merge-tracker.mjs. Scouting hits are landscape-mapping inventory,
 * not active applications, so they live in data/scouting.md with a different
 * column shape (docs/scoring-v2.md §8.2):
 *
 *   # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes
 *
 * TSV input format (12 tab-separated columns, written by modes/scouting.md):
 *
 *   num\tdate\tcompany\trole\twant\tease\ttier\teligibility\treport\tdeadline\tpromotion_hint\tnotes
 *
 * Want/Ease are numbers (no "/10"), or "—" for a Blocked (red-eligibility)
 * listing. The v1 10/11-column forms are retired — v1 data was archived, so
 * they are rejected with a warning rather than converted.
 *
 * Dedup: company normalized + role fuzzy match + report number match.
 * Re-evaluation: a newer evaluation of the same listing REPLACES the old row
 * (the score is point-in-time, not a high-water mark); the note records
 * "Re-eval (W a→b, E c→d)". An addition dated before the existing row is
 * skipped as stale. A PROMOTED-n hint is preserved.
 *
 * Applications refresh: when a merged listing is already in
 * data/applications.md (strict company + role match), that row's Score cell
 * becomes the new `W.. E..` and its Report link the new report, so an applied
 * role never keeps a stale score after a re-evaluation.
 *
 * Row numbers: a TSV's own number stands when it is free and either above the
 * current max or reserved (scripts/reserve-report-num.mjs); otherwise max + 1.
 * Merged numbers are released from the reservation folder.
 *
 * Write safety: runs under the scouting.md lock, and takes the
 * applications.md lock around the refresh (always in that order: scouting,
 * then applications). Both files are replaced atomically through their
 * profile links (lib/dir-lock.mjs, lib/write-file-atomic.mjs).
 *
 * Parsing/normalization lives in lib/scouting-core.mjs (pure + unit-tested);
 * this script owns the file I/O and merge orchestration.
 *
 * Run: node career-ops/merge-scouting.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
  companyKey,
  normalizeRoleForIndex,
  roleVariantMatch,
  extractReportNum,
  isV2ScoutingHeader,
  parseScoutingRow,
  parseScoutingTsv,
  formatScoutingRow,
  shouldReplaceScoutingRow,
  buildReEvalRow,
  reEvalNote,
} from './lib/scouting-core.mjs';
import { SCOUTING_SCAFFOLD } from './lib/profile-core.mjs';
import { refreshApplicationRows } from './lib/tracker-core.mjs';
import { acquireLockSync, lockPathFor, withLockSync } from './lib/dir-lock.mjs';
import { writeFileAtomic } from './lib/write-file-atomic.mjs';
import { isReserved, pickEntryNum, releaseNum } from './lib/report-nums.mjs';

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const APPLICATIONS_FILE = join(CAREER_OPS, 'data/applications.md');
const DEDUP_INDEX_FILE = join(CAREER_OPS, 'data/dedup-index.tsv');
const DEDUP_INDEX_HEADER = 'company_normalized\trole_normalized\tlast_seen_date';
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/scouting-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

/** The link target of a `[n](reports/…md)` cell, or null. */
function reportPath(cell) {
  const m = /\]\(([^)]+)\)\s*$/.exec(String(cell ?? ''));
  return m ? m[1].trim() : null;
}

function appendDedupIndex(company, role, date) {
  if (DRY_RUN) return;
  const row = `${companyKey(company)}\t${normalizeRoleForIndex(role)}\t${date}\n`;
  if (!existsSync(DEDUP_INDEX_FILE)) {
    writeFileSync(DEDUP_INDEX_FILE, DEDUP_INDEX_HEADER + '\n' + row);
  } else {
    appendFileSync(DEDUP_INDEX_FILE, row);
  }
}

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

// ---- Main ----

// Hold the scouting lock from the read to the write (released on every exit).
if (!DRY_RUN) {
  const lock = acquireLockSync(lockPathFor(SCOUTING_FILE), { label: 'merge-scouting', timeoutMs: 60_000 });
  process.on('exit', () => lock.release());
}

if (!existsSync(SCOUTING_FILE)) {
  console.log('No data/scouting.md found. Creating from scratch.');
  // Canonical scaffold is single-sourced in lib/profile-core.mjs so profile
  // creation (scripts/profile.mjs) and this merge always agree on the header.
  writeFileAtomic(SCOUTING_FILE, SCOUTING_SCAFFOLD);
}

const fileContent = readFileSync(SCOUTING_FILE, 'utf-8');
const fileLines = fileContent.split('\n');

// Fail closed on a v1 table: appending 12-column rows under an 11-column
// header would corrupt the file. v1 data is archived (data/archive/scoring-v1/).
const headerLine = fileLines.find(l => /^\|\s*#\s*\|/.test(l));
if (headerLine && !isV2ScoutingHeader(headerLine)) {
  console.error('❌ data/scouting.md has a pre-v2 header (Score/Tier/CF-AF). Archive it and recreate it with the v2 12-column header (Want/Ease/Tier/Eligibility) — see docs/scoring-v2.md §8.2.');
  process.exit(1);
}
const existing = [];
const takenNums = new Set();
let maxNum = 0;

for (const line of fileLines) {
  if (line.startsWith('|') && !line.includes('---') && !/^\|\s*#\s*\|/.test(line)) {
    const e = parseScoutingRow(line);
    if (e) {
      existing.push(e);
      takenNums.add(e.num);
      if (e.num > maxNum) maxNum = e.num;
    }
  }
}

console.log(`📊 Existing: ${existing.length} scouting entries, max #${maxNum}`);

if (!existsSync(ADDITIONS_DIR)) {
  console.log('No scouting-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending scouting additions to merge.');
  process.exit(0);
}

tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending scouting additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newRows = [];
const mergedNums = []; // TSV numbers to release from the reservation folder
const merged = []; // every addition that landed (added or updated), for the applications refresh
// Rows this run already rewrote. Only an exact role or report-path match may
// land on one again: a loose match would compare the next addition with the
// role the previous one just wrote, chaining sibling listings into one row.
const touched = new Set();

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseScoutingTsv(content, file);
  if (!addition) { skipped++; continue; }
  mergedNums.push(addition.num);

  // Match the listing, most specific first. Numbers come last and only within
  // the same company: parallel workers can pick the same next number (two
  // listings both arriving as #13), so a number alone must never decide which
  // row a result overwrites.
  const normCompany = companyKey(addition.company);
  const sameCompany = (e) => companyKey(e.company) === normCompany;
  const roleKey = normalizeRoleForIndex(addition.role);
  const path = reportPath(addition.report);
  const untouched = (e) => !touched.has(e);
  let dup =
    existing.find(e => sameCompany(e) && normalizeRoleForIndex(e.role) === roleKey) ||
    (path && existing.find(e => reportPath(e.report) === path)) ||
    existing.find(e => sameCompany(e) && untouched(e) && roleVariantMatch(addition.role, e.role)) ||
    null;
  if (!dup) {
    const reportNum = extractReportNum(addition.report);
    dup = existing.find(e => sameCompany(e) && untouched(e) && ((reportNum && extractReportNum(e.report) === reportNum) || e.num === addition.num)) || null;
  }

  if (dup) {
    if (shouldReplaceScoutingRow(dup, addition)) {
      console.log(`🔄 Update: #${dup.num} ${addition.company} — ${addition.role} (${reEvalNote(dup, addition).replace(/^Re-eval /, '')})`);
      const idx = fileLines.indexOf(dup.raw);
      if (idx >= 0) {
        const newLine = formatScoutingRow(buildReEvalRow(dup, addition));
        fileLines[idx] = newLine;
        Object.assign(dup, parseScoutingRow(newLine)); // keep `existing` in sync for later additions in this batch
        touched.add(dup);
        updated++;
        merged.push(addition);
        appendDedupIndex(addition.company, addition.role, addition.date);
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${dup.num} dated ${dup.date} is newer than ${addition.date})`);
      skipped++;
    }
  } else {
    const entryNum = pickEntryNum({ wanted: addition.num, taken: takenNums, maxNum, reserved: isReserved(SCOUTING_FILE, addition.num) });
    takenNums.add(entryNum);
    if (entryNum > maxNum) maxNum = entryNum;
    // The report link's text is the row's own number, even when the row is renumbered.
    const report = /^\[\d+\]/.test(addition.report) ? addition.report.replace(/^\[\d+\]/, `[${entryNum}]`) : addition.report;
    newRows.push(formatScoutingRow({ ...addition, num: entryNum, report }));
    added++;
    merged.push({ ...addition, report });
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (W ${addition.want} · E ${addition.ease}, ${addition.tier}, ${addition.eligibility.split(':')[0]})`);
    appendDedupIndex(addition.company, addition.role, addition.date);
  }
}

if (newRows.length > 0) {
  let insertIdx = -1;
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].includes('---') && fileLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx === -1) {
    console.error("❌ Error: Could not find table header separator line (|---|) in markdown file.");
    process.exit(1);
  }
  fileLines.splice(insertIdx, 0, ...newRows);
}

// Refresh any application row for a listing that was just re-scored.
let refreshed = 0;
if (merged.length > 0 && existsSync(APPLICATIONS_FILE)) withLockSync(lockPathFor(APPLICATIONS_FILE), () => {
  const appLines = readFileSync(APPLICATIONS_FILE, 'utf-8').split('\n');
  const updates = merged.map(a => ({
    company: a.company, role: a.role,
    want: Number.parseFloat(a.want), ease: Number.parseFloat(a.ease),
    report: a.report,
  }));
  const { lines, changed, matched } = refreshApplicationRows(appLines, updates);
  for (const c of changed) console.log(`📝 applications.md #${c.num} ${c.company} — ${c.role}: ${c.from} → ${c.to}`);
  refreshed = changed.length;
  if (refreshed > 0 && !DRY_RUN) writeFileAtomic(APPLICATIONS_FILE, lines.join('\n'));

  // A listing that is already an application is not a "READY to apply" scouting
  // hit: point its scouting row at the application instead (PROMOTED-n).
  for (const { num, update } of matched) {
    for (let i = 0; i < fileLines.length; i++) {
      const e = parseScoutingRow(fileLines[i]);
      if (!e || companyKey(e.company) !== companyKey(update.company) || e.role !== update.role) continue;
      const hint = `PROMOTED-${num}`;
      if (e.hint !== hint) fileLines[i] = formatScoutingRow({ ...e, hint });
    }
  }
}, { label: 'merge-scouting refresh', timeoutMs: 60_000 });

if (!DRY_RUN) {
  writeFileAtomic(SCOUTING_FILE, fileLines.join('\n'));
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  for (const n of mergedNums) releaseNum(SCOUTING_FILE, n);
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped, 📝${refreshed} application row(s) refreshed`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [fileURLToPath(new URL('./verify-pipeline.mjs', import.meta.url))], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
