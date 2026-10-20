/**
 * liveness-ladder.test.mjs — every rung of the ladder, and the ambiguous → null
 * path that sends a URL on to the browser. A fake client stands in for the
 * network; no real request is made.
 *
 * Run: node --test scripts/lib/liveness-ladder.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './http.mjs';
import { climbLadder, resolvePosting, judgePostingHtml, htmlToText, jobPostingsFromJsonLd, extractJd, allRungsFailed } from './liveness-ladder.mjs';
import { parsePostingUrl, postingApiUrls, isSafeSegment } from './ats-url.mjs';
import { checkPosting, toOutcome } from './liveness-check.mjs';

const NOW = new Date('2026-10-20T12:00:00Z');

/** table: url substring → value | HttpError | function. Unmatched → network error. */
function fakeHttp(table) {
  const calls = [];
  const find = (url, kind) => {
    calls.push({ kind, url });
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    if (!hit) throw new HttpError('connect ECONNREFUSED', { code: 'ECONNREFUSED', retryable: true });
    const v = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    calls,
    getJson: async (url) => find(url, 'json'),
    getText: async (url) => find(url, 'text'),
  };
}
const notFound = () => new HttpError('HTTP 404', { code: 'ESTATUS', status: 404 });
const serverError = () => new HttpError('HTTP 503', { code: 'ESTATUS', status: 503, retryable: true });

const LONG = 'We are hiring an analyst to join our supply team. '.repeat(40);
const page = (extra = '', status = 200, headers = {}) => ({ status, headers, text: `<html><body><main>${LONG}${extra}</main></body></html>` });

// ── URL mapping ─────────────────────────────────────────────────────────────

test('posting URLs map to hard-coded API hosts, safe segments only', () => {
  const gh = parsePostingUrl('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417');
  assert.deepEqual([gh.ats, gh.org, gh.id], ['greenhouse', 'nimbus-demo', '4417']);
  assert.equal(postingApiUrls(gh, 'x').perJob, 'https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs/4417');
  const eu = parsePostingUrl('https://job-boards.eu.greenhouse.io/nimbus-demo/jobs/9');
  assert.equal(postingApiUrls(eu, 'x').board, 'https://boards-api.eu.greenhouse.io/v1/boards/nimbus-demo/jobs');

  const lv = parsePostingUrl('https://jobs.lever.co/harbor-demo/0a1b2c3d-1111-2222-3333-444455556666/apply');
  assert.equal(postingApiUrls(lv, 'x').perJob, 'https://api.lever.co/v0/postings/harbor-demo/0a1b2c3d-1111-2222-3333-444455556666');

  const ab = parsePostingUrl('https://jobs.ashbyhq.com/lumen-demo/0a1b2c3d-1111-2222-3333-444455556666');
  assert.equal(postingApiUrls(ab, 'x').perJob, null, 'Ashby has no single-posting endpoint');
  assert.equal(postingApiUrls(ab, 'x').board, 'https://api.ashbyhq.com/posting-api/job-board/lumen-demo');

  const sr = parsePostingUrl('https://careers.smartrecruiters.com/Orchard/744000012345678-buyer');
  assert.equal(postingApiUrls(sr, 'x').perJob, 'https://api.smartrecruiters.com/v1/companies/Orchard/postings/744000012345678');

  const wd = parsePostingUrl('https://contoso.wd3.myworkdayjobs.com/en-US/ext/job/Hub/Finance-Analyst_R-1042');
  assert.equal(postingApiUrls(wd, 'x').perJob, 'https://contoso.wd3.myworkdayjobs.com/wday/cxs/contoso/ext/job/Hub/Finance-Analyst_R-1042');
});

