#!/usr/bin/env node
/**
 * merge-scouting.mjs — Merge batch scouting additions into data/scouting.md
 *
 * Sibling of merge-tracker.mjs. Scouting hits are landscape-mapping inventory,
 * not active applications, so they live in data/scouting.md with a different
 * column shape:
 *
 *   # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes
 *
 * TSV input format (11 tab-separated columns, written by modes/scouting.md):
 *
 *   num\tdate\tcompany\trole\tscore\ttier\tcf_af\treport\tdeadline\tpromotion_hint\tnotes
 *
 * Backward-compatible with old 10-column TSVs (no deadline column).
 * Old 10-col TSVs and old scouting.md rows (without Deadline column) are handled gracefully.
 *
 * Dedup: company normalized + role fuzzy match + report number match.
 * If duplicate with higher score → update in-place, refresh tier / CF-AF / notes.
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
  parseScore,
  coalesceDeadline,
  parseScoutingRow,
  parseScoutingTsv,
  formatScoutingRow,
} from './lib/scouting-core.mjs';
import { SCOUTING_SCAFFOLD } from './lib/profile-core.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
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
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(dup.score);
    if (newScore > oldScore) {
      console.log(`🔄 Update: #${dup.num} ${addition.company} — ${addition.role} (${oldScore}→${newScore})`);
      const idx = fileLines.indexOf(dup.raw);
      if (idx >= 0) {
        const merged = {
          num: dup.num,
          date: addition.date,
          company: addition.company,
          role: addition.role,
          score: addition.score,
          tier: addition.tier,
          cfAf: addition.cfAf,
          report: addition.report,
          // Preserve the posting's close date if the re-eval didn't restate it.
          deadline: coalesceDeadline(addition.deadline, dup.deadline),
          hint: addition.hint,
          notes: `Re-eval ${addition.date} (${oldScore}→${newScore}). ${addition.notes}`,
        };
        fileLines[idx] = formatScoutingRow(merged);
        updated++;
        appendDedupIndex(addition.company, addition.role, addition.date);
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${dup.num} ${oldScore} >= new ${newScore})`);
      skipped++;
    }
  } else {
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;
    newRows.push(formatScoutingRow({ ...addition, num: entryNum }));
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score}, ${addition.tier})`);
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
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
