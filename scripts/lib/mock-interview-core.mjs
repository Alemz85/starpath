// mock-interview-core.mjs — pure logic for modes/mock-interview.md.
//
// Mock-interview mode predicts the questions a candidate is likely to face for a
// given company+role, maps each predicted question to the candidate's best-fit
// STAR+R story, flags the competencies no story covers, and drives a
// "practice one question at a time, then critique" loop.
//
// This module owns the *prediction → story-matching → practice* logic and is
// pure (no I/O, no globals, no input mutation). The CLI / agent owns reading the
// story bank and the company-research artifact off disk; this module owns what a
// predicted question *is*, which competency it tests, which story answers it, and
// how a practice answer scores. Mirrors the extract-then-test pattern of
// lib/story-bank.mjs, lib/company-research-core.mjs and lib/tracker-core.mjs.
//
// ── HOW IT COMPOSES WITH WHAT ROUNDS 1–3 BUILT ──────────────────────────────
// It deliberately does NOT duplicate the competency taxonomy or the
// question→story scorer. Those live in lib/story-bank.mjs (the one source of
// truth that interview-prep.md, apply.md and cv-sync-check.mjs already share).
// This module imports them:
//   - COMPETENCIES / normalizeCompetency  → the canonical competency vocabulary
//   - storyCompetencies / buildCompetencyIndex → which stories cover what
//   - rankStoriesByCompetency             → competency-first story ranking
//   - tokenizeQuestion                    → free-text question tokenizing
// and adds the layer above them: a *question bank* keyed by competency, an
// archetype/role/interview-style → question selector, and a practice-loop state
// machine + STAR+R critique rubric.
//
// ── NO HARDCODED USER DATA (CLAUDE.md § System Layer Hygiene) ────────────────
// The QUESTION_BANK below is universal behavioral-interview material keyed off
// the canonical COMPETENCIES — the same legitimate-reference-data carve-out the
// taxonomy itself takes. It names no company, school, person, city or metric.
// Everything candidate-specific (archetypes, role title, the actual stories,
// interview style) is PASSED IN by the caller, read from user/* and
// data/companies/{slug}.md at runtime. A different candidate with a different
// background gets different questions and different matches from the same code.

import {
  COMPETENCIES,
  normalizeCompetency,
  normalizeTheme,
  tokenizeQuestion,
  buildCompetencyIndex,
  rankStoriesByCompetency,
} from './story-bank.mjs';

/* ───── question categories ──────────────────────────────────────────────── */
//
// Every predicted question carries a category so the agent can group the output
// and the practice loop can be filtered ("just behavioral today"). These mirror
// modes/interview-prep.md Step 4's buckets so the two modes speak one language.

export const QUESTION_CATEGORIES = ['behavioral', 'role-specific', 'motivation', 'background'];

/* ───── the universal behavioral question bank ───────────────────────────── */
//
// One small, defensible set of behavioral prompts per canonical competency.
// These are the generic openers large employers actually use ("Tell me about a
// time you…") — not company- or candidate-specific. The agent layers
// company-sourced and JD-inferred questions on top (it has WebSearch + the JD);
// this gives the practice loop a grounded floor even with zero research, and
// guarantees at least one question per competency the role screens for.
//
// Keyed by canonical competency id (see story-bank.mjs COMPETENCIES). Kept short
// on purpose: the value is the competency tagging + story match, not volume.

export const QUESTION_BANK = {
  ownership: [
    'Tell me about a time you took ownership of a problem outside your formal remit.',
    'Describe a time you delivered under a tight deadline with no one telling you how.',
  ],
  leadership: [
    'Tell me about a time you led a team or initiative without formal authority.',
    'Describe a time you had to influence a decision you did not control.',
  ],
  collaboration: [
    'Tell me about a time you worked across functions to ship something.',
    'Describe a time a teammate disagreed with your approach and how you handled it.',
  ],
  conflict: [
    'Tell me about a disagreement with a stakeholder and how you resolved it.',
    'Describe a time you had to deliver difficult feedback.',
  ],
  failure: [
    'Tell me about a time you failed. What did you do next?',
    'Describe a decision you got wrong and what you changed afterwards.',
  ],
  ambiguity: [
    'Tell me about a time you had to make a call with incomplete information.',
    'Describe a project where the goal was unclear and how you brought structure.',
  ],
  analytical: [
    'Walk me through a time you used data to drive a decision.',
    'Describe the most analytically complex problem you have solved.',
  ],
  impact: [
    'Tell me about the work you are most proud of and the impact it had.',
    'Describe a time you moved a metric that mattered to the business.',
  ],
  communication: [
    'Tell me about a time you had to explain something complex to a non-expert audience.',
    'Describe a time your communication changed an outcome.',
  ],
  customer: [
    'Tell me about a time you went out of your way for a customer or user.',
    'Describe a time customer feedback changed what you built.',
  ],
  learning: [
    'Tell me about a time you had to learn something new quickly to deliver.',
    'Describe how you responded to a piece of tough feedback.',
  ],
  innovation: [
    'Tell me about a time you built or proposed something from scratch.',
    'Describe a time you found a non-obvious solution to a problem.',
  ],
};

