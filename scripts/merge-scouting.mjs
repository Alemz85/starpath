#!/usr/bin/env node
/**
 * merge-scouting.mjs — Merge batch scouting additions into data/scouting.md
 *
 * Sibling of merge-tracker.mjs. Scouting hits are landscape-mapping inventory,
 * not active applications, so they live in data/scouting.md with a different
 * column shape:
 *
 *   # | Date | Company | Role | Score | Tier | CF/AF | Report | Promotion Hint | Notes
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
 * Run: node career-ops/merge-scouting.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const DEDUP_INDEX_FILE = join(CAREER_OPS, 'data/dedup-index.tsv');
const DEDUP_INDEX_HEADER = 'company_normalized\trole_normalized\tlast_seen_date';
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/scouting-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

function normalizeRoleForIndex(role) {
  return role.toLowerCase().replace(/\s+/g, ' ').trim();
}

function appendDedupIndex(company, role, date) {
  if (DRY_RUN) return;
  const row = `${normalizeCompany(company)}\t${normalizeRoleForIndex(role)}\t${date}\n`;
  if (!existsSync(DEDUP_INDEX_FILE)) {
    writeFileSync(DEDUP_INDEX_FILE, DEDUP_INDEX_HEADER + '\n' + row);
  } else {
    appendFileSync(DEDUP_INDEX_FILE, row);
  }
}

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(ADDITIONS_DIR, { recursive: true });

const VALID_TIERS = ['T1', 'T2', 'T3', 'T4'];

function normalizeTier(tier) {
  const clean = (tier || '').replace(/\*\*/g, '').trim().toUpperCase();
  if (VALID_TIERS.includes(clean)) return clean;
  // Accept "Tier 1" / "tier-1" / "1"
  const m = clean.match(/T(?:IER[- ]?)?(\d)/);
  if (m && VALID_TIERS.includes(`T${m[1]}`)) return `T${m[1]}`;
  if (/^\d$/.test(clean) && VALID_TIERS.includes(`T${clean}`)) return `T${clean}`;
  console.warn(`⚠️  Non-canonical tier "${tier}" → defaulting to "T4"`);
  return 'T4';
}

function normalizePromotionHint(hint, tier) {
  const clean = (hint || '').trim();
  if (!clean) return tier === 'T1' ? 'READY' : '';
  if (/^ready/i.test(clean)) return 'READY';
  return clean;
}

function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roleFuzzyMatch(a, b) {
  const wordsA = a.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const wordsB = b.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const overlap = wordsA.filter(w => wordsB.some(wb => wb.includes(w) || w.includes(wb)));
  return overlap.length >= 2;
}

function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Reports live in tier subfolders (reports/tier-1/.../tier-4/). If the writer
 * passed a flat path like `reports/scout-014-...md`, rewrite it to the correct
 * tier subfolder. Honor `—` (T4 skip) and already-tiered paths unchanged.
 */
function rewriteReportPathForTier(reportStr, tier) {
  if (!reportStr || reportStr === '—' || reportStr === '-') return reportStr;
  if (/reports\/tier-\d\//.test(reportStr)) return reportStr;
  const m = tier.match(/^T(\d)$/);
  if (!m) return reportStr;
  return reportStr.replace(/reports\//, `reports/tier-${m[1]}/`);
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseScoutingLine(line) {
  const parts = line.split('|').map(s => s.trim());
  // New format (13 parts): empty | num | date | company | role | score | tier | cf_af | report | deadline | hint | notes | empty
  // Old format (12 parts): empty | num | date | company | role | score | tier | cf_af | report | hint | notes | empty
  if (parts.length < 11) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  const hasDeadline = parts.length >= 13;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    tier: parts[6],
    cfAf: parts[7],
    report: parts[8],
    deadline: hasDeadline ? parts[9] : 'n/d',
    hint: hasDeadline ? parts[10] : parts[9],
    notes: hasDeadline ? (parts[11] || '') : (parts[10] || ''),
    raw: line,
  };
}

function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  const parts = content.split('\t');
  if (parts.length < 9) {
    console.warn(`⚠️  Skipping malformed scouting TSV ${filename}: ${parts.length} fields (expected 11)`);
    return null;
  }

  const tier = normalizeTier(parts[5]);
  // New 11-col format: num date company role score tier cf_af report deadline hint notes
  // Old 10-col format: num date company role score tier cf_af report hint notes
  const hasDeadline = parts.length >= 11;
  const addition = {
    num: parseInt(parts[0]),
    date: parts[1],
    company: parts[2],
    role: parts[3],
    score: parts[4],
    tier,
    cfAf: parts[6],
    report: rewriteReportPathForTier(parts[7], tier),
    deadline: hasDeadline ? (parts[8] || 'n/d') : 'n/d',
    hint: normalizePromotionHint(hasDeadline ? parts[9] : parts[8], tier),
    notes: hasDeadline ? (parts[10] || '') : (parts[9] || ''),
  };

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

function formatRow(e) {
  return `| ${e.num} | ${e.date} | ${e.company} | ${e.role} | ${e.score} | ${e.tier} | ${e.cfAf} | ${e.report} | ${e.deadline || 'n/d'} | ${e.hint} | ${e.notes} |`;
}

// ---- Main ----

if (!existsSync(SCOUTING_FILE)) {
  console.log('No data/scouting.md found. Creating from scratch.');
  writeFileSync(
    SCOUTING_FILE,
    '# Scouting Tracker\n\n' +
    'Landscape-mapping inventory. Entries here are NOT active applications — they are observations from `scouting` mode runs.\n\n' +
    '**Promotion path:** Tier 1 entries are flagged `READY` in the Promotion Hint column. Run `node scripts/promote-to-applications.mjs <num>` to move an entry from this file to `data/applications.md` and start the active application flow.\n\n' +
    '| # | Date | Company | Role | Score | Tier | CF/AF | Report | Deadline | Promotion Hint | Notes |\n' +
    '|---|------|---------|------|-------|------|-------|--------|----------|----------------|-------|\n'
  );
}

const fileContent = readFileSync(SCOUTING_FILE, 'utf-8');
const fileLines = fileContent.split('\n');
const existing = [];
let maxNum = 0;

for (const line of fileLines) {
  if (line.startsWith('|') && !line.includes('---') && !/^\|\s*#\s*\|/.test(line)) {
    const e = parseScoutingLine(line);
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
  const addition = parseTsvContent(content, file);
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
    const normCompany = normalizeCompany(addition.company);
    dup = existing.find(e => normalizeCompany(e.company) === normCompany && roleFuzzyMatch(addition.role, e.role));
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
          hint: addition.hint,
          notes: `Re-eval ${addition.date} (${oldScore}→${newScore}). ${addition.notes}`,
        };
        fileLines[idx] = formatRow(merged);
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
    newRows.push(formatRow({ ...addition, num: entryNum }));
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
