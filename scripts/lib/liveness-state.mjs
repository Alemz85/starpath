/**
 * liveness-state.mjs — what a liveness check does to a scan-history row.
 *
 * Three outcomes of a check, three different effects:
 *
 *   active       the posting is live → status `added`; any failure streak and any
 *                earlier `expired` verdict are cleared (a posting is revivable).
 *   expired      a DECISIVE signal (API 404, agreeing page signals, the browser
 *                saw an expired page) → status `expired`, `expired_reason` says
 *                which rung.
 *   unreachable  the check could not get an answer (network error, timeout,
 *                5xx, a blocked fetch). This is NOT evidence the posting is gone —
 *                a weekly scan that hits one bad afternoon must not kill a live
 *                posting. It records `fetch_attempts`, `first_unreachable` and a
 *                200-character `last_error`, and only becomes `expired` with
 *                `expired_reason: unreachable` once BOTH hold:
 *                  attempts ≥ N   and   (now − first_unreachable) ≥ H hours.
 *
 * N and H are configurable in user/profile.yml (scanner.liveness) because the
 * right values depend on how often the user scans:
 *
 *   weekly  (the scheduler's default cadence)   2 attempts over ≥ 240 h (10 days)
 *   daily                                       3 attempts over ≥  48 h
 *
 * Defaults are the weekly pair. With 2 attempts and 10 days, a weekly scan needs
 * three failed checks in a row (day 0, 7, 14) before it calls a posting dead.
 *
 * Pure: rows in, rows out. check-liveness.mjs owns the file IO.
 */

import { canonicalizeUrl } from './merge-staging-core.mjs';
import { getCell, setCells } from './scan-history.mjs';

export const DEFAULT_POLICY = Object.freeze({ attempts: 2, hours: 240 });

const posInt = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : null);

/**
 * Read `scanner.liveness.unreachable_attempts` / `unreachable_hours` from a
 * parsed user/profile.yml. Anything missing or invalid falls back per field.
 * @param {object|null|undefined} profile
 */
export function readLivenessPolicy(profile) {
  const cfg = profile?.scanner?.liveness || {};
  return {
    attempts: posInt(cfg.unreachable_attempts) ?? DEFAULT_POLICY.attempts,
    hours: posInt(cfg.unreachable_hours) ?? DEFAULT_POLICY.hours,
  };
}

const FIELDS = ['status', 'expired_reason', 'fetch_attempts', 'first_unreachable', 'last_error'];
const CLEARED = { expired_reason: '', fetch_attempts: '', first_unreachable: '', last_error: '' };

/**
 * Apply one check outcome to a row's liveness fields.
 *
 * @param {Partial<Record<typeof FIELDS[number], string>>} cur current cell values
 * @param {{kind:'active'|'expired'|'unreachable', reason?:string, error?:string}} outcome
 * @param {{now: Date, policy?: {attempts:number, hours:number}}} ctx
 * @returns {Record<typeof FIELDS[number], string>} the full new values
 */
export function applyCheck(cur, outcome, { now, policy = DEFAULT_POLICY }) {
  const status = cur.status || 'added';
  if (outcome.kind === 'active') return { status: 'added', ...CLEARED };
  if (outcome.kind === 'expired') {
    return { status: 'expired', ...CLEARED, expired_reason: String(outcome.reason || 'unknown').slice(0, 60) };
  }
  // unreachable
  if (status === 'expired' && cur.expired_reason && cur.expired_reason !== 'unreachable') {
    // Already declared dead by a decisive signal: a failed fetch changes nothing.
    return { status, expired_reason: cur.expired_reason, fetch_attempts: '', first_unreachable: '', last_error: '' };
  }
  const attempts = (Number(cur.fetch_attempts) || 0) + 1;
  const firstMs = Date.parse(cur.first_unreachable || '');
  const first = Number.isFinite(firstMs) ? new Date(firstMs) : now;
  const hoursSince = (now.getTime() - first.getTime()) / 3_600_000;
  const dead = attempts >= policy.attempts && hoursSince >= policy.hours;
  return {
    status: dead ? 'expired' : status,
    expired_reason: dead ? 'unreachable' : (cur.expired_reason || ''),
    fetch_attempts: String(attempts),
    first_unreachable: first.toISOString(),
    last_error: String(outcome.error || '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200),
  };
}

/**
 * Apply a batch of check outcomes to scan-history rows, matching rows by
 * canonical URL. Returns the new rows array plus what changed.
 *
 * @param {string[]} rows raw data lines
 * @param {string[]} columns the file's header
 * @param {Array<{url:string, outcome:object}>} checks
 * @param {{now: Date, policy?: object}} ctx
 * @returns {{rows: string[], changes: Array<{url:string, before:string, after:string, reason:string}>, unmatched: string[]}}
 */
export function applyChecks(rows, columns, checks, { now, policy = DEFAULT_POLICY }) {
  const out = rows.slice();
  const byUrl = new Map();
  out.forEach((row, i) => {
    const u = canonicalizeUrl(getCell(row, columns, 'url'));
    if (u && !byUrl.has(u)) byUrl.set(u, i);
  });
  const changes = [];
  const unmatched = [];
  for (const { url, outcome } of checks) {
    const idx = byUrl.get(canonicalizeUrl(url));
    if (idx === undefined) { unmatched.push(url); continue; }
    const cur = Object.fromEntries(FIELDS.map((f) => [f, getCell(out[idx], columns, f)]));
    const next = applyCheck(cur, outcome, { now, policy });
    const patch = {};
    for (const f of FIELDS) if ((cur[f] || '') !== (next[f] || '')) patch[f] = next[f];
    if (Object.keys(patch).length) {
      out[idx] = setCells(out[idx], columns, patch);
      changes.push({ url, before: cur.status || 'added', after: next.status, reason: next.expired_reason || outcome.kind });
    }
  }
  return { rows: out, changes, unmatched };
}
