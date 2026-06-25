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
