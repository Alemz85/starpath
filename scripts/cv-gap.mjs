#!/usr/bin/env node

/**
 * cv-gap.mjs — CV vs. target-landscape gap report.
 *
 * The ATS coverage tool (scripts/ats-coverage.mjs) checks the CV against ONE
 * job description. This checks it against the WHOLE landscape the user keeps
 * evaluating: it aggregates the recurring keyword demand across every report
 * the user has generated, folds in the dimension-drag signal from
 * score-history.tsv, and prints the systematic gaps —
 *
 *   • in-demand terms that appear across many evaluated roles but never in the
 *     CV (add where you have the experience, learn where you don't),
 *   • achievement bullets with no quantified outcome (the proof-point weakness
 *     recruiters notice first),
 *   • the scoring dimensions that systematically drag — flagged CV-fixable
 *     (Skills Match) vs. targeting-only (everything else).
 *
 * All the logic is pure and unit-tested in scripts/lib/cv-gap.mjs; this file is
 * just I/O: read user/cv.md, harvest report bodies, parse score-history.tsv.
 * It reads ONLY from user/* + data/* + reports/** at runtime — no user data is
 * baked into the system layer.
 *
 * Usage:
 *   node scripts/cv-gap.mjs                       # human-readable summary
 *   node scripts/cv-gap.mjs --json                # full structured JSON
 *   node scripts/cv-gap.mjs --cv <path>           # override CV file
 *   node scripts/cv-gap.mjs --reports <dir>       # override reports dir
 *   node scripts/cv-gap.mjs --jd <a.txt> --jd <b.txt>   # extra demand docs
 *   node scripts/cv-gap.mjs --min-roles <n>       # min roles to call a gap (default 2)
 *
 * Exit codes: 0 on a successful analysis; 1 on missing CV / no landscape data.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { analyzeCvGap, htmlToText } from './lib/cv-gap.mjs';
import { parseScoreHistory } from './lib/targeting-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { json: false, jd: [], minRoles: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--cv') out.cv = argv[++i];
    else if (a === '--reports') out.reports = argv[++i];
    else if (a === '--jd') out.jd.push(argv[++i]);
    else if (a === '--min-roles') out.minRoles = parseInt(argv[++i], 10) || 2;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const HELP = `cv-gap — compare user/cv.md against the recurring demand of your evaluated landscape.

  node scripts/cv-gap.mjs [--json] [--cv <path>] [--reports <dir>]
                          [--jd <file> ...] [--min-roles <n>]

Reads user/cv.md, every report under reports/**, and data/score-history.tsv,
then prints the keyword gaps, weak (unquantified) proof points, and the
scoring dimensions that systematically drag. Use --json for the full object.`;

// ── file harvesting ──────────────────────────────────────────────────────────
function loadCvText(cvPath) {
  const raw = readFileSync(cvPath, 'utf-8');
  const ext = extname(cvPath).toLowerCase();
  return ext === '.html' || ext === '.htm' ? htmlToText(raw) : raw;
}

/**
 * Collect one demand document per evaluated role: the body text of every
 * report under reports/**. Reports carry that role's vocabulary (archetype,
 * role summary, gaps, JD-derived language), which is the closest landscape-wide
 * demand signal available without re-fetching JDs. Markdown is kept as-is —
 * the keyword extractor tolerates it.
 */
function harvestReports(reportsDir) {
  if (!existsSync(reportsDir)) return [];
  const docs = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.toLowerCase().endsWith('.md')) {
        try {
          const text = readFileSync(full, 'utf-8').trim();
          if (text) docs.push(text);
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(reportsDir);
  return docs;
}

function loadJdDocs(paths) {
  const docs = [];
  for (const p of paths) {
    if (!existsSync(p)) { console.error(`! --jd file not found: ${p}`); continue; }
    const raw = readFileSync(p, 'utf-8');
    const text = (extname(p).toLowerCase() === '.html' ? htmlToText(raw) : raw).trim();
    if (text) docs.push(text);
  }
  return docs;
}

// ── summary printer ──────────────────────────────────────────────────────────
function printSummary(res, minRoles = 2) {
  if (res.error) { console.log(`\n${res.error}\n`); return; }
  const { metadata, keyword, proof, dimension, recommendations } = res;

  console.log(`\n${'='.repeat(62)}`);
  console.log(`  CV Gap Analysis — ${metadata.analysisDate}`);
  console.log(`  ${metadata.rolesAnalyzed} evaluated roles · ${metadata.scoreRows} score-history rows`);
  console.log(`${'='.repeat(62)}\n`);

  console.log('KEYWORD COVERAGE');
  console.log('-'.repeat(50));
  console.log(`  Your CV surfaces ${keyword.coveredTerms}/${keyword.demandTerms} of the demanded vocabulary (${keyword.coveragePct}%).`);
  if (keyword.gaps.length === 0) {
    console.log('  No systematic keyword gaps — the CV covers what the landscape asks for.');
  } else {
    console.log(`\n  Missing across ≥${minRoles} roles (most systematic first):`);
    for (const g of keyword.gaps.slice(0, 20)) {
      console.log(`    ${g.term.padEnd(28)} ${g.documentFrequency} roles (${g.share}%)`);
    }
  }

  console.log('\nPROOF POINTS (quantified outcomes)');
  console.log('-'.repeat(50));
  console.log(`  ${proof.quantifiedCount}/${proof.achievementBullets} achievement bullets carry a metric (${proof.quantifiedPct}%).`);
  if (proof.weak.length) {
    console.log('\n  Bullets to quantify (no number/%/€/×/time):');
    for (const w of proof.weak.slice(0, 12)) {
      const t = w.text.length > 72 ? w.text.slice(0, 69) + '...' : w.text;
      console.log(`    • ${t}`);
    }
  }

  if (dimension.length) {
    console.log('\nDIMENSION DRAG (from score-history)');
    console.log('-'.repeat(50));
    for (const d of dimension) {
      const tag = d.cvActionable ? '[CV-fixable]' : '[targeting]';
      console.log(`  ${d.label.padEnd(20)} avg ${String(d.avg).padStart(4)}  ${tag}`);
    }
  }

  if (recommendations.length) {
    console.log('\nRECOMMENDATIONS');
    console.log('='.repeat(62));
    recommendations.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`);
      console.log(`     ${r.reasoning}`);
    });
  }
  console.log('');
}

// ── run ──────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

const cvPath = args.cv || join(ROOT, 'user/cv.md');
if (!existsSync(cvPath)) {
  console.error(`\nNo CV found at ${cvPath}. Create user/cv.md (or pass --cv <path>).\n`);
  process.exit(1);
}
const cvText = loadCvText(cvPath);

const reportsDir = args.reports || join(ROOT, 'reports');
const demandDocs = [...harvestReports(reportsDir), ...loadJdDocs(args.jd)];

const scorePath = join(ROOT, 'data/score-history.tsv');
const scoreRows = existsSync(scorePath)
  ? parseScoreHistory(readFileSync(scorePath, 'utf-8'))
  : [];

const result = analyzeCvGap({
  cvText,
  demandDocs,
  scoreRows,
  opts: { keyword: { minRoles: args.minRoles } },
});

if (args.json) console.log(JSON.stringify(result, null, 2));
else printSummary(result, args.minRoles);

if (result.error) process.exit(1);
