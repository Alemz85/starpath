#!/usr/bin/env node
/**
 * outreach-plan.mjs — zero-token pre-flight for the `contacto` (outreach) mode.
 *
 * "I want to reach out at {company} — what's my best move, and what do I draft
 * from?" Before this script, the contacto mode answered that with a cold
 * LinkedIn search even when the user already knew a peer on the team
 * (data/network.md), had a pending thread with the hiring manager
 * (data/outreach.md), or had fresh cached research (data/companies/{slug}.md).
 * This CLI assembles all of that into ONE dossier for ONE target company and
 * recommends the play:
 *
 *   reply-handoff  someone already replied → continue that conversation
 *   nudge          a thread is due a follow-up → nudge, don't open a new one
 *   warm-direct    an untouched 1st-degree contact → message them directly
 *   warm-intro     an untouched 2nd-degree contact → ask the bridge for an intro
 *   wait           the active thread is on track → don't pester
 *   cold-search    nobody known / everyone exhausted → contacto Step 2 search
 *
 * STRICTLY READ-ONLY: inspects what is on disk, recommends, and points at where
 * each draft ingredient lives (hook / proof / angle). It drafts nothing and
 * sends nothing — the contacto mode writes the message, the user sends it.
 *
 * USAGE
 *   node scripts/outreach-plan.mjs "Acme"                    JSON plan (default)
 *   node scripts/outreach-plan.mjs "Acme" --summary          human dashboard
 *   node scripts/outreach-plan.mjs --company "Acme" --role "Strategy Analyst"
 *                                                            prefer that role's report/prep
 *
 * All decision logic is pure and unit-tested in scripts/lib/outreach-plan-core.mjs;
 * this file only resolves files and formats output.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNetwork, parsePipeline, pathsForCompany } from './lib/network-core.mjs';
import { slugify, freshness, validateArtifact, parseFrontmatter } from './lib/company-research-core.mjs';
import { parseStoryBank } from './lib/story-bank.mjs';
import { parseLog, collapse } from './outreach-cadence.mjs';
import { companyThreads, assemblePlan, renderPlan } from './lib/outreach-plan-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NETWORK_FILE = join(ROOT, 'data/network.md');
const APPLICATIONS_FILE = join(ROOT, 'data/applications.md');
const SCOUTING_FILE = join(ROOT, 'data/scouting.md');
const OUTREACH_FILE = join(ROOT, 'data/outreach.md');
const COMPANIES_DIR = join(ROOT, 'data/companies');
const STORY_BANK = join(ROOT, 'interview-prep/story-bank.md');
const PREP_DIR = join(ROOT, 'interview-prep');
const REPORTS_DIR = join(ROOT, 'reports');
const TIER_DIRS = ['tier-1', 'tier-2', 'tier-3', 'tier-4'];

/* ───── CLI args ───────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const getVal = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};
const summaryMode = argv.includes('--summary');
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (a === '--company' || a === '--role') i++;
    continue;
  }
  positionals.push(a);
}
const company = getVal('--company') || positionals[0] || null;
const role = getVal('--role') || positionals[1] || null;

if (!company) {
  process.stderr.write(
    'usage: outreach-plan.mjs "<company>" ["<role>"] [--summary]\n' +
    '       outreach-plan.mjs --company "<company>" [--role "<role>"] [--summary]\n',
  );
  process.exit(2);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/* ───── fact resolvers (the only code that touches disk) ───────────────────── */

// Filename-token normalization for "{Company} - {Role}.md" artifacts — same
// scheme apply-kit.mjs uses so both CLIs resolve the same files.
function normToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchArtifactFile(file, wantCo, wantRo) {
  if (!file.endsWith('.md')) return false;
  const stem = file.replace(/\.md$/, '');
  const dash = stem.indexOf(' - ');
  const fileCo = normToken(dash === -1 ? stem : stem.slice(0, dash));
  const fileRo = normToken(dash === -1 ? '' : stem.slice(dash + 3));
  const coMatch = fileCo === wantCo || (wantCo && fileCo.startsWith(wantCo));
  const roMatch = !wantRo || fileRo === wantRo || (fileRo && fileRo.includes(wantRo));
  return coMatch && roMatch;
}

// Scouting report: scan tier-1..4 for "{Company} - {Role}.md" (role optional).
function resolveReport(co, ro) {
  const wantCo = normToken(co);
  const wantRo = normToken(ro);
  for (let t = 0; t < TIER_DIRS.length; t++) {
    const dir = join(REPORTS_DIR, TIER_DIRS[t]);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (matchArtifactFile(file, wantCo, wantRo)) {
        return { exists: true, path: `reports/${TIER_DIRS[t]}/${file}`, tier: t + 1 };
      }
    }
  }
  return { exists: false };
}

// Per-listing prep file: interview-prep/{Company} - {Role}.md.
function resolvePrep(co, ro) {
  if (!existsSync(PREP_DIR)) return { exists: false };
  const wantCo = normToken(co);
  const wantRo = normToken(ro);
  for (const file of readdirSync(PREP_DIR)) {
    if (file === 'story-bank.md') continue;
    if (matchArtifactFile(file, wantCo, wantRo)) {
      return { exists: true, path: `interview-prep/${file}` };
    }
  }
  return { exists: false };
}

// Cached deep research: data/companies/{slug}.md + freshness verdict.
function resolveResearch(co) {
  const slug = slugify(co);
  const abs = join(COMPANIES_DIR, `${slug}.md`);
  if (!existsSync(abs)) return { exists: false };
  const content = readFileSync(abs, 'utf8');
  const v = validateArtifact(content, { expectedSlug: slug });
  const f = freshness(parseFrontmatter(content), todayStr());
  return { exists: true, path: `data/companies/${slug}.md`, state: f.state, ageDays: f.ageDays, valid: v.ok };
}

/* ───── assemble ───────────────────────────────────────────────────────────── */

const today = todayStr();
const contacts = parseNetwork(read(NETWORK_FILE));
const pipeline = parsePipeline(read(APPLICATIONS_FILE), read(SCOUTING_FILE));
const { contacts: paths, roles } = pathsForCompany(company, contacts, pipeline, today);
const threads = companyThreads(collapse(parseLog(read(OUTREACH_FILE))), company, today);
const stories = parseStoryBank(read(STORY_BANK));

const plan = assemblePlan({
  company,
  roles,
  paths,
  threads,
  research: resolveResearch(company),
  report: resolveReport(company, role),
  prep: resolvePrep(company, role),
  stories,
  today,
});

if (summaryMode) {
  process.stdout.write(renderPlan(plan));
} else {
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
}