test('unsafe or foreign URLs do not map at all', () => {
  for (const u of [
    'http://job-boards.greenhouse.io/nimbus/jobs/1',               // not https
    'https://job-boards.greenhouse.io/../jobs/1',                   // dot segments
    'https://job-boards.greenhouse.io/ni%2Fmbus/jobs/1',            // percent-escape
    'https://job-boards.greenhouse.io/nimbus/jobs/1?x=1#frag/..',   // fine path, checked below
    'https://evil.example.com/nimbus/jobs/1',                       // foreign host
    'https://boards.greenhouse.io:8443/nimbus/jobs/1',              // odd port
    'https://careers.example.com/jobs?gh_jid=123',                  // company-hosted embed
    'not a url',
  ]) {
    const p = parsePostingUrl(u);
    if (u.includes('frag')) assert.ok(p, 'query/fragment are ignored, path is safe');
    else assert.equal(p, null, u);
  }
  assert.equal(isSafeSegment('a/b'), false);
  assert.equal(isSafeSegment('..'), false);
  assert.equal(isSafeSegment('x y'), false);
  assert.equal(isSafeSegment('nimbus-demo_2'), true);
});

// ── rung 1: per-job API ─────────────────────────────────────────────────────

test('rung 1: a per-job 200 for that posting → active, with the JD', async () => {
  const http = fakeHttp({ 'boards/nimbus-demo/jobs/4417': { id: 4417, title: 'Operations Analyst', location: { name: 'Aldervale' }, content: '&lt;p&gt;Great job. Apply by 2026-12-01.&lt;/p&gt;' } });
  const r = await climbLadder('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417', { http, now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.via, 'api-job');
  assert.equal(r.verdict.jd.title, 'Operations Analyst');
  assert.match(r.verdict.jd.description, /Great job/);
  assert.doesNotMatch(r.verdict.jd.description, /[<>]/, 'entity-encoded HTML is decoded, then stripped');
  assert.equal(r.verdict.jd.deadline, '2026-12-01');
  assert.deepEqual(r.attempted, ['api-job'], 'stops at the first decisive rung');
  assert.equal(http.calls.length, 1);
});

test('rung 1: a per-job 404/410 → expired (authoritative from the ATS itself)', async () => {
  const http = fakeHttp({ 'jobs/4417': notFound() });
  const r = await resolvePosting('https://boards.greenhouse.io/nimbus-demo/jobs/4417', { http, now: NOW });
  assert.equal(r.result, 'expired');
  assert.equal(r.via, 'api-job');
  assert.match(r.reason, /HTTP 404/);
});

test('rung 1: a 200 for a DIFFERENT posting id is not a verdict', async () => {
  const http = fakeHttp({
    'jobs/4417': { id: 9999, title: 'Something else' },
    'boards/nimbus-demo/jobs': { jobs: [] },
    'job-boards.greenhouse.io': page(),
  });
  const r = await climbLadder('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417', { http, now: NOW });
  assert.equal(r.verdict?.via === 'api-job', false);
});

// ── rung 2: org board ──────────────────────────────────────────────────────

test('rung 2: the board still lists the id → active (Ashby has no per-job endpoint)', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({ 'job-board/lumen-demo': { jobs: [{ id: 'other' }, { id, title: 'Supply Planner', location: 'Aldervale', descriptionPlain: 'Plan supply.' }] } });
  const r = await climbLadder(`https://jobs.ashbyhq.com/lumen-demo/${id}`, { http, now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.via, 'api-board');
  assert.equal(r.verdict.jd.description, 'Plan supply.');
  assert.deepEqual(r.attempted, ['api-board']);
});

test('rung 2: a 5xx on the per-job endpoint falls through to the board', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({ 'postings/harbor-demo/0a1b': serverError(), 'postings/harbor-demo?mode=json': [{ id, text: 'Logistics Analyst' }] });
  const r = await climbLadder(`https://jobs.lever.co/harbor-demo/${id}`, { http, now: NOW });
  assert.equal(r.verdict.via, 'api-board');
  assert.equal(r.errors.length, 1, 'the 5xx is recorded, not swallowed');
  assert.equal(r.errors[0].status, 503);
});

test('rung 2: absence from the board is NOT proof of closure → on to the page', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({ 'job-board/lumen-demo': { jobs: [{ id: 'other' }] }, 'jobs.ashbyhq.com': page() });
  const r = await climbLadder(`https://jobs.ashbyhq.com/lumen-demo/${id}`, { http, now: NOW });
  assert.notEqual(r.verdict?.result, 'expired');
  assert.deepEqual(r.attempted, ['api-board', 'html']);
});

