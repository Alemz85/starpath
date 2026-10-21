#!/usr/bin/env node
/**
 * promote-to-applications.mjs — Promote a scouting entry to active applications
 *
 * Moves an entry from data/scouting.md to data/applications.md, changing the
 * status from a scouting observation to an "Evaluated" active application.
 * Preserves the report link, the posting's deadline, and the scouting notes.
 * The scouting entry stays in data/scouting.md as a frozen historical record
 * (so positioning trajectory is not disrupted), with the Promotion Hint column
 * flipped to PROMOTED-{num}.
 *
 * The Score cell on the new applications row is the v2 "M8.3 E5.6" form built
 * from the scouting row's Match / Ease; tier + eligibility go into the Notes text.
 * A Blocked row (red eligibility, Match/Ease "—") is refused — a blocked listing
 * has nothing to apply to. A `skip` verdict is allowed but warned about
 * (docs/scoring-v2.md §4 ethical-use rule).
 *
 * Scouting-row parsing lives in lib/scouting-core.mjs (pure + unit-tested) —
 * the 12-column v2 scouting.md format.
 *
 * Write safety: runs under the scouting.md lock and the applications.md lock
 * (always in that order, like merge-scouting), replaces both files atomically
 * (through profile links) and gives the new application an origin row in
 * status-log.tsv (source `promote`).
 *
 * Run: node scripts/promote-to-applications.mjs <scouting-num> [--dry-run]
 *
 * Example:
 *   node scripts/promote-to-applications.mjs 17
 *   → moves Nimbus Robotics Finance & Strategy Intern from scouting.md to
 *     applications.md as a new Evaluated entry, preserving the report link.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { companyKey, parseScoutingRow, formatScoutingRow, verdictFromCells, VERDICT_TIERS } from './lib/scouting-core.mjs';
import { formatScoreCell } from './lib/tracker-core.mjs';
import { lockPathFor, withLockSync } from './lib/dir-lock.mjs';
import { writeFileAtomic } from './lib/write-file-atomic.mjs';
import { appendLedger, ledgerPathFor } from './lib/status-ledger.mjs';

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
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

function promote() {
  const scoutingLines = readFileSync(SCOUTING_FILE, 'utf-8').split('\n');
  const appsLines = readFileSync(APPS_FILE, 'utf-8').split('\n');

  // Find the scouting entry (deadline-aware parse → correct report/deadline/notes)
  let scoutingRow = null;
  let scoutingIdx = -1;
  for (let i = 0; i < scoutingLines.length; i++) {
    const row = parseScoutingRow(scoutingLines[i]);
    if (row && row.num === targetNum) {
      scoutingRow = row;
      scoutingIdx = i;
      break;
    }
  }

  if (!scoutingRow) {
    console.error(`Scouting entry #${targetNum} not found in data/scouting.md`);
    return 1;
  }

  console.log(`📋 Found scouting entry #${targetNum}: ${scoutingRow.company} — ${scoutingRow.role}`);
  console.log(`   Match ${scoutingRow.match} · Ease ${scoutingRow.ease} (${scoutingRow.tier}, eligibility ${scoutingRow.eligibility})`);

  // Blocked listings are never promoted: no Match/Ease, nothing to apply to.
  const { verdict } = verdictFromCells({
    match: scoutingRow.matchNum, ease: scoutingRow.easeNum, eligibility: scoutingRow.eligibility,
  });
  if (verdict === 'blocked' || scoutingRow.matchNum === null || scoutingRow.easeNum === null) {
    console.error(`⛔ Scouting entry #${targetNum} is Blocked (${scoutingRow.eligibility}). Blocked listings are not promoted.`);
    return 1;
  }
  if (verdict === 'skip') {
    console.warn(`⚠️  Verdict is "skip" (${VERDICT_TIERS.skip}) — the model recommends against applying. Proceeding only because you asked.`);
  }

  // Find max applications.md number
  let maxAppNum = 0;
  for (const line of appsLines) {
    if (!line.startsWith('|') || line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
    const parts = line.split('|').map(s => s.trim());
    const num = parseInt(parts[1]);
    if (!isNaN(num) && num > maxAppNum) maxAppNum = num;
  }

  // Check for existing app with same company+role (company/role columns are
  // positionally fixed regardless of the deadline column, so this is safe).
  const normCompany = companyKey(scoutingRow.company);
  for (const line of appsLines) {
    if (!line.startsWith('|') || line.includes('---') || /^\|\s*#\s*\|/.test(line)) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 9) continue;
    if (companyKey(parts[3] || '') === normCompany && parts[4] === scoutingRow.role) {
      console.error(`⚠️  Application already exists for ${scoutingRow.company} — ${scoutingRow.role}. Aborting.`);
      return 1;
    }
  }

  const newAppNum = maxAppNum + 1;
  const today = new Date().toISOString().slice(0, 10);
  const scoreCell = formatScoreCell(scoutingRow.matchNum, scoutingRow.easeNum);
  const promotionNote = `Promoted from scouting #${targetNum} (${scoutingRow.tier}, ${scoutingRow.eligibility}). ${scoutingRow.notes}`.trim().replace(/\|/g, '/');

  // applications.md is 10-column: # date company role score status pdf deadline report notes
  // (matches what merge-tracker writes). Carry the posting's deadline forward.
  const newAppLine = `| ${newAppNum} | ${today} | ${scoutingRow.company} | ${scoutingRow.role} | ${scoreCell} | Evaluated | ❌ | ${scoutingRow.deadline || 'n/d'} | ${scoutingRow.report} | ${promotionNote} |`;

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
    return 1;
  }
  appsLines.splice(insertIdx, 0, newAppLine);

  // Flip the scouting row's promotion hint, preserving every other column
  // (deadline + notes included — formatScoutingRow re-emits the canonical shape).
  scoutingLines[scoutingIdx] = formatScoutingRow({ ...scoutingRow, hint: `PROMOTED-${newAppNum}` });

  if (DRY_RUN) {
    console.log('\n(dry-run — no changes written)');
    return 0;
  }

  writeFileAtomic(APPS_FILE, appsLines.join('\n'));
  writeFileAtomic(SCOUTING_FILE, scoutingLines.join('\n'));
  appendLedger(ledgerPathFor(APPS_FILE), [{
    num: newAppNum, date: today, company: scoutingRow.company, role: scoutingRow.role,
    from: '', to: 'Evaluated', stage: '', source: 'promote',
    note: `promoted from scouting #${targetNum}`, logged_at: new Date().toISOString(),
  }]);

  console.log(`\n✅ Promoted scouting #${targetNum} → applications #${newAppNum}`);
  console.log(`   Scouting entry tagged PROMOTED-${newAppNum} (preserved for trajectory history)`);
  console.log(`\nNext: open the entry in starpath and click "Tailor CV" / "Prep Application" / "Draft Application" as needed.`);

  return 0;
}

const exitCode = withLockSync(lockPathFor(SCOUTING_FILE), () =>
  withLockSync(lockPathFor(APPS_FILE), promote, { label: 'promote-to-applications', timeoutMs: 60_000 }),
{ label: 'promote-to-applications', timeoutMs: 60_000 });
process.exit(exitCode);
