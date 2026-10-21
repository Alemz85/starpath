/**
 * provider-registry.mjs — loads the scanner's ATS providers from
 * `scripts/providers/*.mjs`.
 *
 * A provider is a module whose default export is
 *
 *   {
 *     id:      string                    // 'greenhouse' — also the transport `type`
 *                                        //   (ATS host allowlist) and the scan-history
 *                                        //   portal `<id>-api`
 *     detect(entry) → api | null         // does this portals.yml entry belong to me?
 *                                        //   `api` is an object with at least `url`;
 *                                        //   set `explicit: true` when the entry's own
 *                                        //   `api:` field named me (beats a URL guess)
 *     fetch(entry, ctx) → Job[]          // all current postings of the board (see job.mjs)
 *     enrich?(jobs, ctx) → Job[]         // optional: costly per-posting detail calls,
 *                                        //   run only on the jobs that survived dedup
 *     dedupKey?(job) → string            // optional identity key; default is
 *                                        //   `<id>-api:<externalId>`
 *     boardFeed?: {timeoutMs?, maxBytes?} // optional: the board request needs more
 *                                        //   than the client defaults (a huge feed);
 *                                        //   capped by http.mjs › LIMITS
 *   }
 *
 * Providers never touch the network directly. `ctx` carries the guarded helpers
 * from lib/http.mjs, already bound to the provider's own ATS type (so a provider
 * can only reach its own hosts), plus `api` (the detect result), `maxPages` and
 * `sleep`. The board request itself goes through `getBoardJson` / `postBoardJson`,
 * which carry the board's timeout and body cap (boardFeedLimits); per-posting
 * detail calls keep the client defaults. A static test greps the provider sources for bare `fetch(` / `http`
 * imports.
 *
 * Loading is alphabetical by file name, so priority between providers is
 * deterministic. A module that fails to import or has the wrong shape is
 * skipped with a reason — it never fails the scan.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parallelFetch } from './parallel.mjs';
import { DEFAULTS as HTTP_DEFAULTS, LIMITS as HTTP_LIMITS, clampLimit } from './http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROVIDERS_DIR = join(HERE, '..', 'providers');

export const DEFAULT_MAX_PAGES = 150;

/** Why a candidate is not a valid provider, or '' when it is. */
export function providerProblem(p) {
  if (!p || typeof p !== 'object') return 'default export is not an object';
  if (typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(p.id)) return 'id must be a lowercase slug';
  if (typeof p.detect !== 'function') return 'detect(entry) is missing';
  if (typeof p.fetch !== 'function') return 'fetch(entry, ctx) is missing';
  if (p.enrich !== undefined && typeof p.enrich !== 'function') return 'enrich must be a function';
  if (p.dedupKey !== undefined && typeof p.dedupKey !== 'function') return 'dedupKey must be a function';
  if (p.boardFeed !== undefined && (!p.boardFeed || typeof p.boardFeed !== 'object')) return 'boardFeed must be an object';
  return '';
}

/**
 * Load every provider module in `dir`, alphabetically.
 *
 * @param {{dir?: string, log?: (line:string)=>void}} [opts]
 * @returns {Promise<{providers: object[], skipped: Array<{file:string, reason:string}>}>}
 */
export async function loadProviders({ dir = PROVIDERS_DIR, log = () => {} } = {}) {
  const providers = [];
  const skipped = [];
  if (!existsSync(dir)) return { providers, skipped };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !f.startsWith('_'))
    .sort();
  const ids = new Set();
  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(dir, file)).href);
    } catch (err) {
      skipped.push({ file, reason: `import failed: ${String(err?.message || err).split('\n')[0]}` });
      continue;
    }
    const problem = providerProblem(mod?.default);
    if (problem) {
      skipped.push({ file, reason: problem });
      continue;
    }
    if (ids.has(mod.default.id)) {
      skipped.push({ file, reason: `duplicate provider id "${mod.default.id}"` });
      continue;
    }
    ids.add(mod.default.id);
    providers.push(mod.default);
  }
  for (const s of skipped) log(`  ! provider ${s.file} skipped — ${s.reason}`);
  return { providers, skipped };
}

