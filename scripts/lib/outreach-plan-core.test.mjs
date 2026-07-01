// outreach-plan-core.test.mjs — unit suite for the contacto pre-flight dossier.
//
// Run: node --test scripts/lib/outreach-plan-core.test.mjs   (or `npm test`)
// Picked up by the gate's `node --test "scripts/**/*.test.mjs"` glob.
//
// NO HARDCODED USER DATA: every fixture below is fictional (Acme/Globex,
// "Ada Lovelace", etc.) — it exercises the algorithm, not any real person.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normName,
  companyThreads,
  annotatePaths,
  recommendPlay,
  pickStoryAmmo,
  hookSource,
  assemblePlan,
  renderPlan,
  PLAY_LABEL,
} from './outreach-plan-core.mjs';

const TODAY = '2026-07-01';

/* ───── fixtures ─────────────────────────────────────────────────── */

// Collapsed outreach-log rows (shape from outreach-cadence.mjs `collapse`).
function touch(over = {}) {
  return {
    company: 'Acme',
    role: 'Strategy Analyst',
    contact: 'Ada Lovelace',
    title: 'Hiring Manager',
    channel: 'Message',
    lastTouch: '2026-06-29',
    touches: 1,
    outcome: 'Pending',
    notes: '',
    ...over,
  };
}

// Ranked referral paths (shape from network-core pathsForCompany().contacts).
function path(over = {}) {
  return {
    name: 'Grace Hopper',
    company: 'Acme',
    title: 'Data Engineer',
    relationship: 'strong',
    degree: 1,
    via: '',
    lastContact: '2026-06-01',
    warmth: 3.6,
    leverage: 'peer',
    ...over,
  };
}

/* ───── normName ─────────────────────────────────────────────────── */

test('normName lowercases and collapses whitespace', () => {
  assert.equal(normName('  Ada   LOVELACE '), 'ada lovelace');
  assert.equal(normName(null), '');
});

/* ───── companyThreads ───────────────────────────────────────────── */

test('companyThreads filters by normalized company key and classifies', () => {
  const rows = [
    touch({ company: 'Acme Corp.', contact: 'Ada Lovelace', lastTouch: '2026-06-20' }), // 11d ago → nudge
    touch({ company: 'Globex', contact: 'Max Planck' }),
  ];
  const threads = companyThreads(rows, 'acme-corp', TODAY);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].contact, 'Ada Lovelace');
  assert.equal(threads[0].action, 'nudge');
});

test('companyThreads returns [] when nothing matches', () => {
  assert.deepEqual(companyThreads([touch({ company: 'Globex' })], 'Acme', TODAY), []);
  assert.deepEqual(companyThreads([], 'Acme', TODAY), []);
  assert.deepEqual(companyThreads(null, 'Acme', TODAY), []);
});

/* ───── annotatePaths ────────────────────────────────────────────── */

test('annotatePaths marks threaded contacts and leaves the rest untouched', () => {
  const threads = companyThreads([touch({ contact: 'Grace Hopper', lastTouch: '2026-06-30' })], 'Acme', TODAY);
  const out = annotatePaths([path(), path({ name: 'Alan Turing' })], threads);
  assert.equal(out[0].thread.action, 'waiting'); // sent yesterday → on track
  assert.equal(out[0].thread.touches, 1);
  assert.equal(out[1].thread, null);
});

test('annotatePaths matches names case/space-insensitively', () => {
  const threads = companyThreads([touch({ contact: '  grace  HOPPER ' })], 'Acme', TODAY);
  const out = annotatePaths([path()], threads);
  assert.ok(out[0].thread);
});

/* ───── recommendPlay: the decision ladder ───────────────────────── */

test('a replied thread wins over everything → reply-handoff', () => {
  const threads = companyThreads([
    touch({ contact: 'Ada Lovelace', outcome: 'Replied', lastTouch: '2026-06-20' }),
    touch({ contact: 'Max Planck', lastTouch: '2026-06-10' }), // overdue nudge
  ], 'Acme', TODAY);
  const rec = recommendPlay({ paths: annotatePaths([path()], threads), threads });
  assert.equal(rec.play, 'reply-handoff');
  assert.equal(rec.target.name, 'Ada Lovelace');
});

