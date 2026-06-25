// Unit tests for scripts/lib/cv-gap.mjs — pure CV-vs-target-landscape gap
// analysis. cv-gap.mjs imports (never modifies) ats-keywords (keyword
// extraction + stemLite) and targeting-core (dimensionDrag); this suite pins
// the new logic on top: demand aggregation by document-frequency, keyword-gap
// intersection with the CV stem index, the achievement-bullet / quantified-
// outcome heuristics, dimension-gap framing, and the recommendation gates.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCvIndex,
  termInCv,
  aggregateDemand,
  keywordGaps,
  extractBullets,
  isQuantified,
  weakProofPoints,
  dimensionGaps,
  gapRecommendations,
  analyzeCvGap,
} from './cv-gap.mjs';

// ── buildCvIndex / termInCv ────────────────────────────────────────────────

test('termInCv matches a unigram through stem-lite folding', () => {
  const idx = buildCvIndex('Designed and shipped data pipelines for analytics.');
  assert.equal(termInCv('design', idx), true); // designed → design
  assert.equal(termInCv('pipeline', idx), true); // pipelines → pipeline
  assert.equal(termInCv('kubernetes', idx), false);
});

test('termInCv matches a multi-word term via stem-bigram', () => {
  const idx = buildCvIndex('Experience with machine learning models in production.');
  assert.equal(termInCv('machine learning', idx), true);
  assert.equal(termInCv('deep learning', idx), false);
});

test('termInCv matches a verbatim multi-word phrase', () => {
  const idx = buildCvIndex('Strong stakeholder management across teams.');
  assert.equal(termInCv('stakeholder management', idx), true);
});

// ── aggregateDemand ────────────────────────────────────────────────────────

test('aggregateDemand counts a term in how many distinct roles demand it', () => {
  const docs = [
    'We need strong SQL and Python for data analysis. SQL SQL SQL.',
    'SQL and dashboards. SQL is core.',
    'Python and machine learning, no database query language here.',
  ];
  const demand = aggregateDemand(docs);
  const sql = demand.find((d) => d.term.startsWith('sql'));
  assert.ok(sql, 'sql should be aggregated');
  assert.equal(sql.documentFrequency, 2); // appears in 2 of 3 docs
  assert.equal(sql.share, 67); // 2/3 → 67%
  // totalCount sums raw frequency across docs (>= documentFrequency)
  assert.ok(sql.totalCount >= sql.documentFrequency);
});

test('aggregateDemand sorts by documentFrequency desc', () => {
  const docs = [
    'python sql tableau',
    'python sql',
    'python',
  ];
  const demand = aggregateDemand(docs);
  // python in all 3, sql in 2, tableau in 1
  assert.equal(demand[0].term.split(/\s+/)[0], 'python');
  assert.equal(demand[0].documentFrequency, 3);
});

test('aggregateDemand returns [] for empty/blank input', () => {
  assert.deepEqual(aggregateDemand([]), []);
  assert.deepEqual(aggregateDemand(['', '   ']), []);
  assert.deepEqual(aggregateDemand(null), []);
});

// ── keywordGaps ────────────────────────────────────────────────────────────

test('keywordGaps surfaces demanded terms absent from the CV, ranked by reach', () => {
  const cv = 'Analyst skilled in Python and Excel reporting.';
  const docs = [
    'Need SQL and Tableau for analytics. SQL Tableau.',
    'SQL and Tableau dashboards required. SQL.',
    'SQL pipelines and Tableau. SQL Tableau.',
  ];
  const res = keywordGaps(cv, docs, { minRoles: 2 });
  const terms = res.gaps.map((g) => g.term.split(/\s+/)[0]);
  assert.ok(terms.includes('sql'), 'sql is demanded by 3 roles, absent from CV');
  assert.ok(terms.includes('tableau'), 'tableau is demanded, absent from CV');
  // python IS in the CV → never a gap
  assert.ok(!terms.includes('python'));
  assert.equal(res.totalRoles, 3);
});

