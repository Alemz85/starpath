// story-bank.test.mjs — unit suite for the interview-prep/story-bank.md parser
// and selection helpers.
//
// Run: node --test scripts/lib/story-bank.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAR_BEATS,
  storyTitleKey,
  normalizeTheme,
  parseStoryBank,
  storyMissingBeats,
  isStoryComplete,
  resultIsQuantified,
  tokenizeQuestion,
  scoreStoryForQuestion,
  rankStoriesForQuestion,
  coverageGaps,
  findStoryByTitle,
  bankHealth,
  // competency taxonomy + validator + coverage index (interview-prep Step 5)
  COMPETENCIES,
  normalizeCompetency,
  storyCompetencies,
  validateStory,
  findDuplicateTitles,
  buildCompetencyIndex,
  competencyGaps,
  rankStoriesByCompetency,
  validateBank,
} from './story-bank.mjs';

const SAMPLE = `# Story Bank

Some preamble prose that is not a story.

## Stories

### Rescued the migration deadline
**Themes:** ownership, conflict, delivery-under-pressure
**Situation:** The data migration was two weeks behind with a hard regulator deadline.
**Task:** I owned getting the pipeline green before the cutover.
**Action:** I re-sequenced the ETL jobs and paired with two engineers nightly.
This continuation line belongs to the Action beat.
**Result:** Shipped 3 days early; 0 data-loss incidents at cutover.
**Reflection:** I learned to surface schedule risk early instead of absorbing it.

### Led the analytics redesign
**Themes:** leadership, ambiguity
**Situation:** The dashboard nobody trusted.
**Task:** Rebuild the metric definitions from scratch.
**Action:** Interviewed 8 stakeholders and rewrote the semantic layer.
**Result:** Adoption went from 20% to 75% in one quarter.

### Half-baked story
**Situation:** Something happened.
`;

/* ───── title + theme normalization ───────────────────────────────── */

test('storyTitleKey normalizes emphasis, punctuation, case, whitespace', () => {
  assert.equal(storyTitleKey('**Rescued  the Deadline.**'), 'rescued the deadline');
  assert.equal(storyTitleKey('Led the Analytics Redesign'), 'led the analytics redesign');
  assert.equal(storyTitleKey(null), '');
});

test('normalizeTheme collapses dashes/underscores/case', () => {
  assert.equal(normalizeTheme('Delivery-Under-Pressure'), 'delivery under pressure');
  assert.equal(normalizeTheme('  Ownership '), 'ownership');
  assert.equal(normalizeTheme(undefined), '');
});

/* ───── parsing ───────────────────────────────────────────────────── */

test('parseStoryBank returns one record per ### heading, ignores # and ##', () => {
  const stories = parseStoryBank(SAMPLE);
  assert.equal(stories.length, 3);
  assert.deepEqual(
    stories.map((s) => s.title),
    ['Rescued the migration deadline', 'Led the analytics redesign', 'Half-baked story'],
  );
});

test('parseStoryBank captures all five beats and the themes list', () => {
  const [s] = parseStoryBank(SAMPLE);
  assert.deepEqual(s.themes, ['ownership', 'conflict', 'delivery under pressure']);
  for (const beat of STAR_BEATS) {
    assert.ok(s[beat], `expected non-empty ${beat}`);
  }
  assert.match(s.result, /3 days early/);
});

test('parseStoryBank folds continuation lines into the current beat', () => {
  const [s] = parseStoryBank(SAMPLE);
  assert.match(s.action, /re-sequenced the ETL jobs/);
  assert.match(s.action, /continuation line belongs to the Action beat/);
});

test('parseStoryBank tolerates label aliases and combined R&R labels', () => {
  const md = `### Aliased
**Context:** ctx here
**Challenge:** the goal
**Approach:** what I did
**Outcome:** numbers 42%
**Takeaway:** the lesson`;
  const [s] = parseStoryBank(md);
  assert.equal(s.situation, 'ctx here');
  assert.equal(s.task, 'the goal');
  assert.equal(s.action, 'what I did');
  assert.equal(s.result, 'numbers 42%');
  assert.equal(s.reflection, 'the lesson');
  assert.ok(isStoryComplete(s));
});