test('a due nudge beats an untouched warm path, which becomes a caution', () => {
  const threads = companyThreads([touch({ lastTouch: '2026-06-10' })], 'Acme', TODAY); // 21d → nudge
  const rec = recommendPlay({ paths: annotatePaths([path()], threads), threads });
  assert.equal(rec.play, 'nudge');
  assert.equal(rec.target.name, 'Ada Lovelace');
  assert.ok(rec.cautions.some((c) => c.includes('Grace Hopper')));
});

test('untouched 1st-degree path → warm-direct', () => {
  const rec = recommendPlay({ paths: annotatePaths([path()], []), threads: [] });
  assert.equal(rec.play, 'warm-direct');
  assert.equal(rec.target.name, 'Grace Hopper');
  assert.match(rec.channel, /Direct message/);
});

test('untouched 2nd-degree path → warm-intro naming the bridge', () => {
  const p = path({ degree: 2, via: 'Alan Turing', warmth: 2.2 });
  const rec = recommendPlay({ paths: annotatePaths([p], []), threads: [] });
  assert.equal(rec.play, 'warm-intro');
  assert.match(rec.channel, /Alan Turing/);
  assert.equal(rec.target.via, 'Alan Turing');
});

test('warm path over an on-track thread, but the thread is flagged', () => {
  const threads = companyThreads([touch({ contact: 'Max Planck', lastTouch: '2026-06-30' })], 'Acme', TODAY);
  const rec = recommendPlay({ paths: annotatePaths([path()], threads), threads });
  assert.equal(rec.play, 'warm-direct');
  assert.ok(rec.cautions.some((c) => c.includes('Max Planck')));
});

test('only an on-track thread → wait', () => {
  const threads = companyThreads([touch({ lastTouch: '2026-06-30' })], 'Acme', TODAY);
  const rec = recommendPlay({ paths: [], threads });
  assert.equal(rec.play, 'wait');
  assert.equal(rec.target.name, 'Ada Lovelace');
});

test('nothing known → cold-search with no target', () => {
  const rec = recommendPlay({ paths: [], threads: [] });
  assert.equal(rec.play, 'cold-search');
  assert.equal(rec.target, null);
  assert.match(rec.reason, /No mapped contact/);
});

test('every path exhausted (cold thread) → cold-search + do-not-re-touch caution', () => {
  // Recruiter at 2 touches on the message family → cold (ceiling 2).
  const threads = companyThreads(
    [touch({ contact: 'Grace Hopper', title: 'Recruiter', touches: 2, lastTouch: '2026-06-10' })],
    'Acme', TODAY,
  );
  assert.equal(threads[0].action, 'cold');
  const rec = recommendPlay({ paths: annotatePaths([path()], threads), threads });
  assert.equal(rec.play, 'cold-search');
  assert.match(rec.reason, /NEW person/);
  assert.ok(rec.cautions.some((c) => c.includes('do not re-touch') && c.includes('Grace Hopper')));
});

/* ───── pickStoryAmmo ────────────────────────────────────────────── */

const STORIES = [
  {
    title: 'Automated the data pipeline',
    titleKey: 'automated the data pipeline',
    themes: ['ownership', 'data driven'],
    situation: 's', task: 't', action: 'a',
    result: 'Cut processing time 40%',
    reflection: 'r',
  },
  {
    title: 'Ran the customer workshop',
    titleKey: 'ran the customer workshop',
    themes: ['communication'],
    situation: 's', task: 't', action: 'a',
    result: 'Everyone left happy',
    reflection: 'r',
  },
];