test('keywordGaps honors minRoles — a term in only one role is not a systematic gap', () => {
  const cv = 'Generalist analyst.';
  const docs = [
    'rust systems programming', // rust only here
    'sql analytics',
    'sql reporting',
  ];
  const res = keywordGaps(cv, docs, { minRoles: 2 });
  const terms = res.gaps.map((g) => g.term.split(/\s+/)[0]);
  assert.ok(!terms.includes('rust'), 'rust appears in only 1 role → below minRoles');
  assert.ok(terms.includes('sql'), 'sql appears in 2 roles → a gap');
});

test('keywordGaps reports coverage of the demanded vocabulary', () => {
  const cv = 'Python SQL Tableau expert.';
  const docs = ['python sql tableau', 'python sql tableau'];
  const res = keywordGaps(cv, docs, { minRoles: 1 });
  assert.equal(res.gaps.length, 0, 'CV covers all demanded terms');
  assert.equal(res.coveragePct, 100);
});

// ── extractBullets / quantification ────────────────────────────────────────

test('extractBullets pulls markdown bullets and strips markers + emphasis', () => {
  const cv = [
    '# Experience',
    '- **Led** a team of 5 engineers',
    '* Improved onboarding flow',
    '1. Shipped the analytics dashboard',
    'Not a bullet line',
    '- tiny', // too short, dropped
  ].join('\n');
  const bullets = extractBullets(cv);
  assert.equal(bullets.length, 3);
  assert.equal(bullets[0], 'Led a team of 5 engineers');
  assert.ok(!bullets.some((b) => b === 'tiny'));
});

test('isQuantified detects numbers, percents, currency, multipliers, time', () => {
  assert.equal(isQuantified('Cut onboarding time 40%'), true);
  assert.equal(isQuantified('Saved €120k annually'), true);
  assert.equal(isQuantified('Tripled throughput 3x'), true);
  assert.equal(isQuantified('Reduced build time by 2 hours'), true);
  assert.equal(isQuantified('Improved the onboarding experience'), false);
  assert.equal(isQuantified('Led the migration effort'), false);
});

test('weakProofPoints flags achievement bullets with no metric', () => {
  const cv = [
    '- Led a redesign of the onboarding flow', // achievement, no number → weak
    '- Increased signups 35% in two quarters', // quantified → strong
    '- Responsible for data pipelines', // not an impact verb up front → ignored
    '- Reduced churn by 12%', // quantified
  ].join('\n');
  const res = weakProofPoints(cv);
  assert.equal(res.achievementBullets, 3); // led, increased, reduced
  assert.equal(res.quantifiedCount, 2);
  assert.equal(res.quantifiedPct, 67);
  assert.equal(res.weak.length, 1);
  assert.match(res.weak[0].text, /redesign of the onboarding/);
});

test('weakProofPoints ignores non-achievement lines (no false nagging)', () => {
  const cv = [
    '- Python, SQL, Tableau, Excel', // skills list, no impact verb
    '- Based in City, Country', // descriptive
  ].join('\n');
  const res = weakProofPoints(cv);
  assert.equal(res.achievementBullets, 0);
  assert.equal(res.weak.length, 0);
});

// ── dimensionGaps (over targeting-core's dimensionDrag) ─────────────────────

const SCORE_HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
];

// Build score rows directly as objects (dimensionDrag reads .skills_match etc.)
function scoreRow(over = {}) {
  const base = {
    skills_match: 4, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8, overall: 7,
  };
  return { ...base, ...over };
}

test('dimensionGaps surfaces only the systematically low dimensions', () => {
  const rows = [scoreRow(), scoreRow(), scoreRow()]; // skills+ease low (avg 4)
  const gaps = dimensionGaps(rows, { avgThreshold: 6.0 });
  const keys = gaps.map((g) => g.key);
  assert.ok(keys.includes('skills_match'));
  assert.ok(keys.includes('ease_of_entry'));
  assert.ok(!keys.includes('strategic_fit'), 'strategic_fit avg 8 is not a gap');
});

