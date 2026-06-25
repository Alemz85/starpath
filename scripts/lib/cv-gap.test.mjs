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
