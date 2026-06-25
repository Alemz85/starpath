/**
 * scan-core.mjs — pure, testable matching logic for the portal scanner.
 *
 * scan.mjs hits ATS APIs and writes files (side effects). All the *decisions*
 * about whether a posting survives the filter funnel live here as pure
 * functions so they can be unit-tested without a network or the filesystem.
 *
 * The funnel (each gate must pass, in order):
 *   1. title    — at least one positive keyword AND zero negative keywords
 *   2. language — title contains no lang_blocklist token
 *   3. location — location matches the target-geography allowlist (or is empty)
 *
 * ── Why word-aware matching (the bug this module fixes) ──────────────────
 * The original filter used raw `String.includes()`. That had two failure modes:
 *
 *   FALSE NEGATIVE (senior roles leak in): negative keywords were written with
 *   a trailing space ("Senior ", "Lead ", "Staff ") to avoid matching
 *   "Leadership"/"Leading". But a trailing space only matches when the word is
 *   followed by a space, so "Operations Lead", "Engineering Lead", and
 *   "Lead, Strategy" all slipped past the "Lead " negative and polluted the
 *   pipeline with exactly the seniorities the list exists to exclude.
 *
 *   FALSE POSITIVE (substring collisions): a bare "Lead" negative would also
 *   kill "Leadership Analyst"; a "BI" positive would match "ambitious".
 *
 * keywordMatches() matches on WORD boundaries instead. A single-word keyword
 * ("Lead") matches the standalone word "Lead" wherever it appears — start,
 * middle, end, or before punctuation — but never inside another word
 * ("Leadership", "Leading"). Multi-word keyword phrases ("Strategy &
 * Operations", "Head of") are matched as whole phrases with the same boundary
 * rule at each end. So users can drop the fragile trailing spaces from their
 * portals.yml and get correct results either way (trailing/leading spaces in a
 * keyword are trimmed before matching).
 */

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Memoize compiled matchers — buildTitleFilter rebuilds per company, and the
// same keyword lists recur across hundreds of companies in one scan.
const _matcherCache = new Map();

/**
 * Build a word-boundary matcher for a keyword.
 *
 * "Boundary" here means: the character immediately before/after the keyword is
 * not a letter or digit (so spaces, punctuation, string ends all qualify).
 * This is deliberately looser than `\b`, which treats "&", "+", "/" as
 * boundaries — exactly what we want for titles like "R&D" or "Pre-Sales".
 *
 * @param {string} keyword
 * @returns {(text:string)=>boolean} matcher over an already-lowercased haystack
 */
