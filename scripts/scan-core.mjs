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
  // Filter blanks FIRST, THEN decide override-vs-default (parity with scan.py
  // › set_location_allowlist). Deciding on the raw length would let an
  // all-blank list like ['', '  '] "win" and then filter down to nothing —
  // yielding a reject-everything predicate instead of the intended default.
  const cleaned = (Array.isArray(allowlist) ? allowlist : [])
    .map((l) => String(l).trim().toLowerCase())
    .filter(Boolean);
  const list = (cleaned.length > 0 ? cleaned : DEFAULT_LOCATION_ALLOWLIST)
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
 * Normalize a raw posting/update date from any ATS payload to a bare
 * `YYYY-MM-DD` string, or null if it can't be confidently parsed.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every ATS exposes *when a job was actually posted*, but in different shapes:
 *   • Greenhouse `updated_at` / `first_published` → ISO ts "2026-06-01T09:00:00-04:00"
 *   • Lever      `createdAt`                       → epoch ms (number) 1717225200000
 *   • Ashby      `publishedAt`                      → ISO ts "2026-06-01T09:00:00.000Z"
 *   • JobSpy     `date`                             → bare "2026-06-01"
 * The scanner used to discard all of these and stamp `first_seen = today`, so a
 * job posted 60 days ago that a newly-tracked company surfaces today looked
 * "freshly posted" and won the full freshness bonus — a sourcing-quality false
 * positive that polluted the relevance ranking. This collapses the four shapes
 * to one comparable date so freshness reflects the TRUE posting age.
 *
 * Fail-open: anything we can't confidently parse returns null, and the caller
 * falls back to first_seen (today) — i.e. exactly the old behaviour, never worse.
 *
 * @param {string|number|Date|null|undefined} raw
 * @returns {string|null} YYYY-MM-DD or null
 */
