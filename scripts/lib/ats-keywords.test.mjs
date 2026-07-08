/**
 * ats-keywords.test.mjs — suite for the ATS keyword extractor + coverage scorer.
 *
 * These pin the contract the CV-tailoring flow relies on:
 *   - extractKeywords drops stopwords/boilerplate, keeps real terms, and
 *     recognises multi-word phrases as single keywords.
 *   - analyzeCoverage matches stem-lite variants and multi-word phrases, and
 *     reports a coverage % + the missing-keyword gap list.
 *   - htmlToText strips a CV HTML document down to its visible text.
 *
 * Fixtures are fictional/illustrative (no real user data), per system-layer
 * hygiene. Run: node --test scripts/lib/ats-keywords.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKeywords,
  analyzeCoverage,
  htmlToText,
  stemLite,
} from './ats-keywords.mjs';

const terms = (ks) => ks.map((k) => k.term);

// ── stemLite ───────────────────────────────────────────────────────────────
test('stemLite folds common English variants together', () => {
  assert.equal(stemLite('pipelines'), stemLite('pipeline'));
  assert.equal(stemLite('designing'), stemLite('design'));
  assert.equal(stemLite('models'), stemLite('model'));
  assert.equal(stemLite('shipped'), stemLite('ship'));
});

test('stemLite leaves short tokens and double-s words intact', () => {
  assert.equal(stemLite('css'), 'css');
  assert.equal(stemLite('sql'), 'sql');
  assert.equal(stemLite('class'), 'class'); // not "clas"
});

// ── extractKeywords: stopwords + boilerplate ────────────────────────────────
test('extractKeywords drops function words and recruiting boilerplate', () => {
  const jd =
    'We are looking for a candidate with strong experience to join our team. ' +
    'You will build data pipelines and design machine learning systems.';
  const got = terms(extractKeywords(jd));
  for (const noise of ['we', 'are', 'looking', 'candidate', 'strong', 'experience', 'team', 'join']) {
    assert.ok(!got.includes(noise), `should drop boilerplate "${noise}" (got ${got.join(', ')})`);
  }
  // real content terms survive
  assert.ok(got.includes('pipelines') || got.includes('pipeline'), 'keeps "pipeline(s)"');
});

test('extractKeywords recognises a known multi-word phrase as one keyword', () => {
  const jd =
    'Build machine learning models. Strong machine learning background required. ' +
    'Machine learning is core to this role.';
  const ks = extractKeywords(jd);
  const ml = ks.find((k) => k.term === 'machine learning');
  assert.ok(ml, 'should surface "machine learning" as a phrase');
  assert.equal(ml.type, 'phrase');
  assert.equal(ml.count, 3);
  // the unigrams "machine"/"learning" should NOT separately appear
  assert.ok(!terms(ks).includes('machine'), 'no standalone "machine"');
  assert.ok(!terms(ks).includes('learning'), 'no standalone "learning"');
});

test('extractKeywords ranks more frequent terms higher', () => {
  const jd =
    'kubernetes kubernetes kubernetes kubernetes orchestration. ' +
    'Some terraform here for infra.';
  const ks = extractKeywords(jd);
  assert.equal(ks[0].term, 'kubernetes', 'most frequent term ranks first');
  assert.ok(ks[0].count >= 4);
});

test('extractKeywords respects the limit option', () => {
  const jd = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
  assert.equal(extractKeywords(jd, { limit: 5 }).length, 5);
});

test('extractKeywords preserves symbol-bearing tech tokens', () => {
  const jd = 'Experience with C++ and C# and Node.js and CI/CD pipelines required.';
  const got = terms(extractKeywords(jd));
  assert.ok(got.includes('c++'), `kept c++ (got ${got.join(', ')})`);
  assert.ok(got.includes('c#'), 'kept c#');
});

test('extractKeywords returns [] for empty input', () => {
  assert.deepEqual(extractKeywords(''), []);
  assert.deepEqual(extractKeywords('   '), []);
});

// ── analyzeCoverage ─────────────────────────────────────────────────────────
test('analyzeCoverage detects a fully-covered CV', () => {
  const jd = 'Need kubernetes and terraform and python skills.';
  const cv = 'I have built systems with kubernetes, terraform, and python daily.';
  const r = analyzeCoverage(jd, cv);
  assert.equal(r.missing.length, 0);
  assert.equal(r.coveragePct, 100);
  assert.equal(r.coverage, 1);
});

test('analyzeCoverage reports missing keywords as the gap list', () => {
  const jd = 'Need kubernetes and terraform and graphql experience.';
  const cv = 'I have built systems with kubernetes only.';
  const r = analyzeCoverage(jd, cv);
  const missing = terms(r.missing);
  assert.ok(missing.includes('terraform'), 'terraform flagged missing');
  assert.ok(missing.includes('graphql'), 'graphql flagged missing');
  assert.ok(!terms(r.covered).includes('terraform'));
  assert.ok(r.coveragePct < 100 && r.coveragePct > 0);
});

test('analyzeCoverage matches stem-lite variants (plural/gerund)', () => {
  const jd = 'Design and own data pipelines end to end.';
  // CV uses singular "pipeline" and "designing" — must still count as covered
  const cv = 'Designing a single data pipeline for the analytics platform.';
  const r = analyzeCoverage(jd, cv);
  const missing = terms(r.missing);
  assert.ok(!missing.includes('pipelines'), '"pipelines" should match CV "pipeline"');
  assert.ok(!missing.includes('design'), '"design" should match CV "designing"');
});

test('analyzeCoverage matches a multi-word phrase present in the CV', () => {
  const jd = 'Strong machine learning and product management background.';
  const cv = 'Led machine learning projects and owned product management roadmaps.';
  const r = analyzeCoverage(jd, cv);
  assert.equal(r.missing.length, 0, `expected full coverage, missing: ${terms(r.missing)}`);
});

test('analyzeCoverage flags a phrase the CV lacks even if one word is present', () => {
  const jd = 'Need stakeholder management experience.';
  const cv = 'I managed budgets but did not own stakeholders directly.';
  const r = analyzeCoverage(jd, cv);
  assert.ok(terms(r.missing).includes('stakeholder management'),
    'phrase should be missing when the adjacency is absent');
});

// Regression (audit finding 5): the raw-phrase fallback used
// idx.raw.includes(term) with no word boundary, so a glued compound in the CV
// ("nonrisk management") falsely covered the JD phrase "risk management".
test('analyzeCoverage does NOT cover a phrase glued inside a CV compound word', () => {
  const jd = 'Strong risk management experience required.';
  const cv = 'I ran a nonrisk management program for internal audits.';
  const r = analyzeCoverage(jd, cv);
  assert.ok(terms(r.missing).includes('risk management'),
    '"risk management" must be missing — "nonrisk management" is a different phrase');
  assert.ok(!terms(r.covered).includes('risk management'));
});

// The same fallback must still credit a legitimate, standalone phrase match.
test('analyzeCoverage still covers a legitimate multi-word phrase (word-boundary)', () => {
  const jd = 'Strong risk management experience required.';
  const cv = 'I led risk management across the portfolio.';
  const r = analyzeCoverage(jd, cv);
  assert.ok(terms(r.covered).includes('risk management'),
    'standalone "risk management" in the CV must count as covered');
  assert.ok(!terms(r.missing).includes('risk management'));
});

test('analyzeCoverage exposes weightedCoverage favouring frequent keywords', () => {
  const jd = 'python python python python graphql.'; // python heavily weighted
  const cvHasPython = analyzeCoverage(jd, 'all about python here');
  const cvHasGraphql = analyzeCoverage(jd, 'all about graphql here');
  assert.ok(
    cvHasPython.weightedCoverage > cvHasGraphql.weightedCoverage,
    'covering the high-frequency keyword should weigh more',
  );
});

test('analyzeCoverage handles empty CV gracefully', () => {
  const r = analyzeCoverage('python and sql required', '');
  assert.equal(r.coveragePct, 0);
  assert.equal(r.covered.length, 0);
  assert.ok(r.total > 0);
});

// ── htmlToText ───────────────────────────────────────────────────────────────
test('htmlToText strips tags, styles, scripts and decodes entities', () => {
  const html = `<!DOCTYPE html><html><head><style>.x{color:red}</style>
    <script>var a = 1 < 2;</script></head>
    <body><h1>Jane&nbsp;Doe</h1><p>Built ML &amp; data systems</p></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('Jane Doe'));
  assert.ok(text.includes('Built ML & data systems'));
  assert.ok(!text.includes('color:red'), 'style contents removed');
  assert.ok(!text.includes('var a'), 'script contents removed');
  assert.ok(!text.includes('<'), 'no leftover tags');
});

test('htmlToText feeds cleanly into analyzeCoverage', () => {
  const jd = 'Need python and kubernetes skills.';
  const cvHtml = '<body><ul><li>Shipped <strong>python</strong> services on kubernetes</li></ul></body>';
  const r = analyzeCoverage(jd, htmlToText(cvHtml));
  assert.equal(r.coveragePct, 100);
});
