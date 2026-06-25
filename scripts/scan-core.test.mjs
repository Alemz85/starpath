/**
 * scan-core.test.mjs — suite for the portal scanner's pure matching logic.
 *
 * Pins the funnel contract (title → language → location) and the freshness
 * helpers. The headline cases are the regression tests for the trailing-space
 * negative-keyword leak that let senior roles ("Operations Lead") slip into
 * the pipeline under the old String.includes() matcher.
 *
 * Run: node --test scripts/scan-core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keywordMatches,
  buildTitleFilter,
  buildLangFilter,
  buildLocationFilter,
  isAllowedLocation,
  ageInDays,
  freshnessBucket,
  DEFAULT_LOCATION_ALLOWLIST,
  scoreRelevance,
  rankOffers,
  resolveRelevanceWeights,
  formatRelevanceNote,
  DEFAULT_RELEVANCE_WEIGHTS,
} from './scan-core.mjs';

// ── keywordMatches: word-boundary semantics ───────────────────────────────

test('keywordMatches: standalone word matches at start/middle/end', () => {
  assert.equal(keywordMatches('Operations Lead', 'Lead'), true);
  assert.equal(keywordMatches('Lead, Strategy', 'Lead'), true);
  assert.equal(keywordMatches('Engineering Lead Role', 'Lead'), true);
  assert.equal(keywordMatches('Lead', 'Lead'), true);
});

test('keywordMatches: does NOT match inside another word', () => {
  assert.equal(keywordMatches('Leadership Analyst', 'Lead'), false);
  assert.equal(keywordMatches('Leading Indicators PM', 'Lead'), false);
  assert.equal(keywordMatches('Ambitious Analyst', 'BI'), false); // "BI" not inside "ambitious"
});

test('keywordMatches: case-insensitive', () => {
  assert.equal(keywordMatches('SENIOR ANALYST', 'senior'), true);
  assert.equal(keywordMatches('senior analyst', 'Senior'), true);
});

test('keywordMatches: trailing/leading spaces in the keyword are trimmed', () => {
  // The old portals.yml convention wrote "Senior " / "Lead " with trailing
  // spaces. After trimming, both keyword forms behave identically.
  assert.equal(keywordMatches('Operations Lead', 'Lead '), true);
  assert.equal(keywordMatches('Senior Analyst', ' Senior'), true);
});

test('keywordMatches: punctuation counts as a boundary (R&D, Pre-Sales, m/w/d)', () => {
  assert.equal(keywordMatches('R&D Analyst', 'R&D'), true);
  assert.equal(keywordMatches('Pre-Sales Engineer', 'Pre-Sales'), true);
  assert.equal(keywordMatches('Sales Manager (m/w/d)', '(m/w/d)'), true);
});

test('keywordMatches: multi-word phrase matched as a whole, whitespace-tolerant', () => {
  assert.equal(keywordMatches('Strategy & Operations Associate', 'Strategy & Operations'), true);
  // collapsed/extra internal whitespace still matches (\\s+ in the matcher)
  assert.equal(keywordMatches('Head  of   Growth', 'Head of'), true);
  assert.equal(keywordMatches('Heads of State', 'Head of'), false);
});

test('keywordMatches: empty inputs are safe', () => {
  assert.equal(keywordMatches('', 'Lead'), false);
  assert.equal(keywordMatches('Lead', ''), false);
  assert.equal(keywordMatches('Lead', '   '), false);
});

// ── buildTitleFilter: the regression for the senior-role leak ──────────────

test('REGRESSION: trailing-space negatives now catch end-of-title seniority', () => {
  const filter = buildTitleFilter({
    positive: ['Operations', 'Analyst', 'Engineer'],
    negative: ['Senior ', 'Lead ', 'Staff ', 'Head of'], // legacy trailing-space form
  });
  // These ALL leaked through under String.includes() — they must drop now.
  assert.equal(filter('Operations Lead'), false);
  assert.equal(filter('Lead, Strategy & Operations'), false);
  assert.equal(filter('Engineering Lead'), false);
  assert.equal(filter('Head of Operations'), false);
});

test('buildTitleFilter: legitimate junior titles still pass', () => {
  const filter = buildTitleFilter({
    positive: ['Operations', 'Analyst', 'Engineer'],
    negative: ['Senior ', 'Lead ', 'Staff '],
  });
  assert.equal(filter('Operations Analyst'), true);
  assert.equal(filter('Junior Data Analyst'), true);
  assert.equal(filter('Solutions Engineer'), true);
  // "Leadership" must NOT be killed by the "Lead" negative (no false positive)
  assert.equal(filter('Leadership Operations Analyst'), true);
});

test('buildTitleFilter: empty positive list means "any title with no negative"', () => {
  const filter = buildTitleFilter({ positive: [], negative: ['Senior'] });
  assert.equal(filter('Random Title'), true);
  assert.equal(filter('Senior Random'), false);
});

test('buildTitleFilter: a positive is required when the list is non-empty', () => {
  const filter = buildTitleFilter({ positive: ['Analyst'], negative: [] });
  assert.equal(filter('Marketing Manager'), false);
  assert.equal(filter('Data Analyst'), true);
});

test('buildTitleFilter: audit stats record drop reasons', () => {
  const auditStats = { negativeHits: {}, noPositiveMatch: 0 };
  const filter = buildTitleFilter(
    { positive: ['Analyst'], negative: ['Senior'] },
    auditStats,
  );
  filter('Marketing Manager');   // no positive
  filter('Senior Analyst');      // negative hit
  filter('Data Analyst');        // pass
  assert.equal(auditStats.noPositiveMatch, 1);
  assert.equal(auditStats.negativeHits['Senior'], 1);
});

test('buildTitleFilter: audit pre-seeds every negative keyword to 0', () => {
  const auditStats = { negativeHits: {}, noPositiveMatch: 0 };
  buildTitleFilter({ positive: [], negative: ['Tax', 'Audit'] }, auditStats);
  assert.equal(auditStats.negativeHits['Tax'], 0);
  assert.equal(auditStats.negativeHits['Audit'], 0);
});

test('buildTitleFilter: handles missing/undefined filter config', () => {
  const filter = buildTitleFilter(undefined);
  assert.equal(filter('Anything'), true); // no positives, no negatives → keep
  assert.equal(filter(''), true);
});

// ── buildLangFilter ────────────────────────────────────────────────────────

test('buildLangFilter: empty blocklist keeps everything', () => {
  const filter = buildLangFilter({ lang_blocklist: [] });
  assert.equal(filter('Werkstudent Analyst'), true);
  const filter2 = buildLangFilter({});
  assert.equal(filter2('anything'), true);
});

test('buildLangFilter: drops titles containing a blocklist token', () => {
  const filter = buildLangFilter({ lang_blocklist: ['werkstudent', 'alternance', '(m/w/d)'] });
  assert.equal(filter('Werkstudent Marketing'), false);
  assert.equal(filter('Analyst Alternance'), false);
  assert.equal(filter('Sales Manager (m/w/d)'), false);
  assert.equal(filter('Operations Analyst'), true);
});

test('buildLangFilter: word-aware — a token does not nuke an English substring', () => {
  // "stage" (FR/NL internship) should not kill "Staged Rollout Manager".
  const filter = buildLangFilter({ lang_blocklist: ['stage'] });
  assert.equal(filter('Staged Rollout Manager'), true);
  assert.equal(filter('Stage Marketing Paris'), false);
});

// ── buildLocationFilter ──────────────────────────────────────────────────────

test('buildLocationFilter: empty/unknown location passes (soft filter)', () => {
  const filter = buildLocationFilter();
  assert.equal(filter(''), true);
  assert.equal(filter('   '), true);
  assert.equal(filter(undefined), true);
});

test('buildLocationFilter: target geographies pass, others drop', () => {
  const filter = buildLocationFilter();
  assert.equal(filter('Barcelona, Spain'), true);
  assert.equal(filter('London, UK'), true);
  assert.equal(filter('Remote - Europe'), true);
  assert.equal(filter('Singapore'), false);
  assert.equal(filter('New York, NY'), false);
});

test('buildLocationFilter: "uk" is word-aware (no Paducah false positive)', () => {
  const filter = buildLocationFilter();
  assert.equal(filter('London, UK'), true);
  assert.equal(filter('Paducah, KY, USA'), false); // "uk" not inside "Paducah"
});

test('buildLocationFilter: user override replaces the default list', () => {
  const filter = buildLocationFilter(['dublin', 'remote']);
  assert.equal(filter('Dublin, Ireland'), true);
  assert.equal(filter('Remote'), true);
  assert.equal(filter('Berlin, Germany'), false); // not in the override list
});

test('isAllowedLocation back-compat wrapper matches the default filter', () => {
  assert.equal(isAllowedLocation('Madrid'), true);
  assert.equal(isAllowedLocation('Tokyo'), false);
  assert.equal(isAllowedLocation(''), true);
});

test('DEFAULT_LOCATION_ALLOWLIST is a non-empty generic EU/UK list', () => {
  assert.ok(Array.isArray(DEFAULT_LOCATION_ALLOWLIST));
  assert.ok(DEFAULT_LOCATION_ALLOWLIST.length > 10);
  assert.ok(DEFAULT_LOCATION_ALLOWLIST.includes('remote'));
});

// ── Freshness ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-25T12:00:00Z');

test('ageInDays: counts whole days since first_seen', () => {
  assert.equal(ageInDays('2026-06-25', NOW), 0);
  assert.equal(ageInDays('2026-06-20', NOW), 5);
  assert.equal(ageInDays('2026-05-26', NOW), 30);
});

test('ageInDays: unparseable input → null', () => {
  assert.equal(ageInDays('', NOW), null);
  assert.equal(ageInDays('not-a-date', NOW), null);
  assert.equal(ageInDays(undefined, NOW), null);
});

test('freshnessBucket: fresh / recent / stale boundaries', () => {
  assert.equal(freshnessBucket('2026-06-25', { now: NOW }), 'fresh');   // 0d
  assert.equal(freshnessBucket('2026-06-11', { now: NOW }), 'fresh');   // 14d (inclusive)
  assert.equal(freshnessBucket('2026-06-10', { now: NOW }), 'recent');  // 15d
  assert.equal(freshnessBucket('2026-03-27', { now: NOW }), 'recent');  // 90d (inclusive)
  assert.equal(freshnessBucket('2026-03-26', { now: NOW }), 'stale');   // 91d
});

test('freshnessBucket: future-dated → fresh, unparseable → unknown', () => {
  assert.equal(freshnessBucket('2026-07-01', { now: NOW }), 'fresh');
  assert.equal(freshnessBucket('garbage', { now: NOW }), 'unknown');
});

test('freshnessBucket: custom thresholds respected', () => {
  assert.equal(freshnessBucket('2026-06-18', { now: NOW, freshDays: 7 }), 'fresh');   // 7d
  assert.equal(freshnessBucket('2026-06-17', { now: NOW, freshDays: 7 }), 'recent');  // 8d
});

// ── Relevance ranking ─────────────────────────────────────────────────────────
//
// scoreRelevance / rankOffers turn the binary "keep" into a transparent, ranked
// score so the strongest matches surface first in the pipeline. These pin the
// scoring contract (each signal's contribution), the phrase>word weighting, the
// finally-wired seniority_boost, weight overrides + their fail-safe, and stable
// best-first ordering.

// A representative title_filter (system-layer shape, not user data): mixes a
// single-word positive, a multi-word positive phrase, and a seniority-boost list.
const TF = {
  positive: ['Operations', 'Analyst', 'Strategy & Operations'],
  seniority_boost: ['Junior', 'Intern', 'Associate'],
};

test('resolveRelevanceWeights: defaults when no override', () => {
  assert.deepEqual(resolveRelevanceWeights(undefined), DEFAULT_RELEVANCE_WEIGHTS);
  assert.deepEqual(resolveRelevanceWeights({}), DEFAULT_RELEVANCE_WEIGHTS);
});

test('resolveRelevanceWeights: valid overrides merge; junk falls back per-key', () => {
  const w = resolveRelevanceWeights({
    positiveWord: 3,        // valid override
    seniorityBoost: -5,     // negative → rejected, keep default
    freshFresh: 'high',     // wrong type → rejected, keep default
    bogusKey: 99,           // unknown key → ignored
  });
  assert.equal(w.positiveWord, 3);
  assert.equal(w.seniorityBoost, DEFAULT_RELEVANCE_WEIGHTS.seniorityBoost);
  assert.equal(w.freshFresh, DEFAULT_RELEVANCE_WEIGHTS.freshFresh);
  assert.equal(w.bogusKey, undefined);
});

test('scoreRelevance: a single-word positive contributes positiveWord', () => {
  // "Operations Analyst" matches words "Operations" + "Analyst" (2 × 1.0),
  // no phrase, no boost, no city, unknown freshness (no firstSeen).
  const r = scoreRelevance({ title: 'Operations Analyst' }, TF, { now: NOW });
  assert.equal(r.signals.positiveWords, 2);
  assert.equal(r.signals.positivePhrases, 0);
  assert.equal(r.score, 2.0);
  assert.ok(r.reasons.some(x => x.includes('target keyword')));
});

test('scoreRelevance: a multi-word phrase outscores the same lone word', () => {
  // "Strategy & Operations" matches the PHRASE (2.0) AND the word "Operations" (1.0).
  const r = scoreRelevance({ title: 'Strategy & Operations Associate' }, TF, { now: NOW });
  assert.equal(r.signals.positivePhrases, 1);
  // word "Operations" also matches; "Associate" is a seniority boost not a positive here
  assert.equal(r.signals.positiveWords, 1);
  assert.equal(r.signals.seniorityBoost, true);
  // 2.0 (phrase) + 1.0 (word) + 2.5 (boost) = 5.5
  assert.equal(r.score, 5.5);
});

test('scoreRelevance: seniority_boost is finally wired up (counted once)', () => {
  const tf = { positive: ['Analyst'], seniority_boost: ['Junior', 'Intern'] };
  // Both "Junior" and "Intern" present, but the band bonus counts once.
  const r = scoreRelevance({ title: 'Junior Intern Analyst' }, tf, { now: NOW });
  assert.equal(r.signals.seniorityBoost, true);
  // 1.0 (Analyst word) + 2.5 (boost, once) = 3.5
  assert.equal(r.score, 3.5);
  const noBoost = scoreRelevance({ title: 'Analyst' }, tf, { now: NOW });
  assert.equal(noBoost.signals.seniorityBoost, false);
  assert.equal(noBoost.score, 1.0);
});

test('scoreRelevance: freshness adds fresh > recent > (stale/unknown = 0)', () => {
  const tf = { positive: ['Analyst'] };
  const fresh = scoreRelevance({ title: 'Analyst', firstSeen: '2026-06-25' }, tf, { now: NOW });
  const recent = scoreRelevance({ title: 'Analyst', firstSeen: '2026-05-01' }, tf, { now: NOW });
  const stale = scoreRelevance({ title: 'Analyst', firstSeen: '2026-01-01' }, tf, { now: NOW });
  assert.equal(fresh.signals.freshness, 'fresh');
  assert.equal(recent.signals.freshness, 'recent');
  assert.equal(stale.signals.freshness, 'stale');
  // 1.0 base + freshness contribution (1.5 / 0.5 / 0)
  assert.equal(fresh.score, 2.5);
  assert.equal(recent.score, 1.5);
  assert.equal(stale.score, 1.0);
});

test('scoreRelevance: a named target city scores; country/remote/unknown do not', () => {
  const tf = { positive: ['Analyst'] };
  const city = scoreRelevance({ title: 'Analyst', location: 'Barcelona, Spain' }, tf, { now: NOW });
  const country = scoreRelevance({ title: 'Analyst', location: 'Spain' }, tf, { now: NOW });
  const remote = scoreRelevance({ title: 'Analyst', location: 'Remote - Europe' }, tf, { now: NOW });
  const unknown = scoreRelevance({ title: 'Analyst', location: '' }, tf, { now: NOW });
  assert.equal(city.signals.cityMatch, true);
  assert.equal(country.signals.cityMatch, false); // "Spain" is country-level only
  assert.equal(remote.signals.cityMatch, false);  // "Remote"/"Europe" are generic
  assert.equal(unknown.signals.cityMatch, false);
  assert.equal(city.score, 2.0);   // 1.0 base + 1.0 city
  assert.equal(country.score, 1.0);
});

test('scoreRelevance: custom weights flow through', () => {
  const tf = { positive: ['Analyst'] };
  const weights = resolveRelevanceWeights({ positiveWord: 10 });
  const r = scoreRelevance({ title: 'Analyst' }, tf, { now: NOW, weights });
  assert.equal(r.score, 10);
});

test('scoreRelevance: empty title is safe (no signal, score 0)', () => {
  const r = scoreRelevance({ title: '' }, TF, { now: NOW });
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, []);
});

test('rankOffers: orders best-first and stamps .relevance on each', () => {
  const offers = [
    { url: 'u1', company: 'C', title: 'Marketing Operations', location: 'Remote' },        // weak: 1 word
    { url: 'u2', company: 'C', title: 'Strategy & Operations Intern', location: 'Berlin' }, // strong: phrase+word+boost+city
    { url: 'u3', company: 'C', title: 'Junior Analyst', location: 'Spain' },                // mid: word+boost
  ];
  const ranked = rankOffers(offers, TF, { now: NOW });
  assert.deepEqual(ranked.map(o => o.url), ['u2', 'u3', 'u1']);
  // original fields preserved + relevance attached
  assert.equal(ranked[0].company, 'C');
  assert.ok(ranked[0].relevance.score > ranked[1].relevance.score);
  assert.ok(ranked[1].relevance.score > ranked[2].relevance.score);
});

test('rankOffers: stable for equal scores (preserves fetch order)', () => {
  const offers = [
    { url: 'a', company: 'C', title: 'Operations Analyst' },
    { url: 'b', company: 'C', title: 'Analyst Operations' }, // same two words → same score
  ];
  const ranked = rankOffers(offers, TF, { now: NOW });
  assert.equal(ranked[0].relevance.score, ranked[1].relevance.score);
  assert.deepEqual(ranked.map(o => o.url), ['a', 'b']); // input order kept on tie
});

test('rankOffers: reads relevance_weights from config', () => {
  const offers = [{ url: 'a', company: 'C', title: 'Analyst' }];
  const cfg = { positive: ['Analyst'], relevance_weights: { positiveWord: 7 } };
  const ranked = rankOffers(offers, cfg, { now: NOW });
  assert.equal(ranked[0].relevance.score, 7);
});

test('rankOffers: empty / missing input is safe', () => {
  assert.deepEqual(rankOffers([], TF, { now: NOW }), []);
  assert.deepEqual(rankOffers(undefined, TF, { now: NOW }), []);
});

test('formatRelevanceNote: renders score + reasons; empty when no relevance', () => {
  const r = scoreRelevance({ title: 'Strategy & Operations Intern', location: 'Berlin', firstSeen: '2026-06-25' }, TF, { now: NOW });
  const note = formatRelevanceNote(r);
  assert.ok(note.startsWith('relevance '));
  assert.ok(note.includes('target phrase'));
  assert.ok(note.includes('right seniority band'));
  assert.ok(note.includes('in a target city'));
  assert.equal(formatRelevanceNote(undefined), '');
  assert.equal(formatRelevanceNote({}), '');
  // a zero-signal score still renders the number (so the pipeline shows "relevance 0.0")
  assert.equal(formatRelevanceNote({ score: 0, reasons: [] }), 'relevance 0.0');
});