/**
 * Which provider handles this portals.yml entry? Every provider is asked, in
 * registry order; an `explicit` match (the entry's own `api:` field) beats an
 * inferred one (a careers_url guess), and ties go to the first in registry
 * order. A provider whose detect() throws is treated as "no match".
 *
 * @returns {{provider: object, api: object} | null}
 */
export function detectProvider(entry, providers) {
  let inferred = null;
  for (const provider of providers) {
    let api = null;
    try {
      api = provider.detect(entry);
    } catch {
      api = null;
    }
    if (!api || typeof api !== 'object' || typeof api.url !== 'string' || !api.url) continue;
    if (api.explicit) return { provider, api };
    if (!inferred) inferred = { provider, api };
  }
  return inferred;
}

/**
 * Timeout and body cap for a board's own request (the posting list), never the
 * per-posting detail calls. Starts from the client defaults, raised by the
 * provider's `boardFeed` (Lever and Workday feeds can be huge or slow), then by
 * the `portals.yml` entry's own `board_timeout_s` / `board_max_mb` (for one
 * board that is bigger still). Every value is capped by http.mjs › LIMITS;
 * anything that is not a positive number is ignored. Host allowlists and the
 * private-address guard are untouched: this only sizes the request.
 *
 * @returns {{timeoutMs:number, maxBytes:number}}
 */
export function boardFeedLimits(provider, entry) {
  const feed = (provider && typeof provider.boardFeed === 'object' && provider.boardFeed) || {};
  let timeoutMs = clampLimit(feed.timeoutMs, HTTP_DEFAULTS.timeoutMs, HTTP_LIMITS.maxTimeoutMs);
  let maxBytes = clampLimit(feed.maxBytes, HTTP_DEFAULTS.maxBytes, HTTP_LIMITS.maxBytes);
  const secs = Number(entry?.board_timeout_s);
  if (entry?.board_timeout_s != null && Number.isFinite(secs) && secs > 0) {
    timeoutMs = clampLimit(secs * 1000, timeoutMs, HTTP_LIMITS.maxTimeoutMs);
  }
  const mb = Number(entry?.board_max_mb);
  if (entry?.board_max_mb != null && Number.isFinite(mb) && mb > 0) {
    maxBytes = clampLimit(Math.round(mb * 1024 * 1024), maxBytes, HTTP_LIMITS.maxBytes);
  }
  return { timeoutMs, maxBytes };
}

/**
 * Build the ctx handed to a provider. `http` is the guarded client from
 * lib/http.mjs; its calls are bound to this provider's ATS type unless the
 * provider names another (which the host allowlist then refuses if unknown).
 *
 * @param {object} provider
 * @param {{http:{getJson:Function, postJson:Function}, api?:object, entry?:object,
 *          maxPages?:number, sleep?:(ms:number)=>Promise<void>, log?:Function}} deps
 *        `entry` is the portals.yml entry (for its board_timeout_s / board_max_mb).
 */
export function makeProviderCtx(provider, { http, api, entry, maxPages = DEFAULT_MAX_PAGES, sleep, log = () => {} }) {
  const withType = (opts) => ({ ...(opts || {}), type: opts?.type || provider.id });
  const board = boardFeedLimits(provider, entry);
  // The board's limits are the floor of what a board call gets; an explicit
  // per-call option still wins (and http.mjs still caps it).
  const withBoard = (opts) => withType({ ...board, ...(opts || {}) });
  return {
    api,
    maxPages,
    board,
    sleep: sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    log,
    getJson: (url, opts) => http.getJson(url, withType(opts)),
    postJson: (url, body, opts) => http.postJson(url, body, withType(opts)),
    /** The board's own posting-list request: carries the board's timeout and body cap. */
    getBoardJson: (url, opts) => http.getJson(url, withBoard(opts)),
    postBoardJson: (url, body, opts) => http.postJson(url, body, withBoard(opts)),
    parallel: parallelFetch,
  };
}

/** The identity key for a job under its provider. '' when it has none. */
export function jobDedupKey(provider, job, source) {
  if (provider && typeof provider.dedupKey === 'function') {
    try {
      const k = provider.dedupKey(job);
      if (typeof k === 'string' && k) return k;
    } catch { /* fall through to the default */ }
  }
  const id = String(job?.externalId ?? '').trim();
  return id ? `${String(source ?? `${provider?.id}-api`).toLowerCase()}:${id}` : '';
}
