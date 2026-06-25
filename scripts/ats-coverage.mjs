#!/usr/bin/env node

/**
 * ats-coverage.mjs — measure how well a (tailored) CV covers a job
 * description's keywords, deterministically.
 *
 * The CV-tailoring flow (modes/pdf.md) is supposed to inject the JD's
 * keywords into the CV and report "% keyword coverage". This turns that
 * number from an eyeballed guess into a measured, reproducible metric, and
 * prints the exact list of JD keywords the CV is still MISSING — the gap the
 * agent should close (by re-surfacing real experience in the JD's vocabulary,
 * never by inventing skills).
 *
 * Usage:
 *   node scripts/ats-coverage.mjs --jd <jd.txt> --cv <cv.html|cv.txt>
 *   cat jd.txt | node scripts/ats-coverage.mjs --jd-stdin --cv output/cv-...html
 *   node scripts/ats-coverage.mjs --jd <jd.txt> --cv <cv.html> --json
 *
 * Flags:
 *   --jd <path>      job-description file (plain text or HTML)
 *   --jd-stdin       read the JD from stdin instead of a file
 *   --cv <path>      CV file; .html/.htm is stripped to text automatically
 *   --json           emit the full structured result as JSON
 *   --limit <n>      max keywords to extract (default 24)
 *
 * Exit codes: 0 always on a successful analysis (the coverage number is the
 * signal, not the exit code); non-zero only on bad input.
 */

import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';
import { analyzeCoverage, htmlToText } from './lib/ats-keywords.mjs';

function parseArgs(argv) {
  const out = { json: false, jdStdin: false, limit: 24 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--jd-stdin') out.jdStdin = true;
    else if (a === '--jd') out.jd = argv[++i];
    else if (a === '--cv') out.cv = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 24;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function loadCv(path) {
  const raw = readFileSync(path, 'utf-8');
  const ext = extname(path).toLowerCase();
  return ext === '.html' || ext === '.htm' ? htmlToText(raw) : raw;
}

const HELP = `ats-coverage — measure JD keyword coverage of a CV

  node scripts/ats-coverage.mjs --jd <jd.txt> --cv <cv.html> [--json] [--limit N]
  cat jd.txt | node scripts/ats-coverage.mjs --jd-stdin --cv <cv.html>

Prints overall coverage %, weighted coverage, and the missing-keyword gap list.`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  // Load JD
  let jdText;
  if (args.jdStdin) {
    jdText = readStdin();
  } else if (args.jd) {
    if (!existsSync(args.jd)) {
      console.error(`JD file not found: ${args.jd}`);
      process.exit(1);
    }
    jdText = readFileSync(args.jd, 'utf-8');
    if (/\.html?$/i.test(args.jd)) jdText = htmlToText(jdText);
  } else {
    console.error('Provide a JD with --jd <path> or --jd-stdin.\n');
    console.error(HELP);
    process.exit(1);
  }
  if (!jdText || !jdText.trim()) {
    console.error('JD is empty.');
    process.exit(1);
  }

  // Load CV
  if (!args.cv) {
    console.error('Provide a CV with --cv <path>.');
    process.exit(1);
  }
  if (!existsSync(args.cv)) {
    console.error(`CV file not found: ${args.cv}`);
    process.exit(1);
  }
  const cvText = loadCv(args.cv);

  const result = analyzeCoverage(jdText, cvText, { limit: args.limit });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable report
  const bar = (pct) => {
    const filled = Math.round(pct / 5);
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
  };
  const verdict =
    result.coveragePct >= 75 ? '✅ strong' :
    result.coveragePct >= 55 ? '🟡 acceptable — close the gaps below' :
    '🔴 weak — the CV is under-keyworded for this JD';

  console.log('');
  console.log('  ATS keyword coverage');
  console.log('  ────────────────────');
  console.log(`  Coverage:  ${bar(result.coveragePct)}  ${result.coveragePct}%  (${result.covered.length}/${result.total} keywords)`);
  console.log(`  Weighted:  ${Math.round(result.weightedCoverage * 100)}%  (frequency-weighted)`);
  console.log(`  Verdict:   ${verdict}`);
  console.log('');

  if (result.missing.length) {
    console.log(`  Missing keywords (${result.missing.length}) — surface real experience in these terms, never invent:`);
    for (const k of result.missing) {
      const tag = k.type === 'unigram' ? '' : ` (${k.type})`;
      console.log(`    • ${k.term}${tag}  ×${k.count}`);
    }
  } else {
    console.log('  No missing keywords — every extracted JD keyword is present in the CV.');
  }
  console.log('');
  console.log(`  Covered (${result.covered.length}): ${result.covered.map((k) => k.term).join(', ') || '—'}`);
  console.log('');
}

main();