// ── rung 3: page signals ───────────────────────────────────────────────────

const APPLY = '<a href="/apply">Apply now</a>';
const JSONLD = (extra = '') => `<script type="application/ld+json">{"@type":"JobPosting","title":"Analyst"${extra}}</script>`;

test('rung 3: two agreeing active signals → active', () => {
  const j = judgePostingHtml({ status: 200, headers: {}, text: `<html><body>${JSONLD()}${APPLY}</body></html>` }, { now: NOW });
  assert.equal(j.result, 'active');
  assert.deepEqual(j.signals.sort(), ['apply-control', 'jsonld-jobposting']);
});

test('rung 3: ONE signal is not enough (a bare apply button) → null', () => {
  const j = judgePostingHtml({ status: 200, headers: {}, text: `<html><body>short ${APPLY}</body></html>` }, { now: NOW });
  assert.equal(j.result, null);
});

test('rung 3: an expired phrase CONTRADICTING an apply control → null, not a guess', () => {
  const j = judgePostingHtml({ status: 200, headers: {}, text: `<html><body>${JSONLD()}${APPLY}<p>This job is no longer available.</p></body></html>` }, { now: NOW });
  assert.equal(j.result, null);
});

test('rung 3: 404 + a gone phrase → expired; a bare 404 → null', () => {
  const both = judgePostingHtml({ status: 404, headers: {}, text: '<p>Sorry, this job is no longer available.</p>' }, { now: NOW });
  assert.equal(both.result, 'expired');
  assert.deepEqual(both.signals.sort(), ['expired-text', 'http-404']);
  const bare = judgePostingHtml({ status: 404, headers: {}, text: '<p>Oops</p>' }, { now: NOW });
  assert.equal(bare.result, null);
});

test('rung 3: a redirect to ?error=true is two signals (status + url) → expired', () => {
  const j = judgePostingHtml({ status: 302, headers: { location: 'https://job-boards.greenhouse.io/nimbus?error=true' }, text: '' }, { now: NOW });
  assert.equal(j.result, 'expired');
  const other = judgePostingHtml({ status: 302, headers: { location: 'https://job-boards.greenhouse.io/login' }, text: '' }, { now: NOW });
  assert.equal(other.result, null);
});

test('rung 3: JSON-LD validThrough in the past + a gone phrase → expired; in the future → active signal', () => {
  const past = judgePostingHtml({ status: 200, headers: {}, text: `${JSONLD(',"validThrough":"2026-01-01"')}<p>Job not found</p>` }, { now: NOW });
  assert.equal(past.result, 'expired');
  const future = judgePostingHtml({ status: 200, headers: {}, text: `${JSONLD(',"validThrough":"2027-01-01"')}${APPLY}` }, { now: NOW });
  assert.equal(future.result, 'active');
});

test('rung 3: curly quotes and diacritics in the page text do not hide a gone phrase', () => {
  const curly = judgePostingHtml({ status: 404, headers: {}, text: '<p>The page you are looking for doesn’t exist.</p>' }, { now: NOW });
  assert.equal(curly.result, 'expired');
  const fr = judgePostingHtml({ status: 404, headers: {}, text: '<p>Cette offre expirée a été retirée.</p>' }, { now: NOW });
  assert.equal(fr.result, 'expired');
});

test('rung 3: an empty single-page-app shell gives no verdict', () => {
  const j = judgePostingHtml({ status: 200, headers: {}, text: '<html><head><title>Jobs</title></head><body><div id="root"></div><script>window.x=1</script></body></html>' }, { now: NOW });
  assert.equal(j.result, null);
});

test('rung 3 end to end on a Lever-style page', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({
    'api.lever.co': serverError(),
    'jobs.lever.co': { status: 200, headers: {}, text: `<html><body>${JSONLD()}${APPLY}</body></html>` },
  });
  const r = await climbLadder(`https://jobs.lever.co/harbor-demo/${id}`, { http, now: NOW });
  assert.equal(r.verdict.via, 'html');
  assert.equal(r.verdict.result, 'active');
});

// ── ambiguous → null (the browser's turn) ──────────────────────────────────

