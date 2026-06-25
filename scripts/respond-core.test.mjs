// Unit tests for respond-core.mjs — the recruiter-reply classifier + comp framing.
//
// These pin the router (which asks a message contains, in canonical order), the
// rejection short-circuit, the comp-range anchoring rules (the money-losing ask),
// and the status suggestion the mode hands the pipeline. Pure, zero-dep:
//   node --test scripts/respond-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_TYPES,
  detectAsks,
  detectAskIds,
  isRejection,
  parseCompNumber,
  compRange,
  handlingFor,
  buildReplyPlan,
  suggestedStatus,
  HANDLING,
} from './respond-core.mjs';

/* ───── detectAsks ─────────────────────────────────────────────────────────── */

test('detects comp + availability + scheduling in one bundled message', () => {
  const msg =
    "Thanks for applying! What are your salary expectations, and when could you start? " +
    "Happy to set up a quick call next week.";
  const ids = detectAskIds(msg);
  assert.ok(ids.includes('comp'));
  assert.ok(ids.includes('availability'));
  assert.ok(ids.includes('scheduling'));
});

test('returns asks in canonical ASK_TYPES order regardless of message order', () => {
  // Scheduling appears textually before comp, but comp comes first in the taxonomy.
  const msg = "Can we book a call? Also, what is your compensation expectation?";
  const ids = detectAskIds(msg);
  const order = ASK_TYPES.map((a) => a.id);
  // ids must be a subsequence of the canonical order
  let last = -1;
  for (const id of ids) {
    const i = order.indexOf(id);
    assert.ok(i > last, `${id} out of canonical order`);
    last = i;
  }
  assert.deepEqual(ids.indexOf('comp') < ids.indexOf('scheduling'), true);
});

test('empty / whitespace message yields no asks', () => {
  assert.deepEqual(detectAsks(''), []);
  assert.deepEqual(detectAsks('   \n  '), []);
  assert.deepEqual(detectAsks(null), []);
});

test('take-home assignment is detected', () => {
  assert.ok(detectAskIds('We have a short take-home exercise for you.').includes('takehome'));
  assert.ok(detectAskIds('Please complete the coding challenge by Friday.').includes('takehome'));
});

test('screening "why us" question is detected', () => {
  assert.ok(detectAskIds('Quick one: why are you interested in this role?').includes('screening'));
  assert.ok(detectAskIds('How many years of experience do you have with Python?').includes('screening'));
});

test('logistics: work authorization + CV asks detected', () => {
  assert.ok(detectAskIds('Could you confirm your work authorization?').includes('logistics'));
  assert.ok(detectAskIds('Can you send your latest CV?').includes('logistics'));
});

test('a currency figure alone triggers the comp ask', () => {
  assert.ok(detectAskIds('We are budgeting around €60k for this — does that work?').includes('comp'));
});

/* ───── rejection short-circuit ────────────────────────────────────────────── */

test('isRejection fires on common rejection phrasings', () => {
  assert.ok(isRejection('Unfortunately we have decided not to move forward.'));
  assert.ok(isRejection('We have decided to go in a different direction.'));
  assert.ok(isRejection('We regret to inform you that we chose other candidates.'));
  assert.ok(!isRejection('We would love to move forward with a call!'));
});

test('buildReplyPlan short-circuits a rejection to a single graceful step', () => {
  const plan = buildReplyPlan(
    'Unfortunately we decided not to proceed. We will keep your CV on file.',
  );
  assert.equal(plan.kind, 'rejection');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, 'rejection');
  assert.equal(plan.steps[0].handling, HANDLING.decline_gracefully);
});

test('buildReplyPlan falls back to freeform when no cue matches', () => {
  const plan = buildReplyPlan('Great to e-meet you! Looking forward to the journey ahead.');
  assert.equal(plan.kind, 'freeform');
  assert.equal(plan.steps[0].id, 'freeform');
});

test('buildReplyPlan emits one step per ask, in canonical order, with handling', () => {
  const plan = buildReplyPlan('When can you start and what are your salary expectations?');
  assert.equal(plan.kind, 'reply');
  const ids = plan.steps.map((s) => s.id);
  assert.deepEqual(ids, ['comp', 'availability']); // comp before availability in taxonomy
  for (const s of plan.steps) assert.ok(s.handling && s.handling.length > 0);
});

/* ───── comp parsing + framing ─────────────────────────────────────────────── */

test('parseCompNumber handles numbers, k-suffix, separators, and junk', () => {
  assert.equal(parseCompNumber(55000), 55000);
  assert.equal(parseCompNumber('55k'), 55000);
  assert.equal(parseCompNumber('55K'), 55000);
  assert.equal(parseCompNumber('55,000'), 55000);
  assert.equal(parseCompNumber('€55.000'), 55000); // EU thousands dot
  assert.equal(parseCompNumber('  60 000 '), 60000);
  assert.equal(parseCompNumber(''), null);
  assert.equal(parseCompNumber(null), null);
  assert.equal(parseCompNumber('competitive'), null);
});

test('compRange anchors low at target and gives a real spread', () => {
  const r = compRange(60000, 50000);
  assert.equal(r.ok, true);
  assert.equal(r.low, 60000); // anchored at target, not at the 50k floor
  assert.ok(r.high > r.low);
  assert.equal(r.high, 69000); // 60000 * 1.15
});

test('compRange never goes below a floor that exceeds the target', () => {
  // Floor raised above an old target → respect the floor as the hard minimum.
  const r = compRange(50000, 58000);
  assert.equal(r.low, 58000);
  assert.ok(r.high > r.low);
});

test('compRange defers (ok:false) when no target is on file', () => {
  const r = compRange(null, 50000);
  assert.equal(r.ok, false);
  assert.equal(r.low, null);
  assert.match(r.reason, /no target/);
});

test('compRange parses string inputs from profile.yml', () => {
  const r = compRange('55k', '48k');
  assert.equal(r.low, 55000);
  assert.equal(r.high, 63250); // 55000 * 1.15
});

test('compRange guarantees a non-degenerate range even for tiny targets', () => {
  const r = compRange(100, null, { spreadHigh: 1.0 });
  assert.ok(r.high > r.low); // minSpread kicks in
});

/* ───── handlingFor ────────────────────────────────────────────────────────── */

test('handlingFor resolves every ask id to non-empty guidance', () => {
  for (const a of ASK_TYPES) {
    const h = handlingFor(a.id);
    assert.ok(h && h.length > 0, `no handling for ${a.id}`);
  }
  assert.equal(handlingFor('nope'), null);
});

/* ───── suggestedStatus ────────────────────────────────────────────────────── */

test('suggestedStatus maps the reply to a canonical pipeline status', () => {
  assert.equal(suggestedStatus('Unfortunately not moving forward.'), 'Rejected');
  assert.equal(suggestedStatus("Let's set up a call next week."), 'Interview');
  assert.equal(suggestedStatus('We have a take-home assignment for you.'), 'Interview');
  assert.equal(suggestedStatus('What are your salary expectations?'), 'Responded');
  assert.equal(suggestedStatus('Thanks, received your application.'), 'Responded');
});