/* ───── role / archetype → competency emphasis ───────────────────────────── */
//
// Different role families weight competencies differently. A Strategy & Ops or
// consulting archetype leans analytical + ambiguity + communication; a sales /
// customer-facing archetype leans customer + communication + ownership; an
// engineering archetype leans analytical + ownership + collaboration; a
// leadership/rotational program leans leadership + learning + ambiguity.
//
// This is a *signal*, not a hardcoded user preference: it maps generic role
// KEYWORDS (which the caller derives from the candidate's own archetype names +
// the role title at runtime) to which universal competencies to surface first.
// Unknown keywords simply fall back to a broad default — every candidate,
// whatever their archetypes, gets a sensible ordering.

// Each hint's `keywords` are the individual alternatives its regex matches. They
// drive both *whether* a hint fires and *how strongly* (how many distinct
// keywords hit) — so a "Tech Sales / Solutions Consultant" title, which hits the
// sales hint on two words ("sales", "solution") but the strategy hint on one
// ("consult"), surfaces customer-facing competencies first rather than being
// dominated by an incidental substring.
const ROLE_COMPETENCY_HINTS = [
  { keywords: ['strateg', 'operations', 's&o', 'biz ops', 'bizops', 'consult'], competencies: ['analytical', 'ambiguity', 'communication', 'impact', 'ownership'] },
  { keywords: ['data', 'analyt', 'business intelligence', 'insight'], competencies: ['analytical', 'impact', 'communication', 'ownership'] },
  { keywords: ['sales', 'account', 'customer', 'solution', 'revenue', 'gtm', 'go-to-market'], competencies: ['customer', 'communication', 'ownership', 'impact', 'collaboration'] },
  { keywords: ['product manager', 'product', ' pm', 'pm '], competencies: ['customer', 'ambiguity', 'impact', 'communication', 'analytical'] },
  { keywords: ['engineer', 'developer', 'software', 'data scien'], competencies: ['analytical', 'ownership', 'collaboration', 'learning'] },
  { keywords: ['market'], competencies: ['analytical', 'communication', 'impact', 'customer'] },
  { keywords: ['rotational', 'graduate', 'early career', 'leadership development', 'trainee', 'ldp', 'gdp'], competencies: ['learning', 'leadership', 'ambiguity', 'ownership', 'collaboration'] },
  { keywords: ['manager', 'lead', 'head of', 'director'], competencies: ['leadership', 'ownership', 'conflict', 'impact', 'communication'] },
  { keywords: ['project', 'program', 'delivery'], competencies: ['ownership', 'collaboration', 'communication', 'conflict'] },
];

// Competencies every behavioral loop should touch regardless of role — these are
// the questions that come up in almost any interview.
const UNIVERSAL_CORE = ['ownership', 'failure', 'impact'];

/**
 * Given free-text role signals (the role title plus the candidate's archetype
 * names, joined), return the ordered list of competency ids to emphasise.
 *
 * Hints are ranked by *match strength* — how many of their keywords appear in
 * the signals — so the most-specific role family leads. Ties keep declaration
 * order (stable). Matched-hint competencies come first (deduped across hints),
 * then the universal core, then the rest of the taxonomy, so the output always
 * covers every competency, just in priority order.
 */
export function emphasisedCompetencies(roleSignals) {
  const text = String(roleSignals || '').toLowerCase();
  const ordered = [];
  const push = (id) => {
    if (id && !ordered.includes(id)) ordered.push(id);
  };

  const scored = ROLE_COMPETENCY_HINTS.map((hint, idx) => {
    const hits = hint.keywords.filter((k) => text.includes(k.toLowerCase())).length;
    return { hint, hits, idx };
  })
    .filter((s) => s.hits > 0)
    // strongest match first; stable on ties via original index
    .sort((a, b) => b.hits - a.hits || a.idx - b.idx);

  for (const { hint } of scored) hint.competencies.forEach(push);
  UNIVERSAL_CORE.forEach(push);
  for (const c of COMPETENCIES) push(c.id);
  return ordered;
}