test('ambiguous at every rung → null; an unsupported host never touches the network', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({
    'job-board/lumen-demo': { jobs: [] },
    'jobs.ashbyhq.com': { status: 200, headers: {}, text: '<div id="root"></div>' },
  });
  const r = await climbLadder(`https://jobs.ashbyhq.com/lumen-demo/${id}`, { http, now: NOW });
  assert.equal(r.verdict, null);
  assert.equal(await resolvePosting(`https://jobs.ashbyhq.com/lumen-demo/${id}`, { http, now: NOW }), null);
  assert.equal(allRungsFailed(r), false, 'it reached the host: ambiguous, not unreachable');

  const none = fakeHttp({});
  const foreign = await climbLadder('https://careers.example.com/jobs/12', { http: none, now: NOW });
  assert.equal(foreign.verdict, null);
  assert.equal(none.calls.length, 0);
});

test('when every rung throws, the ladder reports unreachable evidence — never expired', async () => {
  const http = fakeHttp({}); // everything is a network error
  const r = await climbLadder('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417', { http, now: NOW });
  assert.equal(r.verdict, null);
  assert.equal(allRungsFailed(r), true);
  assert.equal(r.errors.length, 3);
});

// ── composed check: ladder + optional browser ──────────────────────────────

test('checkPosting: ladder verdict wins and the browser is never started', async () => {
  const http = fakeHttp({ 'jobs/4417': { id: 4417, title: 'X', content: 'Body' } });
  let launched = false;
  const r = await checkPosting('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417', { http, now: NOW, browser: async () => { launched = true; return { result: 'expired', reason: 'x' }; } });
  assert.equal(r.kind, 'active');
  assert.equal(launched, false);
  assert.deepEqual(toOutcome(r), { kind: 'active' });
});

test('checkPosting: ambiguous → the browser rung decides; a browser load failure is unreachable', async () => {
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const http = fakeHttp({ 'job-board/lumen-demo': { jobs: [] }, 'jobs.ashbyhq.com': { status: 200, headers: {}, text: '<div id="root"></div>' } });
  const url = `https://jobs.ashbyhq.com/lumen-demo/${id}`;
  const viaBrowser = await checkPosting(url, { http, now: NOW, browser: async () => ({ result: 'expired', reason: 'pattern matched: x' }) });
  assert.equal(viaBrowser.kind, 'expired');
  assert.equal(viaBrowser.via, 'browser');
  assert.deepEqual(toOutcome(viaBrowser), { kind: 'expired', reason: 'browser' });

  const broken = await checkPosting(url, { http, now: NOW, browser: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED\n  at ...'); } });
  assert.equal(broken.kind, 'unreachable');
  assert.equal(broken.error, 'net::ERR_NAME_NOT_RESOLVED');

  const noBrowser = await checkPosting(url, { http, now: NOW, browser: null });
  assert.equal(noBrowser.kind, 'uncertain');
  assert.equal(toOutcome(noBrowser), null, 'uncertain leaves the row alone');
});

test('checkPosting: ladder-only and every rung failed → unreachable', async () => {
  const r = await checkPosting('https://job-boards.greenhouse.io/nimbus-demo/jobs/4417', { http: fakeHttp({}), now: NOW, browser: null });
  assert.equal(r.kind, 'unreachable');
  assert.match(r.error, /^html: /);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('htmlToText / jobPostingsFromJsonLd / extractJd', () => {
  assert.equal(htmlToText('<p>Fish &amp; chips&nbsp;now</p><script>x()</script><style>p{}</style>'), 'Fish & chips now');
  assert.equal(jobPostingsFromJsonLd('<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"A"}]}</script>').length, 1);
  assert.equal(jobPostingsFromJsonLd('<script type="application/ld+json">{oops</script>').length, 0);
  const jd = extractJd('workday', { jobPostingInfo: { title: 'Finance Analyst', location: 'Aldervale', startDate: '2026-10-07', endDate: '2026-11-20', jobDescription: '<p>Numbers.</p>' } });
  assert.deepEqual([jd.title, jd.postedDate, jd.deadline, jd.description], ['Finance Analyst', '2026-10-07', '2026-11-20', 'Numbers.']);
});
