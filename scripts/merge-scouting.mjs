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
  roleFuzzyMatch,
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

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const DEDUP_INDEX_FILE = join(CAREER_OPS, 'data/dedup-index.tsv');
const DEDUP_INDEX_HEADER = 'company_normalized\trole_normalized\tlast_seen_date';
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/scouting-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

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

if (!existsSync(SCOUTING_FILE)) {
  console.log('No data/scouting.md found. Creating from scratch.');
  // Canonical scaffold is single-sourced in lib/profile-core.mjs so profile
  // creation (scripts/profile.mjs) and this merge always agree on the header.
  writeFileSync(SCOUTING_FILE, SCOUTING_SCAFFOLD);
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
let maxNum = 0;

for (const line of fileLines) {
  if (line.startsWith('|') && !line.includes('---') && !/^\|\s*#\s*\|/.test(line)) {
    const e = parseScoutingRow(line);
    if (e) {
      existing.push(e);
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

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseScoutingTsv(content, file);
  if (!addition) { skipped++; continue; }

  const reportNum = extractReportNum(addition.report);
  let dup = null;

  if (reportNum) {
    dup = existing.find(e => extractReportNum(e.report) === reportNum);
  }
  if (!dup) {
    dup = existing.find(e => e.num === addition.num);
  }
  if (!dup) {
    const normCompany = companyKey(addition.company);
    dup = existing.find(e => companyKey(e.company) === normCompany && roleFuzzyMatch(addition.role, e.role));
  }

  if (dup) {
    if (shouldReplaceScoutingRow(dup, addition)) {
      console.log(`🔄 Update: #${dup.num} ${addition.company} — ${addition.role} (${reEvalNote(dup, addition).replace(/^Re-eval /, '')})`);
      const idx = fileLines.indexOf(dup.raw);
      if (idx >= 0) {
        const newLine = formatScoutingRow(buildReEvalRow(dup, addition));
        fileLines[idx] = newLine;
        Object.assign(dup, parseScoutingRow(newLine)); // keep `existing` in sync for later additions in this batch
        updated++;
        appendDedupIndex(addition.company, addition.role, addition.date);
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${dup.num} dated ${dup.date} is newer than ${addition.date})`);
      skipped++;
    }
  } else {
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;
    newRows.push(formatScoutingRow({ ...addition, num: entryNum }));
    added++;
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

if (!DRY_RUN) {
  writeFileSync(SCOUTING_FILE, fileLines.join('\n'));
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [fileURLToPath(new URL('./verify-pipeline.mjs', import.meta.url))], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