test('dimensionGaps marks skills_match as the one CV-actionable dimension', () => {
  const rows = [scoreRow(), scoreRow()];
  const gaps = dimensionGaps(rows, { avgThreshold: 6.0 });
  const skills = gaps.find((g) => g.key === 'skills_match');
  const ease = gaps.find((g) => g.key === 'ease_of_entry');
  assert.equal(skills.cvActionable, true);
  assert.equal(ease.cvActionable, false);
});

test('dimensionGaps returns [] when no dimension drags', () => {
  const rows = [scoreRow({ skills_match: 8, ease_of_entry: 8 })];
  assert.deepEqual(dimensionGaps(rows, { avgThreshold: 6.0 }), []);
});

// ── gapRecommendations ─────────────────────────────────────────────────────

test('gapRecommendations fires a keyword rec only for broadly-demanded gaps', () => {
  const report = {
    keyword: { totalRoles: 10, gaps: [
      { term: 'sql', documentFrequency: 6, share: 60 },
      { term: 'spark', documentFrequency: 1, share: 10 }, // below minRolesForKeyword
    ] },
    proof: { achievementBullets: 2, quantifiedPct: 100, weak: [] },
    dimension: [],
  };
  const recs = gapRecommendations(report, { minRolesForKeyword: 3 });
  const kw = recs.find((r) => r.action.includes('systematically-demanded'));
  assert.ok(kw, 'a keyword rec should fire');
  assert.match(kw.action, /sql/);
  assert.ok(!kw.action.includes('spark'), 'thin-demand term excluded');
  assert.equal(kw.impact, 'high'); // 6 >= max(5, 10*0.5=5)
});

test('gapRecommendations fires a proof rec when quantification is low', () => {
  const report = {
    keyword: { totalRoles: 5, gaps: [] },
    proof: { achievementBullets: 6, quantifiedPct: 33, weak: [{ text: 'x' }, { text: 'y' }] },
    dimension: [],
  };
  const recs = gapRecommendations(report);
  const p = recs.find((r) => r.action.includes('Quantify'));
  assert.ok(p);
  assert.equal(p.impact, 'high'); // < 40%
});

test('gapRecommendations separates CV-fixable skills drag from targeting drags', () => {
  const report = {
    keyword: { totalRoles: 5, gaps: [] },
    proof: { achievementBullets: 0, quantifiedPct: 0, weak: [] },
    dimension: [
      { key: 'skills_match', label: 'Skills Match', avg: 4, lowShare: 50, cvActionable: true, hint: 'h' },
      { key: 'brand_value', label: 'Brand Value', avg: 5, lowShare: 30, cvActionable: false, hint: 'h' },
    ],
  };
  const recs = gapRecommendations(report);
  assert.ok(recs.some((r) => r.action.includes('Skills Match') && r.action.includes('drag')));
  assert.ok(recs.some((r) => r.action.includes('targeting/sourcing fixes')));
});

// ── analyzeCvGap (end-to-end) ──────────────────────────────────────────────

test('analyzeCvGap errors without a CV', () => {
  const res = analyzeCvGap({ cvText: '', demandDocs: ['sql'] });
  assert.ok(res.error);
});

test('analyzeCvGap errors without any landscape signal', () => {
  const res = analyzeCvGap({ cvText: 'My CV', demandDocs: [], scoreRows: [] });
  assert.ok(res.error);
});

test('analyzeCvGap produces a full report from CV + demand + scores', () => {
  const cv = [
    '# CV',
    '- Led onboarding redesign', // weak proof
    '- Built dashboards in Python and Excel',
  ].join('\n');
  const docs = [
    'SQL and Tableau analytics. SQL Tableau SQL.',
    'SQL and Tableau reporting. SQL Tableau.',
    'SQL pipelines, Tableau dashboards. SQL Tableau.',
  ];
  const scoreRows = [scoreRow(), scoreRow(), scoreRow()];
  const res = analyzeCvGap({ cvText: cv, demandDocs: docs, scoreRows });
  assert.equal(res.metadata.rolesAnalyzed, 3);
  // keyword gaps present (sql, tableau)
  const gapTerms = res.keyword.gaps.map((g) => g.term.split(/\s+/)[0]);
  assert.ok(gapTerms.includes('sql'));
  // proof weakness detected
  assert.ok(res.proof.weak.length >= 1);
  // dimension gaps include skills_match
  assert.ok(res.dimension.some((d) => d.key === 'skills_match'));
  // recommendations assembled
  assert.ok(res.recommendations.length >= 1);
});