test('pickStoryAmmo ranks stories against the role titles and flags unquantified results', () => {
  const ammo = pickStoryAmmo(STORIES, ['Data Analyst'], { limit: 3 });
  assert.ok(ammo.length >= 1);
  assert.equal(ammo[0].title, 'Automated the data pipeline');
  assert.equal(ammo[0].quantified, true);
  const workshop = pickStoryAmmo(STORIES, ['Customer Success Manager']);
  assert.equal(workshop[0].title, 'Ran the customer workshop');
  assert.equal(workshop[0].quantified, false);
});

test('pickStoryAmmo is empty for no roles or no stories', () => {
  assert.deepEqual(pickStoryAmmo(STORIES, []), []);
  assert.deepEqual(pickStoryAmmo([], ['Data Analyst']), []);
});

/* ───── hookSource ───────────────────────────────────────────────── */

test('hookSource prefers fresh research, then stale, then report, then none', () => {
  assert.equal(hookSource({ exists: true, state: 'fresh', valid: true }, { exists: true }).source, 'research-fresh');
  assert.equal(hookSource({ exists: true, state: 'stale', ageDays: 44, valid: true }, {}).source, 'research-stale');
  assert.equal(hookSource({ exists: true, state: 'fresh', valid: false }, { exists: true, path: 'reports/tier-2/x.md' }).source, 'report');
  assert.equal(hookSource({ exists: false }, { exists: false }).source, 'none');
});

/* ───── assemblePlan + renderPlan ────────────────────────────────── */

test('assemblePlan wires everything together with honest counts', () => {
  const threads = companyThreads([touch({ contact: 'Grace Hopper', lastTouch: '2026-06-30' })], 'Acme', TODAY);
  const plan = assemblePlan({
    company: 'Acme',
    roles: [{ role: 'Data Analyst', score: 8.1, source: 'application' }],
    paths: [path(), path({ name: 'Alan Turing', warmth: 2.0 })],
    threads,
    research: { exists: true, state: 'fresh', ageDays: 3, valid: true, path: 'data/companies/acme.md' },
    report: { exists: true, path: 'reports/tier-1/Acme - Data Analyst.md', tier: 1 },
    prep: { exists: false },
    stories: STORIES,
    today: TODAY,
  });
  assert.equal(plan.inPipeline, true);
  assert.equal(plan.counts.paths, 2);
  assert.equal(plan.counts.untouchedPaths, 1); // Grace has a thread
  assert.equal(plan.counts.threads, 1);
  assert.equal(plan.recommendation.play, 'warm-direct');
  assert.equal(plan.recommendation.target.name, 'Alan Turing'); // Grace is threaded
  assert.equal(plan.ingredients.hook.source, 'research-fresh');
  assert.ok(plan.ingredients.storyAmmo.length >= 1);
});

test('assemblePlan on an empty world recommends cold-search and stays calm', () => {
  const plan = assemblePlan({ company: 'Globex', today: TODAY });
  assert.equal(plan.inPipeline, false);
  assert.equal(plan.recommendation.play, 'cold-search');
  assert.equal(plan.ingredients.hook.source, 'none');
  assert.deepEqual(plan.ingredients.storyAmmo, []);
});

test('renderPlan produces a readable dashboard with the play and the rules', () => {
  const plan = assemblePlan({
    company: 'Acme',
    roles: [{ role: 'Data Analyst', score: 8.1, source: 'application' }],
    paths: [path()],
    threads: [],
    research: { exists: false },
    report: { exists: false },
    prep: { exists: true, path: 'interview-prep/Acme - Data Analyst.md' },
    stories: STORIES,
    today: TODAY,
  });
  const text = renderPlan(plan);
  assert.match(text, /Outreach plan — Acme/);
  assert.match(text, new RegExp(PLAY_LABEL['warm-direct'].split(' — ')[0]));
  assert.match(text, /Grace Hopper/);
  assert.match(text, /user\/cv\.md/); // proof always read at draft time
  assert.match(text, /draft only/i); // never sends
});

test('renderPlan flags speculative outreach when not in the pipeline', () => {
  const text = renderPlan(assemblePlan({ company: 'Globex', today: TODAY }));
  assert.match(text, /speculative outreach/);
  assert.match(text, /COLD SEARCH/);
});