test('parseStoryBank ignores ### headings inside fenced code blocks', () => {
  const md = `# Story Bank

\`\`\`
### Not a real story (this is a format example)
**Situation:** ...
\`\`\`

### Real story
**Themes:** delivery
**Situation:** s
**Task:** t
**Action:** a
**Result:** 5x faster
**Reflection:** r`;
  const stories = parseStoryBank(md);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].title, 'Real story');
});

test('parseStoryBank handles empty/nullish input', () => {
  assert.deepEqual(parseStoryBank(''), []);
  assert.deepEqual(parseStoryBank(null), []);
});

/* ───── completeness ──────────────────────────────────────────────── */

test('storyMissingBeats + isStoryComplete flag incomplete stories', () => {
  const stories = parseStoryBank(SAMPLE);
  const complete = stories[0];
  const noReflection = stories[1];
  const stub = stories[2];

  assert.deepEqual(storyMissingBeats(complete), []);
  assert.ok(isStoryComplete(complete));

  assert.deepEqual(storyMissingBeats(noReflection), ['reflection']);
  assert.equal(isStoryComplete(noReflection), false);

  assert.deepEqual(storyMissingBeats(stub), ['task', 'action', 'result', 'reflection']);
});

test('resultIsQuantified detects a number in the result beat', () => {
  const stories = parseStoryBank(SAMPLE);
  assert.ok(resultIsQuantified(stories[0])); // "3 days early"
  assert.equal(resultIsQuantified({ result: 'It went really well overall' }), false);
});

/* ───── selection ─────────────────────────────────────────────────── */

test('tokenizeQuestion drops stopwords and short tokens', () => {
  const toks = tokenizeQuestion('Tell me about a time you handled conflict on a team');
  assert.ok(toks.includes('handled'));
  assert.ok(toks.includes('conflict'));
  assert.ok(toks.includes('team'));
  assert.ok(!toks.includes('tell'));
  assert.ok(!toks.includes('me'));
  assert.ok(!toks.includes('a'));
});

test('scoreStoryForQuestion weights theme > title > body', () => {
  const [story] = parseStoryBank(SAMPLE);
  // "conflict" is a theme (weight 3); "migration" is in the title (weight 2).
  const themeHit = scoreStoryForQuestion(story, 'a time you handled conflict');
  const titleHit = scoreStoryForQuestion(story, 'tell me about the migration');
  assert.ok(themeHit >= 3);
  assert.ok(titleHit >= 2);
  assert.equal(scoreStoryForQuestion(story, 'gardening hobbies'), 0);
});

test('rankStoriesForQuestion sorts by fit and labels strong/partial', () => {
  const stories = parseStoryBank(SAMPLE);
  const ranked = rankStoriesForQuestion(stories, 'describe a leadership moment with ambiguity');
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].story.title, 'Led the analytics redesign');
  assert.equal(ranked[0].fit, 'strong'); // two theme hits → score ≥ 3
});

test('rankStoriesForQuestion respects limit and drops zero-score', () => {
  const stories = parseStoryBank(SAMPLE);
  const ranked = rankStoriesForQuestion(stories, 'conflict deadline ownership leadership', { limit: 2 });
  assert.ok(ranked.length <= 2);
  for (const r of ranked) assert.ok(r.score > 0);
});

test('coverageGaps reports themes with no story', () => {
  const stories = parseStoryBank(SAMPLE);
  const gaps = coverageGaps(stories, ['leadership', 'conflict', 'failure', 'data-driven decision']);
  // leadership + conflict are covered; failure + data-driven are not.
  assert.ok(!gaps.includes('leadership'));
  assert.ok(!gaps.includes('conflict'));
  assert.ok(gaps.includes('failure'));
  assert.ok(gaps.includes('data driven decision'));
});

/* ───── dedup + health ────────────────────────────────────────────── */

