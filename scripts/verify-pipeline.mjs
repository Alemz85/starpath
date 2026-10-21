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
 * 4. Scores are a v2 "W8.3 E5.6" cell, a legacy "7.4/10" cell, or N/A / DUP
 *    (docs/scoring-v2.md §8.3)
 * 5. All rows have proper pipe-delimited format
 * 6. No pending TSVs in tracker-additions/ (only in merged/ or archived/)
 *
 * scouting.md checks (lighter — landscape inventory, not active applications):
 * 1. The table has the v2 12-column header and every row has 12 columns
 * 2. Tier is T1-T4; Want/Ease are numbers 1-10 or "—"; Eligibility is
 *    green | amber: … | red: …; a red row is blocked (— / — / T4)
 * 3. All report links resolve (— is allowed for T4 skips / blocked rows)
 * 4. No pending TSVs in scouting-additions/
 *
 * score-history.tsv checks (by header name): the v2 required columns exist,
 * eligibility/tier values are valid, blocked rows carry no scores.
 *
 * JD archive: every T1-T3 report has a saved job description in jds/
 * (warns with the backfill command when one is missing; check-jd-archive.mjs).
 *
 * Set CAREER_OPS_ROOT to point the checks at another tree (used by the tests).
 *
 * Run: node career-ops/verify-pipeline.mjs
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { companyKey, parseAppRow, validateScoreCell } from './lib/tracker-core.mjs';
import { isV2ScoutingHeader, parseScoutingRow, validateScoutingRow } from './lib/scouting-core.mjs';
import { checkScoreHistoryRows } from './lib/doctor-checks.mjs';
import { loadAudit } from './lib/jd-archive-fs.mjs';
import { describeMissing } from './check-jd-archive.mjs';
import { reportLinkTarget } from './lib/report-link.mjs';

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const SCOUTING_ADDITIONS_DIR = join(CAREER_OPS, 'batch/scouting-additions');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

// Mirrors frontend/electron/db/sync.ts:looksLikePortalHomepage. Hosts
// that serve company-level careers homepages — a URL on one of these
// hosts with an empty or single-slug path is NOT a listing URL and would
// collide every listing at that company onto the same join key.
const PORTAL_HOMEPAGE_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'jobs.ashbyhq.com',
  'jobs.lever.co',
  'careers.smartrecruiters.com',
]);
const LISTING_QUERY_KEYS = ['gh_jid', 'gh_src', 'jobid', 'job_id', 'id', 'postingid'];

function looksLikePortalHomepage(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (!PORTAL_HOMEPAGE_HOSTS.has(u.host)) return false;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length > 1) return false;
  for (const k of LISTING_QUERY_KEYS) {
    if (u.searchParams.has(k)) return false;
  }
  return true;
}

function walkReports(dir, out) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) walkReports(fp, out);
    else if (e.name.endsWith('.md')) out.push(fp);
  }
}
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
const hasAppsFile = existsSync(APPS_FILE);
if (!hasAppsFile) {
  console.log('\n📊 No applications.md found. This is normal for a fresh setup.');
  console.log('   Skipping applications-tracker checks; URL/report audit still runs.\n');
}
const content = hasAppsFile ? readFileSync(APPS_FILE, 'utf-8') : '';
const lines = content.split('\n');

const entries = [];
if (hasAppsFile) {
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    // parseAppRow is Deadline-aware: with the 10-column layout the report cell
    // is cells[9] (not cells[8], which is the deadline).
    const row = parseAppRow(line);
    if (!row) continue;
    entries.push({
      num: row.num, date: row.date, company: row.company, role: row.role,
      score: row.score, status: row.status, pdf: row.pdf, deadline: row.deadline,
      report: row.report, notes: row.notes,
    });
  }
  console.log(`\n📊 Checking ${entries.length} entries in applications.md\n`);
}

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
  // The shared company key (non-Latin names don't collapse to ''); the role
  // keeps letters of any script, identical to the old fold for ASCII.
  const key = companyKey(e.company) + '::' +
    e.role.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
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
  const rel = reportLinkTarget(e.report);
  if (!rel) continue;
  const reportPath = join(CAREER_OPS, rel);
  if (!existsSync(reportPath)) {
    error(`#${e.num}: Report not found: ${rel}`);
    brokenReports++;
  }
}
if (brokenReports === 0) ok('All report links valid');

// --- Check 4: Score format (v2 "W8.3 E5.6", legacy "7.4/10", N/A, DUP) ---
let badScores = 0;
for (const e of entries) {
  const problem = validateScoreCell(e.score);
  if (problem) {
    error(`#${e.num}: ${problem}`);
    badScores++;
  }
}
if (badScores === 0) ok('All scores valid');

