#!/usr/bin/env node
// Dry-run + apply migration to the entity model.
//
// Usage:
//   node scripts/migrate-to-entity-model.mjs            # dry-run (default)
//   node scripts/migrate-to-entity-model.mjs --apply    # actually mutate
//
// The dry-run reads data/scouting.md, joins it to data/score-history.tsv
// on (company, role) for the location, computes entity_id per row, and
// prints a markdown report describing every collision group, every
// multi-city detection, and every row whose city couldn't be resolved.
// No file is modified.
//
// The `--apply` mode is NOT implemented in this revision — it lands once
// the user has audited the dry-run output. Running with `--apply` today
// prints a stub message and exits non-zero so it can't be invoked
// accidentally.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

// ─── entityId logic — kept in sync with frontend/src/lib/entityId.ts ──

const KNOWN_CITY_ALIASES = {
  Milan: ['Milano'],     Milano: ['Milan'],
  Rome:  ['Roma'],       Roma:   ['Rome'],
  Munich: ['München', 'Munchen'],
  Lisbon: ['Lisboa'],
  Vienna: ['Wien'],
  Brussels: ['Bruxelles'],
};
const KNOWN_CITIES = new Set([
  'Amsterdam', 'Barcelona', 'Berlin', 'Brussels', 'Bruxelles',
  'Copenhagen', 'Dublin', 'Lisbon', 'Lisboa', 'London', 'Madrid',
  'Milan', 'Milano', 'Munich', 'München', 'Munchen', 'Paris', 'Porto',
  'Prague', 'Rome', 'Roma', 'Stockholm', 'Vienna', 'Wien', 'Warsaw',
  'Zurich', 'Geneva', 'Helsinki', 'Oslo', 'Athens', 'Hamburg',
  'Frankfurt', 'Cologne', 'Köln', 'Düsseldorf',
]);

function slug(s) {
  return s.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function canonicalRoleSlug(role, rowCity = null) {
  let r = role;
  r = r.replace(/\(req\s+\d+\)/gi, '');
  r = r.replace(/\(\d{4,}\)/g, '');
  r = r.replace(/\(\s*\d{4}\s*[-–]\s*\d{4}\s*\)/g, '');
  r = r.replace(/\b\d{4}\s*[-–]\s*\d{4}\b/g, '');
  r = r.replace(/\b(?:start\s+)?(?:spring|summer|fall|autumn|winter|q[1-4])\s+20\d{2}\b/gi, '');
  r = r.replace(/\b(?:start\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/gi, '');
  r = r.replace(/\b20\d{2}\b/g, '');
  r = r.replace(/\(\s*all\s+genders?\s*\)/gi, '');
  r = r.replace(/\(\s*[mwfx]\s*[\/\\]\s*[mwfx]\s*(?:[\/\\]\s*[mwfxd]\s*)?\)/gi, '');
  if (rowCity && rowCity !== 'multi') {
    const candidates = new Set([rowCity, ...(KNOWN_CITY_ALIASES[rowCity] ?? [])]);
    for (const c of candidates) {
      r = r.replace(new RegExp(`\\b${escapeRe(c)}\\b`, 'gi'), ' ');
    }
  }
  r = r.replace(/[\s]*[-–—]\s*[-–—][\s]*/g, ' - ');
  r = r.replace(/\(\s*\)/g, '');
  r = r.replace(/\s{2,}/g, ' ');
  r = r.replace(/^[\s\-–—,]+|[\s\-–—,]+$/g, '').trim();
  return slug(r);
}

function parseCities(location) {
  if (!location) return { cities: [], isMulti: false, primary: null };
  const cleaned = location.replace(/\([^)]*\)/g, '').trim();
  if (!cleaned || /^n\/d$/i.test(cleaned)) return { cities: [], isMulti: false, primary: null };
  const tokens = cleaned.split(/\s*[,;\/]\s*/).map(t => t.trim()).filter(Boolean);
  const cityHits = [];
  for (const t of tokens) {
    if (/^remote$/i.test(t)) continue;
    cityHits.push(t);
  }
  if (cityHits.length === 0) return { cities: [], isMulti: false, primary: null };
  if (cityHits.length === 1) return { cities: cityHits, isMulti: false, primary: cityHits[0] };
  const dedup = [...new Set(cityHits)];
  const firstKnown = dedup.find(t => KNOWN_CITIES.has(t)) ?? dedup[0];
  return { cities: dedup, isMulti: true, primary: firstKnown };
}

function entityId(company, role, parsed) {
  const cityKey = parsed.isMulti ? 'multi' : (parsed.primary ? slug(parsed.primary) : 'unknown');
  const roleKey = canonicalRoleSlug(role, parsed.isMulti ? null : parsed.primary);
  return `${slug(company)}::${roleKey}::${cityKey}`;
}

// ─── Read scouting.md + score-history.tsv ────────────────────────────

function readScouting() {
  const path = join(ROOT, 'data/scouting.md');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[#-]/.test(line)) continue;     // header / separator
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 11) continue;
    const [num, date, company, role, score, tier, cfaf, report, deadline, hint, notes] = cells;
    if (!/^\d+$/.test(num)) continue;
    rows.push({ num: Number(num), date, company, role, score, tier, cfaf, report, deadline, hint, notes });
  }
  return rows;
}