test('findStoryByTitle keys off the normalized title', () => {
  const stories = parseStoryBank(SAMPLE);
  assert.ok(findStoryByTitle(stories, '**Led the Analytics Redesign.**'));
  assert.equal(findStoryByTitle(stories, 'a story that does not exist'), null);
});

test('bankHealth summarizes counts, incompletes, unquantified, themes', () => {
  const stories = parseStoryBank(SAMPLE);
  const h = bankHealth(stories);
  assert.equal(h.count, 3);
  assert.equal(h.complete, 1); // only "Rescued the migration deadline"
  assert.equal(h.incomplete.length, 2);
  const stub = h.incomplete.find((i) => i.title === 'Half-baked story');
  assert.deepEqual(stub.missing, ['task', 'action', 'result', 'reflection']);
  assert.ok(h.themes.includes('ownership'));
  assert.ok(h.themes.includes('leadership'));
});

test('bankHealth flags a complete-but-unquantified result', () => {
  const md = `### No numbers
**Themes:** delivery
**Situation:** s
**Task:** t
**Action:** a
**Result:** It went really well and everyone was happy
**Reflection:** r`;
  const h = bankHealth(parseStoryBank(md));
  assert.equal(h.complete, 1);
  assert.deepEqual(h.unquantified, ['No numbers']);
});

/* ════════════════════════════════════════════════════════════════════
 * Competency taxonomy + validator + coverage index (interview-prep Step 5)
 * ════════════════════════════════════════════════════════════════════ */

// A complete, well-formed story in the canonical `### {Title}` + `**Themes:**`
// format. Themes use natural language that should resolve to canonical
// competencies (ownership, conflict, impact). Fictional candidate — never real
// user data (CLAUDE.md § System Layer Hygiene).
const GOOD_STORY = `### Rescued the migration deadline
**Themes:** ownership, conflict, impact
**Situation:** The data-platform migration was three weeks behind and two teams blamed each other.
**Task:** I owned the integration layer and had to unblock both teams before the quarter close.
**Action:** I mapped the dependency graph, called a joint working session, and proposed a phased cutover.
**Result:** We shipped two days before the deadline; error rate dropped 40%.
**Reflection:** I'd surface the cross-team dependency earlier — the conflict was a planning gap, not a people problem.`;

/* ───── normalizeCompetency ───────────────────────────────────────── */

test('normalizeCompetency resolves ids, aliases, substrings, and theme-style dashes', () => {
  assert.equal(normalizeCompetency('ownership'), 'ownership');         // exact id
  assert.equal(normalizeCompetency('Bias for Action'), 'ownership');   // alias, case-insensitive
  assert.equal(normalizeCompetency('led a team'), 'leadership');       // alias
  assert.equal(normalizeCompetency('we had a big disagreement'), 'conflict'); // substring
  assert.equal(normalizeCompetency('teamwork'), 'collaboration');
  // dashed theme tags (the bank writes "delivery-under-pressure") normalize too
  assert.equal(normalizeCompetency('delivery-under-pressure'), 'ownership');
  assert.equal(normalizeCompetency('data-driven'), 'analytical');
});

test('normalizeCompetency prefers the longest matching alias', () => {
  assert.equal(normalizeCompetency('stakeholder management with execs'), 'leadership');
});

test('normalizeCompetency returns null for unknown/empty tags', () => {
  assert.equal(normalizeCompetency('xyzzy'), null);
  assert.equal(normalizeCompetency(''), null);
  assert.equal(normalizeCompetency(null), null);
  assert.equal(normalizeCompetency(undefined), null);
});

/* ───── storyCompetencies ─────────────────────────────────────────── */

test('storyCompetencies resolves a story\'s themes, splitting known from unknown', () => {
  const [s] = parseStoryBank(GOOD_STORY);
  const { competencies, unknownThemes } = storyCompetencies(s);
  assert.deepEqual(competencies, ['ownership', 'conflict', 'impact']);
  assert.deepEqual(unknownThemes, []);
});