/* ───── question prediction ──────────────────────────────────────────────── */

/**
 * Detect a coarse interview "shape" from a free-text Interview Style blob (the
 * `## Interview Style` section of data/companies/{slug}.md, or a recruiter's
 * description). Used only to flavour which categories to surface — e.g. a "case
 * interview" shape adds analytical/ambiguity weight, a "take-home" shape signals
 * role-specific depth. Returns a set of detected tags (possibly empty).
 */
export function detectInterviewShape(styleText) {
  const t = String(styleText || '').toLowerCase();
  const tags = new Set();
  if (/case study|case interview|business case|case round/.test(t)) tags.add('case');
  if (/take-?home|assignment|exercise|presentation|deck/.test(t)) tags.add('take-home');
  if (/system design|architecture/.test(t)) tags.add('system-design');
  if (/coding|leetcode|live cod|pair program|technical screen/.test(t)) tags.add('coding');
  if (/behavio|values|culture|leadership principle|competenc/.test(t)) tags.add('behavioral');
  if (/panel|onsite|loop|superday/.test(t)) tags.add('panel');
  return tags;
}

let __qid = 0;
function makeQuestion({ text, competency, category, source }) {
  return {
    id: `q${++__qid}`,
    text: String(text).trim(),
    competency: competency || null,
    category,
    source: source || 'inferred',
  };
}

// Reset the id counter — used by tests for deterministic ids and available to a
// caller that wants a fresh sequence per session.
export function _resetQuestionIds() {
  __qid = 0;
}

/**
 * Predict the likely interview questions for a role.
 *
 * Inputs (everything degrades gracefully — call with {} and you still get a
 * sensible default behavioral set):
 *   {
 *     roleTitle,          // e.g. "Strategy & Operations Analyst" (string)
 *     archetypes,         // [{name, fit}] from user/profile.yml — caller-supplied
 *     interviewStyle,     // free text from data/companies/{slug}.md (optional)
 *     extraQuestions,     // [{text, competency?, category?, source?}] the agent
 *                         //   sourced from Glassdoor/Blind/JD (optional)
 *     perCompetency,      // how many bank questions per emphasised competency (default 1)
 *     maxBehavioral,      // cap on behavioral questions (default 8)
 *   }
 *
 * Returns { questions, shape, emphasis }:
 *   questions — ordered, de-duplicated [{id,text,competency,category,source}].
 *               Agent-supplied (`extraQuestions`) come first (they're real,
 *               sourced), then bank questions for the emphasised competencies.
 *               Behavioral questions are ordered by the role's competency emphasis.
 *   shape     — the detected interview-shape tag set (see detectInterviewShape).
 *   emphasis  — the ordered competency ids that drove behavioral selection.
 *
 * The function is deterministic given its inputs (ids are sequential; call
 * _resetQuestionIds() first if you need them to start at q1).
 */
