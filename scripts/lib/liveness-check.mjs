/**
 * liveness-check.mjs — one posting URL through the whole ladder, browser last.
 *
 * Combines lib/liveness-ladder.mjs (API → board → page signals) with an
 * optional browser rung and folds the outcome into the three kinds the
 * scan-history state machine understands (lib/liveness-state.mjs):
 *
 *   active      a rung said the posting is live
 *   expired     a rung found a decisive sign it is gone
 *   unreachable nothing could be fetched (every rung that ran failed, or the
 *               browser could not load the page) — NOT "expired"
 *   uncertain   reached, but no rung could decide (and no browser was allowed)
 *
 * `via` records which rung decided: 'api-job' | 'api-board' | 'html' | 'browser'.
 */

import { climbLadder, allRungsFailed } from './liveness-ladder.mjs';

/**
 * @param {string} url
 * @param {object} deps
 * @param {{getJson:Function, getText:Function}} deps.http
 * @param {((url:string)=>Promise<{result:'active'|'expired'|'uncertain', reason:string}>)|null} [deps.browser]
 *        the Playwright rung; null/absent = ladder only. It throws when the
 *        page cannot be loaded at all (that becomes `unreachable`).
 * @param {Date} [deps.now]
 * @param {Record<string,string[]>} [deps.workdaySites] {host → sites} to resolve siteless Workday URLs
 * @returns {Promise<{url:string, kind:'active'|'expired'|'unreachable'|'uncertain', reason:string,
 *                    via:string, error?:string, jd?:object, attempted:string[]}>}
 */
export async function checkPosting(url, { http, browser = null, now = new Date(), workdaySites = {} }) {
  const ladder = await climbLadder(url, { http, now, workdaySites });
  const base = { url, attempted: ladder.attempted };

  if (ladder.verdict) {
    const { result, reason, via, jd } = ladder.verdict;
    return { ...base, kind: result, reason, via, ...(jd ? { jd } : {}) };
  }

  if (browser) {
    try {
      const r = await browser(url);
      return { ...base, attempted: [...ladder.attempted, 'browser'], kind: r.result, reason: r.reason, via: 'browser' };
    } catch (err) {
      const message = String(err?.message || err).split('\n')[0].slice(0, 200);
      return { ...base, attempted: [...ladder.attempted, 'browser'], kind: 'unreachable', reason: 'browser could not load the page', via: 'browser', error: message };
    }
  }

  if (allRungsFailed(ladder)) {
    const last = ladder.errors[ladder.errors.length - 1];
    return { ...base, kind: 'unreachable', reason: 'every rung failed to get an answer', via: 'ladder', error: `${last.rung}: ${last.message}` };
  }
  return { ...base, kind: 'uncertain', reason: ladder.hint || 'no rung could decide', via: 'ladder' };
}

/** Map a checkPosting result to the state machine's outcome (null = leave the row alone). */
export function toOutcome(check) {
  switch (check.kind) {
    case 'active': return { kind: 'active' };
    case 'expired': return { kind: 'expired', reason: { 'api-job': 'ats-api', 'api-board': 'ats-api', html: 'html', browser: 'browser' }[check.via] || check.via };
    case 'unreachable': return { kind: 'unreachable', error: check.error || check.reason };
    default: return null;
  }
}
