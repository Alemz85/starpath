#!/usr/bin/env node
/**
 * analyze-patterns.mjs — Rejection Pattern Detector for career-ops
 *
 * Parses applications.md + all linked reports, extracts dimensions
 * (archetype, seniority, remote, gaps, scores), classifies outcomes,
 * and outputs structured JSON with actionable patterns.
 *
 * Run: node scripts/analyze-patterns.mjs          (JSON to stdout)
 *      node scripts/analyze-patterns.mjs --summary (human-readable table)
 *      node scripts/analyze-patterns.mjs --min-threshold 3
 *      node scripts/analyze-patterns.mjs --scouting (targeting intel from
 *        score-history.tsv — works before any outcomes exist)
 *      node scripts/analyze-patterns.mjs --scouting --summary
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseScoreHistory, analyzeScouting } from './lib/targeting-core.mjs';
import { parseTracker, enrichEntries, analyzeOutcomes } from './lib/patterns-core.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const scoutingMode = args.includes('--scouting');
const minThresholdIdx = args.indexOf('--min-threshold');
const MIN_THRESHOLD = minThresholdIdx !== -1 && args[minThresholdIdx + 1] !== undefined
  ? (Number.isNaN(parseInt(args[minThresholdIdx + 1])) ? 5 : parseInt(args[minThresholdIdx + 1]))
  : 5;

// Status normalization, outcome classification, tracker parsing, remote/size
// bucketing, blocker classification, and the whole outcome analysis now live in
// the pure, unit-tested ./lib/patterns-core.mjs. This file is the thin
// file-reading wrapper: it reads applications.md + the linked report files off
// disk, then hands the parsed data to the core.

// --- Parse a single report file ---
function parseReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  const content = readFileSync(reportPath, 'utf-8');
  const report = {
    archetype: null,
    seniority: null,
    remote: null,
    teamSize: null,
    comp: null,
    domain: null,
    scores: {},
    gaps: [],
  };

  // Strip bold markers for easier matching
  const plain = content.replace(/\*\*/g, '');

  // Extract Block A table (Role Summary) — works with both EN and ES headers
  const blockARegex = /\|\s*(?:Archetype|Arquetipo)\s*\|\s*(.*?)\s*\|/i;
  const seniorityRegex = /\|\s*(?:Seniority|Nivel|Level)\s*\|\s*(.*?)\s*\|/i;
  const remoteRegex = /\|\s*(?:Remote|Remoto|Location)\s*\|\s*(.*?)\s*\|/i;
  const teamRegex = /\|\s*(?:Team|Team size|Equipo)\s*\|\s*(.*?)\s*\|/i;
  const compRegex = /\|\s*(?:Comp|Salary|Salario|Listed salary)\s*\|\s*(.*?)\s*\|/i;
  const domainRegex = /\|\s*(?:Domain|Dominio|Industry)\s*\|\s*(.*?)\s*\|/i;

  const archMatch = plain.match(blockARegex);
  if (archMatch) report.archetype = archMatch[1].trim();

  const senMatch = plain.match(seniorityRegex);
  if (senMatch) report.seniority = senMatch[1].trim();

  const remMatch = plain.match(remoteRegex);
  if (remMatch) report.remote = remMatch[1].trim();

  const teamMatch = plain.match(teamRegex);
  if (teamMatch) report.teamSize = teamMatch[1].trim();

  const compMatch = plain.match(compRegex);
  if (compMatch) report.comp = compMatch[1].trim();

  const domainMatch = plain.match(domainRegex);
  if (domainMatch) report.domain = domainMatch[1].trim();

  // Extract scoring table — look for table with "Global" row (using plain, bold already stripped)
  const scoreRegex = /\|\s*(?:CV Match|Match con CV)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const northStarRegex = /\|\s*(?:North Star)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const compScoreRegex = /\|\s*(?:Comp)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const culturalRegex = /\|\s*(?:Cultural signals|Cultural)\s*\|\s*([\d.]+)\/5\s*\|/i;
  const redFlagsRegex = /\|\s*(?:Red flags)\s*\|\s*([-+]?[\d.]+)\s*\|/i;
  const globalRegex = /\|\s*(?:Global)\s*\|\s*([\d.]+)\/5\s*\|/i;

  const cvScoreMatch = plain.match(scoreRegex);
  if (cvScoreMatch) report.scores.cvMatch = parseFloat(cvScoreMatch[1]);

  const nsMatch = plain.match(northStarRegex);
  if (nsMatch) report.scores.northStar = parseFloat(nsMatch[1]);

  const csMatch = plain.match(compScoreRegex);
  if (csMatch) report.scores.comp = parseFloat(csMatch[1]);

  const culMatch = plain.match(culturalRegex);
  if (culMatch) report.scores.cultural = parseFloat(culMatch[1]);

  const rfMatch = plain.match(redFlagsRegex);
  if (rfMatch) report.scores.redFlags = parseFloat(rfMatch[1]);

  const glMatch = plain.match(globalRegex);
  if (glMatch) report.scores.global = parseFloat(glMatch[1]);

  // Extract gaps table
  const gapTableRegex = /\|\s*Gap\s*\|\s*Severity\s*\|.*?\n\|[-|\s]+\n([\s\S]*?)(?:\n\n|\n##|\n\*\*|$)/i;
  const gapTableMatch = content.match(gapTableRegex);
  if (gapTableMatch) {
    const gapRows = gapTableMatch[1].split('\n').filter(r => r.startsWith('|'));
    for (const row of gapRows) {
      const cols = row.split('|').map(s => s.trim()).filter(Boolean);
      if (cols.length >= 2) {
        report.gaps.push({
          description: cols[0],
          severity: cols[1].toLowerCase(),
          mitigation: cols[2] || '',
        });
      }
    }
  }

  return report;
}