function readScoreHistory() {
  const path = join(ROOT, 'data/score-history.tsv');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  const colIdx = (name) => header.indexOf(name);
  const ci = {
    date: colIdx('date'), company: colIdx('company'), role: colIdx('role'),
    location: colIdx('location'), overall: colIdx('overall'), tier: colIdx('tier'),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    rows.push({
      date:     cells[ci.date],
      company:  cells[ci.company],
      role:     cells[ci.role],
      location: cells[ci.location] ?? '',
      overall:  cells[ci.overall],
      tier:     cells[ci.tier],
    });
  }
  return rows;
}

// Build a (company, role) → location index from score-history. When a
// (company, role) appears multiple times (re-evaluations), keep the
// MOST RECENT location string, which is the one the entity should
// represent today.
function buildLocationIndex(scoreRows) {
  const idx = new Map();
  for (const r of scoreRows) {
    const key = `${r.company}::${r.role}`;
    const prev = idx.get(key);
    if (!prev || (r.date && r.date > prev.date)) {
      idx.set(key, { location: r.location, date: r.date });
    }
  }
  return idx;
}

// ─── Build the entity model from current data ────────────────────────

function buildEntities() {
  const scouting = readScouting();
  const scoreHistory = readScoreHistory();
  const locIdx = buildLocationIndex(scoreHistory);

  // Per-scouting-row resolution: company, role, city → entity_id
  const resolved = scouting.map(row => {
    const locKey = `${row.company}::${row.role}`;
    const loc = locIdx.get(locKey);
    const parsed = parseCities(loc?.location ?? '');
    const id = entityId(row.company, row.role, parsed);
    return { row, parsed, entityId: id, location: loc?.location ?? '(no location in score-history)' };
  });

  // Group by entity_id (collisions = multiple scouting rows mapping to
  // the same entity — these are the rows that would merge under the
  // new model).
  const byEntity = new Map();
  for (const r of resolved) {
    if (!byEntity.has(r.entityId)) byEntity.set(r.entityId, []);
    byEntity.get(r.entityId).push(r);
  }

  // Sibling detection: group entities by (company, role-canonical) and
  // surface those with ≥2 different cities.
  const byRoleCanonical = new Map();
  for (const r of resolved) {
    const key = r.entityId.split('::').slice(0, 2).join('::');     // strip the city slug
    if (!byRoleCanonical.has(key)) byRoleCanonical.set(key, new Set());
    byRoleCanonical.get(key).add(r.entityId);
  }
  const siblingGroups = [...byRoleCanonical.entries()]
    .filter(([_, ids]) => ids.size >= 2)
    .map(([key, ids]) => ({ roleKey: key, entityIds: [...ids] }));

  return { resolved, byEntity, siblingGroups };
}

// ─── Dry-run report ──────────────────────────────────────────────────

