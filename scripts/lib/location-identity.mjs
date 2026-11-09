/**
 * location-identity.mjs — "is this the same place?" for the scanner's
 * (company, role) dedup.
 *
 * A multi-city programme is often posted city by city: one title, one URL and
 * one posting id per city. The (company, role) key alone collapses all of them
 * onto the first city seen. This module turns a posting's locations into a set
 * of normalized place tokens so the dedup can admit a city it has not seen yet
 * for that key, and nothing else.
 *
 * Fail-closed: a posting whose locations name no specific city (blank,
 * "Remote", a country or region on its own, any piece that is only that) has
 * NO tokens, which callers treat as "could be anywhere". An unknown location on
 * either side keeps today's verdict: duplicate.
 *
 * Pure: no IO.
 */

import { splitLocations } from './listing-fields.mjs';

/** Sentinel token: this key was seen somewhere unknown, so it blocks every city. */
export const ANY_LOCATION = '*';

// Work-mode and office words that say nothing about the place.
const MARKER_RE =
  /\b(?:fully\s+remote|full\s+remote|remote(?:\s+first)?|hybrid|on[\s-]?site|in[\s-]?office|office|hq|headquarters|campus|flexible|work\s+from\s+home|wfh|home[\s-]?based)\b/g;

// Areas wider than a city (generic reference data).
const REGIONS = new Set([
  'europe', 'emea', 'eu', 'european union', 'worldwide', 'global', 'international', 'anywhere',
  'multiple locations', 'various', 'various locations', 'nordics', 'benelux', 'dach', 'apac',
  'americas', 'latam', 'north america', 'south america', 'asia', 'africa', 'middle east',
]);

// Placeholders some boards print instead of the places: "2 Locations", "+3 more".
const COUNT_RE = /^(?:\+?\d+\s*(?:more\s*)?(?:locations?|cities|offices|sites|more)|multiple|several\s+locations)$/;

// Country names (generic reference data). A country alone is not a city.
const COUNTRIES = new Set([
  'spain', 'ireland', 'netherlands', 'the netherlands', 'holland', 'denmark', 'united kingdom', 'uk',
  'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'italy', 'germany', 'deutschland',
  'france', 'portugal', 'belgium', 'sweden', 'switzerland', 'austria', 'finland', 'norway', 'poland',
  'czechia', 'czech republic', 'luxembourg', 'greece', 'hungary', 'romania', 'bulgaria', 'croatia',
  'slovenia', 'slovakia', 'estonia', 'latvia', 'lithuania', 'iceland', 'united states',
  'united states of america', 'usa', 'us', 'canada', 'australia', 'india', 'singapore', 'japan',
  'brazil', 'mexico', 'turkey', 'ukraine', 'serbia', 'espana', 'italia', 'nederland',
]);

// Local spellings of the same city (after accent folding).
const CITY_ALIASES = new Map([
  ['munchen', 'munich'], ['muenchen', 'munich'], ['milano', 'milan'], ['lisboa', 'lisbon'],
  ['koln', 'cologne'], ['koeln', 'cologne'], ['wien', 'vienna'], ['praha', 'prague'],
  ['den haag', 'the hague'], ['\'s-gravenhage', 'the hague'], ['bruxelles', 'brussels'],
  ['brussel', 'brussels'], ['roma', 'rome'], ['warszawa', 'warsaw'], ['kobenhavn', 'copenhagen'],
  ['goteborg', 'gothenburg'], ['geneve', 'geneva'], ['firenze', 'florence'], ['torino', 'turin'],
  ['napoli', 'naples'], ['sevilla', 'seville'], ['frankfurt am main', 'frankfurt'],
]);

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/**
 * The city tokens of ONE location string ("Lyon, France", "Hybrid - Porto",
 * "Berlin (DE)"), or null when it names no specific city. Every non-country,
 * non-region comma part counts as a token, so an unsplit "Lyon, Porto" carries
 * both (over-matching is the safe side).
 *
 * @param {string} location
 * @returns {string[]|null}
 */
export function placeTokens(location) {
  const raw = fold(location).replace(/[([][^)\]]*[)\]]/g, ' ');
  const parts = raw
    .split(/,|\s[-–—]\s|[–—]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (/^[A-Z]{2,3}$/.test(part)) continue; // region / country code: "TX", "NL", "USA"
    let p = part.toLowerCase().replace(MARKER_RE, ' ');
    p = p.replace(/^greater\s+/, '').replace(/\s+(?:metropolitan\s+area|metro\s+area|area|region)$/, '');
    p = p.replace(/[.\s]+/g, ' ').replace(/^[\s:/-]+|[\s:/-]+$/g, '').trim();
    if (!p || COUNTRIES.has(p) || REGIONS.has(p) || COUNT_RE.test(p)) continue;
    const city = CITY_ALIASES.get(p) || p;
    if (!out.includes(city)) out.push(city);
  }
  return out.length ? out : null;
}

/**
 * The place tokens of a posting, from every location string it carries (the
 * source `location`, a split `locations` list, …). Each string is split into
 * single places first. Returns an empty Set when the posting's place is
 * unknown: no location at all, or any piece that names no city ("Lyon; Remote"
 * could be anywhere).
 *
 * @param {Iterable<string|null|undefined>} strings
 * @returns {Set<string>}
 */
export function locationTokens(strings) {
  const pieces = splitLocations([...(strings || [])].filter((s) => s && String(s).trim()).map(String));
  const tokens = new Set();
  for (const piece of pieces) {
    const t = placeTokens(piece);
    if (!t) return new Set();
    for (const x of t) tokens.add(x);
  }
  return tokens;
}

/**
 * Record that `key` was seen at `tokens` (empty = unknown → ANY_LOCATION,
 * which blocks every later city for that key).
 *
 * @param {Map<string, Set<string>>} map
 * @param {string} key
 * @param {Set<string>|Iterable<string>} tokens
 */
export function recordLocations(map, key, tokens) {
  if (!map || !key) return;
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  const list = [...(tokens || [])];
  if (list.length === 0) set.add(ANY_LOCATION);
  for (const t of list) set.add(t);
}

/**
 * True only when a posting of an already-seen `key` is in a city that no
 * earlier posting of that key named: the key has a location record (a key
 * missing from `map` was seen somewhere unknown), that record is not ANY, the
 * posting has tokens, and none of them overlaps.
 *
 * @param {Map<string, Set<string>>|undefined} map
 * @param {string} key
 * @param {Set<string>} tokens
 */
export function isNewLocation(map, key, tokens) {
  if (!map || !key || !tokens || tokens.size === 0) return false;
  const seen = map.get(key);
  if (!seen || seen.size === 0 || seen.has(ANY_LOCATION)) return false;
  for (const t of tokens) if (seen.has(t)) return false;
  return true;
}
