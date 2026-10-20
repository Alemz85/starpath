/**
 * posted-date.test.mjs — deterministic posted-date extraction. All companies
 * and dates are fictional.
 *
 * Run: node --test scripts/lib/posted-date.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPostedDate } from './posted-date.mjs';

const TODAY = '2026-10-20';
const page = (body, head = '') => `<!doctype html><html><head><title>Role</title>${head}</head><body>${body}</body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
const posted = (input) => extractPostedDate({ today: TODAY, ...input });

// ── json-ld ─────────────────────────────────────────────────────────────────

test('json-ld: single JobPosting, leading date taken as written (no timezone shift)', () => {
  const html = page('<h1>Data Engineer</h1>', ld({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Engineer', datePosted: '2026-10-02T23:30:00-08:00' }));
  assert.deepEqual(posted({ html }), { date: '2026-10-02', source: 'json-ld' });
});

test('json-ld: array, @graph, @type array and several scripts', () => {
  const posting = { '@type': 'JobPosting', datePosted: '2026-09-15' };
  assert.equal(posted({ html: page('', ld([{ '@type': 'Organization', name: 'Nimbus Robotics' }, posting])) }).date, '2026-09-15');
  assert.equal(posted({ html: page('', ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, posting] })) }).date, '2026-09-15');
  assert.equal(posted({ html: page('', ld({ '@type': ['Thing', 'JobPosting'], datePosted: '2026-09-16' })) }).date, '2026-09-16');
  const several = page('', ld({ '@type': 'BreadcrumbList' }) + '<script type="application/ld+json">{ not json</script>' + ld(posting));
  assert.deepEqual(posted({ html: several }), { date: '2026-09-15', source: 'json-ld' });
});

test('json-ld: ignores non-JobPosting nodes and a bare date value', () => {
  assert.equal(posted({ html: page('', ld({ '@type': 'Article', datePublished: '2026-10-01', dateModified: '2026-10-02' })) }), null);
  assert.equal(posted({ html: page('', ld({ '@type': 'JobPosting', datePosted: 'last week' })) }), null);
});

test('a page with both validThrough and datePosted returns datePosted', () => {
  const html = page('<p>Closes soon</p>', ld({ '@type': 'JobPosting', validThrough: '2026-10-25T00:00', datePosted: '2026-10-05' }));
  assert.deepEqual(posted({ html }), { date: '2026-10-05', source: 'json-ld' });
  const noPosted = page('', ld({ '@type': 'JobPosting', validThrough: '2026-10-19' }));
  assert.equal(posted({ html: noPosted }), null);
});

// ── microdata ───────────────────────────────────────────────────────────────

test('microdata: itemprop datePosted via content or datetime', () => {
  const meta = page('<div itemscope itemtype="https://schema.org/JobPosting"><meta itemprop="datePosted" content="2026-08-30"></div>');
  assert.deepEqual(posted({ html: meta }), { date: '2026-08-30', source: 'microdata' });
  const time = page("<time itemprop='datePosted' datetime=\"2026-08-31T09:00:00Z\">31 Aug</time>");
  assert.deepEqual(posted({ html: time }), { date: '2026-08-31', source: 'microdata' });
});

// ── ats-json ────────────────────────────────────────────────────────────────

test('ats-json: known ISO keys in embedded JSON', () => {
  for (const key of ['datePosted', 'publishedAt', 'published_at', 'first_published', 'postedOn']) {
    const html = page(`<script id="__NEXT_DATA__" type="application/json">{"job":{"title":"Analyst","${key}":"2026-07-14T08:00:00.000Z"}}</script>`);
    assert.deepEqual(posted({ html }), { date: '2026-07-14', source: 'ats-json' }, key);
  }
});

test('ats-json: JSON inside a JS string literal (escaped quotes)', () => {
  const html = page('<script>window.__DATA__ = "{\\"first_published\\":\\"2026-06-01T10:00:00-04:00\\"}";</script>');
  assert.deepEqual(posted({ html }), { date: '2026-06-01', source: 'ats-json' });
});

test('ats-json: Lever createdAt epoch milliseconds, converted in UTC', () => {
  const ms = Date.UTC(2026, 8, 30, 23, 59, 0); // 2026-09-30T23:59Z
  const html = page(`<script>var posting = {"text":"Platform Engineer","createdAt":${ms},"workplaceType":"remote"};</script>`);
  assert.deepEqual(posted({ html }), { date: '2026-09-30', source: 'ats-json' });
});

test('ats-json: never reads update, deadline or expiry fields', () => {
  const html = page('<script>{"updated_at":"2026-10-10T00:00:00Z","updatedAt":"2026-10-11","validThrough":"2026-10-12","deadline":"2026-10-13","closingDate":"2026-10-14"}</script>');
  assert.equal(posted({ html }), null);
});

test('ats-json: several different dates under one key are ambiguous and skipped', () => {
  const html = page('<script>{"jobs":[{"publishedAt":"2026-10-01"},{"publishedAt":"2026-10-03"}]}</script>');
  assert.equal(posted({ html }), null);
  const same = page('<script>{"a":{"publishedAt":"2026-10-01"},"b":{"publishedAt":"2026-10-01T05:00:00Z"}}</script>');
  assert.equal(posted({ html: same }).date, '2026-10-01');
});

// ── text ────────────────────────────────────────────────────────────────────

test('text: relative phrases resolve against today', () => {
  const cases = {
    'Posted today': '2026-10-20',
    'Posted yesterday': '2026-10-19',
    'Posted 1 day ago': '2026-10-19',
    'Posted 3 days ago': '2026-10-17',
    'posted 12 days ago': '2026-10-08',
    'Posted a week ago': '2026-10-13',
    'Posted 2 weeks ago': '2026-10-06',
    'Posted: 3 days ago': '2026-10-17',
  };
  for (const [line, date] of Object.entries(cases)) {
    assert.deepEqual(posted({ text: `Data Engineer\n${line}\nLyon` }), { date, source: 'text' }, line);
  }
});

test('text: absolute formats', () => {
  const cases = {
    'Posted on 2 October 2026': '2026-10-02',
    'Posted 2nd Oct 2026': '2026-10-02',
    'Date posted: 2026-10-02': '2026-10-02',
    'Posted Oct 2, 2026': '2026-10-02',
    'Posted on October 2nd, 2026': '2026-10-02',
    'Posted: Sept 9 2026': '2026-09-09',
  };
  for (const [line, date] of Object.entries(cases)) {
    assert.deepEqual(posted({ text: line }), { date, source: 'text' }, line);
  }
});

test('text: coarse or ambiguous phrases yield no date', () => {
  for (const line of ['Posted 30+ days ago', 'Posted over a month ago', 'Posted a month ago', 'Posted 3 months ago', 'Posted 03/04/2026', 'Reposted today', 'Last updated 3 days ago', 'Apply by 2026-10-30']) {
    assert.equal(posted({ text: line }), null, line);
  }
});

test('text: a coarse line does not block a precise one elsewhere', () => {
  assert.equal(posted({ text: 'Posted 30+ days ago\nDate posted: 2026-09-01' }).date, '2026-09-01');
});

test('text: read from html visible text only, never hidden or script text', () => {
  const hidden = page('<h1>Role</h1><div style="display:none">Posted today</div><!-- Posted today --><script>var s = "Posted today"</script>');
  assert.equal(posted({ html: hidden }), null);
  const visible = page('<h1>Role</h1><span class="meta">Posted <b>4</b> days ago</span>');
  assert.deepEqual(posted({ html: visible }), { date: '2026-10-16', source: 'text' });
});

// ── priority and rejections ─────────────────────────────────────────────────

test('priority: json-ld > microdata > ats-json > text', () => {
  const body = '<meta itemprop="datePosted" content="2026-09-02"><script>{"publishedAt":"2026-09-03"}</script><p>Posted 5 days ago</p>';
  assert.deepEqual(posted({ html: page(body, ld({ '@type': 'JobPosting', datePosted: '2026-09-01' })) }), { date: '2026-09-01', source: 'json-ld' });
  assert.deepEqual(posted({ html: page(body) }), { date: '2026-09-02', source: 'microdata' });
  assert.deepEqual(posted({ html: page('<script>{"publishedAt":"2026-09-03"}</script><p>Posted 5 days ago</p>') }), { date: '2026-09-03', source: 'ats-json' });
  assert.deepEqual(posted({ html: page('<p>Posted 5 days ago</p>') }), { date: '2026-10-15', source: 'text' });
});

test('rejections fall through to the next source', () => {
  const future = ld({ '@type': 'JobPosting', datePosted: '2026-10-21' });
  const html = page('<p>Posted 2 days ago</p>', future);
  assert.deepEqual(posted({ html }), { date: '2026-10-18', source: 'text' });
  const stale = page('<p>Posted yesterday</p>', ld({ '@type': 'JobPosting', datePosted: '2023-01-05' }));
  assert.deepEqual(posted({ html: stale }), { date: '2026-10-19', source: 'text' });
  const impossible = page('<p>Posted yesterday</p>', ld({ '@type': 'JobPosting', datePosted: '2026-02-30' }));
  assert.deepEqual(posted({ html: impossible }), { date: '2026-10-19', source: 'text' });
});

test('window edges: today is accepted, tomorrow is not, exactly two years back is accepted', () => {
  assert.equal(posted({ text: 'Date posted: 2026-10-20' }).date, '2026-10-20');
  assert.equal(posted({ text: 'Date posted: 2026-10-21' }), null);
  assert.equal(posted({ text: 'Date posted: 2024-10-20' }).date, '2024-10-20');
  assert.equal(posted({ text: 'Date posted: 2024-10-19' }), null);
  assert.equal(posted({ text: 'Posted on 31 February 2026' }), null);
  assert.equal(posted({ text: 'Posted 200 weeks ago' }), null);
});

test('nothing found, empty input, and a bad `today`', () => {
  assert.equal(posted({ html: page('<p>No dates here</p>') }), null);
  assert.equal(posted({}), null);
  assert.throws(() => extractPostedDate({ text: 'Posted today' }), TypeError);
  assert.throws(() => extractPostedDate({ text: 'Posted today', today: '20-10-2026' }), TypeError);
  assert.throws(() => extractPostedDate({ text: 'Posted today', today: '2026-02-30' }), TypeError);
});
