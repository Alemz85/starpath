#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 10-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\tdeadline\treport\tnotes
 * - 9-col:  num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes (no deadline, backward-compat)
 * - 8-col:  num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes, backward-compat)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * The score column is a v2 "M8.3 E5.6" cell (legacy "7.4/10" still accepted).
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with a higher Priority (sqrt(match × ease) for v2 cells, the
 * legacy number for legacy cells; v2 beats legacy on a tie) → update in-place,
 * update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Row numbers: a TSV's own number stands when it is free and either above the
 * current max or reserved (scripts/reserve-report-num.mjs), so an evaluation
 * that reserved early but finishes late keeps its number; otherwise the row
 * gets max + 1. Merged numbers are released from the reservation folder.
 *
 * Write safety: the whole read → merge → write runs under the applications.md
 * lock (lib/dir-lock.mjs) and the file is replaced atomically through the
 * profile link (lib/write-file-atomic.mjs). Each new row also gets an origin
 * row in the status log (lib/status-ledger.mjs).
 *
 * All parsing/normalization lives in lib/tracker-core.mjs (pure + unit-tested);
 * this script owns only the file I/O and merge orchestration.
 *
 * Run: node career-ops/merge-tracker.mjs [--dry-run] [--verify]
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
  compareScoreCells,
  describeReEval,
  parseAppRow,
  parseTsvAddition,
} from './lib/tracker-core.mjs';
import { acquireLockSync, lockPathFor } from './lib/dir-lock.mjs';
import { writeFileAtomic } from './lib/write-file-atomic.mjs';
import { isReserved, pickEntryNum, releaseNum } from './lib/report-nums.mjs';
import { appendLedger, ledgerPathFor } from './lib/status-ledger.mjs';

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DEDUP_INDEX_FILE = join(CAREER_OPS, 'data/dedup-index.tsv');
const DEDUP_INDEX_HEADER = 'company_normalized\trole_normalized\tlast_seen_date';
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
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

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

// ---- Main ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
// Hold the tracker lock from the read to the write, so a status change from the
// app or set-status.mjs can't land in between and be overwritten. Released on
// every exit path.
if (!DRY_RUN) {
  const lock = acquireLockSync(lockPathFor(APPS_FILE), { label: 'merge-tracker', timeoutMs: 60_000 });
  process.on('exit', () => lock.release());
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
const appLines = appContent.split('\n');
const existingApps = [];
const takenNums = new Set();
let maxNum = 0;

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppRow(line);
    if (app) {
      existingApps.push(app);
      takenNums.add(app.num);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '')) || 0;
  const numB = parseInt(b.replace(/\D/g, '')) || 0;
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

const mergedNums = []; // TSV numbers to release from the reservation folder
let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];
const origins = []; // status-log origin rows for the new entries

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvAddition(content, file);
  if (!addition) { skipped++; continue; }
  mergedNums.push(addition.num);

  // Check for duplicate by:
  // 1. Exact report number match
  // 2. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report);
  let duplicate = null;

  if (reportNum) {
    // Check if this report number already exists
    duplicate = existingApps.find(app => {
      const existingReportNum = extractReportNum(app.report);
      return existingReportNum === reportNum;
    });
  }

  if (!duplicate) {
    // Exact entry number match
    duplicate = existingApps.find(app => app.num === addition.num);
  }

  if (!duplicate) {
    // Company + role fuzzy match
    const normCompany = companyKey(addition.company);
    duplicate = existingApps.find(app => {
      if (companyKey(app.company) !== normCompany) return false;
      return roleFuzzyMatch(addition.role, app.role);
    });
  }

  if (duplicate) {
    const better = compareScoreCells(addition.score, duplicate.score) > 0;

    if (better) {
      const change = describeReEval(duplicate.score, addition.score);
      console.log(`🔄 Update: #${duplicate.num} ${addition.company} — ${addition.role} ${change}`);
      const lineIdx = appLines.indexOf(duplicate.raw);
      if (lineIdx >= 0) {
        const updatedLine = `| ${duplicate.num} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${duplicate.status} | ${duplicate.pdf} | ${addition.deadline || duplicate.deadline || 'n/d'} | ${addition.report} | Re-eval ${addition.date} ${change}. ${addition.notes} |`;
        appLines[lineIdx] = updatedLine;
        updated++;
        appendDedupIndex(addition.company, addition.role, addition.date);
      }
    } else {
      console.log(`⏭️  Skip: ${addition.company} — ${addition.role} (existing #${duplicate.num} ${duplicate.score} >= new ${addition.score})`);
      skipped++;
    }
  } else {
    // New entry — the TSV's number when it is free (see header), else max + 1
    const entryNum = pickEntryNum({ wanted: addition.num, taken: takenNums, maxNum, reserved: isReserved(APPS_FILE, addition.num) });
    takenNums.add(entryNum);
    if (entryNum > maxNum) maxNum = entryNum;

    const newLine = `| ${entryNum} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${addition.status} | ${addition.pdf} | ${addition.deadline || 'n/d'} | ${addition.report} | ${addition.notes} |`;
    newLines.push(newLine);
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
    origins.push({
      num: entryNum, date: addition.date, company: addition.company, role: addition.role,
      from: '', to: addition.status, stage: '', source: 'merge-tracker', note: '', logged_at: new Date().toISOString(),
    });
    appendDedupIndex(addition.company, addition.role, addition.date);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx === -1) {
    console.error("❌ Error: Could not find table header separator line (|---|) in markdown file.");
    process.exit(1);
  }
  appLines.splice(insertIdx, 0, ...newLines);
}

// Write back
if (!DRY_RUN) {
  writeFileAtomic(APPS_FILE, appLines.join('\n'));
  appendLedger(ledgerPathFor(APPS_FILE), origins);

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  for (const n of mergedNums) releaseNum(APPS_FILE, n);
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [fileURLToPath(new URL('./verify-pipeline.mjs', import.meta.url))], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