test('storyCompetencies dedups when two themes map to the same competency', () => {
  const md = `### Doubled
**Themes:** leadership, led a team, telepathy
**Situation:** s long enough here
**Task:** t long enough here
**Action:** a long enough here
**Result:** 10x long enough here
**Reflection:** r long enough here`;
  const [s] = parseStoryBank(md);
  const { competencies, unknownThemes } = storyCompetencies(s);
  assert.deepEqual(competencies, ['leadership']); // both leadership themes collapse
  assert.deepEqual(unknownThemes, ['telepathy']);
});

/* ───── validateStory ─────────────────────────────────────────────── */

test('validateStory passes a complete, competency-tagged story', () => {
  const [s] = parseStoryBank(GOOD_STORY);
  const v = validateStory(s);
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('validateStory errors on a missing STAR+R beat (the +R differentiator)', () => {
  const md = `### No reflection
**Themes:** impact
**Situation:** A real situation that is long enough.
**Task:** A real task that is long enough.
**Action:** A real action that is long enough.
**Result:** A real result with 5 numbers.`;
  const [s] = parseStoryBank(md);
  const v = validateStory(s);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /reflection/i.test(e)));
});

test('validateStory errors when no theme maps to a recognized competency', () => {
  const md = `### Untagged
**Themes:** telepathy
**Situation:** A real situation that is long enough.
**Task:** A real task that is long enough.
**Action:** A real action that is long enough.
**Result:** A real result with 7 numbers.
**Reflection:** A real reflection that is long enough.`;
  const [s] = parseStoryBank(md);
  const v = validateStory(s);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /competency/i.test(e)));
  assert.ok(v.warnings.some((w) => /telepathy/.test(w)));
});

test('validateStory warns on placeholder-length beats and unquantified Result', () => {
  const md = `### Stub
**Themes:** ownership
**Situation:** TODO
**Task:** A real task that is long enough.
**Action:** A real action that is long enough.
**Result:** It went really well overall and the team was happy
**Reflection:** A real reflection that is long enough.`;
  const [s] = parseStoryBank(md);
  const v = validateStory(s);
  assert.ok(v.warnings.some((w) => /placeholder/.test(w)));
  assert.ok(v.warnings.some((w) => /Result has no number/.test(w)));
});

/* ───── findDuplicateTitles ───────────────────────────────────────── */

test('findDuplicateTitles catches normalized title collisions (dedup rule)', () => {
  const md = `${GOOD_STORY}\n\n### **rescued the MIGRATION deadline.**
**Themes:** impact
**Situation:** Another telling of the same story.
**Task:** Same task here, long enough.
**Action:** Same action here, long enough.
**Result:** Same 40% result here.
**Reflection:** Same reflection here, long enough.`;
  const stories = parseStoryBank(md);
  const dups = findDuplicateTitles(stories);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].count, 2);
  assert.deepEqual(dups[0].indices, [0, 1]);
});

test('findDuplicateTitles returns empty when titles are unique', () => {
  const stories = parseStoryBank(GOOD_STORY);
  assert.deepEqual(findDuplicateTitles(stories), []);
});

/* ───── buildCompetencyIndex / competencyGaps ─────────────────────── */

test('buildCompetencyIndex maps competencies to covering story titles', () => {
  const stories = parseStoryBank(GOOD_STORY);
  const idx = buildCompetencyIndex(stories);
  assert.deepEqual(idx.ownership, ['Rescued the migration deadline']);
  assert.deepEqual(idx.conflict, ['Rescued the migration deadline']);
  assert.deepEqual(idx.leadership, []); // not covered
  for (const c of COMPETENCIES) assert.ok(Array.isArray(idx[c.id]));
});

test('competencyGaps lists exactly the uncovered competencies, with labels', () => {
  const stories = parseStoryBank(GOOD_STORY);
  const gaps = competencyGaps(stories);
  const gapIds = gaps.map((g) => g.id);
  assert.ok(!gapIds.includes('ownership'));
  assert.ok(!gapIds.includes('conflict'));
  assert.ok(!gapIds.includes('impact'));
  assert.ok(gapIds.includes('leadership'));
  assert.ok(gaps.find((g) => g.id === 'leadership').label.length > 0);
});

