#!/usr/bin/env node
/**
 * verify-pipeline.mjs — Health check for career-ops pipeline integrity
 *
 * Checks data/applications.md AND data/scouting.md (the two trackers).
 *
 * applications.md checks:
 * 1. All statuses are canonical (per states.yml)
 * 2. No duplicate company+role entries
 * 3. All report links point to existing files
 * 4. Scores match format X.XX/5 or N/A or DUP
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 *
 * scouting.md checks (lighter — landscape inventory, not active applications):
 * 1. All tiers are T1-T4
 * 2. All report links resolve (— is allowed for T4 skips)
 * 3. CF/AF column matches X.X/X.X
 * 4. No pending TSVs in scouting-additions/
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const SCOUTING_ADDITIONS_DIR = join(CAREER_OPS, 'batch/scouting-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const STATES_FILE = existsSync(join(CAREER_OPS, 'templates/states.yml'))
  ? join(CAREER_OPS, 'templates/states.yml')
  : join(CAREER_OPS, 'states.yml');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const CANONICAL_STATUSES = [
  'evaluated', 'applied', 'responded', 'interview',
  'offer', 'rejected', 'discarded', 'skip',
];

const VALID_TIERS = ['T1', 'T2', 'T3', 'T4'];

const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated', 'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied', 'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'descartado': 'discarded', 'descartada': 'discarded', 'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

let errors = 0;
let warnings = 0;

function error(msg) { console.log(`❌ ${msg}`); errors++; }
function warn(msg) { console.log(`⚠️  ${msg}`); warnings++; }
function ok(msg) { console.log(`✅ ${msg}`); }

// --- Read applications.md ---
if (!existsSync(APPS_FILE)) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   The file will be created when you evaluate your first offer.\n');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n');

const entries = [];
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) continue;
  const num = parseInt(parts[1]);
  if (isNaN(num)) continue;
  entries.push({
    num, date: parts[2], company: parts[3], role: parts[4],
    score: parts[5], status: parts[6], pdf: parts[7], report: parts[8],
    notes: parts[9] || '',
  });
}

console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);

// --- Check 1: Canonical statuses ---
let badStatuses = 0;
for (const e of entries) {
  const clean = e.status.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing dates
  const statusOnly = clean.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();

  if (!CANONICAL_STATUSES.includes(statusOnly) && !ALIASES[statusOnly]) {
    error(`#${e.num}: Non-canonical status "${e.status}"`);
    badStatuses++;
  }

  // Check for markdown bold in status
  if (e.status.includes('**')) {
    error(`#${e.num}: Status contains markdown bold: "${e.status}"`);
    badStatuses++;
  }

  // Check for dates in status
  if (/\d{4}-\d{2}-\d{2}/.test(e.status)) {
    error(`#${e.num}: Status contains date: "${e.status}" — dates go in date column`);
    badStatuses++;
  }
}
if (badStatuses === 0) ok('All statuses are canonical');

// --- Check 2: Duplicates ---
const companyRoleMap = new Map();
let dupes = 0;
for (const e of entries) {
  const key = e.company.toLowerCase().replace(/[^a-z0-9]/g, '') + '::' +
    e.role.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (!companyRoleMap.has(key)) companyRoleMap.set(key, []);
  companyRoleMap.get(key).push(e);
}
for (const [key, group] of companyRoleMap) {
  if (group.length > 1) {
    warn(`Possible duplicates: ${group.map(e => `#${e.num}`).join(', ')} (${group[0].company} — ${group[0].role})`);
    dupes++;
  }
}
if (dupes === 0) ok('No exact duplicates found');

// --- Check 3: Report links ---
let brokenReports = 0;
for (const e of entries) {
  const match = e.report.match(/\]\(([^)]+)\)/);
  if (!match) continue;
  const reportPath = join(CAREER_OPS, match[1]);
  if (!existsSync(reportPath)) {
    error(`#${e.num}: Report not found: ${match[1]}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score format ---
let badScores = 0;
for (const e of entries) {
  const s = e.score.replace(/\*\*/g, '').trim();
  if (!/^\d+\.?\d*\/5$/.test(s) && s !== 'N/A' && s !== 'DUP') {
    error(`#${e.num}: Invalid score format: "${e.score}"`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (line.includes('---') || line.includes('Empresa')) continue;
  const parts = line.split('|');
  if (parts.length < 9) {
    error(`Row with <9 columns: ${line.substring(0, 80)}...`);
    badRows++;
  }
}
if (badRows === 0) ok('All rows properly formatted');

// --- Check 6: Pending TSVs ---
let pendingTsvs = 0;
if (existsSync(ADDITIONS_DIR)) {
  const files = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
  pendingTsvs = files.length;
  if (pendingTsvs > 0) {
    warn(`${pendingTsvs} pending TSVs in tracker-additions/ (not merged)`);
  }
}
if (pendingTsvs === 0) ok('No pending TSVs');

// --- Check 7: Bold in scores ---
let boldScores = 0;
for (const e of entries) {
  if (e.score.includes('**')) {
    warn(`#${e.num}: Score has markdown bold: "${e.score}"`);
    boldScores++;
  }
}
if (boldScores === 0) ok('No bold in scores');

// --- Scouting tracker checks ---
if (existsSync(SCOUTING_FILE)) {
  const scoutingContent = readFileSync(SCOUTING_FILE, 'utf-8');
  const scoutingLines = scoutingContent.split('\n');

  const scoutingEntries = [];
  for (const line of scoutingLines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 11) continue;
    const num = parseInt(parts[1]);
    if (isNaN(num)) continue;
    scoutingEntries.push({
      num, date: parts[2], company: parts[3], role: parts[4],
      score: parts[5], tier: parts[6], cfAf: parts[7],
      report: parts[8], hint: parts[9], notes: parts[10] || '',
    });
  }

  console.log(`\n📊 Checking ${scoutingEntries.length} entries in data/scouting.md\n`);

  // Tier validity
  let badTiers = 0;
  for (const e of scoutingEntries) {
    if (!VALID_TIERS.includes(e.tier)) {
      error(`scouting #${e.num}: Invalid tier "${e.tier}" (expected T1-T4)`);
      badTiers++;
    }
  }
  if (badTiers === 0) ok('All scouting tiers valid');

  // CF/AF format
  let badCfAf = 0;
  for (const e of scoutingEntries) {
    if (!/^\d+\.?\d*\/\d+\.?\d*$/.test(e.cfAf)) {
      error(`scouting #${e.num}: Invalid CF/AF "${e.cfAf}" (expected X.X/X.X)`);
      badCfAf++;
    }
  }
  if (badCfAf === 0) ok('All scouting CF/AF formatted');

  // Report links (— allowed for T4 skips)
  let brokenScoutReports = 0;
  for (const e of scoutingEntries) {
    if (e.report === '—' || e.report === '-') continue;
    const m = e.report.match(/\]\(([^)]+)\)/);
    if (!m) {
      error(`scouting #${e.num}: Malformed report link "${e.report}"`);
      brokenScoutReports++;
      continue;
    }
    const reportPath = join(CAREER_OPS, m[1]);
    if (!existsSync(reportPath)) {
      error(`scouting #${e.num}: Report not found: ${m[1]}`);
      brokenScoutReports++;
    }
  }
  if (brokenScoutReports === 0) ok('All scouting report links valid');

  // Pending scouting TSVs
  let pendingScoutTsvs = 0;
  if (existsSync(SCOUTING_ADDITIONS_DIR)) {
    const files = readdirSync(SCOUTING_ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
    pendingScoutTsvs = files.length;
    if (pendingScoutTsvs > 0) {
      warn(`${pendingScoutTsvs} pending TSVs in scouting-additions/ (not merged)`);
    }
  }
  if (pendingScoutTsvs === 0) ok('No pending scouting TSVs');
}

// --- Summary ---
console.log('\n' + '='.repeat(50));
console.log(`📊 Pipeline Health: ${errors} errors, ${warnings} warnings`);
if (errors === 0 && warnings === 0) {
  console.log('🟢 Pipeline is clean!');
} else if (errors === 0) {
  console.log('🟡 Pipeline OK with warnings');
} else {
  console.log('🔴 Pipeline has errors — fix before proceeding');
}

process.exit(errors > 0 ? 1 : 0);
