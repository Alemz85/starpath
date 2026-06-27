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
  extractCompFigures,
  detectCompDisclosure,
  evaluateCompOffer,
  COMP_OFFER_HANDLING,
  detectUrgency,
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

/* ───── extractCompFigures ─────────────────────────────────────────────────── */

test('extractCompFigures pulls currency/k figures, ignores non-comp numbers', () => {
  assert.deepEqual(extractCompFigures('The band is €55k–65k for this role.'), [55000, 65000]);
  assert.deepEqual(extractCompFigures('We can offer $90,000 base.'), [90000]);
  // Headcount / dates / versions are not comp → ignored (no currency/k, <1000 or no context).
  assert.deepEqual(extractCompFigures('We have 200 engineers and ship by 2026.'), []);
  // A bare "60" with no currency/k cue is not a salary even with a comp word nearby.
  assert.deepEqual(extractCompFigures('salary review every 6 months'), []);
});

test('extractCompFigures reads a k-suffix and EU thousands dot as comp', () => {
  assert.deepEqual(extractCompFigures('base around 70k'), [70000]);
  assert.deepEqual(extractCompFigures('package of €60.000'), [60000]);
});

test('extractCompFigures shares a trailing k across a hyphenated band', () => {
  // "55-65k" = 55k–65k; the k applies to both ends, not just the second.
  assert.deepEqual(extractCompFigures('band is 55-65k'), [55000, 65000]);
  assert.deepEqual(extractCompFigures('€55-65k'), [55000, 65000]);
  assert.deepEqual(extractCompFigures('55 to 65k base'), [55000, 65000]);
  assert.deepEqual(extractCompFigures('the band is €55k–65k'), [55000, 65000]);
});

/* ───── detectCompDisclosure ───────────────────────────────────────────────── */

test('detectCompDisclosure: a stated band is a disclosure, not a question', () => {
  const d = detectCompDisclosure('The salary band for this role is €55k–65k.');
  assert.equal(d.disclosed, true);
  assert.equal(d.low, 55000);
  assert.equal(d.high, 65000);
});

test('detectCompDisclosure: a single budgeted number is a disclosure', () => {
  const d = detectCompDisclosure("We're budgeting around 60k for this position.");
  assert.equal(d.disclosed, true);
  assert.equal(d.low, 60000);
  assert.equal(d.high, 60000);
});

test('detectCompDisclosure: a pure question is NOT a disclosure', () => {
  // Has a comp ask but no number stated → not a disclosure.
  const d = detectCompDisclosure('What are your salary expectations for this role?');
  assert.equal(d.disclosed, false);
  assert.deepEqual(d.figures, []);
});

test('detectCompDisclosure: a number inside a question is not a firm disclosure', () => {
  // "can you do €50k?" carries a figure but no disclosure phrasing → treat as a
  // question/probe, not an offer on the table.
  const d = detectCompDisclosure('Can you work with €50k?');
  assert.equal(d.disclosed, false);
  assert.deepEqual(d.figures, [50000]); // figure still extracted for context
});

test('detectCompDisclosure: empty / numberless message → not disclosed', () => {
  assert.equal(detectCompDisclosure('').disclosed, false);
  assert.equal(detectCompDisclosure('Thanks for your application!').disclosed, false);
});

/* ───── evaluateCompOffer ──────────────────────────────────────────────────── */

test('evaluateCompOffer: at/above target → accept warmly', () => {
  const r = evaluateCompOffer({ low: 60000, high: 70000 }, 60000, 50000);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'at_or_above_target');
});

test('evaluateCompOffer: clears floor, under target → anchor up', () => {
  const r = evaluateCompOffer({ low: 52000, high: 55000 }, 60000, 50000);
  assert.equal(r.verdict, 'below_target');
});

test('evaluateCompOffer: top of band under floor → below_floor', () => {
  const r = evaluateCompOffer({ low: 40000, high: 45000 }, 60000, 50000);
  assert.equal(r.verdict, 'below_floor');
});