// --- Outcome analysis: read files, delegate the math to patterns-core ---
function analyze() {
  const content = existsSync(APPS_FILE) ? readFileSync(APPS_FILE, "utf-8") : "";
  const entries = parseTracker(content);
  // Resolver injected into the pure core so it stays I/O-free: maps a
  // report link (relative to the repo root) to its parsed report object.
  const loadReport = (rel) => parseReport(join(CAREER_OPS, rel));
  const enriched = enrichEntries(entries, loadReport);
  return analyzeOutcomes(enriched, { minThreshold: MIN_THRESHOLD });
}

// --- Summary mode (human-readable) ---
function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }

  const { metadata, funnel, conversionFunnel, funnelDiagnosis, scoreComparison, archetypeBreakdown, blockerAnalysis, remotePolicy, scoreThreshold, techStackGaps, recommendations } = result;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Pattern Analysis — ${metadata.analysisDate}`);
  console.log(`  ${metadata.total} applications (${metadata.dateRange.from} to ${metadata.dateRange.to})`);
  console.log(`${'='.repeat(60)}\n`);

  // Funnel
  console.log('CONVERSION FUNNEL');
  console.log('-'.repeat(40));
  const funnelOrder = ['evaluated', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip'];
  for (const status of funnelOrder) {
    if (funnel[status]) {
      const pct = Math.round((funnel[status] / metadata.total) * 100);
      console.log(`  ${status.padEnd(15)} ${String(funnel[status]).padStart(3)} (${pct}%)`);
    }
  }

  // Stage conversion — where applications are actually being lost.
  if (conversionFunnel && conversionFunnel.reached.applied > 0) {
    console.log('\nSTAGE CONVERSION (where you lose applications)');
    console.log('-'.repeat(40));
    const fromLabel = { applied: 'applied', responded: 'got a response', interview: 'reached interview' };
    for (const s of conversionFunnel.stages) {
      const rateStr = s.rate === null ? '   —' : `${String(s.rate).padStart(3)}%`;
      const fromStr = s.fromPrev ? ` of those who ${fromLabel[s.fromPrev] || s.fromPrev}` : '';
      console.log(`  ${s.label.padEnd(20)} ${String(s.reached).padStart(3)}   ${rateStr}${s.rate === null ? '' : fromStr}`);
    }
    if (funnelDiagnosis && funnelDiagnosis.hasDiagnosis) {
      console.log(`\n  → ${funnelDiagnosis.headline}`);
      console.log(`    ${funnelDiagnosis.lever}`);
    } else if (funnelDiagnosis && funnelDiagnosis.reason) {
      console.log(`\n  → ${funnelDiagnosis.reason}`);
    }
  }

  // Score comparison
  console.log('\nSCORE BY OUTCOME');
  console.log('-'.repeat(40));
  for (const [group, stats] of Object.entries(scoreComparison)) {
    if (stats.count > 0) {
      console.log(`  ${group.padEnd(15)} avg ${stats.avg}/5  (${stats.count} entries, range ${stats.min}-${stats.max})`);
    }
  }

  // Blockers
  if (blockerAnalysis.length > 0) {
    console.log('\nTOP BLOCKERS');
    console.log('-'.repeat(40));
    for (const b of blockerAnalysis) {
      console.log(`  ${b.blocker.padEnd(20)} ${String(b.frequency).padStart(2)}x (${b.percentage}% of all)`);
    }
  }

  // Remote policy
  console.log('\nREMOTE POLICY');
  console.log('-'.repeat(40));
  for (const r of remotePolicy) {
    console.log(`  ${r.policy.padEnd(20)} ${String(r.total).padStart(2)} total, ${r.positive} positive (${r.conversionRate}%)`);
  }

  // Tech gaps
  if (techStackGaps.length > 0) {
    console.log('\nTOP TECH STACK GAPS (negative outcomes)');
    console.log('-'.repeat(40));
    for (const g of techStackGaps.slice(0, 10)) {
      console.log(`  ${g.skill.padEnd(20)} ${g.frequency}x`);
    }
  }

  // Score threshold
  console.log(`\nSCORE THRESHOLD: ${scoreThreshold.recommended}/5`);
  console.log(`  ${scoreThreshold.reasoning}`);

  // Recommendations
  if (recommendations.length > 0) {
    console.log(`\nRECOMMENDATIONS`);
    console.log('='.repeat(60));
    for (let i = 0; i < recommendations.length; i++) {
      const r = recommendations[i];
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`);
      console.log(`     ${r.reasoning}`);
    }
  }

  console.log('');
}

