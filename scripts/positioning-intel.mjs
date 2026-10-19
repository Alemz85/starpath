#!/usr/bin/env node
/**
 * positioning-intel.mjs — corpus-level positioning synthesis for the
 * `positioning` mode (scoring v2: eligibility gate, Want, Ease, verdict).
 *
 * Thin file/CLI wrapper around scripts/lib/positioning-core.mjs. Reads
 * data/score-history.tsv, builds per-archetype dimensional fingerprints, replays
 * the canonical scoring engine on each archetype's AVERAGE role, and surfaces:
 *
 *   • per-archetype Want · Ease, verdict mix, actionable share, blocked count,
 *     and the cheapest single-dim lever that moves the typical role to a
 *     better verdict cell (the targeting move, made concrete);
 *   • the Ease trajectory per archetype (earlier vs later half, against the
 *     Ease noise floor and the trend gate) — the positioning canary;
 *   • the SYSTEMIC binding constraint — what holds back the typical role in the
 *     most archetypes, i.e. the one fix with cross-archetype leverage;
 *   • corpus dimension drag + city exposure (from targeting-core).
 *
 * This is the quantitative backbone the positioning report reasons over. It does
 * NOT write the report — the agent does that in modes/positioning.md, reading
 * judgments off this JSON.
 *
 * Run: node scripts/positioning-intel.mjs            (JSON to stdout)
 *      node scripts/positioning-intel.mjs --summary  (human-readable)
 *      node scripts/positioning-intel.mjs --min-roles 4
 *      node scripts/positioning-intel.mjs --score-history path.tsv --profile path.yml
 *
 * user/profile.yml is optional: its `scoring.want_weights` / `ease_weights` and
 * `calibration.dream_companies` feed the engine replay, exactly as the scorer
 * reads them.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { parseScoreHistory } from './lib/targeting-core.mjs';
import { positioningIntel } from './lib/positioning-core.mjs';
import { VERDICT_LABELS } from './lib/score-bands.mjs';
import { DIM_LABELS } from './lib/explain-score.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
};
const minRolesArg = parseInt(argVal('--min-roles'), 10);
const MIN_ROLES = Number.isNaN(minRolesArg) ? 3 : minRolesArg;
const SCORE_HISTORY_FILE = argVal('--score-history') || join(CAREER_OPS, 'data/score-history.tsv');
const PROFILE_FILE = argVal('--profile') || join(CAREER_OPS, 'user/profile.yml');

function loadProfile(path) {
  if (!path || !existsSync(path)) return { weights: undefined, calibration: {} };
  try {
    const doc = yaml.load(readFileSync(path, 'utf-8')) || {};
    const scoring = doc.scoring || {};
    const calibration = { ...(doc.calibration || {}) };
    const dream = doc?.target_roles?.dream_companies ?? doc?.profile?.dream_companies ?? null;
    if (dream && !calibration.dream_companies) calibration.dream_companies = dream;
    return {
      weights: { want: scoring.want ?? scoring.want_weights, ease: scoring.ease ?? scoring.ease_weights },
      calibration,
    };
  } catch (e) {
    process.stderr.write(`Could not parse ${path}: ${e.message}\n`);
    return { weights: undefined, calibration: {} };
  }
}

const vLabel = (v) => VERDICT_LABELS[v] ?? v;
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');

function verdictMix(verdicts = {}) {
  const parts = ['go', 'stretch', 'solid', 'thin', 'growth', 'skip']
    .filter(v => verdicts[v])
    .map(v => `${vLabel(v)} ${verdicts[v]}`);
  return parts.length ? parts.join(' · ') : 'none';
}

function trajectoryLine(t) {
  if (!t) return 'n/a';
  const halves = `${t.earlier.count} earlier / ${t.later.count} later`;
  if (t.insufficientData) return `insufficient data (${halves}; ${t.gate} per half required)`;
  if (t.reportableVerdict === 'flat-within-noise') {
    return `flat within noise (|Δ| ${Math.abs(t.delta).toFixed(2)} < ${t.floor.toFixed(2)} floor; ${halves}; ${t.confidence} confidence)`;
  }
  const sign = t.delta > 0 ? '+' : '';
  return `${t.reportableVerdict} (Ease ${fmt(t.earlier.avgEase)} → ${fmt(t.later.avgEase)}, ${sign}${t.delta.toFixed(2)}; ${halves}; ${t.confidence} confidence)`;
}

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }
  const { metadata, landscape, eligibility, fingerprints, levers, systemicConstraint, easeCanary, dimensionDrag, cityExposure } = result;
  const leverByArch = new Map(levers.map(l => [l.archetype, l]));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  Positioning Intelligence — ${metadata.analysisDate}`);
  console.log(`  ${metadata.evaluated} scored evaluations (${metadata.dateRange.from} to ${metadata.dateRange.to})` +
    (metadata.blocked ? ` · ${metadata.blocked} blocked by eligibility` : ''));
  console.log(`  ${metadata.archetypesAnalyzed} archetypes with >= ${metadata.minRoles} scored roles`);
  console.log(`${'='.repeat(64)}\n`);

  console.log('LANDSCAPE');
  console.log('-'.repeat(48));
  console.log(`  Want ${fmt(landscape.avgWant)} · Ease ${fmt(landscape.avgEase)} (mean)  ·  median Want ${fmt(landscape.medianWant)} · Ease ${fmt(landscape.medianEase)}`);
  console.log(`  ${verdictMix(landscape.verdicts)}`);
  console.log(`  ${landscape.actionableShare}% actionable (Go / Stretch / Solid) · ${landscape.wastedShare}% Skip`);
  if (eligibility && eligibility.total) {
    console.log(`  eligibility: ${eligibility.status.red} red (${eligibility.redShare}%) · ${eligibility.status.amber} amber (${eligibility.amberShare}%) of ${eligibility.total} listings`);
  }

  // The headline finding.
  const sc = systemicConstraint;
  console.log('\nSYSTEMIC BINDING CONSTRAINT (the cross-archetype blocker)');
  console.log('-'.repeat(48));
  if (sc.dominant) {
    const weakest = Object.entries(sc.dominant.on || {}).sort((a, b) => b[1] - a[1])[0];
    const hint = !sc.dominant.dimension && weakest ? ` (weakest dimension: ${DIM_LABELS[weakest[0]] ?? weakest[0]})` : '';
    console.log(`  ${sc.dominant.label}${hint} holds back the typical role in ${sc.dominant.count} of ${metadata.archetypesAnalyzed} archetypes` +
      ` (binding in ${sc.dominant.binding}):`);
    console.log(`    ${sc.dominant.archetypes.join(', ')}`);
  } else {
    console.log('  Nothing holds back the typical role across archetypes — constraints are idiosyncratic (or every archetype is already Go).');
  }
  if (sc.lever) {
    console.log(`  Highest-leverage fix: lift ${sc.lever.label} — a single raise moves the typical role`);
    console.log(`    to a better verdict in ${sc.lever.count} archetype(s) (avg +${sc.lever.avgLift}): ${sc.lever.archetypes.join(', ')}`);
  }
  const li = sc.listings;
  if (li && li.n) {
    const topKind = li.constraintKinds[0];
    const topLever = li.leverDimensions[0];
    console.log(`  Across ${li.n} individual listings: ${li.alreadyGo} already Go` +
      (topKind ? `; most common binding constraint: ${topKind.label} (${topKind.count}, ${topKind.share}%)` : '') +
      (topLever ? `; most common cheapest lever: ${topLever.label} (${topLever.count}, avg +${topLever.avgLift})` : ''));
    if (li.replayMismatches) {
      console.log(`    (${li.replayMismatches} listing(s) replay to a different verdict than stored — weights or the dream list changed since they were scored)`);
    }
  }

  console.log('\nEASE TRAJECTORY — the positioning canary (earlier vs later half per archetype)');
  console.log('-'.repeat(48));
  console.log(`  floor ${easeCanary.floor.toFixed(2)} Ease · gate ${easeCanary.gate} scored evals per half`);
  if (easeCanary.improving.length) console.log(`  improving: ${easeCanary.improving.join(', ')}`);
  if (easeCanary.declining.length) console.log(`  declining: ${easeCanary.declining.join(', ')}`);
  if (easeCanary.flat.length) console.log(`  flat within noise: ${easeCanary.flat.join(', ')}`);
  if (easeCanary.insufficient.length) console.log(`  insufficient data: ${easeCanary.insufficient.join(', ')}`);
  console.log('  (not causal: a shift can come from the scan surfacing different roles, not only from the profile)');

  console.log('\nPER-ARCHETYPE READ (most actionable first)');
  console.log('-'.repeat(48));
  for (const f of fingerprints) {
    const l = leverByArch.get(f.archetype);
    const name = f.archetype.slice(0, 38);
    console.log(`  ${name}`);
    console.log(`    ${f.count} scored roles${f.blocked ? ` (+${f.blocked} blocked)` : ''} · Want ${fmt(f.avgWant)} · Ease ${fmt(f.avgEase)} · ${f.actionableShare}% actionable`);
    console.log(`    verdicts: ${verdictMix(f.verdicts)}`);
    console.log(`    typical role: Want ${fmt(l.want)} · Ease ${fmt(l.ease)} → ${l.verdictLabel}`);
    if (f.bottleneck) {
      console.log(`    bottleneck: ${f.bottleneck.label} (avg ${f.bottleneck.avg})`);
    }
    if (l.bindingConstraint && l.verdict !== 'go') {
      console.log(`    holding it back: ${l.bindingConstraint.message}`);
    }
    if (l.cheapestLever) {
      console.log(`    cheapest lever: ${l.cheapestLever.message}`);
    } else if (l.verdict === 'go') {
      console.log(`    already Go on the typical role — no lever needed.`);
    } else {
      console.log(`    no single-dimension raise moves the typical role to a better verdict (multi-dim gap).`);
    }
    const topKind = l.listings?.constraintKinds?.[0];
    const topLever = l.listings?.leverDimensions?.[0];
    if (topKind || topLever) {
      console.log(`    across its listings: ` +
        [topKind && `${topKind.label} binds ${topKind.count}`, topLever && `cheapest lever ${topLever.label} in ${topLever.count}`]
          .filter(Boolean).join(' · '));
    }
    console.log(`    Ease trajectory: ${trajectoryLine(f.easeTrajectory)}`);
  }

  console.log('\nDIMENSION DRAG (weakest first — corpus-wide)');
  console.log('-'.repeat(48));
  for (const d of dimensionDrag) {
    const rollup = d.rollup === 'ease' ? 'Ease' : 'Want';
    console.log(`  ${d.label.padEnd(22)} avg ${String(d.avg).padStart(4)}  (${rollup}; low in ${d.lowShare}% of evals)`);
  }

  if (cityExposure.length > 0) {
    console.log('\nWHERE ACTIONABLE MATCHES CLUSTER (Go / Stretch / Solid roles)');
    console.log('-'.repeat(48));
    for (const c of cityExposure.slice(0, 8)) {
      console.log(`  ${c.city.padEnd(26)} ${c.count}x`);
    }
  }
  console.log('');
}

// --- Run ---
const tsv = existsSync(SCORE_HISTORY_FILE) ? readFileSync(SCORE_HISTORY_FILE, 'utf-8') : '';
const { weights, calibration } = loadProfile(PROFILE_FILE);
const result = positioningIntel(parseScoreHistory(tsv), { minRoles: MIN_ROLES, weights, calibration });

if (summaryMode) {
  printSummary(result);
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.error) process.exit(1);
