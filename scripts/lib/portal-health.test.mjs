/**
 * portal-health.test.mjs — dead-board memory: three real 404s → skip 30 days;
 * everything else is not a 404; an empty file means every board is healthy.
 *
 * Run: node --test scripts/lib/portal-health.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealth, serializeHealth, recordOutcome, shouldSkip, longEmptyBoards, boardKey, HEALTH_HEADER } from './portal-health.mjs';

const B = boardKey('greenhouse', 'https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs');
const rec = (map, outcome, today, error = '') => recordOutcome(map, { board: B, company: 'Nimbus Robotics', provider: 'greenhouse', outcome, today, error });

test('three consecutive real 404s skip the board for 30 days; the skip window ends on its date', () => {
  const m = new Map();
  rec(m, '404', '2026-10-01', 'HTTP 404');
  rec(m, '404', '2026-10-08', 'HTTP 404');
  assert.equal(shouldSkip(m, B, '2026-10-09').skip, false, 'two are not enough');
  rec(m, '404', '2026-10-15', 'HTTP 404');
  assert.equal(m.get(B).skip_until, '2026-11-14');
  assert.equal(shouldSkip(m, B, '2026-10-22').skip, true);
  assert.equal(shouldSkip(m, B, '2026-11-13').skip, true);
  assert.equal(shouldSkip(m, B, '2026-11-14').skip, false, 'probed again on the skip_until date');
  // another 404 on the probe skips it for another 30 days
  rec(m, '404', '2026-11-14', 'HTTP 404');
  assert.equal(m.get(B).skip_until, '2026-12-14');
});

test('network errors, timeouts, 429 and 5xx are `error`: they never build a dead-board streak', () => {
  const m = new Map();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) rec(m, 'error', d, 'HTTP 503');
  assert.equal(m.get(B).consecutive_404, 0);
  assert.equal(m.get(B).consecutive_errors, 4);
  assert.equal(shouldSkip(m, B, '2026-10-05').skip, false);
});

test('an error between two 404s does not reset the 404 streak; a success clears everything', () => {
  const m = new Map();
  rec(m, '404', '2026-10-01');
  rec(m, 'error', '2026-10-02', 'ETIMEDOUT');
  rec(m, '404', '2026-10-03');
  assert.equal(m.get(B).consecutive_404, 2);
  rec(m, 'ok', '2026-10-04');
  assert.equal(m.has(B), false, 'healthy again → no row');
});

test('an empty board is counted, resets the 404 streak, and is surfaced after three scans — but never skipped', () => {
  const m = new Map();
  rec(m, '404', '2026-10-01');
  rec(m, 'empty', '2026-10-02');
  assert.equal(m.get(B).consecutive_404, 0);
  rec(m, 'empty', '2026-10-09');
  assert.equal(longEmptyBoards(m).length, 0);
  rec(m, 'empty', '2026-10-16');
  assert.equal(longEmptyBoards(m).length, 1);
  assert.equal(shouldSkip(m, B, '2026-10-17').skip, false);
});

test('the file round-trips; no problem boards means a header-only file (all healthy)', () => {
  const m = new Map();
  rec(m, '404', '2026-10-01', 'HTTP 404\twith a tab');
  const text = serializeHealth(m);
  assert.equal(text.split('\n')[0], HEALTH_HEADER);
  const back = parseHealth(text);
  assert.equal(back.get(B).consecutive_404, 1);
  assert.equal(back.get(B).last_error, 'HTTP 404 with a tab');
  assert.equal(serializeHealth(new Map()), HEALTH_HEADER + '\n');
  assert.equal(parseHealth(HEALTH_HEADER + '\n').size, 0);
  assert.equal(parseHealth('').size, 0);
  assert.equal(parseHealth(undefined).size, 0);
});

test('last_error is capped at 200 characters', () => {
  const m = new Map();
  rec(m, 'error', '2026-10-01', 'x'.repeat(900));
  assert.equal(m.get(B).last_error.length, 200);
});
