#!/usr/bin/env node
/**
 * normalize-statuses.mjs — Clean non-canonical states in applications.md
 *
 * Maps all non-canonical statuses to canonical ones per states.yml:
 *   Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP
 *
 * Also strips markdown bold (**) and dates from the status field,
 * moving DUPLICADO info to the notes column.
 *
 * Status mapping lives in lib/tracker-core.mjs (pure + unit-tested); this
 * script owns the file I/O and applies the result to the correct columns.
 *
 * Write safety: runs under the applications.md lock, replaces the file
 * atomically (through profile links) and logs each status change to
 * status-log.tsv (source `normalize`), like set-status.mjs does.
 *
 * Run: node scripts/normalize-statuses.mjs [--dry-run]
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeStatus, parseAppRow, serializeAppRow } from './lib/tracker-core.mjs';
import { lockPathFor, withLockSync } from './lib/dir-lock.mjs';
import { writeFileAtomic } from './lib/write-file-atomic.mjs';
import { appendLedger, ledgerPathFor, statusChangeEntries } from './lib/status-ledger.mjs';

const CAREER_OPS = process.env.CAREER_OPS_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to normalize.');
} else {
  // Read, rewrite and log under the tracker lock, so a status change from the
  // app or set-status.mjs can't land between the read and the write.
  withLockSync(lockPathFor(APPS_FILE), normalize, { label: 'normalize-statuses', timeoutMs: 60_000 });
}

function normalize() {
  const lines = readFileSync(APPS_FILE, 'utf-8').split('\n');

  let changes = 0;
  const unknowns = [];
  const logged = [];

  for (let i = 0; i < lines.length; i++) {
    const row = parseAppRow(lines[i]);
    if (!row) continue; // skip non-rows, headers, separators

    const rawStatus = row.status;
    const result = normalizeStatus(rawStatus);

    if (result.unknown) {
      unknowns.push({ num: row.num, rawStatus, line: i + 1 });
      continue;
    }

    if (result.status === rawStatus) continue; // Already canonical

    // Apply change to the resolved column indices — report/notes shift when the
    // Deadline column is present, so writing notes by a hardcoded index would
    // otherwise clobber the report link on the current 10-column format.
    const cells = row.cells;
    cells[row.cols.status] = result.status;

    // Carry DUPLICADO/repost context into the notes column
    if (result.moveToNotes) {
      const existing = cells[row.cols.notes] || '';
      if (!existing.includes(result.moveToNotes)) {
        cells[row.cols.notes] = result.moveToNotes + (existing ? '. ' + existing : '');
      }
    }

    // Also strip bold from the score field
    if (cells[row.cols.score]) {
      cells[row.cols.score] = cells[row.cols.score].replace(/\*\*/g, '');
    }

    lines[i] = serializeAppRow(cells);
    changes++;
    logged.push({ num: row.num, company: row.company, role: row.role, from: rawStatus, to: result.status });

    console.log(`#${row.num}: "${rawStatus}" → "${result.status}"`);
  }

  if (unknowns.length > 0) {
    console.log(`\n⚠️  ${unknowns.length} unknown statuses:`);
    for (const u of unknowns) {
      console.log(`  #${u.num} (line ${u.line}): "${u.rawStatus}"`);
    }
  }

  console.log(`\n📊 ${changes} statuses normalized`);

  if (!DRY_RUN && changes > 0) {
    // Backup first
    copyFileSync(APPS_FILE, APPS_FILE + '.bak');
    writeFileAtomic(APPS_FILE, lines.join('\n'));
    appendLedger(ledgerPathFor(APPS_FILE), statusChangeEntries(logged, { source: 'normalize', note: 'normalized to a canonical status' }));
    console.log('✅ Written to applications.md (backup: applications.md.bak)');
  } else if (DRY_RUN) {
    console.log('(dry-run — no changes written)');
  } else {
    console.log('✅ No changes needed');
  }
}