/* ───── rankStoriesByCompetency ───────────────────────────────────── */

test('rankStoriesByCompetency boosts the story that covers the target competency', () => {
  const md = `${GOOD_STORY}\n\n### Led the analytics redesign
**Themes:** leadership, ambiguity
**Situation:** The dashboard nobody trusted.
**Task:** Rebuild the metric definitions.
**Action:** Interviewed 8 stakeholders and rewrote the semantic layer.
**Result:** Adoption went from 20% to 75% in one quarter.
**Reflection:** Trust is rebuilt by transparency, not by a prettier chart.`;
  const stories = parseStoryBank(md);
  // Ask a conflict question pre-classified to the conflict competency.
  const ranked = rankStoriesByCompetency(stories, 'tell me about a disagreement', 'conflict');
  assert.equal(ranked[0].story.title, 'Rescued the migration deadline');
  assert.equal(ranked[0].viaCompetency, true);
  assert.equal(ranked[0].fit, 'strong');
});

test('rankStoriesByCompetency falls back to text scoring when no competency given', () => {
  const stories = parseStoryBank(GOOD_STORY);
  const ranked = rankStoriesByCompetency(stories, 'the migration cutover');
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].viaCompetency, false);
  assert.ok(ranked[0].score > 0);
});

// Tie stability (audit finding 12c): two stories covering the SAME competency
// with identical bodies score exactly equal. Array.prototype.sort is stable, so
// the earlier-DECLARED story must remain first. Pinned so a future re-ordering
// of the sort comparator (or a switch to an unstable sort) is caught.
test('rankStoriesByCompetency keeps declaration order on an exact score tie', () => {
  const body = [
    '**Themes:** conflict',
    '**Situation:** A cross-team disagreement stalled the roadmap.',
    '**Task:** Break the deadlock without escalating.',
    '**Action:** Ran a structured working session to align on the tradeoffs.',
    '**Result:** Reached a decision the same week; 0 re-litigation after.',
    '**Reflection:** Naming the disagreement early defuses it.',
  ].join('\n');
  const md = `# Story Bank\n\n## Stories\n\n### First declared story\n${body}\n\n### Second declared story\n${body}`;
  const stories = parseStoryBank(md);
  const ranked = rankStoriesByCompetency(stories, 'tell me about a disagreement', 'conflict');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].score, ranked[1].score); // exact tie
  assert.equal(ranked[0].story.title, 'First declared story');
  assert.equal(ranked[1].story.title, 'Second declared story');
});

/* ───── validateBank rollup ───────────────────────────────────────── */

test('validateBank ok=true for a clean single-story bank', () => {
  const r = validateBank(parseStoryBank(GOOD_STORY));
  assert.equal(r.ok, true);
  assert.equal(r.storyCount, 1);
  assert.equal(r.duplicates.length, 0);
  assert.ok(r.gaps.length > 0); // one story can't cover all competencies
  assert.equal(r.perStory[0].ok, true);
});

test('validateBank ok=false when any story is incomplete', () => {
  const bad = `### Incomplete
**Themes:** impact
**Situation:** Only a situation here, nothing else.`;
  const r = validateBank(parseStoryBank(bad));
  assert.equal(r.ok, false);
  assert.equal(r.perStory[0].ok, false);
});

test('validateBank ok=false when titles collide even if each story is complete', () => {
  const md = `${GOOD_STORY}\n\n### Rescued the migration deadline
**Themes:** impact
**Situation:** A duplicate-title telling, long enough.
**Task:** Same task, long enough here.
**Action:** Same action, long enough here.
**Result:** Same 40% drop result here.
**Reflection:** Same reflection, long enough here.`;
  const r = validateBank(parseStoryBank(md));
  assert.equal(r.ok, false);
  assert.equal(r.duplicates.length, 1);
});

test('validateBank empty bank: ok with zero stories and all competencies as gaps', () => {
  const r = validateBank(parseStoryBank(''));
  assert.equal(r.ok, true);
  assert.equal(r.storyCount, 0);
  assert.equal(r.gaps.length, COMPETENCIES.length);
});