// --- Scouting targeting summary (human-readable) ---
function printScoutingSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }
  const { metadata, landscape, archetypePerformance, dimensionDrag, cityExposure, recommendations } = result;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Targeting Intelligence — ${metadata.analysisDate}`);
  console.log(`  ${metadata.evaluated} scouting evaluations (${metadata.dateRange.from} to ${metadata.dateRange.to})`);
  console.log(`${'='.repeat(60)}\n`);

  console.log('LANDSCAPE');
  console.log('-'.repeat(40));
  console.log(`  avg Overall ${landscape.avgOverall}  ·  median ${landscape.medianOverall}`);
  const b = landscape.bands;
  console.log(`  strong ${b.strong || 0} · solid ${b.solid || 0} · pass ${b.pass || 0} · weak ${b.weak || 0}`);
  console.log(`  ${landscape.wastedShare}% of evaluations are weak (< 6.0)`);

  console.log('\nARCHETYPE PERFORMANCE (best avg first)');
  console.log('-'.repeat(40));
  for (const a of archetypePerformance.slice(0, 10)) {
    console.log(`  ${a.archetype.slice(0, 32).padEnd(33)} avg ${String(a.avgOverall).padStart(4)}  ${String(a.count).padStart(3)} roles  ${a.strongRate}% strong/solid`);
  }

  console.log('\nDIMENSION DRAG (weakest first — fix the top one)');
  console.log('-'.repeat(40));
  for (const d of dimensionDrag) {
    console.log(`  ${d.label.padEnd(20)} avg ${String(d.avg).padStart(4)}  (low in ${d.lowShare}% of evals)`);
  }

  if (cityExposure.length > 0) {
    console.log('\nWHERE STRONG MATCHES CLUSTER (solid+ roles)');
    console.log('-'.repeat(40));
    for (const c of cityExposure.slice(0, 8)) {
      console.log(`  ${c.city.padEnd(24)} ${c.count}x`);
    }
  }

  if (recommendations.length > 0) {
    console.log(`\nTARGETING MOVES`);
    console.log('='.repeat(60));
    recommendations.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.impact.toUpperCase()}] ${r.action}`);
      console.log(`     ${r.reasoning}`);
    });
  }
  console.log('');
}

// --- Run ---
let result;
if (scoutingMode) {
  const tsv = existsSync(SCORE_HISTORY_FILE) ? readFileSync(SCORE_HISTORY_FILE, 'utf-8') : '';
  result = analyzeScouting(parseScoreHistory(tsv));
} else {
  result = analyze();
}

if (summaryMode) {
  if (scoutingMode) printScoutingSummary(result);
  else printSummary(result);
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.error) process.exit(1);