// --- Check 5: Row format ---
let badRows = 0;
for (const line of lines) {
  if (!line.startsWith('|')) continue;
  if (line.includes('---') || line.includes('Empresa')) continue;
  // 9 columns (legacy) = 11 cells incl. the outer pipes; the current 10-column
  // layout (Deadline present) = 12.
  const parts = line.split('|');
  if (parts.length < 11) {
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
  const scoutingHeader = scoutingLines.find(l => /^\|\s*#\s*\|/.test(l));
  let v2Header = true;
  if (scoutingHeader && !isV2ScoutingHeader(scoutingHeader)) {
    v2Header = false;
    error('data/scouting.md has a pre-v2 header (expected # | Date | Company | Role | Want | Ease | Tier | Eligibility | Report | Deadline | Promotion Hint | Notes)');
  }
  let malformedScoutRows = 0;
  for (const line of scoutingLines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
    const num = parseInt(line.split('|')[1]);
    if (isNaN(num)) continue;
    // 12 columns (14 cells incl. the outer pipes). A shorter row is a v1 row or
    // a hand-edit that dropped a cell; every cell index below would be off.
    const row = parseScoutingRow(line);
    if (!row) {
      error(`scouting #${num}: row does not have the 12 v2 columns`);
      malformedScoutRows++;
      continue;
    }
    scoutingEntries.push(row);
  }

  console.log(`\n📊 Checking ${scoutingEntries.length} entries in data/scouting.md\n`);

  // Cell validity: tier, Want/Ease, Eligibility, blocked-row consistency
  let badCells = 0;
  for (const e of scoutingEntries) {
    const { errors: errs, warnings: warns } = validateScoutingRow(e);
    for (const m of errs) { error(`scouting #${e.num}: ${m}`); badCells++; }
    for (const m of warns) warn(`scouting #${e.num}: ${m}`);
  }
  if (badCells === 0 && malformedScoutRows === 0 && v2Header) ok('All scouting rows valid (tier, Want/Ease, Eligibility)');

  // Report links (— allowed for T4 skips)
  let brokenScoutReports = 0;
  for (const e of scoutingEntries) {
    if (e.report === '—' || e.report === '-') continue;
    const rel = reportLinkTarget(e.report);
    if (!rel) {
      error(`scouting #${e.num}: Malformed report link "${e.report}"`);
      brokenScoutReports++;
      continue;
    }
    const reportPath = join(CAREER_OPS, rel);
    if (!existsSync(reportPath)) {
      error(`scouting #${e.num}: Report not found: ${rel}`);
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

// --- URL quality: report headers + score-history.tsv ---
//
// A URL on the join key (`**URL:**` in reports, `url` column in
// score-history.tsv) must be listing-specific. A bare portal homepage
// like `https://boards.greenhouse.io/anthropic` would map every listing
// at that company onto the same key and the frontend cache would link
// them to the wrong report. Warn so the agent can re-evaluate or fix
// by hand.
let portalUrls = 0;

// Reports' `**URL:**` header
const reportFiles = [];
walkReports(REPORTS_DIR, reportFiles);
for (const fp of reportFiles) {
  const text = readFileSync(fp, 'utf-8');
  const m = text.match(/^\*\*URL:\*\*\s*(\S+)/im);
  if (!m) continue;
  const url = m[1].trim();
  if (!/^https?:\/\//i.test(url)) continue;
  if (looksLikePortalHomepage(url)) {
    warn(`Portal-homepage URL in report header: ${fp.replace(CAREER_OPS + '/', '')} — "${url}"`);
    portalUrls++;
  }
}

// score-history.tsv: v2 schema check (by header name), then the url column
if (existsSync(SCORE_HISTORY_FILE)) {
  const historyText = readFileSync(SCORE_HISTORY_FILE, 'utf-8');
  const hist = checkScoreHistoryRows(historyText);
  for (const m of hist.errors) error(m);
  for (const m of hist.warnings) warn(m);
  if (hist.errors.length === 0) ok(`score-history.tsv valid (${hist.rows} row${hist.rows === 1 ? '' : 's'})`);

  const lines = historyText.split('\n');
  const header = (lines[0] || '').split('\t');
  const urlIdx = header.indexOf('url');
  if (urlIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const url = (cols[urlIdx] ?? '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      if (looksLikePortalHomepage(url)) {
        const company = cols[header.indexOf('company')] ?? '';
        const role = cols[header.indexOf('role')] ?? '';
        warn(`Portal-homepage URL in score-history row: ${company} — ${role} — "${url}"`);
        portalUrls++;
      }
    }
  }
}
if (portalUrls === 0) ok('No portal-homepage URLs (all join keys are listing-specific)');

// --- JD archive: every T1–T3 report keeps its job description in jds/ ---
{
  const audit = loadAudit(CAREER_OPS);
  const { counts } = audit;
  if (counts.missing === 0) {
    ok(`JD archive complete (${counts.archived}/${counts.total} reports${counts.unrecoverable ? `, ${counts.unrecoverable} gone` : ''})`);
  } else {
    warn(`${counts.missing} of ${counts.total} reports have no saved job description (jds/): run node scripts/archive-posting.mjs --missing (see scripts/check-jd-archive.mjs)`);
    for (const line of describeMissing(audit).slice(0, 10)) console.log(`   ${line}`);
  }
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