export function predictQuestions({
  roleTitle = '',
  archetypes = [],
  interviewStyle = '',
  extraQuestions = [],
  perCompetency = 1,
  maxBehavioral = 8,
} = {}) {
  const archNames = (archetypes || [])
    .map((a) => (a && (a.name || a.label || a.role)) || (typeof a === 'string' ? a : ''))
    .filter(Boolean)
    .join(' ');
  const roleSignals = `${roleTitle} ${archNames}`.trim();
  const emphasis = emphasisedCompetencies(roleSignals);
  const shape = detectInterviewShape(interviewStyle);

  const questions = [];
  const seen = new Set(); // normalized question text → dedup

  const add = (q) => {
    const key = normalizeQuestionText(q.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    questions.push(q);
    return true;
  };

  // 1. Agent-sourced extra questions first — they're real and citeable. Tag any
  //    that omitted a competency by inferring it from the text.
  for (const e of extraQuestions || []) {
    if (!e || !e.text) continue;
    const competency = e.competency
      ? normalizeCompetency(e.competency)
      : inferCompetency(e.text);
    add(
      makeQuestion({
        text: e.text,
        competency,
        category: e.category || (competency ? 'behavioral' : 'role-specific'),
        source: e.source || 'sourced',
      }),
    );
  }

  // 2. Bank behavioral questions for the emphasised competencies, in priority
  //    order, until we hit the behavioral cap.
  const behavioralCount = () => questions.filter((q) => q.category === 'behavioral').length;
  for (const compId of emphasis) {
    if (behavioralCount() >= maxBehavioral) break;
    const pool = QUESTION_BANK[compId] || [];
    for (let i = 0; i < Math.min(perCompetency, pool.length); i++) {
      if (behavioralCount() >= maxBehavioral) break;
      add(
        makeQuestion({
          text: pool[i],
          competency: compId,
          category: 'behavioral',
          source: 'inferred',
        }),
      );
    }
  }

  // 3. A standing motivation question — every interview asks some form of "why
  //    us / why this role". Generic (no company hardcoded); the agent fills the
  //    company in when it renders.
  add(
    makeQuestion({
      text: 'Why this company and why this role specifically?',
      competency: null,
      category: 'motivation',
      source: 'inferred',
    }),
  );

  return { questions, shape, emphasis };
}

/* ───── question → competency inference ──────────────────────────────────── */

/**
 * Infer a canonical competency from a free-text question. First tries direct
 * normalization of salient tokens (so "conflict", "ambiguity", "failure"
 * questions classify exactly); then scores against each competency's alias
 * vocabulary by token overlap. Returns a competency id or null.
 *
 * This is what lets the agent drop in a raw Glassdoor question with no tag and
 * still get it mapped to a story.
 */
export function inferCompetency(question) {
  const tokens = tokenizeQuestion(question);
  if (!tokens.length) return null;

  // Exact / containment hit on a single token wins immediately.
  for (const tok of tokens) {
    const id = normalizeCompetency(tok);
    if (id) return id;
  }

  // Otherwise score competencies by how many alias words their vocabulary shares
  // with the question tokens.
  const tokenSet = new Set(tokens);
  let best = null;
  let bestScore = 0;
  for (const c of COMPETENCIES) {
    let score = 0;
    for (const alias of c.aliases) {
      for (const word of normalizeTheme(alias).split(' ')) {
        if (word.length > 2 && tokenSet.has(word)) score += 1;
      }
    }
    if (score > bestScore) {
      best = c.id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Normalize question text for dedup: lowercase, strip punctuation, collapse
 * whitespace. "Tell me about a time you failed." and "Tell me about a time you
 * failed" collapse to one.
 */
export function normalizeQuestionText(text) {
  if (text == null) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ───── question → story matching ────────────────────────────────────────── */

/**
 * For each predicted question, attach the candidate's best-fit stories from the
 * bank. Reuses lib/story-bank.mjs's competency-first ranker so this mode and
 * interview-prep.md produce identical matches.
 *
 *   matchQuestionsToStories(questions, stories, { limit })
 *     → [{ question, matches, bestFit, gap }]
 *       matches  — [{ story, score, fit, viaCompetency }] (top `limit`)
 *       bestFit  — 'strong' | 'partial' | 'none' (the top match's fit, or 'none')
 *       gap      — true when no story covers the question's competency
 *                  (bestFit === 'none' for a competency-tagged question)
 */
export function matchQuestionsToStories(questions, stories, { limit = 2 } = {}) {
  return (questions || []).map((question) => {
    const matches = rankStoriesByCompetency(
      stories || [],
      question.text,
      question.competency,
      { limit },
    );
    const bestFit = matches.length ? matches[0].fit : 'none';
    const gap = bestFit === 'none';
    return { question, matches, bestFit, gap };
  });
}

/**
 * Across the predicted questions, which competencies have NO covering story.
 * This is the candidate's "questions they could be asked but have no story for"
 * list — the gaps to build stories for before the interview.
 *
 * Returns [{ id, label, questions }] for each gap competency, in the order it
 * first appears among the predicted questions, where `questions` are the
 * predicted question texts that test it.
 */
export function predictedCompetencyGaps(questions, stories) {
  const index = buildCompetencyIndex(stories || []);
  const byComp = new Map(); // compId → [question texts]
  for (const q of questions || []) {
    if (!q.competency) continue;
    if (!byComp.has(q.competency)) byComp.set(q.competency, []);
    byComp.get(q.competency).push(q.text);
  }
  const labelOf = (id) => {
    const c = COMPETENCIES.find((x) => x.id === id);
    return c ? c.label : id;
  };
  const gaps = [];
  for (const [compId, qs] of byComp) {
    const covered = (index[compId] || []).length > 0;
    if (!covered) gaps.push({ id: compId, label: labelOf(compId), questions: qs });
  }
  return gaps;
}

/* ───── practice-loop state machine ──────────────────────────────────────── */
//
// The practice loop is "ask one question, candidate answers, critique, advance".
// State is a plain serializable object so the agent (or a future frontend) can
// persist it between turns without this module doing any I/O.

/**
 * Initialise a practice session over a list of predicted questions.
 *   { questions } → { questions, results: [], cursor: 0 }
 * `results` accumulates one record per answered question; `cursor` is the index
 * of the next question to ask. Input is shallow-copied so the source array is
 * never mutated.
 */
export function startSession(questions) {
  return {
    questions: (questions || []).map((q) => ({ ...q })),
    results: [],
    cursor: 0,
  };
}

/** The next unanswered question, or null when the session is done. */
export function nextQuestion(session) {
  if (!session || !Array.isArray(session.questions)) return null;
  if (session.cursor >= session.questions.length) return null;
  return session.questions[session.cursor];
}

/**
 * Record a critique for the current question and advance the cursor. Pure:
 * returns a NEW session object, does not mutate the input.
 *   recordAnswer(session, critique) → session'
 * `critique` is whatever the agent produced (typically the object from
 * buildCritique below); it's stored verbatim alongside the question.
 */
export function recordAnswer(session, critique) {
  if (!session) return startSession([]);
  const q = (session.questions || [])[session.cursor] || null;
  return {
    ...session,
    results: [...(session.results || []), { question: q, critique }],
    cursor: (session.cursor || 0) + 1,
  };
}

/**
 * Session progress summary for the agent to print between questions.
 *   { total, answered, remaining, done, avgScore }
 * `avgScore` averages the numeric `score` field of stored critiques (null when
 * no scored answers yet), so the loop can report "you're averaging 3.4/5".
 */
export function sessionProgress(session) {
  const total = session && Array.isArray(session.questions) ? session.questions.length : 0;
  const answered = session && Array.isArray(session.results) ? session.results.length : 0;
  const scored = ((session && session.results) || [])
    .map((r) => r && r.critique && r.critique.score)
    .filter((s) => typeof s === 'number' && !Number.isNaN(s));
  const avgScore = scored.length
    ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10
    : null;
  return {
    total,
    answered,
    remaining: Math.max(0, total - answered),
    done: total > 0 && answered >= total,
    avgScore,
  };
}

/* ───── STAR+R critique rubric ────────────────────────────────────────────── */
//
// Grading a practice answer. The agent reads the candidate's spoken/typed answer
// and the rubric tells it WHAT to check; the few pure helpers below turn its
// findings into a consistent score so feedback is comparable across questions.

// The five things a strong behavioral answer needs — one point each, 0–5 total.
// Mirrors the STAR+R beats the story bank enforces, so practice feedback and the
// bank's completeness check use the same yardstick.
export const CRITIQUE_DIMENSIONS = [
  { id: 'situation', label: 'Set the situation concisely', weight: 1 },
  { id: 'task', label: 'Made the task / stakes clear', weight: 1 },
  { id: 'action', label: 'Detailed specific actions (I, not we)', weight: 1 },
  { id: 'result', label: 'Quantified the result', weight: 1 },
  { id: 'reflection', label: 'Closed with a reflection / learning', weight: 1 },
];

/**
 * Score a critique from a per-dimension boolean map. The agent decides whether
 * each STAR+R dimension was satisfied; this turns that into a number and a band
 * so the wording of feedback stays consistent.
 *
 *   scoreCritique({ situation: true, task: true, action: false, ... })
 *     → { score, max, band, missing }
 *   band ∈ 'strong' (>=4.5) | 'solid' (>=3) | 'developing' (>=1.5) | 'weak'
 *   missing — the dimension labels that were not satisfied (the coaching list)
 */
export function scoreCritique(dimResults = {}) {
  let score = 0;
  const missing = [];
  for (const d of CRITIQUE_DIMENSIONS) {
    if (dimResults[d.id]) score += d.weight;
    else missing.push(d.label);
  }
  const max = CRITIQUE_DIMENSIONS.reduce((a, d) => a + d.weight, 0);
  let band = 'weak';
  if (score >= 4.5) band = 'strong';
  else if (score >= 3) band = 'solid';
  else if (score >= 1.5) band = 'developing';
  return { score, max, band, missing };
}

/**
 * Assemble a full critique record for storage in the session. Combines the
 * dimension scoring with the agent's free-text notes and the story it expected
 * the candidate to draw on.
 *
 *   buildCritique({ dimResults, notes, expectedStory })
 *     → { score, max, band, missing, notes, expectedStory }
 */
export function buildCritique({ dimResults = {}, notes = '', expectedStory = null } = {}) {
  return {
    ...scoreCritique(dimResults),
    notes: String(notes || ''),
    expectedStory: expectedStory || null,
  };
}
