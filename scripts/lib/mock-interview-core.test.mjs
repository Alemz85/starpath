// mock-interview-core.test.mjs — unit suite for the mock-interview prediction,
// question→story matching, and practice-loop logic.
//
// Run: node --test scripts/lib/mock-interview-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.
//
// The module composes on top of lib/story-bank.mjs (taxonomy + ranker), so a few
// tests use a small parsed story bank to confirm the composition is wired right.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStoryBank } from './story-bank.mjs';

import {
  QUESTION_CATEGORIES,
  QUESTION_BANK,
  CRITIQUE_DIMENSIONS,
  emphasisedCompetencies,
  detectInterviewShape,
  predictQuestions,
  inferCompetency,
  normalizeQuestionText,
  matchQuestionsToStories,
  predictedCompetencyGaps,
  startSession,
  nextQuestion,
  recordAnswer,
  sessionProgress,
  scoreCritique,
  buildCritique,
  _resetQuestionIds,
} from './mock-interview-core.mjs';

// A small bank covering a few competencies but deliberately NOT 'failure' or
// 'conflict' — so gap detection has something to find.
const SAMPLE_BANK = `# Story Bank

### Rescued the migration deadline
**Themes:** ownership, delivery-under-pressure
**Situation:** The data migration was two weeks behind a hard regulator deadline.
**Task:** I owned getting the pipeline green before cutover.
**Action:** I re-sequenced the ETL jobs and paired nightly.
**Result:** Shipped 3 days early; 0 data-loss incidents.
**Reflection:** I learned to surface schedule risk early.

### Rebuilt the analytics layer
**Themes:** analytical, impact, communication
**Situation:** Nobody trusted the dashboard.
**Task:** Rebuild the metric definitions.
**Action:** Interviewed 8 stakeholders and rewrote the semantic layer.
**Result:** Adoption rose from 20% to 75% in a quarter.
**Reflection:** Trust in data is a communication problem, not a tooling one.
`;
const STORIES = parseStoryBank(SAMPLE_BANK);

/* ───── constants are well-formed ─────────────────────────────────────────── */

test('QUESTION_BANK is keyed by every canonical competency, each non-empty', () => {
  // every key maps to a non-empty array of string prompts
  for (const [comp, qs] of Object.entries(QUESTION_BANK)) {
    assert.ok(Array.isArray(qs) && qs.length > 0, `${comp} has prompts`);
    for (const q of qs) assert.equal(typeof q, 'string');
  }
});

test('QUESTION_CATEGORIES and CRITIQUE_DIMENSIONS are stable shapes', () => {
  assert.ok(QUESTION_CATEGORIES.includes('behavioral'));
  assert.ok(QUESTION_CATEGORIES.includes('motivation'));
  assert.equal(CRITIQUE_DIMENSIONS.length, 5); // STAR+R
  assert.deepEqual(
    CRITIQUE_DIMENSIONS.map((d) => d.id),
    ['situation', 'task', 'action', 'result', 'reflection'],
  );
});

/* ───── emphasisedCompetencies ────────────────────────────────────────────── */

test('emphasisedCompetencies leads with role-matched competencies', () => {
  const sales = emphasisedCompetencies('Tech Sales / Solutions Consultant');
  assert.equal(sales[0], 'customer'); // sales hint puts customer first
  assert.ok(sales.includes('communication'));

  const ds = emphasisedCompetencies('Strategy & Operations Analyst');
  assert.equal(ds[0], 'analytical');
  assert.ok(ds.includes('ambiguity'));
});

test('emphasisedCompetencies always returns the full taxonomy (every competency present, deduped)', () => {
  const all = emphasisedCompetencies('anything at all');
  // 12 canonical competencies, no dupes
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, Object.keys(QUESTION_BANK).length);
});

test('emphasisedCompetencies falls back to universal core first for unknown roles', () => {
  const unknown = emphasisedCompetencies('Underwater Basket Weaver');
  // no hint matches → universal core leads
  assert.deepEqual(unknown.slice(0, 3), ['ownership', 'failure', 'impact']);
});

test('emphasisedCompetencies tolerates empty/nullish input', () => {
  assert.deepEqual(emphasisedCompetencies('').slice(0, 3), ['ownership', 'failure', 'impact']);
  assert.deepEqual(emphasisedCompetencies(null).slice(0, 3), ['ownership', 'failure', 'impact']);
});

