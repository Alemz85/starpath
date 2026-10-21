/**
 * site-posting.test.mjs — the ladder rungs added for hosts that fetch-posting.mjs
 * used to send to WebFetch: Greenhouse EU, Workday URLs without a site segment,
 * and the company career sites (amazon.jobs, jobs.picnic.app, careers.factorial.com).
 * Fictional fixtures and a fake client; no network.
 *
 * Run: node --test scripts/lib/site-posting.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './http.mjs';
import { climbLadder } from './liveness-ladder.mjs';
import { parsePostingUrl, postingApiUrls } from './ats-url.mjs';
import { judgeSitePage, siteJdFromHtml, amazonHit } from './site-posting.mjs';
import { workdaySitesFromPortals } from './workday-sites.mjs';
import { workdaySiteOf } from '../providers/workday.mjs';
import { fetchPosting, render } from '../fetch-posting.mjs';
import { checkPosting } from './liveness-check.mjs';

const NOW = new Date('2026-10-20T12:00:00Z');

function fakeHttp(table) {
  const calls = [];
  const find = (url, kind, opts) => {
    calls.push({ kind, url, opts });
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    if (!hit) throw new HttpError('connect ECONNREFUSED', { code: 'ECONNREFUSED', retryable: true });
    const v = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    if (v instanceof Error) throw v;
    return v;
  };
  return { calls, getJson: async (u, o) => find(u, 'json', o), getText: async (u, o) => find(u, 'text', o) };
}
const notFound = () => new HttpError('HTTP 404', { code: 'ESTATUS', status: 404 });
const html = (body, status = 200) => ({ status, headers: {}, text: `<html><head><title>t</title></head><body>${body}</body></html>` });
const ld = (o) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', ...o })}</script>`;
const LONG = 'You will plan routes and keep the depot supplied. '.repeat(30);

// ── Greenhouse EU ───────────────────────────────────────────────────────────

test('Greenhouse EU page: per-job API on the global host returns the JD', async () => {
  const http = fakeHttp({ 'https://boards-api.greenhouse.io/v1/boards/nimbus-demo/jobs/77': { id: 77, title: 'Ops Analyst', location: { name: 'Lyon' }, content: '&lt;p&gt;Run the depot.&lt;/p&gt;' } });
  const r = await fetchPosting('https://job-boards.eu.greenhouse.io/nimbus-demo/jobs/77', { http, now: NOW, workdaySites: {} });
  assert.equal(r.exitCode, 0);
  assert.equal(r.title, 'Ops Analyst');
  assert.match(r.description, /Run the depot/);
  assert.ok(http.calls.every((c) => !c.url.includes('boards-api.eu.')), 'the non-existent EU API host is never called');
});

// ── Workday, with and without a site segment ────────────────────────────────

const WD_JOB = { jobPostingInfo: { title: 'Finance Analyst', location: 'Hub', jobDescription: '<p>Close the books.</p>', startDate: '2026-10-01' } };

test('Workday URL with a site segment still goes straight to the CXS endpoint', async () => {
  const http = fakeHttp({ '/wday/cxs/contoso/ext/job/Hub/Finance-Analyst_R-1': WD_JOB });
  const r = await climbLadder('https://contoso.wd3.myworkdayjobs.com/en-US/ext/job/Hub/Finance-Analyst_R-1', { http, now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.jd.title, 'Finance Analyst');
});

test('Workday URL without a site: sites come from portals.yml; a 404 on a guessed site is not "expired"', async () => {
  const url = 'https://contoso.wd3.myworkdayjobs.com/job/Hub/Finance-Analyst_R-1';
  const p = parsePostingUrl(url);
  assert.equal(p.ats, 'workday');
  assert.equal(p.site, null);
  assert.equal(postingApiUrls(p, url).perJob, null);

  const http = fakeHttp({
    '/wday/cxs/contoso/careers_old/job/': notFound(),
    '/wday/cxs/contoso/ext/job/Hub/Finance-Analyst_R-1': WD_JOB,
  });
  const ok = await climbLadder(url, { http, now: NOW, workdaySites: { 'contoso.wd3.myworkdayjobs.com': ['careers_old', 'ext'] } });
  assert.equal(ok.verdict.result, 'active');
  assert.equal(ok.verdict.via, 'api-job');

  const gone = await climbLadder(url, { http: fakeHttp({ '/wday/cxs/': notFound() }), now: NOW, workdaySites: { 'contoso.wd3.myworkdayjobs.com': ['careers_old'] } });
  assert.notEqual(gone.verdict?.result, 'expired', 'a 404 on a site we only guessed proves nothing');
});

test('Workday URL without a site and no known site: no request, a hint, uncertain (not unreachable)', async () => {
  const url = 'https://contoso.wd3.myworkdayjobs.com/en-US/job/Hub/Finance-Analyst_R-1';
  const http = fakeHttp({});
  const r = await climbLadder(url, { http, now: NOW, workdaySites: {} });
  assert.equal(r.verdict, null);
  assert.match(r.hint, /no site segment/);
  assert.equal(http.calls.length, 0);
  const c = await checkPosting(url, { http, now: NOW });
  assert.equal(c.kind, 'uncertain');
  const f = await fetchPosting(url, { http, now: NOW, workdaySites: {} });
  assert.equal(f.exitCode, 3);
  assert.match(render(f), /no site segment/);
});

test('Workday path segments: long and percent-escaped titles parse; escaped slashes and dots do not', () => {
  const long = `Associate-${'Product-'.repeat(20)}Specialist_R-1`;
  assert.equal(parsePostingUrl(`https://contoso.wd1.myworkdayjobs.com/ext/job/Hub/${long}`)?.id, long);
  assert.equal(parsePostingUrl('https://contoso.wd1.myworkdayjobs.com/ext/job/M%C3%BCnchen/Analyst_R-1')?.site, 'ext');
  assert.equal(parsePostingUrl('https://contoso.wd1.myworkdayjobs.com/ext/job/a%2Fb/Analyst_R-1'), null);
  assert.equal(parsePostingUrl('https://contoso.wd1.myworkdayjobs.com/ext/job/%2e%2e/Analyst_R-1'), null);
});

test('workdaySiteOf / workdaySitesFromPortals read careers_url and the explicit CXS api', () => {
  assert.deepEqual(workdaySiteOf({ careers_url: 'https://contoso.wd3.myworkdayjobs.com/en-US/ext' }), { host: 'contoso.wd3.myworkdayjobs.com', tenant: 'contoso', site: 'ext' });
  assert.deepEqual(workdaySiteOf({ api: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs' }), { host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'Careers' });
  assert.equal(workdaySiteOf({ careers_url: 'https://boards.greenhouse.io/x' }), null);
  assert.deepEqual(workdaySitesFromPortals({ tracked_companies: [
    { careers_url: 'https://contoso.wd3.myworkdayjobs.com/ext' },
    { careers_url: 'https://contoso.wd3.myworkdayjobs.com/other' },
    { careers_url: 'https://contoso.wd3.myworkdayjobs.com/ext' },
    { careers_url: 'https://jobs.lever.co/x' },
  ] }), { 'contoso.wd3.myworkdayjobs.com': ['ext', 'other'] });
  assert.deepEqual(workdaySitesFromPortals(null), {});
});

// ── amazon.jobs ─────────────────────────────────────────────────────────────

const AMZ_HIT = { id_icims: '1234567', title: 'Logistics Intern', normalized_location: 'Aldervale, XYZ', posted_date: 'September 23, 2026',
  description: 'Plan the network.<br/><br/>Own a project.', basic_qualifications: '- Enrolled in a degree', preferred_qualifications: '- Likes spreadsheets' };

test('amazon.jobs: the public search JSON is the per-job rung and returns the JD', async () => {
  const url = 'https://amazon.jobs/en/jobs/1234567/logistics-intern';
  assert.equal(parsePostingUrl(url).ats, 'amazon');
  assert.equal(parsePostingUrl('https://amazon.jobs/jobs/1234567').id, '1234567');
  const http = fakeHttp({ 'search.json?base_query=1234567': { hits: 2, jobs: [{ id_icims: '7654321', title: 'Other' }, AMZ_HIT] } });
  const r = await climbLadder(url, { http, now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.jd.title, 'Logistics Intern');
  assert.equal(r.verdict.jd.location, 'Aldervale, XYZ');
  assert.equal(r.verdict.jd.postedDate, '2026-09-23');
  assert.match(r.verdict.jd.description, /Plan the network\.\n+Own a project\./);
  assert.match(r.verdict.jd.description, /Basic qualifications/);
  assert.deepEqual(http.calls[0].opts.hosts, ['www.amazon.jobs'], 'the search host is pinned in http.mjs SITE_API_HOSTS');
  assert.ok(!amazonHit({ jobs: [{ id_icims: '7654321' }] }, '1234567'));
});

test('amazon.jobs: not in the search and the page 404s → expired; the page alone 302 → no verdict', async () => {
  const url = 'https://www.amazon.jobs/en/jobs/1234567';
  const gone = await climbLadder(url, { http: fakeHttp({ 'search.json': { hits: 0, jobs: [] }, '/en/jobs/1234567': html('', 404) }), now: NOW });
  assert.equal(gone.verdict.result, 'expired');
  const redirect = { status: 302, headers: { location: 'https://www.amazon.jobs/en/jobs/1234567/x' }, text: '' };
  const unsure = await climbLadder(url, { http: fakeHttp({ 'search.json': { hits: 0, jobs: [] }, '/en/jobs/1234567': redirect }), now: NOW });
  assert.equal(unsure.verdict, null);
});

// ── jobs.picnic.app ─────────────────────────────────────────────────────────

test('jobs.picnic.app: a 404 is expired; a page with JobPosting and a full body is active with the rendered JD', async () => {
  const url = 'https://jobs.picnic.app/en/vacancies/AB12CD34/engineering/route-planner/aldervale/region/country';
  assert.equal(parsePostingUrl(url).id, 'AB12CD34');
  const gone = await climbLadder(url, { http: fakeHttp({ 'vacancies/AB12CD34': html('', 404) }), now: NOW });
  assert.equal(gone.verdict.result, 'expired');

  // Next.js ships the JSON-LD inside the RSC stream (escaped), with a truncated description.
  const rsc = '<script>self.__next_f.push([1,"{\\"@type\\":\\"JobPosting\\",\\"title\\":\\"Route Planner\\",\\"datePosted\\":\\"2026-10-19T09:40:00.766Z\\",\\"description\\":\\"Plan routes...\\"}"])</script>';
  const live = html(`${rsc}<header>Menu</header><main><h1>Route Planner</h1><p>${LONG}</p></main>`);
  const r = await climbLadder(url, { http: fakeHttp({ 'vacancies/AB12CD34': live }), now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.equal(r.verdict.jd.title, 'Route Planner');
  assert.equal(r.verdict.jd.postedDate, '2026-10-19');
  assert.match(r.verdict.jd.description, /keep the depot supplied/);
  assert.doesNotMatch(r.verdict.jd.description, /Menu/, 'only <main>, not the site chrome');
});

test('jobs.picnic.app: current /jobs/{CODE} links parse too, and a locale-less one is read on its /en/ page (redirects are not followed)', async () => {
  const bare = 'https://jobs.picnic.app/jobs/AB12CD34';
  assert.equal(parsePostingUrl(bare).id, 'AB12CD34');
  assert.equal(postingApiUrls(parsePostingUrl(bare), bare).html, 'https://jobs.picnic.app/en/jobs/AB12CD34');
  const withLocale = 'https://jobs.picnic.app/de/jobs/AB12CD34/internships/route-planner/aldervale';
  assert.equal(postingApiUrls(parsePostingUrl(withLocale), withLocale).html, withLocale);
  const http = fakeHttp({ '/en/jobs/AB12CD34': html('', 404) });
  assert.equal((await climbLadder(bare, { http, now: NOW })).verdict.result, 'expired');
  assert.deepEqual(http.calls.map((c) => c.url), ['https://jobs.picnic.app/en/jobs/AB12CD34']);
});

test('careers.factorialhr.com (the old host, a 301 to careers.factorial.com) is read on the current host', () => {
  const old = 'https://careers.factorialhr.com/job_posting/account-executive-295523';
  const p = parsePostingUrl(old);
  assert.equal(p.ats, 'factorial');
  assert.equal(p.id, '295523');
  assert.equal(postingApiUrls(p, old).html, 'https://careers.factorial.com/job_posting/account-executive-295523');
});

// ── careers.factorial.com ───────────────────────────────────────────────────

test('careers.factorial.com: JobPosting JSON-LD is the JD; the id must match; the generic list page is expired', async () => {
  const url = 'https://careers.factorial.com/job_posting/account-executive-295523';
  assert.equal(parsePostingUrl(url).id, '295523');
  const page = html(`<h1>Account Executive</h1>${ld({ title: 'Account Executive', description: '<p>Sell things.</p>', datePosted: '2026-04-08',
    validThrough: '2026-12-31', identifier: { '@type': 'PropertyValue', name: 'Nimbus', value: '295523' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Aldervale', addressCountry: 'XY' } } })}`);
  const r = await climbLadder(url, { http: fakeHttp({ 'job_posting/account-executive-295523': page }), now: NOW });
  assert.equal(r.verdict.result, 'active');
  assert.deepEqual([r.verdict.jd.title, r.verdict.jd.location, r.verdict.jd.postedDate, r.verdict.jd.deadline], ['Account Executive', 'Aldervale, XY', '2026-04-08', '2026-12-31']);
  assert.match(r.verdict.jd.description, /Sell things/);

  const other = html(`<h1>x</h1>${ld({ title: 'Other', description: 'd', identifier: { value: '111111' } })}`);
  assert.equal((await climbLadder(url, { http: fakeHttp({ 'job_posting/': other }), now: NOW })).verdict, null, 'JSON-LD for another posting is not ours');

  const list = html('<nav>Jobs</nav><ul><li><a href="/job_posting/x-1">x</a></li></ul>');
  assert.equal((await climbLadder(url, { http: fakeHttp({ 'job_posting/': list }), now: NOW })).verdict.result, 'expired');
  assert.equal((await climbLadder(url, { http: fakeHttp({ 'job_posting/': html('', 404) }), now: NOW })).verdict.result, 'expired');

  const past = html(`<h1>x</h1>${ld({ title: 'Old', description: 'd', validThrough: '2026-01-01', identifier: { value: '295523' } })}`);
  assert.equal((await climbLadder(url, { http: fakeHttp({ 'job_posting/': past }), now: NOW })).verdict.result, 'expired');
});

test('judgeSitePage / siteJdFromHtml: a non-2xx that is not 404 gives no verdict; no JSON-LD gives no JD', () => {
  assert.equal(judgeSitePage('factorial', { status: 503, text: '' }, '1', { now: NOW }).result, null);
  assert.equal(siteJdFromHtml('factorial', '<html></html>'), null);
});

test('hosts that are not registered stay unsupported (no generic fetch of arbitrary company pages)', async () => {
  const http = fakeHttp({});
  const r = await climbLadder('https://www.revolut.com/careers/position/analyst-1234', { http, now: NOW });
  assert.equal(r.verdict, null);
  assert.equal(r.ats, null);
  assert.equal(http.calls.length, 0);
});
