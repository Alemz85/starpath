// apply-core.test.mjs — unit suite for the pure answer-drafting logic behind
// modes/apply.md: question→recipe classification, the Step 5G self-check gates
// (concrete / banned phrase / length / walk-away), and the cross-form proof-point
// ledger (Step 5D "don't reuse the same proof twice").
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs` (picked up by the gate).
//
// apply-core composes on lib/story-bank.mjs (via mock-interview-core's
// inferCompetency) so a couple of tests confirm the behavioral path tags a
// competency exactly as the shared taxonomy would.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECIPES,
  BANNED_PHRASES,
  LENGTH_TARGETS,
  classifyQuestion,
  scanForBannedPhrases,
  hasConcrete,
  lengthCheck,
  createProofLedger,
  proofKey,
  recordProofUse,
  overusedProofs,
  selfCheck,
} from './apply-core.mjs';

/* ───── classifyQuestion ──────────────────────────────────────────────────── */

test('classifyQuestion: logistics wins even when wrapped in prose', () => {
  // The mode's "logística primero" rule: a comp ask is logistics, not a cover letter.
  const c = classifyQuestion('What are your salary expectations for this role?');
  assert.equal(c.type, 'logistics');
  assert.equal(c.recipe, '5F');
  assert.equal(c.competency, null);
  assert.equal(c.defaulted, false);
});

test('classifyQuestion: visa / work-authorization → logistics', () => {
  assert.equal(classifyQuestion('Are you authorized to work in the country?').type, 'logistics');
  assert.equal(classifyQuestion('Do you require visa sponsorship?').type, 'logistics');
  assert.equal(classifyQuestion('What is your notice period?').type, 'logistics');
  assert.equal(classifyQuestion('Are you willing to relocate?').type, 'logistics');
});

test('classifyQuestion: behavioral question tags a competency from the shared taxonomy', () => {
  const c = classifyQuestion('Tell me about a time you had a conflict with a stakeholder.');
  assert.equal(c.type, 'behavioral');
  assert.equal(c.recipe, '5A');
  assert.equal(c.competency, 'conflict');
});

test('classifyQuestion: "describe a time you failed…" → behavioral (competency best-effort)', () => {
  // Routing is the contract: it's a behavioral field regardless of whether the
  // shared taxonomy can infer the competency from the un-stemmed verb "failed"
  // (it tags it null here — the agent still pulls a failure story by reading the
  // prompt; the classifier never blocks on inference).
  const c = classifyQuestion('Describe a time you failed and what you learned.');
  assert.equal(c.type, 'behavioral');
  assert.equal(c.recipe, '5A');
  // The noun form does resolve, confirming the wiring to the shared taxonomy.
  assert.equal(classifyQuestion('Tell me about a failure you owned.').competency, 'failure');
});

test('classifyQuestion: motivation prompt → 5B motivation', () => {
  assert.equal(classifyQuestion('Why do you want to work here?').type, 'motivation');
  assert.equal(classifyQuestion('Why this role specifically?').type, 'motivation');
  assert.equal(classifyQuestion('What attracts you to our company?').type, 'motivation');
});

test('classifyQuestion: fit prompt → 5B fit (distinct from motivation)', () => {
  const c = classifyQuestion('Why are you a good fit for this position?');
  assert.equal(c.type, 'fit');
  assert.equal(c.recipe, '5B');
});

test('classifyQuestion: explicit cover-letter label → coverletter', () => {
  assert.equal(classifyQuestion('Cover letter').type, 'coverletter');
  assert.equal(classifyQuestion("Anything else you'd like us to know?").type, 'coverletter');
});

test('classifyQuestion: a big unlabeled text box defaults to coverletter', () => {
  const c = classifyQuestion('Your message', { charLimit: 2000 });
  assert.equal(c.type, 'coverletter');
  assert.equal(c.defaulted, true);
});

test('classifyQuestion: unknown short field defaults to motivation (flagged)', () => {
  const c = classifyQuestion('Tell us something');
  assert.equal(c.type, 'motivation');
  assert.equal(c.defaulted, true);
});

test('classifyQuestion: compound field surfaces a secondary recipe', () => {
  // "why this role AND what's your biggest strength" — two moves, not one.
  const c = classifyQuestion('Why this role, and why are you a good fit?');
  assert.equal(c.type, 'motivation'); // first in table order
  assert.equal(c.secondary, 'fit'); // the second distinct recipe
});

test('classifyQuestion: every recipe id has full metadata', () => {
  for (const id of Object.keys(RECIPES)) {
    const r = RECIPES[id];
    assert.equal(r.id, id);
    assert.ok(r.recipe && r.label && r.source && r.shape, `recipe ${id} fully populated`);
  }
});

/* ───── scanForBannedPhrases ──────────────────────────────────────────────── */

test('scanForBannedPhrases: clean answer returns []', () => {
  assert.deepEqual(scanForBannedPhrases('I cut onboarding time by 40% on the billing service.'), []);
});

test('scanForBannedPhrases: catches a hard-banned cliché', () => {
  const found = scanForBannedPhrases("I'm passionate about distributed systems.");
  assert.deepEqual(found, ['passionate about']);
});

test('scanForBannedPhrases: multiple bans reported in appearance order', () => {
  const found = scanForBannedPhrases('A results-driven team player who can hit the ground running.');
  assert.deepEqual(found, ['results-driven', 'team player', 'hit the ground running']);
});

test('scanForBannedPhrases: longest phrase wins, no double-report of sub-phrase', () => {
  // "i believe i would be a great fit" contains "i would be a great fit" — report once.
  const found = scanForBannedPhrases('I believe I would be a great fit for this team.');
  assert.deepEqual(found, ['i believe i would be a great fit']);
});

test('scanForBannedPhrases: case-insensitive', () => {
  assert.deepEqual(scanForBannedPhrases('SYNERGY across teams'), ['synergy']);
});

test('BANNED_PHRASES is non-empty and all lowercase', () => {
  assert.ok(BANNED_PHRASES.length > 10);
  for (const p of BANNED_PHRASES) assert.equal(p, p.toLowerCase());
});

/* ───── hasConcrete ───────────────────────────────────────────────────────── */

test('hasConcrete: a number always counts', () => {
  const r = hasConcrete('Grew adoption from 20% to 75% in one quarter.');
  assert.equal(r.ok, true);
  assert.equal(r.via, 'number');
});

test('hasConcrete: a dollar metric counts', () => {
  assert.equal(hasConcrete('Saved $1.2M in cloud spend.').via, 'number');
});

test('hasConcrete: a 3x-style multiplier counts', () => {
  assert.equal(hasConcrete('Improved throughput 3x.').ok, true);
});

test('hasConcrete: a CV proper-noun proof token counts when no number', () => {
  const r = hasConcrete('I rebuilt the Atlas pipeline end to end.', { proofVocab: ['atlas'] });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'proof');
  assert.equal(r.matched, 'atlas');
});

test('hasConcrete: a JD term counts as a last-resort concrete', () => {
  const r = hasConcrete('My work centered on retrieval-augmented generation.', {
    proofVocab: [],
    jdVocab: ['retrieval-augmented generation'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'jd');
});

test('hasConcrete: prose with no number and no known token fails', () => {
  const r = hasConcrete('I really enjoy solving hard problems with great people.', {
    proofVocab: ['atlas'],
    jdVocab: ['kubernetes'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.via, null);
});

test('hasConcrete: empty answer fails cleanly', () => {
  assert.equal(hasConcrete('').ok, false);
  assert.equal(hasConcrete('   ').ok, false);
});

/* ───── lengthCheck ───────────────────────────────────────────────────────── */

function repeatWords(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

test('lengthCheck: behavioral answer within band is ok', () => {
  const r = lengthCheck(repeatWords(80), 'behavioral');
  assert.equal(r.verdict, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.words, 80);
});

test('lengthCheck: too-short behavioral flagged short', () => {
  assert.equal(lengthCheck(repeatWords(10), 'behavioral').verdict, 'short');
});

test('lengthCheck: too-long behavioral flagged long', () => {
  assert.equal(lengthCheck(repeatWords(300), 'behavioral').verdict, 'long');
});

test('lengthCheck: over a visible character limit is a hard fail', () => {
  const text = repeatWords(40); // within behavioral word band but...
  const r = lengthCheck(text, 'behavioral', { charLimit: 10 });
  assert.equal(r.overCharLimit, true);
  assert.equal(r.ok, false);
});

test('lengthCheck: unknown type falls back to motivation band', () => {
  const r = lengthCheck(repeatWords(60), 'mystery');
  assert.equal(r.target, LENGTH_TARGETS.motivation);
});

/* ───── proof-point ledger (Step 5D cross-form reuse) ─────────────────────── */

test('proofKey: normalizes case / punctuation / spacing', () => {
  assert.equal(proofKey('Migration Rescue!'), 'migration rescue');
  assert.equal(proofKey('migration-rescue'), 'migration rescue');
});

test('recordProofUse: first use is fresh, no reuse reported', () => {
  const { ledger, reused } = recordProofUse(createProofLedger(), ['Migration rescue']);
  assert.deepEqual(reused, []);
  assert.equal(ledger.used['migration rescue'], 1);
  assert.deepEqual(ledger.order, ['migration rescue']);
});

test('recordProofUse: reusing across answers flags it with the prior count', () => {
  let { ledger } = recordProofUse(createProofLedger(), ['Capstone project']);
  const step = recordProofUse(ledger, ['Capstone Project']); // same proof, different casing
  assert.equal(step.reused.length, 1);
  assert.equal(step.reused[0].priorCount, 1);
  assert.equal(step.ledger.used['capstone project'], 2);
});

test('recordProofUse: using the same proof twice in ONE answer counts once', () => {
  const { ledger, reused } = recordProofUse(createProofLedger(), ['Atlas', 'atlas!']);
  assert.deepEqual(reused, []); // intra-answer dup isn't a cross-answer reuse
  assert.equal(ledger.used['atlas'], 1);
});

test('recordProofUse: does not mutate the input ledger', () => {
  const l0 = createProofLedger();
  recordProofUse(l0, ['X']);
  assert.deepEqual(l0, createProofLedger()); // unchanged
});

test('overusedProofs: flags proofs leaned on more than once, worst first', () => {
  let { ledger } = recordProofUse(createProofLedger(), ['A', 'B']);
  ({ ledger } = recordProofUse(ledger, ['A']));
  ({ ledger } = recordProofUse(ledger, ['A', 'B']));
  const over = overusedProofs(ledger); // A used 3x, B 2x
  assert.deepEqual(over, [
    { key: 'a', count: 3 },
    { key: 'b', count: 2 },
  ]);
});

/* ───── selfCheck (Step 5G gate composition) ──────────────────────────────── */

test('selfCheck: a clean prose answer passes every gate', () => {
  // A behavioral answer needs to clear the 50-word floor as well as the concrete
  // and banned-phrase gates, so the fixture is a full STAR+R-shaped paragraph.
  const answer =
    'On the Atlas pipeline I owned the latency problem nobody had picked up. The cache layer was ' +
    'thrashing under load, so I profiled the hot path, reworked the eviction policy, and shipped a ' +
    'staged rollout behind a flag. p95 latency dropped from 800ms to 120ms within two weeks, and the ' +
    'on-call pages for that service went to zero. The lasting lesson was to instrument before guessing.';
  const r = selfCheck({
    answer,
    type: 'behavioral',
    proofVocab: ['atlas'],
    proofIds: ['Atlas latency fix'],
    ledger: createProofLedger(),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.gates.concrete, true);
  assert.equal(r.gates.noBanned, true);
  assert.equal(r.gates.noReuse, true);
});

test('selfCheck: no concrete + banned phrase + reuse all reported together', () => {
  let ledger = createProofLedger();
  ({ ledger } = recordProofUse(ledger, ['Capstone']));
  const r = selfCheck({
    answer: "I'm passionate about building great products with great people.",
    type: 'motivation',
    proofVocab: ['atlas'],
    proofIds: ['Capstone'], // already used → reuse
    ledger,
  });
  assert.equal(r.ok, false);
  assert.equal(r.gates.concrete, false);
  assert.equal(r.gates.noBanned, false);
  assert.equal(r.gates.noReuse, false);
  assert.ok(r.reasons.length >= 3);
});

test('selfCheck: logistics field is exempt from the concrete + length gates', () => {
  const r = selfCheck({
    answer: 'My target range is the upper band; authorized to work without sponsorship.',
    type: 'logistics',
  });
  assert.equal(r.ok, true);
  assert.equal(r.gates.concrete, true); // exempt → treated as satisfied
  assert.equal(r.gates.length, true);
});

test('selfCheck: logistics still fails on a leaked walk-away', () => {
  const r = selfCheck({
    answer: 'My absolute minimum is 30000; I would not go below that.',
    type: 'logistics',
    leakedWalkaway: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.gates.noWalkaway, false);
  assert.match(r.reasons.join(' '), /walk-away/i);
});

test('selfCheck: over the char limit fails even with a concrete', () => {
  const r = selfCheck({
    answer: 'Cut churn by 30% on the Atlas product line over two quarters of focused work.',
    type: 'fit',
    proofVocab: ['atlas'],
    charLimit: 20,
    proofIds: ['Atlas churn'],
    ledger: createProofLedger(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.gates.length, false);
});

test('selfCheck: returns an updated ledger to thread into the next answer', () => {
  const r = selfCheck({
    answer: 'Shipped the Orion dashboard; weekly active users rose 18%.',
    type: 'behavioral',
    proofVocab: ['orion'],
    proofIds: ['Orion dashboard'],
    ledger: createProofLedger(),
  });
  assert.equal(r.ledger.used['orion dashboard'], 1);
  // Threading the returned ledger into a second use flags the reuse.
  const r2 = selfCheck({
    answer: 'Again on Orion, I drove a 22% lift in retention.',
    type: 'behavioral',
    proofVocab: ['orion'],
    proofIds: ['Orion dashboard'],
    ledger: r.ledger,
  });
  assert.equal(r2.gates.noReuse, false);
});

test('selfCheck: defaults are safe — empty call does not throw and reports gaps', () => {
  const r = selfCheck({});
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.reasons));
  assert.ok(r.ledger && typeof r.ledger === 'object');
});
