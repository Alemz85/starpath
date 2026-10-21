/**
 * provider-registry.test.mjs — the provider plugin contract: alphabetical load
 * order, malformed modules skipped (never fatal), detection priority, the ctx
 * handed to a provider, and the rule that providers never fetch directly.
 *
 * Run: node --test scripts/lib/provider-registry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProviders, detectProvider, makeProviderCtx, providerProblem, jobDedupKey, PROVIDERS_DIR, DEFAULT_MAX_PAGES,
  boardFeedLimits,
} from './provider-registry.mjs';
import { DEFAULTS as HTTP_DEFAULTS, LIMITS as HTTP_LIMITS } from './http.mjs';
import lever, { BOARD_FEED as LEVER_FEED } from '../providers/lever.mjs';
import workday, { BOARD_FEED as WORKDAY_FEED } from '../providers/workday.mjs';
import { normalizeJob, normalizeSalary } from './job.mjs';
import { parseAshby } from '../providers/ashby.mjs';

const provider = (id, extra = '') => `export default { id: '${id}', detect(e) { return e.kind === '${id}' ? { url: 'https://x.example/${id}' } : null; }, async fetch() { return []; }${extra} };\n`;

function tmpProviders(files) {
  const dir = mkdtempSync(join(tmpdir(), 'providers-'));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return dir;
}

test('the built-in providers load alphabetically (deterministic priority)', async () => {
  const { providers, skipped } = await loadProviders();
  assert.deepEqual(providers.map((p) => p.id), ['ashby', 'greenhouse', 'lever', 'smartrecruiters', 'workday']);
  assert.deepEqual(skipped, []);
  for (const p of providers) assert.equal(providerProblem(p), '');
});

test('order follows the file name, not the id, whatever the directory listing order', async () => {
  const dir = tmpProviders({
    'zeta.mjs': provider('alpha'),
    'beta.mjs': provider('omega'),
    'alpha.mjs': provider('zulu'),
  });
  try {
    const { providers } = await loadProviders({ dir });
    assert.deepEqual(providers.map((p) => p.id), ['zulu', 'omega', 'alpha']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed provider is skipped with a reason; the scan keeps going', async () => {
  const dir = tmpProviders({
    'a-good.mjs': provider('good'),
    'b-syntax.mjs': 'export default { id: "x", detect( {',
    'c-no-detect.mjs': "export default { id: 'nodetect', async fetch() { return []; } };\n",
    'd-bad-id.mjs': "export default { id: 'Bad Id!', detect() { return null; }, async fetch() { return []; } };\n",
    'e-not-object.mjs': 'export default 42;\n',
    'f-bad-enrich.mjs': provider('badenrich', ', enrich: 5'),
    'g-dup.mjs': provider('good'),
    'h-good-too.mjs': provider('fine'),
    '_helper.mjs': 'throw new Error("never imported");\n',
    'notes.txt': 'ignored',
    'i.test.mjs': 'throw new Error("never imported");\n',
  });
  const lines = [];
  try {
    const { providers, skipped } = await loadProviders({ dir, log: (l) => lines.push(l) });
    assert.deepEqual(providers.map((p) => p.id), ['good', 'fine']);
    assert.deepEqual(skipped.map((s) => s.file), ['b-syntax.mjs', 'c-no-detect.mjs', 'd-bad-id.mjs', 'e-not-object.mjs', 'f-bad-enrich.mjs', 'g-dup.mjs']);
    assert.match(skipped[0].reason, /^import failed/);
    assert.match(skipped[1].reason, /detect/);
    assert.match(skipped[5].reason, /duplicate provider id/);
    assert.equal(lines.length, 6, 'each skip is logged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing providers directory is an empty registry, not a crash', async () => {
  const { providers } = await loadProviders({ dir: join(tmpdir(), 'no-such-providers-dir') });
  assert.deepEqual(providers, []);
});

test('detection: an explicit api: field beats a careers_url guess; ties go to registry order', async () => {
  const { providers } = await loadProviders();
  const pick = (entry) => detectProvider(entry, providers)?.provider.id ?? null;
  assert.equal(pick({ careers_url: 'https://jobs.ashbyhq.com/lumen-demo' }), 'ashby');
  assert.equal(pick({ careers_url: 'https://jobs.lever.co/harborlight-demo' }), 'lever');
  assert.equal(pick({ careers_url: 'https://job-boards.greenhouse.io/nimbus-demo' }), 'greenhouse');
  assert.equal(pick({ careers_url: 'https://contoso.wd3.myworkdayjobs.com/ext' }), 'workday');
  assert.equal(pick({ api: 'https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs', careers_url: 'https://jobs.ashbyhq.com/lumen-demo' }), 'greenhouse', 'explicit api wins although ashby sorts first');
  assert.equal(pick({ api: 'https://api.smartrecruiters.com/v1/companies/orchard/postings' }), 'smartrecruiters');
  assert.equal(pick({ careers_url: 'https://careers.example.com/jobs' }), null);
  assert.equal(pick({}), null);
  // a slug with path tricks is refused rather than interpolated into an API URL
  assert.equal(pick({ careers_url: 'https://jobs.lever.co/..%2Fadmin' }), null);
});

test('detection: a provider whose detect() throws counts as "no match"', () => {
  const boom = { id: 'boom', detect() { throw new Error('x'); }, async fetch() { return []; } };
  const ok = { id: 'ok', detect: () => ({ url: 'https://x.example/ok' }), async fetch() { return []; } };
  assert.equal(detectProvider({}, [boom, ok]).provider.id, 'ok');
  assert.equal(detectProvider({}, [boom]), null);
  const bad = { id: 'bad', detect: () => ({ nourl: 1 }), async fetch() { return []; } };
  assert.equal(detectProvider({}, [bad]), null, 'a detect result needs a url');
});

test('the provider ctx binds the guarded helpers to the provider\'s own ATS type', async () => {
  const calls = [];
  const http = {
    getJson: async (url, opts) => { calls.push(['get', url, opts]); return {}; },
    postJson: async (url, body, opts) => { calls.push(['post', url, opts]); return {}; },
  };
  const ctx = makeProviderCtx({ id: 'lever' }, { http, api: { url: 'u' }, sleep: async () => {} });
  await ctx.getJson('https://api.lever.co/x');
  await ctx.postJson('https://api.lever.co/y', {}, { retries: 1 });
  assert.equal(calls[0][2].type, 'lever');
  assert.deepEqual(calls[1][2], { retries: 1, type: 'lever' });
  assert.equal(ctx.maxPages, DEFAULT_MAX_PAGES);
  assert.equal(typeof ctx.sleep, 'function');
  assert.deepEqual(ctx.api, { url: 'u' });
  assert.equal(typeof ctx.parallel, 'function');
  assert.equal(ctx.fetch, undefined, 'no raw fetch on the ctx');
});

test('providers never call fetch or the network stack directly', () => {
  const dir = PROVIDERS_DIR;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // `async fetch(entry, ctx)` is the contract method; a BARE fetch( or globalThis.fetch( is not.
    assert.doesNotMatch(src, /(?<![.\w])(?<!async )fetch\s*\(|globalThis\.fetch/, `${f} calls a bare fetch(`);
    assert.doesNotMatch(src, /node:(https?|net|dns)|from ['"](https?|net|dns|undici|node-fetch|axios)['"]|lib\/http\.mjs/, `${f} reaches the network stack`);
  }
});

test('dedupKey: default is <source>:<externalId>; a provider can override; requisitionId is never an identity', () => {
  assert.equal(jobDedupKey({ id: 'greenhouse' }, { externalId: '4417' }, 'greenhouse-api'), 'greenhouse-api:4417');
  assert.equal(jobDedupKey({ id: 'greenhouse' }, { externalId: '', requisitionId: 'R-1' }, 'greenhouse-api'), '', 'a requisition id alone has no identity');
  assert.equal(jobDedupKey({ id: 'x', dedupKey: (j) => `x:${j.externalId.toLowerCase()}` }, { externalId: 'AbC' }, 'x-api'), 'x:abc');
  assert.equal(jobDedupKey({ id: 'x', dedupKey: () => { throw new Error('no'); } }, { externalId: '7' }, 'x-api'), 'x-api:7', 'a throwing dedupKey falls back');
});

// ── Job typedef ────────────────────────────────────────────────────────────

test('normalizeJob: needs a title and a per-posting url; ids are cleaned; requisitionId stays a label', () => {
  assert.equal(normalizeJob({ title: '', url: 'https://x/y' }, { company: 'C' }), null);
  assert.equal(normalizeJob({ title: 'T', url: '' }, { company: 'C' }), null);
  const j = normalizeJob({ title: ' Analyst\t', url: 'https://x/y', externalId: 4417, requisitionId: 'R\t1', extraLocations: ['A', '', null] }, { company: 'Nimbus Robotics' });
  assert.deepEqual([j.title, j.company, j.externalId, j.requisitionId, j.extraLocations], ['Analyst', 'Nimbus Robotics', '4417', 'R 1', ['A']]);
});

test('salary only from real figures: numbers + a currency code, never a label or a guess', () => {
  assert.deepEqual(normalizeSalary({ min: 60000, max: 80000, currency: 'eur', period: 'YEAR' }), { min: 60000, max: 80000, currency: 'EUR', period: 'year' });
  assert.deepEqual(normalizeSalary({ min: 55, currency: 'GBP', period: 'hour' }), { min: 55, max: null, currency: 'GBP', period: 'hour' });
  assert.equal(normalizeSalary({ min: '60K', max: '80K', currency: 'EUR' }), null, 'strings are not figures');
  assert.equal(normalizeSalary({ min: 0, max: 0, currency: 'EUR' }), null);
  assert.equal(normalizeSalary({ min: 90, max: 10, currency: 'EUR' }), null, 'inverted range');
  assert.equal(normalizeSalary({ min: 60000, max: 80000 }), null, 'no currency, no salary');
  assert.equal(normalizeSalary(null), null);
  const j = normalizeJob({ title: 'T', url: 'https://x/y', salary: { min: '€60K', max: '€80K', currency: 'EUR' } }, { company: 'C' });
  assert.equal('salary' in j, false);
});

test('Ashby salary comes from numeric summaryComponents only', () => {
  const [a, b] = parseAshby({ jobs: [
    { id: '1', title: 'A', jobUrl: 'https://j/1', compensation: { compensationTierSummary: '€60K – €80K', summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 60000, maxValue: 80000 }] } },
    { id: '2', title: 'B', jobUrl: 'https://j/2', compensation: { compensationTierSummary: '€60K – €80K' } },
  ] }, 'Lumen');
  assert.deepEqual(a.salary, { min: 60000, max: 80000, currency: 'EUR', period: 'year' });
  assert.equal(b.salary, undefined, 'a summary string alone is not a salary');
});

// ── Board feed limits ───────────────────────────────────────────────────────

const MB = 1024 * 1024;

test('boardFeedLimits: client defaults, raised by the provider, then by the portals.yml entry, capped', () => {
  assert.deepEqual(boardFeedLimits({ id: 'greenhouse' }, {}), { timeoutMs: HTTP_DEFAULTS.timeoutMs, maxBytes: HTTP_DEFAULTS.maxBytes });
  assert.deepEqual(boardFeedLimits(lever, { name: 'Nimbus Robotics' }), { timeoutMs: LEVER_FEED.timeoutMs, maxBytes: LEVER_FEED.maxBytes });
  assert.deepEqual(boardFeedLimits(workday, {}), { timeoutMs: WORKDAY_FEED.timeoutMs, maxBytes: HTTP_DEFAULTS.maxBytes });
  // A board entry can ask for more (seconds / megabytes) …
  assert.deepEqual(boardFeedLimits(lever, { board_timeout_s: 90, board_max_mb: 80 }), { timeoutMs: 90_000, maxBytes: 80 * MB });
  // … never past the transport's ceilings.
  assert.deepEqual(boardFeedLimits(lever, { board_timeout_s: 3600, board_max_mb: 4096 }), { timeoutMs: HTTP_LIMITS.maxTimeoutMs, maxBytes: HTTP_LIMITS.maxBytes });
  assert.deepEqual(boardFeedLimits({ id: 'x', boardFeed: { timeoutMs: 1e9, maxBytes: 1e12 } }, {}), { timeoutMs: HTTP_LIMITS.maxTimeoutMs, maxBytes: HTTP_LIMITS.maxBytes });
  // Junk is ignored.
  assert.deepEqual(boardFeedLimits(lever, { board_timeout_s: 'forever', board_max_mb: -1 }), { timeoutMs: LEVER_FEED.timeoutMs, maxBytes: LEVER_FEED.maxBytes });
  assert.equal(providerProblem({ id: 'bad', detect() {}, async fetch() {}, boardFeed: 5 }), 'boardFeed must be an object');
});

test('the board helpers carry the board limits; detail calls keep the client defaults', async () => {
  const calls = [];
  const http = {
    getJson: async (url, opts) => { calls.push(['get', url, opts]); return []; },
    postJson: async (url, body, opts) => { calls.push(['post', url, opts]); return {}; },
  };
  const entry = { name: 'Nimbus Robotics', careers_url: 'https://jobs.lever.co/nimbus-demo', board_timeout_s: 75 };
  const ctx = makeProviderCtx(lever, { http, api: lever.detect(entry), entry, sleep: async () => {} });
  assert.deepEqual(ctx.board, { timeoutMs: 75_000, maxBytes: LEVER_FEED.maxBytes });
  await lever.fetch(entry, ctx);
  assert.deepEqual(calls[0], ['get', 'https://api.lever.co/v0/postings/nimbus-demo', { timeoutMs: 75_000, maxBytes: LEVER_FEED.maxBytes, type: 'lever' }]);
  await ctx.getJson('https://api.lever.co/v0/postings/nimbus-demo/abc');
  assert.deepEqual(calls[1][2], { type: 'lever' }, 'a non-board call gets no raised limits');
  await ctx.postBoardJson('https://api.lever.co/y', {}, { retries: 1 });
  assert.deepEqual(calls[2][2], { timeoutMs: 75_000, maxBytes: LEVER_FEED.maxBytes, retries: 1, type: 'lever' });
});

test('every provider fetches its board through the board helpers', () => {
  for (const f of readdirSync(PROVIDERS_DIR).filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs'))) {
    const src = readFileSync(join(PROVIDERS_DIR, f), 'utf8');
    const fetchBody = src.slice(src.indexOf('async fetch('), src.indexOf('async enrich(') > 0 ? src.indexOf('async enrich(') : undefined);
    assert.match(fetchBody, /ctx\.(getBoardJson|postBoardJson)\(/, `${f} fetches its board without the board limits`);
    assert.doesNotMatch(fetchBody, /ctx\.(getJson|postJson)\(/, `${f} fetches its board with the plain helpers`);
  }
});