test('evaluateCompOffer: band straddling the floor → spans_floor', () => {
  const r = evaluateCompOffer({ low: 45000, high: 55000 }, 60000, 50000);
  assert.equal(r.verdict, 'spans_floor');
});

test('evaluateCompOffer: accepts a single number too, and orders low/high', () => {
  assert.equal(evaluateCompOffer(70000, 60000, 50000).verdict, 'at_or_above_target');
  // swapped inputs are normalized
  const r = evaluateCompOffer({ low: 65000, high: 55000 }, 60000, 50000);
  assert.equal(r.low, 55000);
  assert.equal(r.high, 65000);
});

test('evaluateCompOffer: floor only (no target) → clearing floor is acceptable', () => {
  const r = evaluateCompOffer({ low: 55000, high: 58000 }, null, 50000);
  assert.equal(r.verdict, 'at_or_above_target');
});

test('evaluateCompOffer: no floor/target on file → ok:false', () => {
  const r = evaluateCompOffer({ low: 55000, high: 58000 }, null, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no target\/floor/);
});

test('evaluateCompOffer: no number to evaluate → ok:false', () => {
  const r = evaluateCompOffer({ low: null, high: null }, 60000, 50000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no disclosed number/);
});

test('every COMP_OFFER_HANDLING verdict has non-empty guidance', () => {
  for (const v of ['below_floor', 'spans_floor', 'below_target', 'at_or_above_target']) {
    assert.ok(COMP_OFFER_HANDLING[v] && COMP_OFFER_HANDLING[v].length > 0, `missing ${v}`);
  }
});

/* ───── detectUrgency ──────────────────────────────────────────────────────── */

test('detectUrgency fires on a reply deadline', () => {
  assert.equal(detectUrgency('Can you get back to me by Friday?').urgent, true);
  assert.equal(detectUrgency('We need an answer ASAP.').urgent, true);
  assert.equal(detectUrgency('This role closes soon, so reply quickly.').urgent, true);
  assert.equal(detectUrgency('We are moving fast on this.').urgent, true);
});

test('detectUrgency echoes the matched cue', () => {
  const u = detectUrgency('Please respond by end of week.');
  assert.equal(u.urgent, true);
  assert.match(u.cue, /by\s+end\s+of\s+week/i);
});

test('detectUrgency stays quiet on a relaxed message', () => {
  assert.equal(detectUrgency('No rush at all — whenever works for you.').urgent, false);
  assert.equal(detectUrgency('').urgent, false);
});

/* ───── buildReplyPlan: disclosure + urgency integration ───────────────────── */

test('buildReplyPlan routes a comp disclosure to the evaluate-not-overask step', () => {
  const plan = buildReplyPlan('Good news — the band for this role is €55k–65k. Thoughts?');
  const comp = plan.steps.find((s) => s.id === 'comp');
  assert.ok(comp, 'expected a comp step');
  assert.ok(comp.compDisclosure, 'comp step should carry the disclosure');
  assert.equal(comp.compDisclosure.low, 55000);
  assert.equal(comp.compDisclosure.high, 65000);
  assert.match(comp.label, /disclosed/i);
});

test('buildReplyPlan keeps the question-handling comp step when no number is stated', () => {
  const plan = buildReplyPlan('What are your salary expectations?');
  const comp = plan.steps.find((s) => s.id === 'comp');
  assert.ok(comp);
  assert.equal(comp.compDisclosure, undefined);
  assert.equal(comp.handling, HANDLING.comp);
});

test('buildReplyPlan attaches urgency to every plan kind', () => {
  const urgent = buildReplyPlan('We are moving quickly — can you reply by Monday and share comp?');
  assert.equal(urgent.urgency.urgent, true);
  const calm = buildReplyPlan('What are your salary expectations?');
  assert.equal(calm.urgency.urgent, false);
  // urgency present on rejection + freeform shapes too
  assert.equal(buildReplyPlan('Unfortunately, not moving forward.').urgency.urgent, false);
  assert.ok('urgency' in buildReplyPlan('Hello there!'));
});
