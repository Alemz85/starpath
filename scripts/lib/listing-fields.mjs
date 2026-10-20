/**
 * listing-fields.mjs — pure parsers for the per-listing fields the scanner
 * records beyond title/company/url: the application DEADLINE, the multi-city
 * LOCATIONS list, and the ATS-native ids. No IO.
 *
 * Rule for every date here: only an unambiguous ISO-8601 calendar date counts.
 * "03/04/2026" (March or April?), "next Friday", "Rolling" — all absent, never
 * guessed. A wrong deadline on an Applying card is worse than no deadline.
 */

// ── Deadline ────────────────────────────────────────────────────────────────

const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function validYmd(y, m, d) {
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Parse a deadline field from an ATS payload. Accepts `YYYY-MM-DD` or an ISO
 * timestamp (`2026-12-31T23:59:00Z`); returns the calendar date as written
 * (`YYYY-MM-DD`) or null. Numbers (epoch), slashed/dotted dates, month names,
 * impossible dates (2026-02-30) and out-of-range years are all null.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseDeadline(raw) {
  if (typeof raw !== 'string') return null;
  const m = ISO_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validYmd(y, mo, d)) return null;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// A deadline-ish cue immediately followed by an ISO date. The cue list is
// deliberately narrow (explicit "deadline"/"closing date"/"apply by" phrasing);
// a bare date elsewhere in a JD (start date, founding year) never matches.
const DEADLINE_CUE =
  '(?:(?:application|applications|apply)\\s+(?:deadline|closing\\s+date|close\\s+date|by|before|until)' +
  '|(?:closing|close|application)\\s+date' +
  '|deadline(?:\\s+(?:for\\s+(?:applications?|submissions?)|to\\s+apply))?' +
  '|applications?\\s+(?:close|closes|are\\s+due|due|must\\s+be\\s+(?:received|submitted)\\s+by)' +
  '|(?:position|role|vacancy|posting)\\s+closes?' +
  '|(?:last\\s+day|final\\s+date)\\s+to\\s+apply' +
  '|submit\\s+(?:your\\s+)?application\\s+(?:by|before)' +
  '|closes?(?:\\s+on)?)';
const DEADLINE_IN_TEXT_RE = new RegExp(
  `\\b${DEADLINE_CUE}\\s*(?:is|are|will\\s+be|:|-|–|—|on|by|before|until)?\\s*[:\\-–—]?\\s*(\\d{4}-\\d{2}-\\d{2})(?![\\d/]|[.-]\\d)`,
  'gi',
);

/** Strip tags / decode the few entities that matter, collapse whitespace. */
function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8209;|&#8211;|&ndash;|&#8212;|&mdash;/gi, '-')
    .replace(/\s+/g, ' ');
}

/**
 * Find an explicit application deadline in a job-description body. Returns the
 * ISO date when exactly one distinct valid date follows a deadline cue; null
 * when there is none or the JD names several different ones (ambiguous).
 *
 * @param {string} text plain text or HTML
 * @returns {string|null}
 */
