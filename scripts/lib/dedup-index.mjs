/**
 * dedup-index.mjs — pure index-building logic for the (company, role) dedup
 * index, extracted from rebuild-dedup-index.mjs so it can be unit-tested in
 * isolation (no filesystem). The script keeps the file IO + reporting; the
 * parsing/normalization/merge math lives here.
 *
 * The index collapses every (company, role) entry across scouting.md and
 * applications.md to a single normalized key, keeping the latest date seen.
 */

import { createHash } from 'node:crypto';

export const HEADER = 'company_normalized\trole_normalized\tlast_seen_date';

/**
 * The ORIGINAL company key: lowercase, strip every non-[a-z0-9]. Kept only so
 * rows written before the identity-key change still match (see
 * companyKeyAliases) — it is lossy: any Cyrillic/CJK/Arabic name folds to ''
 * and every such company collided with every other.
 */
export function legacyCompanyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Latin letters NFKD cannot decompose to an ASCII base.
const LATIN_FOLD = { 'ß': 'ss', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ı': 'i' };

function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Normalize a company name to a dedup key.
 *
 *   • Plain ASCII names are unchanged: "Acme Corp." → `acmecorp` (every existing
 *     index row keeps matching).
 *   • Latin names with diacritics fold cleanly instead of losing the letter:
 *     "Café Noir" → `cafenoir` (was `cafnoir`; the old key stays reachable via
 *     companyKeyAliases).
 *   • Names with letters/digits outside Latin script (Cyrillic, CJK, Arabic,
 *     Greek …), or no ASCII at all, get an NFKD slug of their own letters plus a
 *     short hash: "Северный Ветер" → `северныйветер~<hash>`. The hash covers the whole
 *     normalized name, so two different non-Latin names can never collapse onto
 *     the same key, and a mixed name ("Acme Северный Ветер") no longer collides with
 *     the plain-ASCII "Acme". `~` cannot occur in a plain key, so the two
 *     families never overlap.
 *   • Blank or punctuation-only input stays '' (callers treat '' as "no key —
 *     skip key dedup" and fall back to the ATS posting id / URL hash, see
 *     merge-staging-core › listingIdentity).
 */
export function normalizeCompany(name) {
  const raw = String(name ?? '');
  const legacy = legacyCompanyKey(raw);
  if (legacy && /^[\x00-\x7f]*$/.test(raw)) return legacy; // fast path: pure ASCII

  const nfkd = raw.normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '');
  const folded = nfkd.replace(/[ßøæœđðþłı]/g, (c) => LATIN_FOLD[c]);
  const letters = folded.replace(/[^\p{L}\p{N}]+/gu, '');
  // Nothing alphanumeric at all (punctuation / emoji only, or blank): no key,
  // callers skip key-based dedup rather than key on noise.
  if (!letters) return '';
  const ascii = letters.replace(/[^a-z0-9]/g, '');
  if (ascii === letters) return ascii; // pure Latin once diacritics are folded
  return `${letters.slice(0, 32)}~${shortHash(letters)}`;
}

/** Every non-ASCII letter/digit is a (non-fullwidth) Latin letter, i.e. the legacy key only lost diacritics. */
function isPlainLatin(name) {
  for (const ch of String(name ?? '')) {
    if (ch.charCodeAt(0) < 0x80 || !/[\p{L}\p{N}]/u.test(ch)) continue;
    if (!/\p{Script=Latin}/u.test(ch) || /[\uFF00-\uFFEF]/.test(ch)) return false;
  }
  return true;
}

/**
 * Every key an existing index row for this company might carry: the current
 * key first, then the pre-change key when it is a meaningful alias (non-empty,
 * different, and the name is Latin-only — for non-Latin names the legacy key is
 * '' or a fragment of an ASCII sub-word, and matching on it IS the collision
 * bug). Use this for READS against an index written by older code; write the
 * first element.
 */
export function companyKeyAliases(name) {
  const primary = normalizeCompany(name);
  const keys = [primary];
  const legacy = legacyCompanyKey(name);
  if (legacy && legacy !== primary && !primary.includes('~') && isPlainLatin(name)) keys.push(legacy);
  return keys;
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
    const role = normalizeRole(r.role);
    // Primary key first, then the legacy alias (only for Latin names whose key
    // changed), so a reader or writer still on the old scheme keeps matching
    // until every writer moves to normalizeCompany.
    for (const company of companyKeyAliases(r.company)) {
      const key = `${company}\t${role}`;
      const prev = map.get(key);
      if (!prev || r.date > prev) map.set(key, r.date);
    }
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