/* ───── detectInterviewShape ──────────────────────────────────────────────── */

test('detectInterviewShape tags case / take-home / coding / behavioral', () => {
  const t = detectInterviewShape(
    'Recruiter screen, then a business case interview, a take-home exercise, and a behavioral panel.',
  );
  assert.ok(t.has('case'));
  assert.ok(t.has('take-home'));
  assert.ok(t.has('behavioral'));
  assert.ok(t.has('panel'));
});

test('detectInterviewShape returns empty set for empty input', () => {
  assert.equal(detectInterviewShape('').size, 0);
  assert.equal(detectInterviewShape(null).size, 0);
});

/* ───── normalizeQuestionText ─────────────────────────────────────────────── */

test('normalizeQuestionText collapses punctuation/case/whitespace for dedup', () => {
  assert.equal(
    normalizeQuestionText('Tell me about a time you FAILED.'),
    'tell me about a time you failed',
  );
  assert.equal(
    normalizeQuestionText('Tell me about a time you failed'),
    normalizeQuestionText('Tell me, about a time you failed!'),
  );
  assert.equal(normalizeQuestionText(null), '');
});

/* ───── inferCompetency ───────────────────────────────────────────────────── */

test('inferCompetency classifies salient single tokens directly', () => {
  assert.equal(inferCompetency('Tell me about a conflict with a stakeholder'), 'conflict');
  assert.equal(inferCompetency('Describe a failure and what you learned'), 'failure');
  assert.equal(inferCompetency('How do you handle ambiguity?'), 'ambiguity');
});

test('inferCompetency falls back to alias-vocabulary overlap', () => {
  // "mentoring" is a leadership alias; no bare competency token present
  assert.equal(inferCompetency('Have you done any mentoring of junior teammates?'), 'leadership');
});

test('inferCompetency returns null for a question with no competency signal', () => {
  assert.equal(inferCompetency('What is your favorite color?'), null);
  assert.equal(inferCompetency(''), null);
});

/* ───── predictQuestions ──────────────────────────────────────────────────── */

test('predictQuestions returns behavioral questions ordered by role emphasis + a motivation question', () => {
  _resetQuestionIds();
  const { questions, emphasis } = predictQuestions({
    roleTitle: 'Strategy & Operations Analyst',
    archetypes: [{ name: 'Strategy & Operations' }],
  });
  assert.ok(questions.length > 0);

  // ids are sequential from q1
  assert.equal(questions[0].id, 'q1');

  // analytical leads the emphasis, so the first behavioral question is analytical
  const firstBehavioral = questions.find((q) => q.category === 'behavioral');
  assert.equal(firstBehavioral.competency, emphasis[0]);
  assert.equal(emphasis[0], 'analytical');

  // exactly one motivation question, and it carries no competency
  const motivation = questions.filter((q) => q.category === 'motivation');
  assert.equal(motivation.length, 1);
  assert.equal(motivation[0].competency, null);
});

test('predictQuestions respects maxBehavioral and perCompetency caps', () => {
  _resetQuestionIds();
  const { questions } = predictQuestions({
    roleTitle: 'Data Analyst',
    maxBehavioral: 3,
    perCompetency: 1,
  });
  const behavioral = questions.filter((q) => q.category === 'behavioral');
  assert.equal(behavioral.length, 3);
  // one per competency → three distinct competencies
  assert.equal(new Set(behavioral.map((q) => q.competency)).size, 3);
});

test('predictQuestions puts sourced extra questions first and dedups against the bank', () => {
  _resetQuestionIds();
  const sourced = 'Tell me about a time you failed. What did you do next?'; // identical to a bank prompt
  const { questions } = predictQuestions({
    roleTitle: 'Product Manager',
    extraQuestions: [
      { text: 'Walk me through how you would prioritize our roadmap.', category: 'role-specific', source: 'glassdoor' },
      { text: sourced, source: 'blind' }, // duplicate of QUESTION_BANK.failure[0]
    ],
  });

  // sourced ones come first
  assert.equal(questions[0].source, 'glassdoor');
  // the duplicate appears exactly once, and keeps the *sourced* provenance (added first)
  const failedQs = questions.filter(
    (q) => normalizeQuestionText(q.text) === normalizeQuestionText(sourced),
  );
  assert.equal(failedQs.length, 1);
  assert.equal(failedQs[0].source, 'blind');
});

