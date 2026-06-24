#!/usr/bin/env node
/**
 * rebuild-dedup-index.mjs — Rebuild data/dedup-index.tsv from scratch.
 *
 * Reads data/scouting.md and data/applications.md, extracts every
 * (company, role, date) triple, and writes data/dedup-index.tsv from
 * scratch. Idempotent — safe to run anytime. Latest date per
 * (company_normalized, role_normalized) wins.
 *
 * WHEN TO RUN:
 *   - After any manual edit to data/scouting.md or data/applications.md
 *     (the merge scripts append to dedup-index automatically; this is
 *     the safety net for out-of-band edits).
 *   - The pipeline / scouting modes will also halt and ask you to run
 *     this if they detect a stale index (index max date older than
 *     scouting.md / applications.md max date).
 *
 * Run: node scripts/rebuild-dedup-index.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HEADER, collectInto } from './lib/dedup-index.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(ROOT, 'data/scouting.md');
const APPS_FILE = join(ROOT, 'data/applications.md');
const INDEX_FILE = join(ROOT, 'data/dedup-index.tsv');

function collect(file, map) {
  if (!existsSync(file)) return 0;
  return collectInto(readFileSync(file, 'utf-8'), map);
}

const map = new Map();
const scoutCount = collect(SCOUTING_FILE, map);
const appsCount = collect(APPS_FILE, map);

const lines = [HEADER];
const sortedKeys = [...map.keys()].sort();
for (const key of sortedKeys) {
  lines.push(`${key}\t${map.get(key)}`);
}
writeFileSync(INDEX_FILE, lines.join('\n') + '\n');

console.log(`✅ Rebuilt ${INDEX_FILE}`);
console.log(`   Scouting rows scanned:        ${scoutCount}`);
console.log(`   Applications rows scanned:    ${appsCount}`);
console.log(`   Unique (company, role) pairs: ${map.size}`);
