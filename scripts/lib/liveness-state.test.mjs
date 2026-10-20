/**
 * liveness-state.test.mjs — unreachable ≠ expired: the attempts × time-horizon
 * policy, revival, and how a check lands in scan-history rows.
 *
 * Run: node --test scripts/lib/liveness-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCheck, applyChecks, readLivenessPolicy, DEFAULT_POLICY } from './liveness-state.mjs';
import { HISTORY_COLUMNS, buildHistoryRow, getCell } from './scan-history.mjs';

const at = (iso) => new Date(iso);
const FAIL = { kind: 'unreachable', error: 'connect ETIMEDOUT' };

/** Walk a row's fields through a series of [isoTime, outcome] checks. */
function walk(checks, policy) {
  let cur = { status: 'added' };
  const trace = [];
  for (const [when, outcome] of checks) {
    cur = applyCheck(cur, outcome, { now: at(when), policy });
    trace.push(cur.status + (cur.expired_reason ? `:${cur.expired_reason}` : ''));
  }
  return { cur, trace };
}

test('defaults suit the weekly scheduler: 2 attempts over >= 10 days', () => {
  assert.deepEqual(DEFAULT_POLICY, { attempts: 2, hours: 240 });
});

test('weekly scan: day 0, 7 and 14 — only the third failure expires it', () => {
  const { trace, cur } = walk([
    ['2026-10-01T09:00:00Z', FAIL],
    ['2026-10-08T09:00:00Z', FAIL], // 2 attempts but only 168 h
    ['2026-10-15T09:00:00Z', FAIL], // 3 attempts, 336 h
  ], DEFAULT_POLICY);
  assert.deepEqual(trace, ['added', 'added', 'expired:unreachable']);
  assert.equal(cur.fetch_attempts, '3');
  assert.equal(cur.first_unreachable, '2026-10-01T09:00:00.000Z');
});

test('daily scan: 3 attempts over >= 48 h', () => {
  const policy = { attempts: 3, hours: 48 };
  const { trace } = walk([
    ['2026-10-01T09:00:00Z', FAIL],
    ['2026-10-02T09:00:00Z', FAIL],
    ['2026-10-03T08:00:00Z', FAIL], // 3 attempts but 47 h
    ['2026-10-03T09:00:00Z', FAIL], // 4 attempts, 48 h
  ], policy);
  assert.deepEqual(trace, ['added', 'added', 'added', 'expired:unreachable']);
});

test('both conditions are required: many attempts too soon, or a long gap with one attempt, do not expire', () => {
  const quick = walk([['2026-10-01T09:00:00Z', FAIL], ['2026-10-01T10:00:00Z', FAIL], ['2026-10-01T11:00:00Z', FAIL], ['2026-10-01T12:00:00Z', FAIL]], DEFAULT_POLICY);
  assert.equal(quick.cur.status, 'added');
  const once = walk([['2026-10-01T09:00:00Z', FAIL]], { attempts: 2, hours: 1 });
  assert.equal(once.cur.status, 'added');
});

test('a failure records attempts, the first failure time and a last error capped at 200 chars', () => {
  const next = applyCheck({ status: 'added' }, { kind: 'unreachable', error: 'x'.repeat(500) + '\nsecond line' }, { now: at('2026-10-01T09:00:00Z') });
  assert.equal(next.fetch_attempts, '1');
  assert.equal(next.last_error.length, 200);
  assert.ok(!next.last_error.includes('\n'));
  assert.equal(next.status, 'added');
});

test('a successful check clears the streak', () => {
  const next = applyCheck({ status: 'added', fetch_attempts: '2', first_unreachable: '2026-10-01T09:00:00.000Z', last_error: 'boom' }, { kind: 'active' }, { now: at('2026-10-09T09:00:00Z') });
  assert.deepEqual(next, { status: 'added', expired_reason: '', fetch_attempts: '', first_unreachable: '', last_error: '' });
});

test('revivable: an unreachable-expired posting that answers again is active again', () => {
  const dead = { status: 'expired', expired_reason: 'unreachable', fetch_attempts: '3', first_unreachable: '2026-10-01T09:00:00.000Z', last_error: 'x' };
  assert.equal(applyCheck(dead, { kind: 'active' }, { now: at('2026-11-01T00:00:00Z') }).status, 'added');
});

test('a decisive expiry is final against later failed fetches, and records its rung', () => {
  const dead = applyCheck({ status: 'added' }, { kind: 'expired', reason: 'ats-api' }, { now: at('2026-10-01T09:00:00Z') });
  assert.deepEqual([dead.status, dead.expired_reason], ['expired', 'ats-api']);
  const still = applyCheck(dead, FAIL, { now: at('2026-10-20T09:00:00Z') });
  assert.deepEqual([still.status, still.expired_reason, still.fetch_attempts], ['expired', 'ats-api', '']);
});

test('policy comes from user/profile.yml › scanner.liveness, field by field with safe fallbacks', () => {
  assert.deepEqual(readLivenessPolicy(null), DEFAULT_POLICY);
  assert.deepEqual(readLivenessPolicy({ scanner: { liveness: { unreachable_attempts: 3, unreachable_hours: 48 } } }), { attempts: 3, hours: 48 });
  assert.deepEqual(readLivenessPolicy({ scanner: { liveness: { unreachable_attempts: 0, unreachable_hours: 'soon' } } }), DEFAULT_POLICY);
  assert.deepEqual(readLivenessPolicy({ scanner: { liveness: { unreachable_hours: 72 } } }), { attempts: 2, hours: 72 });
});

test('applyChecks writes the verdict into the matching scan-history row (by canonical URL)', () => {
  const row = (url) => buildHistoryRow({ url, source: 'greenhouse-api', title: 'Analyst', company: 'Nimbus Robotics', location: 'Aldervale' }, '2026-10-01', HISTORY_COLUMNS);
  const rows = [row('https://boards.example.com/a'), row('https://boards.example.com/b')];
  const { rows: next, changes, unmatched } = applyChecks(rows, HISTORY_COLUMNS, [
    { url: 'https://boards.example.com/a?utm_source=feed', outcome: { kind: 'expired', reason: 'html' } },
    { url: 'https://boards.example.com/b', outcome: FAIL },
    { url: 'https://boards.example.com/zzz', outcome: { kind: 'active' } },
  ], { now: at('2026-10-20T09:00:00Z') });
  assert.equal(getCell(next[0], HISTORY_COLUMNS, 'status'), 'expired');
  assert.equal(getCell(next[0], HISTORY_COLUMNS, 'expired_reason'), 'html');
  assert.equal(getCell(next[1], HISTORY_COLUMNS, 'status'), 'added');
  assert.equal(getCell(next[1], HISTORY_COLUMNS, 'fetch_attempts'), '1');
  assert.equal(getCell(next[1], HISTORY_COLUMNS, 'last_error'), 'connect ETIMEDOUT');
  assert.deepEqual(unmatched, ['https://boards.example.com/zzz']);
  assert.equal(changes.length, 2);
});

test('applyChecks pads old short rows and is a no-op when nothing changes', () => {
  const old = 'https://boards.example.com/a\t2026-10-01\tgreenhouse-api\tAnalyst\tNimbus\tAldervale\tadded\t2026-10-01';
  const { rows, changes } = applyChecks([old], HISTORY_COLUMNS, [{ url: 'https://boards.example.com/a', outcome: { kind: 'active' } }], { now: at('2026-10-20T09:00:00Z') });
  assert.equal(rows[0], old);
  assert.equal(changes.length, 0);
});