function compileKeyword(keyword) {
  const trimmed = keyword.trim().toLowerCase();
  if (!trimmed) return () => false;
  if (_matcherCache.has(trimmed)) return _matcherCache.get(trimmed);

  // Left boundary: start-of-string or a non-alphanumeric char.
  // Right boundary: end-of-string or a non-alphanumeric char.
  // We use lookarounds so adjacent matches don't consume the boundary char.
  const body = escapeRegExp(trimmed).replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?:^|[^a-z0-9])${body}(?:$|[^a-z0-9])`, 'i');
  const matcher = (lowerText) => re.test(lowerText);
  _matcherCache.set(trimmed, matcher);
  return matcher;
}

/**
 * Does `title` contain `keyword` as a whole word/phrase (case-insensitive)?
 * @param {string} title
 * @param {string} keyword
 */
export function keywordMatches(title, keyword) {
  if (!title || !keyword) return false;
  return compileKeyword(keyword)(title.toLowerCase());
}

/**
 * Build the title-stage predicate.
 *
 * Mirrors the original contract: a title passes when at least one positive
 * keyword matches (or there are no positives) AND no negative keyword matches.
 * The only behavioral change is word-boundary matching instead of substring.
 *
 * If `auditStats` is provided it is mutated to record why titles were dropped:
 *   - auditStats.negativeHits[keyword]++ when a negative kills a title
 *   - auditStats.noPositiveMatch++       when no positive matched
 * (keeps scan.mjs's existing filter-health report working unchanged.)
 *
 * @param {{positive?:string[], negative?:string[]}} titleFilter
 * @param {{negativeHits:Record<string,number>, noPositiveMatch:number}} [auditStats]
 * @returns {(title:string)=>boolean}
 */
export function buildTitleFilter(titleFilter, auditStats) {
  const positive = (titleFilter?.positive || []).map((k) => k.trim()).filter(Boolean);
  const negative = (titleFilter?.negative || []).map((k) => k.trim()).filter(Boolean);

  if (auditStats) {
    for (const k of negative) {
      if (!(k in auditStats.negativeHits)) auditStats.negativeHits[k] = 0;
    }
  }

  const posMatchers = positive.map((k) => ({ key: k, test: compileKeyword(k) }));
  const negMatchers = negative.map((k) => ({ key: k, test: compileKeyword(k) }));

  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = posMatchers.length === 0 || posMatchers.some((m) => m.test(lower));
    if (!hasPositive) {
      if (auditStats) auditStats.noPositiveMatch++;
      return false;
    }
    for (const m of negMatchers) {
      if (m.test(lower)) {
        if (auditStats) auditStats.negativeHits[m.key]++;
        return false;
      }
    }
    return true;
  };
}

/**
 * Build the language-barrier predicate. A title is rejected if it contains any
 * blocklist token. Tokens are matched word-aware too, so a token like "stage"
 * (French/Dutch internship) won't nuke "Staged rollout"… but note many
 * language markers are sub-word ("(m/w/d)", "consultoría"); those still match
 * because they contain non-alphanumeric chars or accented letters that act as
 * boundaries / aren't in [a-z0-9].
 *
 * @param {{lang_blocklist?:string[]}} config
 * @returns {(title:string)=>boolean} true = keep
 */
export function buildLangFilter(config) {
  const blocklist = (config?.lang_blocklist || []).map((t) => t.trim()).filter(Boolean);
  if (blocklist.length === 0) return () => true;
  const matchers = blocklist.map((t) => compileKeyword(t));
  return (title) => {
    const lower = (title || '').toLowerCase();
    return !matchers.some((m) => m(lower));
  };
}

// ── Location allowlist ──────────────────────────────────────────────────────
//
// Generic European target-geography list. This is a *system-layer* reference
// (covers the common EU/UK hubs), NOT one user's preference — a user who wants
// to narrow or widen this passes `location_allowlist` in portals.yml (handled
// by buildLocationFilter below). Tokens are lowercased.

export const DEFAULT_LOCATION_ALLOWLIST = [
  'spain', 'barcelona', 'madrid', 'valencia',
  'ireland', 'dublin',
  'netherlands', 'amsterdam', 'rotterdam', 'eindhoven', 'the hague',
  'denmark', 'copenhagen',
  'united kingdom', 'uk', 'london', 'manchester', 'cambridge',
  'italy', 'milan', 'milano', 'rome',
  'germany', 'munich', 'münchen', 'berlin', 'hamburg', 'frankfurt', 'cologne',
  'france', 'paris',
  'portugal', 'lisbon', 'porto',
  'belgium', 'brussels',
  'sweden', 'stockholm',
  'switzerland', 'zurich', 'zürich', 'geneva',
  'austria', 'vienna',
  'finland', 'helsinki',
  'norway', 'oslo',
  'poland', 'warsaw', 'krakow',
  'remote',
];

// Markers that mean "anywhere on Earth" / non-target geographies. A location
// like "Remote - US" should be allowed (it has "remote"), but "New York" or
// "Singapore" alone should not. We don't maintain a global blocklist; the
// allowlist is the gate. Empty/unknown locations pass (the API often omits
// location), so location is a soft filter by design.

/**
 * Build the location predicate from an optional user allowlist.
 * @param {string[]} [allowlist] overrides DEFAULT_LOCATION_ALLOWLIST when non-empty
 * @returns {(location:string)=>boolean} true = keep
 */
export function buildLocationFilter(allowlist) {
  const list = (allowlist && allowlist.length > 0 ? allowlist : DEFAULT_LOCATION_ALLOWLIST)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  return (location) => {
    if (!location || location.trim() === '') return true; // unknown → don't filter
    const lower = location.toLowerCase();
    // Country/city tokens are matched word-aware so "uk" doesn't hit "Paducah"
    // and "rome" doesn't hit "Jerome".
    return list.some((token) => compileKeyword(token)(lower));
  };
}

/** Back-compat: the old free function, now backed by the default allowlist. */
const _defaultLocationFilter = buildLocationFilter();
export function isAllowedLocation(location) {
  return _defaultLocationFilter(location);
}

// ── Freshness ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Age in whole days of a posting given its scan-history row's first_seen date.
 * Returns null for unparseable input.
 * @param {string} firstSeen ISO date (YYYY-MM-DD)
 * @param {Date|string} [now]
 */
export function ageInDays(firstSeen, now = new Date()) {
  if (!firstSeen) return null;
  const seen = new Date(firstSeen);
  if (Number.isNaN(seen.getTime())) return null;
  const ref = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(ref.getTime())) return null;
  return Math.floor((ref.getTime() - seen.getTime()) / MS_PER_DAY);
}

/**
 * Classify a posting's freshness for surfacing. Mirrors the frontend Database
 * liveness buckets so a "what's new and high-fit" view can lean on it.
 *   fresh   : first seen in the last `freshDays` days   (default 14)
 *   recent  : older than fresh but within `staleDays`   (default 90)
 *   stale   : older than staleDays
 *   unknown : no parseable date
 * @returns {'fresh'|'recent'|'stale'|'unknown'}
 */
export function freshnessBucket(firstSeen, { now = new Date(), freshDays = 14, staleDays = 90 } = {}) {
  const age = ageInDays(firstSeen, now);
  if (age === null) return 'unknown';
  if (age < 0) return 'fresh'; // future-dated → treat as brand new
  if (age <= freshDays) return 'fresh';
  if (age <= staleDays) return 'recent';
  return 'stale';
}