// ── buildCvIndex: empty / null input ────────────────────────────────────────

test('buildCvIndex with empty string → empty index (no crash)', () => {
  const idx = buildCvIndex('');
  assert.equal(idx.stems.size, 0);
  assert.equal(idx.bigrams.size, 0);
  assert.equal(idx.raw, '');
});

test('buildCvIndex with null → empty index (no crash)', () => {
  const idx = buildCvIndex(null);
  assert.equal(idx.stems.size, 0);
});

// ── termInCv: special programming language tokens ────────────────────────────

test('termInCv matches c++ via cplusplus normalization', () => {
  const idx = buildCvIndex('Experienced in C++ and systems programming.');
  assert.equal(termInCv('c++', idx), true);
});

test('termInCv matches c# via csharp normalization', () => {
  const idx = buildCvIndex('Built services in C# and .NET.');
  assert.equal(termInCv('c#', idx), true);
  assert.equal(termInCv('.net', idx), true);
});

test('termInCv: empty term → false (no crash)', () => {
  const idx = buildCvIndex('Some text here.');
  assert.equal(termInCv('', idx), false);
});

// ── aggregateDemand: options ──────────────────────────────────────────────────

test('aggregateDemand respects perDocLimit (fewer keywords extracted per doc)', () => {
  // With perDocLimit=1, each doc contributes only its top-1 keyword.
  const docs = ['python sql tableau excel pandas', 'python sql tableau excel pandas'];
  const demand = aggregateDemand(docs, { perDocLimit: 1 });
  // At most 1 unique keyword (the top one) × 2 docs = docFreq 2 for that term;
  // other terms should be absent or have very low doc freq.
  assert.ok(demand.length >= 1);
  assert.ok(demand.length < 5, 'perDocLimit=1 should suppress most keywords');
});

test('aggregateDemand: single-doc corpus, share is 100 for any extracted term', () => {
  const docs = ['python python python'];
  const demand = aggregateDemand(docs);
  assert.ok(demand.length > 0);
  assert.equal(demand[0].share, 100);
  assert.equal(demand[0].documentFrequency, 1);
});

// ── keywordGaps: empty CV + limit option ─────────────────────────────────────

test('keywordGaps with empty CV string → all demanded terms are gaps', () => {
  const res = keywordGaps('', ['sql python tableau', 'sql python tableau'], { minRoles: 1 });
  // Every term is demanded and the CV is empty → all are gaps.
  assert.ok(res.gaps.length > 0);
  assert.equal(res.coveragePct, 0);
});

test('keywordGaps limit option caps the returned gaps list', () => {
  // Build a CV with nothing and lots of demanded terms, request limit=2.
  const docs = Array.from({ length: 3 }, () =>
    'sql python tableau excel pandas spark dbt airflow kubernetes docker');
  const res = keywordGaps('', docs, { minRoles: 2, limit: 2 });
  assert.ok(res.gaps.length <= 2, `limit should cap gaps, got ${res.gaps.length}`);
});

test('keywordGaps with null demandDocs → 0 gaps, 0 roles', () => {
  const res = keywordGaps('My CV', null);
  assert.equal(res.totalRoles, 0);
  assert.equal(res.gaps.length, 0);
  assert.equal(res.coveragePct, 0);
});

// ── extractBullets: bullet marker varieties ───────────────────────────────────

test('extractBullets handles • bullet marker', () => {
  const cv = '• Led the migration to cloud infrastructure\n• Updated reporting pipelines';
  const bullets = extractBullets(cv);
  assert.equal(bullets.length, 2);
  assert.ok(bullets[0].startsWith('Led'));
});

test('extractBullets with empty string → [] (no crash)', () => {
  assert.deepEqual(extractBullets(''), []);
  assert.deepEqual(extractBullets(null), []);
});

