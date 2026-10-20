#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company + fuzzy role match.
 * Keeps entry with highest score (Priority = sqrt(want × ease) for v2
 * "W8.3 E5.6" cells, the legacy number for "X.X/10" cells; v2 wins ties). If discarded entry had more advanced status,
 * preserves that status. Merges notes.
 *
 * Parsing/normalization lives in lib/tracker-core.mjs (pure + unit-tested);
 * this script owns the file I/O and the dedup grouping.
 *
 * Write safety: runs under the applications.md lock, replaces the file
 * atomically (through profile links) and logs a promoted status to
 * status-log.tsv (source `dedup`), like set-status.mjs does.
 *
 * Run: node scripts/dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  STATUS_RANK,
  companyKeyLoose,
  roleMatchStrict,
  compareScoreCells,
  parseAppRow,
  serializeAppRow,
} from './lib/tracker-core.mjs';
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
  console.log('No applications.md found. Nothing to dedup.');
} else {
  // Read, rewrite and log under the tracker lock, so a status change from the
  // app or set-status.mjs can't land between the read and the write.
  withLockSync(lockPathFor(APPS_FILE), dedup, { label: 'dedup-tracker', timeoutMs: 60_000 });
}

function dedup() {
  const content = readFileSync(APPS_FILE, 'utf-8');
  const lines = content.split('\n');

  // Parse all entries
  const entries = [];
  const entryLineMap = new Map(); // num → line index

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const app = parseAppRow(lines[i]);
    if (app && app.num > 0) {
      entries.push(app);
      entryLineMap.set(app.num, i);
    }
  }

  console.log(`📊 ${entries.length} entries loaded`);

  // Group by company+role
  const groups = new Map();
  for (const entry of entries) {
    const key = companyKeyLoose(entry.company);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  // Find duplicates
  let removed = 0;
  const promoted = [];
  const linesToRemove = new Set();

  for (const [company, companyEntries] of groups) {
    if (companyEntries.length < 2) continue;

    // Within same company, find role matches
    const processed = new Set();
    for (let i = 0; i < companyEntries.length; i++) {
      if (processed.has(i)) continue;
      const cluster = [companyEntries[i]];
      processed.add(i);

      for (let j = i + 1; j < companyEntries.length; j++) {
        if (processed.has(j)) continue;
        if (roleMatchStrict(companyEntries[i].role, companyEntries[j].role)) {
          cluster.push(companyEntries[j]);
          processed.add(j);
        }
      }

      if (cluster.length < 2) continue;

      // Keep the one with highest score
      cluster.sort((a, b) => compareScoreCells(b.score, a.score));
      const keeper = cluster[0];

      // Check if any removed entry has more advanced status
      let bestStatusRank = STATUS_RANK[keeper.status.toLowerCase()] || 0;
      let bestStatus = keeper.status;
      for (let k = 1; k < cluster.length; k++) {
        const rank = STATUS_RANK[cluster[k].status.toLowerCase()] || 0;
        if (rank > bestStatusRank) {
          bestStatusRank = rank;
          bestStatus = cluster[k].status;
        }
      }

      // Update keeper's status if a removed entry had a more advanced one
      if (bestStatus !== keeper.status) {
        promoted.push({ num: keeper.num, company: keeper.company, role: keeper.role, from: keeper.status, to: bestStatus });
        const lineIdx = entryLineMap.get(keeper.num);
        if (lineIdx !== undefined) {
          // Status sits at a fixed column index in every row layout.
          const cells = lines[lineIdx].split('|').map(s => s.trim());
          cells[keeper.cols.status] = bestStatus;
          lines[lineIdx] = serializeAppRow(cells);
          console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
        }
      }

      // Remove duplicates
      for (let k = 1; k < cluster.length; k++) {
        const dup = cluster[k];
        const lineIdx = entryLineMap.get(dup.num);
        if (lineIdx !== undefined) {
          linesToRemove.add(lineIdx);
          removed++;
          console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
        }
      }
    }
  }

  // Remove lines (in reverse order to preserve indices)
  const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
  for (const idx of sortedRemoveIndices) {
    lines.splice(idx, 1);
  }

  console.log(`\n📊 ${removed} duplicates removed`);

  if (!DRY_RUN && removed > 0) {
    copyFileSync(APPS_FILE, APPS_FILE + '.bak');
    writeFileAtomic(APPS_FILE, lines.join('\n'));
    appendLedger(ledgerPathFor(APPS_FILE), statusChangeEntries(promoted, { source: 'dedup', note: 'kept the more advanced status of a removed duplicate' }));
    console.log('✅ Written to applications.md (backup: applications.md.bak)');
  } else if (DRY_RUN) {
    console.log('(dry-run — no changes written)');
  } else {
    console.log('✅ No duplicates found');
  }
}