test('predictQuestions infers competency for an untagged sourced question', () => {
  _resetQuestionIds();
  const { questions } = predictQuestions({
    extraQuestions: [{ text: 'Describe a disagreement you had with your manager.', source: 'glassdoor' }],
  });
  const q = questions.find((x) => x.source === 'glassdoor');
  assert.equal(q.competency, 'conflict');
  assert.equal(q.category, 'behavioral'); // inferred competency → behavioral default
});

test('predictQuestions degrades gracefully with no inputs', () => {
  _resetQuestionIds();
  const { questions, emphasis, shape } = predictQuestions();
  assert.ok(questions.length > 0); // still get a default behavioral set + motivation
  assert.ok(emphasis.length > 0);
  assert.equal(shape.size, 0);
});

/* ───── matchQuestionsToStories ───────────────────────────────────────────── */

test('matchQuestionsToStories attaches best-fit stories and flags gaps via competency', () => {
  _resetQuestionIds();
  const questions = [
    { id: 'q1', text: 'Tell me about delivering under pressure', competency: 'ownership', category: 'behavioral' },
    { id: 'q2', text: 'Tell me about a conflict you resolved', competency: 'conflict', category: 'behavioral' },
  ];
  const matched = matchQuestionsToStories(questions, STORIES, { limit: 2 });

  // ownership is covered by "Rescued the migration deadline" → strong, not a gap
  const ownership = matched.find((m) => m.question.competency === 'ownership');
  assert.equal(ownership.bestFit, 'strong');
  assert.equal(ownership.gap, false);
  assert.ok(ownership.matches[0].viaCompetency);

  // conflict is NOT covered by the sample bank → none, gap
  const conflict = matched.find((m) => m.question.competency === 'conflict');
  assert.equal(conflict.bestFit, 'none');
  assert.equal(conflict.gap, true);
  assert.equal(conflict.matches.length, 0);
});

test('matchQuestionsToStories handles an empty bank (everything is a gap)', () => {
  const questions = [{ id: 'q1', text: 'anything', competency: 'impact', category: 'behavioral' }];
  const matched = matchQuestionsToStories(questions, [], { limit: 2 });
  assert.equal(matched[0].bestFit, 'none');
  assert.equal(matched[0].gap, true);
});

/* ───── predictedCompetencyGaps ───────────────────────────────────────────── */

test('predictedCompetencyGaps lists only tested competencies with no covering story', () => {
  const questions = [
    { id: 'q1', text: 'q', competency: 'ownership', category: 'behavioral' }, // covered
    { id: 'q2', text: 'q', competency: 'analytical', category: 'behavioral' }, // covered
    { id: 'q3', text: 'q', competency: 'failure', category: 'behavioral' }, // gap
    { id: 'q4', text: 'q', competency: 'conflict', category: 'behavioral' }, // gap
    { id: 'q5', text: 'q', competency: null, category: 'motivation' }, // ignored
  ];
  const gaps = predictedCompetencyGaps(questions, STORIES);
  const gapIds = gaps.map((g) => g.id);
  assert.deepEqual(gapIds, ['failure', 'conflict']);
  // labels resolved from the taxonomy
  assert.ok(gaps[0].label.toLowerCase().includes('failure'));
  // each gap carries the question texts that test it
  assert.ok(Array.isArray(gaps[0].questions) && gaps[0].questions.length === 1);
});

test('predictedCompetencyGaps groups multiple questions under one competency', () => {
  const questions = [
    { id: 'q1', text: 'first failure q', competency: 'failure', category: 'behavioral' },
    { id: 'q2', text: 'second failure q', competency: 'failure', category: 'behavioral' },
  ];
  const gaps = predictedCompetencyGaps(questions, STORIES);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].questions.length, 2);
});

/* ───── practice-loop state machine ───────────────────────────────────────── */

