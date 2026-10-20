/**
 * liveness-ladder.mjs — is this posting still open? Cheapest evidence first.
 *
 * Playwright costs seconds and a browser per URL, and a fixed wait still guesses.
 * Most postings sit on an ATS that answers the question over plain HTTP, so the
 * browser is the LAST rung:
 *
 *   1. per-job API   The ATS's own single-posting endpoint (hard-coded API host,
 *                    safe path segments only — lib/ats-url.mjs).
 *                    200 for that posting → active.  404/410 → expired.
 *   2. org board     The org's full board listing still lists the posting's id
 *                    → active. (Absence is NOT proof: unlisted postings exist.)
 *   3. posting HTML  The public page, judged on SIGNALS, two of which must agree:
 *                      active:  JobPosting JSON-LD · an apply control · a body long
 *                               enough to be a job description
 *                      expired: HTTP 404/410 · a redirect to ?error=true ·
 *                               an "no longer available" phrase · a listing-page
 *                               phrase · JSON-LD validThrough in the past
 *                    One signal, or signals that disagree → no verdict.
 *   4. (caller)      `null` = ambiguous → run the browser (check-liveness.mjs).
 *
 * `climbLadder` returns `{verdict, errors, attempted}`; `resolvePosting` returns
 * just the verdict (`null` on anything ambiguous). Network failures never become
 * `expired` here: they are collected in `errors` so the caller can apply the
 * unreachable policy (lib/liveness-state.mjs).
 *
 * Rungs 1 and 2 also return the posting's JD, which is what
 * scripts/fetch-posting.mjs hands to batch workers instead of a WebFetch.
 *
 * All IO is the injected `http` (lib/http.mjs `createHttp()`), so the whole
 * ladder is tested with a fake.
 */

import { parsePostingUrl, postingApiUrls } from './ats-url.mjs';
import { resolveDeadline, cleanId } from './listing-fields.mjs';
import { matchExpiredText, matchListingText, hasApplyControl } from '../liveness-core.mjs';
import { parsePostingDate } from '../scan-core.mjs';

const MIN_DESCRIPTION_CHARS = 1200;

// ── HTML → text and signals ─────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Tags stripped, scripts/styles dropped, common entities decoded, whitespace collapsed. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|ul|ol)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? ' ';
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Greenhouse ships `content` as entity-encoded HTML (`&lt;p&gt;…`): undo one level of escaping. */
function unescapeOnce(s) {
  return String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The JobPosting objects in a page's JSON-LD blocks ([] when none/unparseable). */
export function jobPostingsFromJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      const type = [].concat(node['@type'] || []).map(String);
      if (type.includes('JobPosting')) out.push(node);
      if (node['@graph']) stack.push(node['@graph']);
    }
  }
  return out;
}

/** Labels of the page's links/buttons (raw HTML, no DOM). */
function controlLabels(html) {
  const labels = [];
  const re = /<(a|button)\b[^>]*>([\s\S]*?)<\/\1>|<input\b[^>]*type=["'](?:submit|button)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    labels.push(htmlToText(m[2] ?? m[3] ?? ''));
    if (labels.length > 400) break;
  }
  return labels.filter(Boolean);
}

/**
 * Judge a fetched posting page. Returns `{result:'active'|'expired'|null, signals, reason}`.
 * Two agreeing signals decide; anything else is null.
 *
 * @param {{status:number, headers?:object, text?:string}} res
 * @param {{now?: Date}} [opts]
 */
export function judgePostingHtml(res, { now = new Date() } = {}) {
  const html = res.text || '';
  const text = htmlToText(html);
  const active = [];
  const expired = [];

  if (res.status === 404 || res.status === 410) expired.push(`http-${res.status}`);
  const location = String(res.headers?.location || '');
  if (res.status >= 300 && res.status < 400) {
    if (/[?&]error=true/i.test(location)) expired.push('redirect-status', 'redirect-error');
    return finish(active, expired);
  }
  if (matchExpiredText(text)) expired.push('expired-text');
  if (matchListingText(text)) expired.push('listing-page');

  const posts = jobPostingsFromJsonLd(html);
  if (posts.length) {
    const past = posts.every((p) => {
      const t = Date.parse(p.validThrough);
      return Number.isFinite(t) && t < now.getTime();
    });
    if (past) expired.push('valid-through-past'); else active.push('jsonld-jobposting');
  }
  if (res.status >= 200 && res.status < 300) {
    if (hasApplyControl(controlLabels(html))) active.push('apply-control');
    if (text.length >= MIN_DESCRIPTION_CHARS) active.push('long-body');
  }
  return finish(active, expired);

  function finish(a, e) {
    // Any contrary signal makes the page ambiguous: active needs zero expired
    // signals, expired needs zero active ones.
    if (a.length >= 2 && e.length === 0) return { result: 'active', signals: a, reason: `page signals agree: ${a.join(' + ')}` };
    if (e.length >= 2 && a.length === 0) return { result: 'expired', signals: e, reason: `page signals agree: ${e.join(' + ')}` };
    return { result: null, signals: [...a, ...e], reason: 'page signals insufficient or conflicting' };
  }
}

// ── JD extraction (what the per-job endpoints return) ───────────────────────

const clip = (s, n = 60_000) => String(s ?? '').slice(0, n);

