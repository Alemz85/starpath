#!/usr/bin/env node
/**
 * positioning-intel.mjs — corpus-level positioning synthesis for the
 * `positioning` mode.
 *
 * Thin file/CLI wrapper around scripts/lib/positioning-core.mjs. Reads
 * data/score-history.tsv, builds per-archetype dimensional fingerprints, replays
 * the canonical scoring engine on each archetype's AVERAGE role, and surfaces:
 *
 *   • per-archetype fingerprint + the cheapest single-dim lever that re-bands
 *     the archetype's typical role (the targeting move, made concrete);
 *   • the SYSTEMIC binding constraint — the dimension gating the most archetypes,
 *     i.e. the one fix with cross-archetype leverage;
 *   • corpus dimension drag + city exposure (from targeting-core).
 *
 * This is the quantitative backbone the positioning report reasons over. It does
 * NOT write the report — the agent does that in modes/positioning.md, reading
 * judgments off this JSON.
 *
 * Run: node scripts/positioning-intel.mjs            (JSON to stdout)
 *      node scripts/positioning-intel.mjs --summary  (human-readable)
 *      node scripts/positioning-intel.mjs --min-roles 4
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseScoreHistory } from './lib/targeting-core.mjs';
import { positioningIntel } from './lib/positioning-core.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const SCORE_HISTORY_FILE = join(CAREER_OPS, 'data/score-history.tsv');

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const minRolesIdx = args.indexOf('--min-roles');
const MIN_ROLES = minRolesIdx !== -1 && args[minRolesIdx + 1] !== undefined
  ? (Number.isNaN(parseInt(args[minRolesIdx + 1])) ? 3 : parseInt(args[minRolesIdx + 1]))
  : 3;

function printSummary(result) {
  if (result.error) {
    console.log(`\n${result.error}\n`);
    return;
  }
  const { metadata, landscape, fingerprints, levers, systemicConstraint, dimensionDrag, cityExposure } = result;
  const leverByArch = new Map(levers.map(l => [l.archetype, l]));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  Positioning Intelligence — ${metadata.analysisDate}`);
  console.log(`  ${metadata.evaluated} evaluations (${metadata.dateRange.from} to ${metadata.dateRange.to})`);
  console.log(`  ${metadata.archetypesAnalyzed} archetypes with >= ${metadata.minRoles} roles`);
  console.log(`${'='.repeat(64)}\n`);

  console.log('LANDSCAPE');
  console.log('-'.repeat(48));
  console.log(`  avg Overall ${landscape.avgOverall}  ·  median ${landscape.medianOverall}`);
  const b = landscape.bands;
  console.log(`  strong ${b.strong || 0} · solid ${b.solid || 0} · pass ${b.pass || 0} · weak ${b.weak || 0}`);
  console.log(`  ${landscape.wastedShare}% of evaluations are weak (< 6.0)`);

  // The headline finding.
  const sc = systemicConstraint;
  console.log('\nSYSTEMIC BINDING CONSTRAINT (the cross-archetype blocker)');
  console.log('-'.repeat(48));
  if (sc.dominant) {
    console.log(`  ${sc.dominant.label} gates the typical role in ${sc.dominant.count} of ${metadata.archetypesAnalyzed} archetypes:`);
    console.log(`    ${sc.dominant.archetypes.join(', ')}`);
  } else {
    console.log('  No single dimension binds across archetypes — constraints are idiosyncratic.');
  }
  if (sc.lever) {
    console.log(`  Highest-leverage fix: lift ${sc.lever.label} — a single raise re-bands the typical`);
    console.log(`    role in ${sc.lever.count} archetype(s) (avg +${sc.lever.avgLift}): ${sc.lever.archetypes.join(', ')}`);
  }

  console.log('\nPER-ARCHETYPE READ (strongest avg Overall first)');
  console.log('-'.repeat(48));
  for (const f of fingerprints) {
    const l = leverByArch.get(f.archetype);
    const name = f.archetype.slice(0, 38);
    console.log(`  ${name}`);
    console.log(`    ${f.count} roles · avg Overall ${f.avgOverall} · CF ${l.cf} / AF ${l.af} · ${l.tier} · ${f.strongRate}% strong/solid`);
    if (f.bottleneck) {
      console.log(`    bottleneck: ${f.bottleneck.label} (avg ${f.bottleneck.avg})`);
    }
    if (l.cheapestLever) {
      console.log(`    cheapest lever: ${l.cheapestLever.message}`);
    } else if (l.tier === 'T1') {
      console.log(`    already top-band on the average role — no lever needed.`);
    } else {
      console.log(`    no single-dimension raise re-bands the average role (multi-dim gap).`);
    }
  }

  console.log('\nDIMENSION DRAG (weakest first — corpus-wide)');
  console.log('-'.repeat(48));
  for (const d of dimensionDrag) {
    console.log(`  ${d.label.padEnd(22)} avg ${String(d.avg).padStart(4)}  (low in ${d.lowShare}% of evals)`);
  }

  if (cityExposure.length > 0) {
    console.log('\nWHERE STRONG MATCHES CLUSTER (solid+ roles)');
    console.log('-'.repeat(48));
    for (const c of cityExposure.slice(0, 8)) {
      console.log(`  ${c.city.padEnd(26)} ${c.count}x`);
    }
  }
  console.log('');
}

// --- Run ---
const tsv = existsSync(SCORE_HISTORY_FILE) ? readFileSync(SCORE_HISTORY_FILE, 'utf-8') : '';
const result = positioningIntel(parseScoreHistory(tsv), { minRoles: MIN_ROLES });

if (summaryMode) {
  printSummary(result);
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.error) process.exit(1);
