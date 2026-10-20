import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planFetch, htmlToText, decodeEntities, jobPostingFromJsonLd, extractFromPage, fetchPosting,
  greenhouseText, leverText, ashbyText, smartrecruitersText,
} from './jd-fetch-core.mjs';
import { HttpError } from './http.mjs';

test('planFetch routes ATS listing URLs to their public API and everything else to the page', () => {
  assert.deepEqual(
    (({ kind, apiUrl, source }) => ({ kind, apiUrl, source }))(planFetch('https://boards.greenhouse.io/nimbus/jobs/4012345')),
    { kind: 'greenhouse', apiUrl: 'https://boards-api.greenhouse.io/v1/boards/nimbus/jobs/4012345', source: 'greenhouse-api' },
  );
  assert.equal(planFetch('https://job-boards.eu.greenhouse.io/nimbus?gh_jid=77').apiUrl, 'https://boards-api.eu.greenhouse.io/v1/boards/nimbus/jobs/77');
  assert.equal(planFetch('https://jobs.lever.co/contoso/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab').apiUrl, 'https://api.lever.co/v0/postings/contoso/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab');
  assert.equal(planFetch('https://jobs.ashbyhq.com/tailspin/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab').kind, 'ashby');
  assert.equal(planFetch('https://jobs.smartrecruiters.com/Fabrikam/743999-data-analyst').apiUrl, 'https://api.smartrecruiters.com/v1/companies/Fabrikam/postings/743999');
  // a board homepage has no job id: page route, not an API guess
  assert.equal(planFetch('https://boards.greenhouse.io/nimbus').kind, 'page');
  assert.equal(planFetch('https://careers.example.com/jobs/9').kind, 'page');
  assert.equal(planFetch('—'), null);
  assert.equal(planFetch('ftp://x.example.com/'), null);
});

test('htmlToText keeps structure and wording, drops markup/scripts, decodes entities', () => {
  const html = '<div><h2>About the role</h2><p>Build <strong>reports</strong> &amp; dashboards.</p><ul><li>SQL</li><li>Python&nbsp;3</li></ul><script>evil()</script><p>Apply by 1&nbsp;Nov</p></div>';
  assert.equal(htmlToText(html), '## About the role\n\nBuild **reports** & dashboards.\n\n- SQL\n- Python 3\n\nApply by 1 Nov');
  assert.equal(decodeEntities('&#8217;&#x41;&unknown;'), '’A&unknown;');
});

test('htmlToText unescapes entity-encoded markup (Greenhouse content)', () => {
  assert.equal(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;One&lt;/li&gt;&lt;/ul&gt;'), 'Hello & welcome\n\n- One');
});

test('payload converters', () => {
  assert.equal(greenhouseText({ title: 'Analyst', content: '&lt;p&gt;Hi&lt;/p&gt;' }).text, 'Hi');
  const lever = leverText({ text: 'Analyst', descriptionPlain: 'Intro', lists: [{ text: 'You have', content: '<li>SQL</li>' }], additionalPlain: 'Perks' });
  assert.equal(lever.text, 'Intro\n\n## You have\n\n- SQL\n\nPerks');
  assert.equal(ashbyText({ jobs: [{ id: 'a', title: 'T', descriptionPlain: 'Body' }] }, 'a').text, 'Body');
  assert.equal(ashbyText({ jobs: [] }, 'a').missing, true);
  const sr = smartrecruitersText({ name: 'N', jobAd: { sections: { jobDescription: { title: 'Job', text: '<p>Do</p>' }, qualifications: { title: 'You', text: '<p>Can</p>' } } } });
  assert.equal(sr.text, '## Job\n\nDo\n\n## You\n\nCan');
});

const longText = 'You will analyse operations data and report to the team. '.repeat(20);

test('extractFromPage prefers JSON-LD JobPosting, then readable text, and spots closed pages', () => {
  const ld = `<html><head><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', title: 'Analyst', description: `<p>${longText}</p>` }] })}</script></head><body>nav</body></html>`;
  assert.equal(jobPostingFromJsonLd(ld).title, 'Analyst');
  assert.equal(extractFromPage(ld).status, 'ok');
  const article = `<html><title>Analyst | Nimbus</title><body><nav>Home Jobs</nav><main><h1>Analyst</h1><p>${longText}</p></main></body></html>`;
  const got = extractFromPage(article);
  assert.equal(got.status, 'ok');
  assert.match(got.text, /analyse operations data/);
  assert.doesNotMatch(got.text, /Home Jobs/);
  assert.equal(extractFromPage('<body><main><p>Sorry, this position has been filled.</p></main></body>').status, 'gone');
  assert.equal(extractFromPage('<body><main><p>Loading…</p></main></body>').status, 'unextractable');
});

function fakeHttp({ json, html, error } = {}) {
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => { calls.push({ url, opts }); if (error) throw error; return json; },
    send: async (url, opts) => { calls.push({ url, opts }); if (error) throw error; return { status: 200, body: Buffer.from(html ?? '') }; },
  };
}

test('fetchPosting: ATS API ok / gone / unreachable', async () => {
  const ok = await fetchPosting('https://boards.greenhouse.io/nimbus/jobs/1', fakeHttp({ json: { title: 'A', content: '&lt;p&gt;Body&lt;/p&gt;' } }));
  assert.deepEqual([ok.status, ok.text, ok.source], ['ok', 'Body', 'greenhouse-api']);
  const gone = await fetchPosting('https://boards.greenhouse.io/nimbus/jobs/1', fakeHttp({ error: new HttpError('HTTP 404', { status: 404 }) }));
  assert.equal(gone.status, 'gone');
  const down = await fetchPosting('https://boards.greenhouse.io/nimbus/jobs/1', fakeHttp({ error: new HttpError('HTTP 503', { status: 503, retryable: true }) }));
  assert.equal(down.status, 'unreachable');
  const missingAshby = await fetchPosting('https://jobs.ashbyhq.com/tailspin/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab', fakeHttp({ json: { jobs: [] } }));
  assert.equal(missingAshby.status, 'gone');
  const noText = await fetchPosting('https://jobs.lever.co/contoso/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab', fakeHttp({ json: {} }));
  assert.equal(noText.status, 'unextractable');
});

test('fetchPosting: a page is fetched on its own host only, as HTML', async () => {
  const h = fakeHttp({ html: `<main><p>${longText}</p></main>` });
  const r = await fetchPosting('https://careers.example.com/jobs/9', h);
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'page-html');
  assert.deepEqual(h.calls[0].opts.hosts, ['careers.example.com']);
  assert.match(h.calls[0].opts.headers.accept, /text\/html/);
  assert.equal((await fetchPosting('nope', h)).status, 'unsupported');
});
