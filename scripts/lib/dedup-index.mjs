/**
 * dedup-index.mjs — pure index-building logic for the (company, role) dedup
 * index, extracted from rebuild-dedup-index.mjs so it can be unit-tested in
 * isolation (no filesystem). The script keeps the file IO + reporting; the
 * parsing/normalization/merge math lives here.
 *
 * The index collapses every (company, role) entry across scouting.md and
 * applications.md to a single normalized key, keeping the latest date seen.
 */

export const HEADER = 'company_normalized\trole_normalized\tlast_seen_date';

/** Normalize a company name to a dedup key: lowercase, strip non-alphanumerics. */
export function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalize a role to a dedup key: lowercase, collapse internal whitespace, trim. */
export function normalizeRole(role) {
  return role.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A markdown table data row (pipe-delimited, not a separator or header row). */
export function isDataRow(line) {
  return line.startsWith('|') && !line.includes('---') && !/^\|\s*#\s*\|/.test(line);
}

/**
 * Parse a tracker/scouting row into { date, company, role }, or null if the
 * line isn't a real entry. Both scouting.md and applications.md share the
 * leading shape: | num | date | company | role | ...
 */
export function parseRow(line) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 6) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  const date = parts[2];
  const company = parts[3];
  const role = parts[4];
  if (!date || !company || !role) return null;
  // Reject header noise where the date column doesn't look like a date.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, company, role };
}

/**
 * Fold one file's content into the key→latest-date map. Latest date wins per
 * (normalized company, normalized role). Returns the count of valid rows seen.
 */
export function collectInto(content, map) {
  let count = 0;
  for (const line of (content ?? '').split('\n')) {
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

/**
 * Build the sorted index body (data lines, no header) from one or more file
 * contents. Latest date wins across all inputs; keys are sorted lexically.
 */
export function buildIndexLines(...contents) {
  const map = new Map();
  for (const content of contents) collectInto(content, map);
  return [...map.keys()].sort().map((key) => `${key}\t${map.get(key)}`);
}
