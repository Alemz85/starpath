#!/usr/bin/env node
/**
 * promote-to-applications.mjs — Promote a scouting entry to active applications
 *
 * Moves an entry from data/scouting.md to data/applications.md, changing the
 * status from a scouting observation to an "Evaluated" active application.
 * Preserves the report link. The scouting entry stays in data/scouting.md as
 * a frozen historical record (so positioning trajectory is not disrupted),
 * with the Promotion Hint column flipped to PROMOTED-{num}.
 *
 * Run: node career-ops/promote-to-applications.mjs <scouting-num> [--dry-run]
 *
 * Example:
 *   node scripts/promote-to-applications.mjs 17
 *   → moves Glovo QCommerce Finance & Strategy Intern from scouting.md to
 *     applications.md as a new Evaluated entry, preserving the report link.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(CAREER_OPS, 'data/scouting.md');
const APPS_FILE = join(CAREER_OPS, 'data/applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (args.length === 0) {
  console.error('Usage: node scripts/promote-to-applications.mjs <scouting-num> [--dry-run]');
  process.exit(1);
}
const targetNum = parseInt(args[0]);
if (isNaN(targetNum)) {
  console.error(`Invalid scouting number: ${args[0]}`);
  process.exit(1);
}

if (!existsSync(SCOUTING_FILE)) {
  console.error('data/scouting.md not found.');
  process.exit(1);
}
if (!existsSync(APPS_FILE)) {
  console.error('data/applications.md not found.');
  process.exit(1);
}

const scoutingLines = readFileSync(SCOUTING_FILE, 'utf-8').split('\n');
const appsLines = readFileSync(APPS_FILE, 'utf-8').split('\n');

// Find the scouting entry
let scoutingRow = null;
let scoutingIdx = -1;
for (let i = 0; i < scoutingLines.length; i++) {
  const line = scoutingLines[i];
  if (!line.startsWith('|') || line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 11) continue;
  const num = parseInt(parts[1]);
  if (num === targetNum) {
    scoutingRow = {
      num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      score: parts[5],
      tier: parts[6],
      cfAf: parts[7],
      report: parts[8],
      hint: parts[9],
      notes: parts[10] || '',
    };
    scoutingIdx = i;
    break;
  }
}

if (!scoutingRow) {
  console.error(`Scouting entry #${targetNum} not found in data/scouting.md`);
  process.exit(1);
}

console.log(`📋 Found scouting entry #${targetNum}: ${scoutingRow.company} — ${scoutingRow.role}`);
console.log(`   Score: ${scoutingRow.score} (${scoutingRow.tier}, CF/AF ${scoutingRow.cfAf})`);

// Find max applications.md number
let maxAppNum = 0;
for (const line of appsLines) {
  if (!line.startsWith('|') || line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
  const parts = line.split('|').map(s => s.trim());
  const num = parseInt(parts[1]);
  if (!isNaN(num) && num > maxAppNum) maxAppNum = num;
}

// Check for existing app with same company+role
const normCompany = scoutingRow.company.toLowerCase().replace(/[^a-z0-9]/g, '');
for (const line of appsLines) {
  if (!line.startsWith('|') || line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) continue;
  const c = (parts[3] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (c === normCompany && parts[4] === scoutingRow.role) {
    console.error(`⚠️  Application already exists for ${scoutingRow.company} — ${scoutingRow.role}. Aborting.`);
    process.exit(1);
  }
}

const newAppNum = maxAppNum + 1;
const today = new Date().toISOString().slice(0, 10);
const promotionNote = `Promoted from scouting #${targetNum} (${scoutingRow.tier}, CF/AF ${scoutingRow.cfAf}). ${scoutingRow.notes}`;

const newAppLine = `| ${newAppNum} | ${today} | ${scoutingRow.company} | ${scoutingRow.role} | ${scoutingRow.score} | Evaluated | ❌ | ${scoutingRow.report} | ${promotionNote} |`;

console.log(`\n➕ New applications.md entry #${newAppNum}:`);
console.log(`   ${newAppLine}`);

// Insert into applications.md after header separator
let insertIdx = -1;
for (let i = 0; i < appsLines.length; i++) {
  if (appsLines[i].includes('---') && appsLines[i].startsWith('|')) {
    insertIdx = i + 1;
    break;
  }
}
if (insertIdx < 0) {
  console.error('Could not find header separator in applications.md');
  process.exit(1);
}
appsLines.splice(insertIdx, 0, newAppLine);

// Update the scouting row's promotion hint
const updatedScoutingRow = {
  ...scoutingRow,
  hint: `PROMOTED-${newAppNum}`,
};
const updatedLine = `| ${updatedScoutingRow.num} | ${updatedScoutingRow.date} | ${updatedScoutingRow.company} | ${updatedScoutingRow.role} | ${updatedScoutingRow.score} | ${updatedScoutingRow.tier} | ${updatedScoutingRow.cfAf} | ${updatedScoutingRow.report} | ${updatedScoutingRow.hint} | ${updatedScoutingRow.notes} |`;
scoutingLines[scoutingIdx] = updatedLine;

if (DRY_RUN) {
  console.log('\n(dry-run — no changes written)');
  process.exit(0);
}

writeFileSync(APPS_FILE, appsLines.join('\n'));
writeFileSync(SCOUTING_FILE, scoutingLines.join('\n'));

console.log(`\n✅ Promoted scouting #${targetNum} → applications #${newAppNum}`);
console.log(`   Scouting entry tagged PROMOTED-${newAppNum} (preserved for trajectory history)`);
console.log(`\nNext: run \`/career-ops oferta\` against the URL to generate the full A-H evaluation.`);