/** Normalised JD from a per-job (or board-entry) payload. */
export function extractJd(ats, json) {
  const o = json || {};
  let title = '';
  let location = '';
  let body = '';
  let posted = null;
  let deadlineFields = [];
  switch (ats) {
    case 'greenhouse':
      title = o.title; location = o.location?.name; body = unescapeOnce(o.content); posted = o.first_published || o.updated_at;
      deadlineFields = [o.application_deadline];
      break;
    case 'lever':
      title = o.text; location = o.categories?.location;
      body = [o.descriptionPlain, ...(o.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), o.additionalPlain].filter(Boolean).join('\n\n');
      posted = o.createdAt;
      break;
    case 'smartrecruiters': {
      title = o.name; location = o.location?.fullLocation || o.location?.city; posted = o.releasedDate;
      const sections = o.jobAd?.sections || {};
      body = Object.values(sections).map((s) => `${s?.title || ''}\n${s?.text || ''}`).join('\n\n');
      break;
    }
    case 'workday': {
      const i = o.jobPostingInfo || {};
      title = i.title; location = i.location; body = i.jobDescription; posted = i.startDate; deadlineFields = [i.endDate];
      break;
    }
    case 'ashby':
      title = o.title; location = o.location; body = o.descriptionPlain || o.descriptionHtml; posted = o.publishedAt;
      break;
    default:
      break;
  }
  const description = clip(htmlToText(body));
  return {
    title: String(title ?? '').trim(),
    location: String(location ?? '').trim(),
    description,
    postedDate: parsePostingDate(posted) || '',
    deadline: resolveDeadline(deadlineFields, description) || '',
  };
}

// ── The ladder ──────────────────────────────────────────────────────────────

const sameId = (a, b) => cleanId(a) !== '' && cleanId(a) === cleanId(b);

/** Does a per-job 200 payload actually describe the posting we asked about? */
function perJobMatches(ats, json, id) {
  if (!json || typeof json !== 'object') return false;
  switch (ats) {
    case 'greenhouse': return sameId(json.id, id);
    case 'lever': return sameId(json.id, id);
    case 'smartrecruiters': return sameId(json.id, id) || sameId(json.refNumber, id);
    case 'workday': return Boolean(json.jobPostingInfo);
    default: return false;
  }
}

function boardEntries(boardType, json) {
  if (boardType === 'lever') return Array.isArray(json) ? json : [];
  return Array.isArray(json?.jobs) ? json.jobs : [];
}

/**
 * Run the ladder for one posting URL.
 *
 * @param {string} url
 * @param {{http: {getJson:Function, getText:Function}, now?: Date}} deps
 * @returns {Promise<{verdict: null | {result:'active'|'expired', reason:string, via:'api-job'|'api-board'|'html', jd?:object},
 *                    errors: Array<{rung:string, message:string, status:number|null}>, attempted: string[], ats: string|null}>}
 */
export async function climbLadder(url, { http, now = new Date() }) {
  const errors = [];
  const attempted = [];
  const parsed = parsePostingUrl(url);
  if (!parsed) return { verdict: null, errors, attempted, ats: null };
  const api = postingApiUrls(parsed, url);
  const note = (rung, err) => errors.push({ rung, message: String(err?.message || err).slice(0, 200), status: err?.status ?? null });

  // 1. per-job API
  if (api.perJob) {
    attempted.push('api-job');
    try {
      const json = await http.getJson(api.perJob, { type: parsed.ats, retries: 1 });
      if (perJobMatches(parsed.ats, json, parsed.id)) {
        return {
          verdict: { result: 'active', reason: `${parsed.ats} per-job API returned the posting`, via: 'api-job', jd: extractJd(parsed.ats, json) },
          errors, attempted, ats: parsed.ats,
        };
      }
    } catch (err) {
      if (err?.status === 404 || err?.status === 410) {
        return {
          verdict: { result: 'expired', reason: `${parsed.ats} per-job API: HTTP ${err.status}`, via: 'api-job' },
          errors, attempted, ats: parsed.ats,
        };
      }
      note('api-job', err);
    }
  }

  // 2. org board still lists the id
  if (api.board) {
    attempted.push('api-board');
    try {
      const json = await http.getJson(api.board, { type: parsed.ats, retries: 1 });
      const hit = boardEntries(api.boardType, json).find((j) => sameId(j?.id, parsed.id));
      if (hit) {
        return {
          verdict: { result: 'active', reason: `${parsed.ats} board still lists the posting`, via: 'api-board', jd: extractJd(parsed.ats, hit) },
          errors, attempted, ats: parsed.ats,
        };
      }
      // Not listed: NOT proof of closure (unlisted postings exist). Next rung.
    } catch (err) {
      note('api-board', err);
    }
  }

  // 3. the page itself, on agreeing signals
  attempted.push('html');
  try {
    const res = await http.getText(api.html, { type: parsed.ats });
    const judged = judgePostingHtml(res, { now });
    if (judged.result) {
      return { verdict: { result: judged.result, reason: judged.reason, via: 'html' }, errors, attempted, ats: parsed.ats };
    }
  } catch (err) {
    note('html', err);
  }

  return { verdict: null, errors, attempted, ats: parsed.ats };
}

/** The verdict only: `{result, reason, via, jd?}` or `null` on anything ambiguous. */
export async function resolvePosting(url, deps) {
  return (await climbLadder(url, deps)).verdict;
}

/** True when every rung that ran failed to get an answer (nothing but errors). */
export function allRungsFailed({ verdict, errors, attempted }) {
  return !verdict && attempted.length > 0 && errors.length >= attempted.length;
}