test('startSession seeds an immutable copy of the questions', () => {
  const qs = [{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }];
  const s = startSession(qs);
  assert.equal(s.cursor, 0);
  assert.deepEqual(s.results, []);
  // mutating the source array's object does not bleed into the session
  qs[0].text = 'MUTATED';
  assert.equal(s.questions[0].text, 'a');
});

test('nextQuestion walks the queue and returns null when done', () => {
  const s0 = startSession([{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }]);
  assert.equal(nextQuestion(s0).id, 'q1');
  const s1 = recordAnswer(s0, buildCritique({ dimResults: { situation: true } }));
  assert.equal(nextQuestion(s1).id, 'q2');
  const s2 = recordAnswer(s1, buildCritique({ dimResults: {} }));
  assert.equal(nextQuestion(s2), null);
});

test('recordAnswer is pure — returns a new session, leaves the prior one intact', () => {
  const s0 = startSession([{ id: 'q1', text: 'a' }]);
  const crit = buildCritique({ dimResults: { situation: true, task: true } });
  const s1 = recordAnswer(s0, crit);
  // original untouched
  assert.equal(s0.cursor, 0);
  assert.equal(s0.results.length, 0);
  // new one advanced and stored the critique against the asked question
  assert.equal(s1.cursor, 1);
  assert.equal(s1.results.length, 1);
  assert.equal(s1.results[0].question.id, 'q1');
  assert.equal(s1.results[0].critique, crit);
});

test('sessionProgress reports counts, done flag, and avg score', () => {
  let s = startSession([{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }]);
  let p = sessionProgress(s);
  assert.deepEqual([p.total, p.answered, p.remaining, p.done, p.avgScore], [2, 0, 2, false, null]);

  s = recordAnswer(s, buildCritique({ dimResults: { situation: true, task: true, action: true } })); // 3
  s = recordAnswer(s, buildCritique({ dimResults: { situation: true, task: true, action: true, result: true, reflection: true } })); // 5
  p = sessionProgress(s);
  assert.equal(p.answered, 2);
  assert.equal(p.done, true);
  assert.equal(p.avgScore, 4); // (3 + 5) / 2
});

test('sessionProgress tolerates a null/empty session', () => {
  const p = sessionProgress(null);
  assert.deepEqual([p.total, p.answered, p.remaining, p.done, p.avgScore], [0, 0, 0, false, null]);
});

/* ───── critique rubric ───────────────────────────────────────────────────── */

test('scoreCritique sums satisfied dimensions and bands them', () => {
  const perfect = scoreCritique({ situation: true, task: true, action: true, result: true, reflection: true });
  assert.deepEqual([perfect.score, perfect.max, perfect.band], [5, 5, 'strong']);
  assert.deepEqual(perfect.missing, []);

  const solid = scoreCritique({ situation: true, task: true, action: true });
  assert.deepEqual([solid.score, solid.band], [3, 'solid']);

  const developing = scoreCritique({ situation: true, result: true });
  assert.deepEqual([developing.score, developing.band], [2, 'developing']);

  const weak = scoreCritique({});
  assert.deepEqual([weak.score, weak.band], [0, 'weak']);
  assert.equal(weak.missing.length, 5);
});

test('scoreCritique missing list names the unsatisfied dimensions', () => {
  const r = scoreCritique({ situation: true, task: true, action: true, reflection: true }); // no result
  assert.equal(r.score, 4);
  assert.equal(r.band, 'solid'); // 4 is < 4.5 → solid, not strong (quantified result matters)
  assert.ok(r.missing.some((m) => /quantif/i.test(m)));
});

test('buildCritique merges scoring with notes and expected story', () => {
  const c = buildCritique({
    dimResults: { situation: true, task: true, action: true, result: true, reflection: true },
    notes: 'Strong, but trim the setup.',
    expectedStory: 'Rescued the migration deadline',
  });
  assert.equal(c.score, 5);
  assert.equal(c.band, 'strong');
  assert.equal(c.notes, 'Strong, but trim the setup.');
  assert.equal(c.expectedStory, 'Rescued the migration deadline');
});

test('buildCritique defaults are safe with no args', () => {
  const c = buildCritique();
  assert.equal(c.score, 0);
  assert.equal(c.band, 'weak');
  assert.equal(c.notes, '');
  assert.equal(c.expectedStory, null);
});