export function parsePostingDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  // Already a bare YYYY-MM-DD — accept verbatim (cheap, avoids any TZ drift).
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  }

  let d;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Epoch — ms vs seconds: 10-digit values are seconds (until ~2286).
    d = new Date(Math.abs(raw) < 1e11 ? raw * 1000 : raw);
  } else if (typeof raw === 'string' && /^\d{10,}$/.test(raw.trim())) {
    const n = Number(raw.trim());
    d = new Date(raw.trim().length <= 11 ? n * 1000 : n);
  } else if (raw instanceof Date) {
    d = raw;
  } else {
    // ISO timestamp / date string — let the engine parse it.
    d = new Date(raw);
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;

  // Render in UTC so an ISO ts near midnight doesn't slide a day under local TZ.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

// ── Relevance ranking ─────────────────────────────────────────────────────────
//
// Once a posting clears the 4-pass filter funnel it's a *binary* keep — but not
// all keeps are equal. A title that matches three of the user's positive
// keywords, names a target city, hits a seniority-boost token, and was first
// seen today is a far better use of the user's evaluation time than one that
// barely scraped a single positive in an unknown location. Yet scan.mjs used to
// append survivors in raw fetch order, so the strongest match could sit at the
// bottom of the pipeline behind dozens of marginal ones.
//
// scoreRelevance() turns each surviving posting into a transparent, additive
// score plus a `reasons[]` trail explaining how it got there. It is intentionally
// simple and deterministic (no ML, no opaque weights): every point is traceable
// to a signal the user can see and tune via portals.yml. rankOffers() then orders
// a batch best-first and stamps the score on each offer.
//
// Design choices:
//   • Multi-word positive phrases ("Strategy & Operations") score higher than a
//     single token ("Operations") — a phrase match signals far more specific
//     topical intent than a lone common word.
//   • seniority_boost finally gets wired up. It's been a defined-but-unread field
//     in portals.yml; the user's whole target band (Junior / Intern / Associate /
//     Entry Level) lives there, so a hit is a strong positive signal.
//   • Freshness leans on the same buckets the Database view uses, so "new and
//     high-fit" means the same thing across the scanner and the cockpit.
//   • A named target city outranks a bare "remote" / unknown location — physical
//     presence in a target hub is the user's strongest geographic signal.
//
// All weights are overridable via portals.yml › relevance_weights (see
// resolveRelevanceWeights) so this is system-layer scaffolding, not a hardcoded
// one-user policy.

export const DEFAULT_RELEVANCE_WEIGHTS = Object.freeze({
  positivePhrase: 2.0, // each matched multi-word positive keyword
  positiveWord: 1.0,   // each matched single-word positive keyword
  seniorityBoost: 2.5, // any seniority_boost token present (counted once)
  freshFresh: 1.5,     // posted (or, fallback, first seen) within the fresh window
  freshRecent: 0.5,    // posted (or, fallback, first seen) within the recent window
  staleRepost: -1.0,   // posted before the stale window — a long-open repost; demote
  cityMatch: 1.0,      // location names a specific allowlisted city (not just country/remote)
});

/**
 * A small, curated set of generic "anywhere" location tokens. A posting whose
 * location is only one of these (e.g. "Remote") still passed the location gate,
 * but it earns no city-specificity bonus — it's not tied to a target hub.
 * This is system-layer reference data, not user preference.
 */
const GENERIC_LOCATION_TOKENS = new Set(['remote', 'europe', 'emea', 'hybrid', 'anywhere']);

/**
 * Country-level allowlist tokens (as opposed to city-level). A location that only
 * names a country ("Spain") is less specific than one naming a city ("Barcelona"),
 * so it doesn't earn the city bonus. Derived from the default allowlist; this is
 * the generic EU country set, not one user's targets.
 */
const COUNTRY_TOKENS = new Set([
  'spain', 'ireland', 'netherlands', 'denmark', 'united kingdom', 'uk',
  'italy', 'germany', 'france', 'portugal', 'belgium', 'sweden',
  'switzerland', 'austria', 'finland', 'norway', 'poland',
]);

// Weights that are penalties (≤ 0) rather than bonuses. For these a positive
// override would invert the intent (rewarding a stale repost), so we clamp them
// to be non-positive; all others are clamped non-negative. Either way a typo
// can't flip a signal's sign.
const PENALTY_WEIGHT_KEYS = new Set(['staleRepost']);

/**
 * Merge user-supplied relevance weights (portals.yml › relevance_weights) over
 * the system defaults. Unknown keys are ignored; non-finite values fall back to
 * the default for that key. Bonus weights are clamped to ≥ 0 and penalty weights
 * (e.g. staleRepost) to ≤ 0, so a typo can't zero out or invert scoring.
 * @param {Record<string, number>} [overrides]
 * @returns {typeof DEFAULT_RELEVANCE_WEIGHTS}
 */
export function resolveRelevanceWeights(overrides) {
  const out = { ...DEFAULT_RELEVANCE_WEIGHTS };
  if (overrides && typeof overrides === 'object') {
    for (const key of Object.keys(DEFAULT_RELEVANCE_WEIGHTS)) {
      const v = overrides[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const isPenalty = PENALTY_WEIGHT_KEYS.has(key);
      if (isPenalty ? v <= 0 : v >= 0) out[key] = v;
    }
  }
  return out;
}

/**
 * Is a single keyword a multi-word phrase (after trimming/collapsing space)?
 */
function isPhrase(keyword) {
  return /\s/.test(keyword.trim());
}

/**
 * Score a single surviving posting for relevance. Higher = better match.
 *
 * Pure and deterministic. Returns the numeric score plus a `reasons[]` trail and
 * a `signals` breakdown, so callers (and the user) can see exactly why a posting
 * ranked where it did. Assumes the posting already passed the filter funnel —
 * this ranks keeps, it does not re-filter.
 *
 * Freshness prefers the TRUE posting date (`posting.postedDate`, normalized via
 * parsePostingDate) over `firstSeen`. Within a single scan run every offer is
 * first-seen today, so without the posting date freshness was uniform and did
 * nothing to separate a job posted this morning from one open for two months.
 * With it, the genuinely-new posting outranks the long-stale repost — and a
 * repost older than the stale window is actively demoted (staleRepost weight).
 *
 * @param {{title?:string, location?:string, firstSeen?:string, postedDate?:string|number}} posting
 * @param {{positive?:string[], seniority_boost?:string[]}} titleFilter
 * @param {object} [opts]
 * @param {Record<string,number>} [opts.weights] resolved relevance weights
 * @param {string[]} [opts.locationAllowlist] effective location allowlist
 * @param {Date|string} [opts.now] reference time for freshness
 * @param {number} [opts.freshDays]
 * @param {number} [opts.staleDays]
 * @returns {{score:number, reasons:string[], signals:object}}
 */
export function scoreRelevance(posting, titleFilter, opts = {}) {
  const weights = opts.weights || DEFAULT_RELEVANCE_WEIGHTS;
  const title = posting?.title || '';
  const lowerTitle = title.toLowerCase();
  const reasons = [];
  let score = 0;

  // ── 1. Positive keyword matches (phrases weigh more than lone words) ──
  const positives = (titleFilter?.positive || []).map((k) => k.trim()).filter(Boolean);
  const matchedPhrases = [];
  const matchedWords = [];
  for (const kw of positives) {
    if (compileKeyword(kw)(lowerTitle)) {
      (isPhrase(kw) ? matchedPhrases : matchedWords).push(kw);
    }
  }
  if (matchedPhrases.length) {
    score += matchedPhrases.length * weights.positivePhrase;
    reasons.push(`matches ${matchedPhrases.length} target phrase${matchedPhrases.length > 1 ? 's' : ''} (${matchedPhrases.join(', ')})`);
  }
  if (matchedWords.length) {
    score += matchedWords.length * weights.positiveWord;
    reasons.push(`matches ${matchedWords.length} target keyword${matchedWords.length > 1 ? 's' : ''} (${matchedWords.join(', ')})`);
  }

  // ── 2. Seniority-boost tokens (the user's actual target band) ──
  const boosts = (titleFilter?.seniority_boost || []).map((k) => k.trim()).filter(Boolean);
  const matchedBoosts = boosts.filter((b) => compileKeyword(b)(lowerTitle));
  if (matchedBoosts.length) {
    // Counted once — presence of the band matters, not how many synonyms hit.
    score += weights.seniorityBoost;
    reasons.push(`right seniority band (${matchedBoosts.join(', ')})`);
  }

  // ── 3. Freshness — prefer the TRUE posting date over the scan date ──
  // postedDate (from the ATS payload) tells us when the role was actually
  // posted; firstSeen is just when our scanner first noticed it (≈ today for a
  // fresh batch). Use posting age when we have it, falling back to first-seen.
  const postedDate = parsePostingDate(posting?.postedDate);
  const freshnessDate = postedDate || posting?.firstSeen;
  const usingPostedDate = Boolean(postedDate);
  const bucket = freshnessBucket(freshnessDate, {
    now: opts.now || new Date(),
    freshDays: opts.freshDays,
    staleDays: opts.staleDays,
  });
  // When the date is the real posting date we can phrase it precisely; when we
  // only have first-seen, say "newly listed" so the user knows it's a scan
  // signal, not a confirmed post date.
  if (bucket === 'fresh') {
    score += weights.freshFresh;
    reasons.push(usingPostedDate ? 'freshly posted' : 'newly listed');
  } else if (bucket === 'recent') {
    score += weights.freshRecent;
    reasons.push(usingPostedDate ? 'posted recently' : 'recently listed');
  } else if (bucket === 'stale' && usingPostedDate) {
    // A confirmed-stale repost: it's been open past the stale window, so it's
    // likely been passed over by many already. Demote it. We only penalize when
    // we KNOW the post date — never punish a role merely for an old scan date.
    score += weights.staleRepost;
    reasons.push('stale repost (long open)');
  }

  // ── 4. Location specificity (named target city > country/remote/unknown) ──
  const loc = (posting?.location || '').trim().toLowerCase();
  let cityMatched = false;
  if (loc) {
    const allowlist = (opts.locationAllowlist && opts.locationAllowlist.length
      ? opts.locationAllowlist
      : DEFAULT_LOCATION_ALLOWLIST
    ).map((t) => t.trim().toLowerCase());
    for (const token of allowlist) {
      if (GENERIC_LOCATION_TOKENS.has(token) || COUNTRY_TOKENS.has(token)) continue;
      if (compileKeyword(token)(loc)) { cityMatched = true; break; }
    }
  }
  if (cityMatched) {
    score += weights.cityMatch;
    reasons.push('in a target city');
  }

  const signals = {
    positivePhrases: matchedPhrases.length,
    positiveWords: matchedWords.length,
    seniorityBoost: matchedBoosts.length > 0,
    freshness: bucket,
    // True when the freshness bucket came from a real ATS posting date rather
    // than the (≈today) scan date — lets callers trust the recency signal.
    postedDateKnown: usingPostedDate,
    cityMatch: cityMatched,
  };

  // Round to one decimal to keep the pipeline annotation tidy.
  return { score: Math.round(score * 10) / 10, reasons, signals };
}

/**
 * Rank a batch of surviving offers best-first by relevance score, stamping each
 * with `relevance` ({score, reasons, signals}). Stable for equal scores
 * (preserves input/fetch order), so ties read predictably.
 *
 * @param {Array<object>} offers postings that already cleared the filter funnel
 * @param {{positive?:string[], seniority_boost?:string[], relevance_weights?:object}} config
 *        the parsed portals.yml title_filter (+ optional relevance_weights)
 * @param {object} [opts] forwarded to scoreRelevance (now/freshDays/locationAllowlist…)
 * @returns {Array<object>} new array, sorted, each offer carrying `.relevance`
 */
export function rankOffers(offers, config = {}, opts = {}) {
  const weights = resolveRelevanceWeights(config?.relevance_weights);
  const scoreOpts = { ...opts, weights };
  const scored = (offers || []).map((offer, i) => ({
    offer,
    i,
    relevance: scoreRelevance(offer, config, scoreOpts),
  }));
  scored.sort((a, b) => (b.relevance.score - a.relevance.score) || (a.i - b.i));
  return scored.map(({ offer, relevance }) => ({ ...offer, relevance }));
}

/**
 * Compact one-line relevance annotation for the pipeline.md tail, e.g.
 *   "relevance 6.5 — matches 1 target phrase (Strategy & Operations), right
 *    seniority band (Intern), freshly posted, in a target city"
 * Returns '' when there's no signal worth showing.
 * @param {{score:number, reasons:string[]}} relevance
 */
export function formatRelevanceNote(relevance) {
  if (!relevance || typeof relevance.score !== 'number') return '';
  const reasons = relevance.reasons && relevance.reasons.length
    ? ` — ${relevance.reasons.join(', ')}`
    : '';
  return `relevance ${relevance.score.toFixed(1)}${reasons}`;
}