export function extractDeadlineFromText(text) {
  if (!text) return null;
  const hay = plainText(text);
  const found = new Set();
  for (const m of hay.matchAll(DEADLINE_IN_TEXT_RE)) {
    const d = parseDeadline(m[1]);
    if (d) found.add(d);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Pick a deadline from structured ATS fields, then fall back to the JD body.
 * `fields` are raw candidate values (any type); the first that parses wins.
 */
export function resolveDeadline(fields = [], bodyText = '') {
  for (const f of fields) {
    const d = parseDeadline(f);
    if (d) return d;
  }
  return extractDeadlineFromText(bodyText);
}

// ── Locations ───────────────────────────────────────────────────────────────

// Generic country names (system-layer reference data, not a user preference).
// Used only to tell "Germany, Berlin, Munich" (one country + two cities) from
// "Paris, France" (a city and its country).
const COUNTRIES = new Set([
  'spain', 'ireland', 'netherlands', 'the netherlands', 'denmark', 'united kingdom', 'uk', 'great britain',
  'england', 'scotland', 'wales', 'italy', 'germany', 'france', 'portugal', 'belgium', 'sweden',
  'switzerland', 'austria', 'finland', 'norway', 'poland', 'czechia', 'czech republic', 'luxembourg',
  'greece', 'hungary', 'romania', 'bulgaria', 'croatia', 'slovenia', 'slovakia', 'estonia', 'latvia',
  'lithuania', 'iceland', 'united states', 'usa', 'us', 'canada', 'australia', 'india', 'singapore',
  'japan', 'brazil', 'mexico', 'turkey', 'ukraine', 'serbia',
]);

const MAX_LOCATIONS = 20;

/** Split on `sep` at parenthesis depth 0 only ("Berlin (DE, hybrid)" stays whole). */
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const clean = (s) => s.replace(/\s+/g, ' ').replace(/^[\s,;-]+|[\s,;-]+$/g, '').trim();
const isCountry = (s) => COUNTRIES.has(s.toLowerCase().replace(/\./g, ''));
const isRegionCode = (s) => /^[A-Z]{2}$/.test(s); // "TX", "CA"

/**
 * Split one comma-separated segment into locations, or return it whole.
 * Only splits when it is clearly several cities, never "City, Country" or
 * "City, Region".
 */
function splitCommaSegment(segment, knownPlaces) {
  const parts = splitTopLevel(segment, ',').map(clean).filter(Boolean);
  if (parts.length < 2) return parts;

  // Attach a trailing 2-letter region code to the city before it ("Austin, TX").
  const merged = [];
  for (const p of parts) {
    if (isRegionCode(p) && merged.length && !isCountry(p)) merged[merged.length - 1] += `, ${p}`;
    else merged.push(p);
  }
  const countries = merged.filter(isCountry);
  const rest = merged.filter((p) => !isCountry(p));
  const known = (p) => knownPlaces.has(p.toLowerCase());
  const looksMulti = rest.length >= 2 && (countries.length >= 1 || rest.length >= 3 || rest.every(known));
  if (!looksMulti) return [merged.join(', ')];
  // One country shared by several cities → "City, Country" for each, so every
  // location is self-describing; several (or no) countries → cities as given.
  const suffix = countries.length === 1 ? `, ${countries[0]}` : '';
  return rest.map((c) => `${c}${suffix}`);
}

/**
 * Turn the raw location string an ATS/aggregator gave us into a list of
 * separate locations. Handles `;` `|` newline ` / ` ` & ` ` • ` as hard separators and
 * comma lists conservatively (see splitCommaSegment). Case-insensitive
 * de-dup, order preserved, capped at 20. An empty/blank input → [].
 *
 * @param {string|string[]|null|undefined} raw
 * @param {{knownPlaces?: Iterable<string>}} [opts] lowercase city/country names
 *        the caller knows (e.g. the portals.yml allowlist); lets a bare
 *        "Berlin, Munich" split without a country present.
 * @returns {string[]}
 */
export function splitLocations(raw, { knownPlaces = [] } = {}) {
  const known = new Set([...knownPlaces].map((k) => String(k).trim().toLowerCase()).filter(Boolean));
  const chunks = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  const out = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const hard = chunk
      .split(/[;|\n\r•·]+| \/ | & |(?<=[A-Za-zÀ-ÿ])\/(?=[A-Za-zÀ-ÿ])/)
      .map(clean)
      .filter(Boolean);
    for (const seg of hard) {
      for (const loc of splitCommaSegment(seg, known)) {
        const key = loc.toLowerCase();
        if (!loc || seen.has(key)) continue;
        seen.add(key);
        out.push(loc);
        if (out.length >= MAX_LOCATIONS) return out;
      }
    }
  }
  return out;
}

/** Locations stored in the scan-history `locations` cell (`|`-joined). */
export function formatLocations(list) {
  return (list || []).map((l) => String(l).replace(/[\t|\n\r]/g, ' ').trim()).filter(Boolean).join('|');
}

/** Inverse of formatLocations (empty cell → []). */
export function parseLocationsCell(cell) {
  return String(cell ?? '').split('|').map((s) => s.trim()).filter(Boolean);
}

/**
 * Location gate for a listing with possibly several locations: kept when ANY
 * location passes `filter` (a listing open in Berlin and New York is a Berlin
 * listing). No locations at all defers to the filter's own empty-string rule
 * (unknown → keep).
 *
 * @param {string[]} locations
 * @param {(location:string)=>boolean} filter e.g. buildLocationFilter(...)
 */
export function anyLocationAllowed(locations, filter) {
  if (!locations || locations.length === 0) return filter('');
  return locations.some((l) => filter(l));
}

// ── Native ids ──────────────────────────────────────────────────────────────

/** Trim an id to a tab/newline-free string; numbers become decimal strings. */
export function cleanId(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
  return s.replace(/[\t\r\n|]+/g, ' ').trim().slice(0, 120);
}