test('extractBullets strips bold/italic/code emphasis from bullet text', () => {
  const cv = '- **Built** a `real-time` _data_ pipeline';
  const bullets = extractBullets(cv);
  assert.equal(bullets.length, 1);
  assert.equal(bullets[0], 'Built a real-time data pipeline');
});

// ── isQuantified: additional token coverage ──────────────────────────────────

test('isQuantified: "billion" and "million" and "thousand" are quantified', () => {
  assert.equal(isQuantified('Generated $2 billion in savings'), true);
  assert.equal(isQuantified('Reached 1 million users'), true);
  assert.equal(isQuantified('Saved 50 thousand engineering hours'), true);
});

test('isQuantified: standalone "k" suffix is quantified', () => {
  assert.equal(isQuantified('Reduced costs by 200k'), true);
});

test('isQuantified: weeks and months are quantified time deltas', () => {
  assert.equal(isQuantified('Shipped in 3 weeks'), true);
  assert.equal(isQuantified('Reduced delivery from 6 months to 1'), true);
});

// ── weakProofPoints: empty + limit ───────────────────────────────────────────

test('weakProofPoints with empty CV → zero everything (no crash)', () => {
  const res = weakProofPoints('');
  assert.equal(res.totalBullets, 0);
  assert.equal(res.achievementBullets, 0);
  assert.equal(res.quantifiedPct, 0);
  assert.equal(res.weak.length, 0);
});

test('weakProofPoints limit option caps the weak bullets list', () => {
  const cv = Array.from({ length: 10 },
    (_, i) => `- Led initiative ${i + 1} without any metric`
  ).join('\n');
  const res = weakProofPoints(cv, { limit: 3 });
  assert.ok(res.weak.length <= 3);
  assert.ok(res.achievementBullets >= 3);
});

test('weakProofPoints: all bullets quantified → weak=[], quantifiedPct=100', () => {
  const cv = [
    '- Increased revenue by 25%',
    '- Reduced latency by 100ms',
    '- Grew team from 3 to 10 engineers',
  ].join('\n');
  const res = weakProofPoints(cv);
  assert.equal(res.weak.length, 0);
  assert.equal(res.quantifiedPct, 100);
});

// ── dimensionGaps: lowShareThreshold trigger + empty rows ────────────────────

test('dimensionGaps: lowShareThreshold triggers when lowShare is high even if avg is above avgThreshold', () => {
  // Avg = 6.5 (above avgThreshold 6.0) but lowShare could be high if some evals score ≤4.
  // Build rows where skills_match is 6.5 avg but 30% score ≤4 (3 out of 10).
  const rows = [
    ...Array.from({ length: 3 }, () => scoreRow({ skills_match: 4, ease_of_entry: 8 })), // ≤4
    ...Array.from({ length: 7 }, () => scoreRow({ skills_match: 7.5, ease_of_entry: 8 })), // above
  ];
  // avg = (4*3 + 7.5*7) / 10 = (12+52.5)/10 = 6.45 → above avgThreshold 6.0
  // lowShare = 3/10 = 30% → above lowShareThreshold default 25
  const gaps = dimensionGaps(rows, { avgThreshold: 6.0, lowShareThreshold: 25 });
  const keys = gaps.map((g) => g.key);
  assert.ok(keys.includes('skills_match'), 'lowShare 30% should trigger the gap even when avg > threshold');
});

test('dimensionGaps: empty score rows → [] (no crash)', () => {
  assert.deepEqual(dimensionGaps([]), []);
  assert.deepEqual(dimensionGaps(null), []);
});

test('dimensionGaps: all dimensions healthy → [] returned', () => {
  const rows = Array.from({ length: 5 }, () =>
    scoreRow({ skills_match: 9, ease_of_entry: 8, strategic_fit: 8 }));
  const gaps = dimensionGaps(rows, { avgThreshold: 6.0, lowShareThreshold: 25 });
  assert.deepEqual(gaps, []);
});

test('dimensionGaps: has hint for every returned dimension', () => {
  const rows = [scoreRow(), scoreRow()]; // skills+ease both at 4
  const gaps = dimensionGaps(rows, { avgThreshold: 6.0 });
  for (const g of gaps) {
    assert.ok(g.hint, `dimension ${g.key} should have a hint`);
    assert.ok(typeof g.hint === 'string' && g.hint.length > 0);
  }
});

