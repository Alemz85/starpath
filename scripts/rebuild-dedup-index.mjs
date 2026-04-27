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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOUTING_FILE = join(ROOT, 'data/scouting.md');
const APPS_FILE = join(ROOT, 'data/applications.md');
const INDEX_FILE = join(ROOT, 'data/dedup-index.tsv');

const HEADER = 'company_normalized\trole_normalized\tlast_seen_date';

function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRole(role) {
  return role.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isDataRow(line) {
  return line.startsWith('|') && !line.includes('---') && !/^\|\s*#\s*\|/.test(line);
}

function parseRow(line) {
  // Both scouting.md and applications.md share: empty | num | date | company | role | ...
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 6) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  const date = parts[2];
  const company = parts[3];
  const role = parts[4];
  if (!date || !company || !role) return null;
  // Reject obvious header noise where date column doesn't look like a date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, company, role };
}

function collect(file, map) {
  if (!existsSync(file)) return 0;
  const content = readFileSync(file, 'utf-8');
  let count = 0;
  for (const line of content.split('\n')) {
    if (!isDataRow(line)) continue;
    const r = parseRow(line);
    if (!r) continue;
    const key = `${normalizeCompany(r.company)}\t${normalizeRole(r.role)}`;
    const prev = map.get(key);
    if (!prev || r.date > prev) map.set(key, r.date);
    count++;
  }
  return count;
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