function renderReport({ resolved, byEntity, siblingGroups }) {
  const collisions = [...byEntity.entries()].filter(([_, rows]) => rows.length > 1);
  const multiCity = resolved.filter(r => r.parsed.isMulti);
  const noCity = resolved.filter(r => !r.parsed.primary && !r.parsed.isMulti);

  const out = [];
  out.push(`# Entity migration — dry-run report`);
  out.push('');
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push(`- Scouting rows scanned: **${resolved.length}**`);
  out.push(`- Distinct entities post-collapse: **${byEntity.size}**`);
  out.push(`- Collision groups (rows that would merge): **${collisions.length}**`);
  out.push(`- Multi-city listings detected: **${multiCity.length}**`);
  out.push(`- Rows with no resolvable city: **${noCity.length}**`);
  out.push(`- Sibling groups (same role, multiple cities): **${siblingGroups.length}**`);
  out.push('');

  if (collisions.length > 0) {
    out.push(`## Collision groups`);
    out.push('');
    out.push(`Each group below is a set of scouting rows that map to the same entity_id. Under the entity model these merge into one row (latest evaluation wins for the canonical view; all evaluations stay in score-history.tsv).`);
    out.push('');
    for (const [id, rows] of collisions) {
      out.push(`### \`${id}\``);
      out.push('');
      out.push(`| # | Date | Company | Role | Score | Tier | Location | Notes |`);
      out.push(`|---|------|---------|------|-------|------|----------|-------|`);
      for (const r of rows) {
        out.push(`| ${r.row.num} | ${r.row.date} | ${r.row.company} | ${r.row.role} | ${r.row.score} | ${r.row.tier} | ${r.location} | ${(r.row.notes || '').slice(0, 80)} |`);
      }
      out.push('');
    }
  }

  if (multiCity.length > 0) {
    out.push(`## Multi-city listings detected`);
    out.push('');
    out.push(`These rows have a location field that names ≥2 cities for a single posting. They become 1 entity with cities[] = the full list and city-key = "multi" in the entity_id.`);
    out.push('');
    out.push(`| # | Company | Role | Location | Cities[] | entity_id |`);
    out.push(`|---|---------|------|----------|----------|-----------|`);
    for (const r of multiCity) {
      out.push(`| ${r.row.num} | ${r.row.company} | ${r.row.role} | ${r.location} | ${r.parsed.cities.join(' · ')} | \`${r.entityId}\` |`);
    }
    out.push('');
  }

  if (noCity.length > 0) {
    out.push(`## Rows with no resolvable city`);
    out.push('');
    out.push(`These rows had no location data in score-history.tsv (or the location string couldn't be parsed). Their entity_id uses city-key = "unknown" — likely a parser fix or a manual location backfill needed before applying.`);
    out.push('');
    out.push(`| # | Company | Role | Raw location | entity_id |`);
    out.push(`|---|---------|------|--------------|-----------|`);
    for (const r of noCity) {
      out.push(`| ${r.row.num} | ${r.row.company} | ${r.row.role} | ${r.location} | \`${r.entityId}\` |`);
    }
    out.push('');
  }

  if (siblingGroups.length > 0) {
    out.push(`## Sibling groups (same role across cities)`);
    out.push('');
    out.push(`Each group is a set of entities that share company + role-canonical but differ on city. Under the entity model these become siblings — separate entities cross-linked in the slide-over.`);
    out.push('');
    for (const g of siblingGroups) {
      out.push(`### \`${g.roleKey}\``);
      out.push('');
      for (const id of g.entityIds) {
        const ex = resolved.find(r => r.entityId === id);
        if (!ex) continue;
        out.push(`- \`${id}\` — ${ex.row.company} · ${ex.row.role} · ${ex.parsed.primary ?? '(multi)'}`);
      }
      out.push('');
    }
  }

  out.push(`## Full entity table`);
  out.push('');
  out.push(`Every scouting row + its computed entity_id, sorted by entity_id. Scan this for surprises (over-collapse, mis-canonicalised role strings).`);
  out.push('');
  out.push(`| entity_id | # | Company | Role | Location |`);
  out.push(`|-----------|---|---------|------|----------|`);
  const sorted = [...resolved].sort((a, b) => a.entityId.localeCompare(b.entityId));
  for (const r of sorted) {
    out.push(`| \`${r.entityId}\` | ${r.row.num} | ${r.row.company} | ${r.row.role} | ${r.location} |`);
  }
  out.push('');

  return out.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────

if (APPLY) {
  console.error('--apply is not implemented yet. Audit the dry-run output first, then this script will be extended.');
  process.exit(2);
}

const model = buildEntities();
const report = renderReport(model);
const reportPath = join(ROOT, 'data/.entity-migration-dry-run.md');
writeFileSync(reportPath, report, 'utf-8');

console.log(report);
console.log('');
console.log(`(saved to ${reportPath})`);