// ── gapRecommendations: no-gap and boundary cases ────────────────────────────

test('gapRecommendations with no gaps at all → [] (nothing to recommend)', () => {
  const report = {
    keyword: { totalRoles: 10, gaps: [] },
    proof: { achievementBullets: 5, quantifiedPct: 80, weak: [] },
    dimension: [],
  };
  const recs = gapRecommendations(report);
  assert.deepEqual(recs, []);
});

test('gapRecommendations proof rec: 40-59% quantified → medium impact', () => {
  const report = {
    keyword: { totalRoles: 5, gaps: [] },
    proof: { achievementBullets: 5, quantifiedPct: 50, weak: [{ text: 'a' }, { text: 'b' }] },
    dimension: [],
  };
  const recs = gapRecommendations(report);
  const p = recs.find((r) => r.action.includes('Quantify'));
  assert.ok(p);
  assert.equal(p.impact, 'medium'); // 40-59% → medium
});

test('gapRecommendations proof rec does NOT fire when achievementBullets < 4', () => {
  const report = {
    keyword: { totalRoles: 5, gaps: [] },
    proof: { achievementBullets: 3, quantifiedPct: 0, weak: [{ text: 'x' }] },
    dimension: [],
  };
  const recs = gapRecommendations(report);
  const p = recs.find((r) => r.action.includes('Quantify'));
  assert.equal(p, undefined, 'proof rec should not fire for fewer than 4 achievement bullets');
});

test('gapRecommendations keyword rec: medium impact when top gap docFreq < max(5, 50% of roles)', () => {
  // 3 roles, top gap docFreq 2 → max(5, 3*0.5=1.5) = 5, 2 < 5 → medium
  const report = {
    keyword: { totalRoles: 3, gaps: [
      { term: 'tableau', documentFrequency: 2, share: 67 },
    ] },
    proof: { achievementBullets: 0, quantifiedPct: 0, weak: [] },
    dimension: [],
  };
  const recs = gapRecommendations(report, { minRolesForKeyword: 2 });
  const kw = recs.find((r) => r.action.includes('systematically-demanded'));
  assert.ok(kw);
  assert.equal(kw.impact, 'medium');
});

// ── analyzeCvGap: edge inputs ─────────────────────────────────────────────────

test('analyzeCvGap succeeds with only scoreRows and no demandDocs', () => {
  // scoreRows.length > 0 and demandDocs filter length == 0 → error should fire
  // (the condition is: BOTH empty → error; either non-empty → proceed).
  const res = analyzeCvGap({ cvText: 'My CV text here.', demandDocs: [], scoreRows: [scoreRow()] });
  // demandDocs is empty but scoreRows has data → no error → report returned
  assert.ok(!res.error, `expected no error, got: ${res?.error}`);
  assert.ok(res.keyword);
  assert.equal(res.keyword.totalRoles, 0);
  assert.equal(res.metadata.scoreRows, 1);
});

test('analyzeCvGap: whitespace-only CV → error', () => {
  const res = analyzeCvGap({ cvText: '   \n\t  ', demandDocs: ['sql python'] });
  assert.ok(res.error);
  assert.match(res.error, /No CV text/);
});

test('analyzeCvGap: metadata.analysisDate is today-formatted (YYYY-MM-DD)', () => {
  const res = analyzeCvGap({ cvText: 'CV text', demandDocs: ['sql python'], scoreRows: [] });
  assert.ok(!res.error);
  assert.match(res.metadata.analysisDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('analyzeCvGap passes opts.keyword through to keywordGaps', () => {
  // With minRoles=999 no gap can satisfy it → gaps list empty.
  const cv = 'Python analyst.';
  const docs = ['sql tableau', 'sql tableau'];
  const res = analyzeCvGap({ cvText: cv, demandDocs: docs, opts: { keyword: { minRoles: 999 } } });
  assert.ok(!res.error);
  assert.equal(res.keyword.gaps.length, 0, 'minRoles=999 should suppress all gaps');
});
