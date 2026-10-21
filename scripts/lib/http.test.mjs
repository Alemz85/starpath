/**
 * http.test.mjs — scanner transport: address guard, host allowlists,
 * redirect refusal, retry/backoff, bounded bodies. No network: the transport
 * and resolver are injected.
 *
 * Run: node --test scripts/lib/http.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateAddress,
  assertAtsUrl,
  hostMatches,
  guardedLookup,
  backoffDelay,
  createHttp,
  HttpError,
  ATS_HOSTS,
  DEFAULTS,
  LIMITS,
  clampLimit,
} from './http.mjs';

// ── isPrivateAddress ───────────────────────────────────────────────────────

test('isPrivateAddress: RFC1918, loopback, link-local, CGNAT, reserved v4', () => {
  for (const ip of [
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1',
    '127.0.0.1', '127.8.8.8', '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1',
  ]) assert.equal(isPrivateAddress(ip), true, ip);
});

test('isPrivateAddress: public v4 stays public (incl. range edges)', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '203.0.114.1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('isPrivateAddress: IPv6 loopback, unique-local, link-local, multicast, docs', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '2001:db8::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('isPrivateAddress: IPv4 embedded in IPv6 is judged by the embedded address', () => {
  // mapped, dotted and hex forms; NAT64
  for (const ip of ['::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::192.168.0.1', '::127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('[::ffff:8.8.8.8]'), false);
});

test('isPrivateAddress: garbage and empty fail closed', () => {
  for (const ip of ['', null, undefined, 'not-an-ip', '1.2.3', '999.1.1.1', '::g']) {
    assert.equal(isPrivateAddress(ip), true, String(ip));
  }
});

// ── Host allowlist ─────────────────────────────────────────────────────────

test('hostMatches: exact and *.suffix (suffix must have a label in front)', () => {
  assert.equal(hostMatches('api.lever.co', 'api.lever.co'), true);
  assert.equal(hostMatches('API.LEVER.CO.', 'api.lever.co'), true);
  assert.equal(hostMatches('evil-api.lever.co', 'api.lever.co'), false);
  assert.equal(hostMatches('tenant.wd5.myworkdayjobs.com', '*.myworkdayjobs.com'), true);
  assert.equal(hostMatches('myworkdayjobs.com', '*.myworkdayjobs.com'), false);
  assert.equal(hostMatches('myworkdayjobs.com.evil.example', '*.myworkdayjobs.com'), false);
});

test('assertAtsUrl: accepts a real ATS endpoint for its type', () => {
  const u = assertAtsUrl('https://boards-api.greenhouse.io/v1/boards/acme-demo/jobs', { type: 'greenhouse' });
  assert.equal(u.hostname, 'boards-api.greenhouse.io');
  assert.ok(assertAtsUrl('https://nimbus.wd3.myworkdayjobs.com/wday/cxs/nimbus/ext/jobs', { type: 'workday' }));
});

test('assertAtsUrl: rejects wrong ATS host, http, creds, odd port, IP literals, bad URL', () => {
  const bad = (url, type, code) => assert.throws(() => assertAtsUrl(url, { type }), (e) => e instanceof HttpError && e.code === code, url);
  bad('https://evil.example/v1/boards/x/jobs?greenhouse', 'greenhouse', 'EHOST');
  bad('https://api.lever.co/v0/postings/x', 'greenhouse', 'EHOST'); // right host, wrong ATS
  bad('http://boards-api.greenhouse.io/v1/boards/x/jobs', 'greenhouse', 'EBADURL');
  bad(['https://u', ':p', '@boards-api.greenhouse.io/v1'].join(''), 'greenhouse', 'EBADURL'); // URL with credentials
  bad('https://boards-api.greenhouse.io:8443/v1', 'greenhouse', 'EBADURL');
  bad('https://192.168.0.10/jobs', 'greenhouse', 'EBADURL');
  bad('https://[::1]/jobs', 'greenhouse', 'EBADURL');
  bad('not a url', 'greenhouse', 'EBADURL');
  bad('https://x.example/', 'nosuchats', 'EBADURL');
});

test('ATS_HOSTS covers every type scan.mjs detects', () => {
  assert.deepEqual(Object.keys(ATS_HOSTS).sort(), ['ashby', 'greenhouse', 'lever', 'smartrecruiters', 'workday']);
});

// ── guardedLookup ──────────────────────────────────────────────────────────

const lookupReturning = (addrs) => (host, opts, cb) => cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

test('guardedLookup: public answers pass (all:true and single forms)', async () => {
  const look = guardedLookup(lookupReturning(['93.184.216.34']));
  await new Promise((res, rej) => look('api.lever.co', { all: true }, (e, list) => {
    try { assert.equal(e, null); assert.equal(list[0].address, '93.184.216.34'); res(); } catch (x) { rej(x); }
  }));
  await new Promise((res, rej) => look('api.lever.co', {}, (e, addr, fam) => {
    try { assert.equal(addr, '93.184.216.34'); assert.equal(fam, 4); res(); } catch (x) { rej(x); }
  }));
});

test('guardedLookup: a name that resolves to ANY private address is refused', async () => {
  for (const addrs of [['10.0.0.5'], ['93.184.216.34', '127.0.0.1'], ['::ffff:169.254.169.254'], ['fd00::1']]) {
    const look = guardedLookup(lookupReturning(addrs));
    await new Promise((res, rej) => look('rebind.example', { all: true }, (e) => {
      try { assert.ok(e instanceof HttpError); assert.equal(e.code, 'EPRIVATE'); assert.equal(e.retryable, false); res(); } catch (x) { rej(x); }
    }));
  }
});

test('guardedLookup: resolver errors pass through', async () => {
  const look = guardedLookup((h, o, cb) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
  await new Promise((res, rej) => look('nx.example', {}, (e) => { try { assert.equal(e.code, 'ENOTFOUND'); res(); } catch (x) { rej(x); } }));
});

// ── Client: redirects, retries, bounds ─────────────────────────────────────

const ok = (obj, status = 200) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(obj)) });
const URL_GH = 'https://boards-api.greenhouse.io/v1/boards/acme-demo/jobs';

function client(responses, extra = {}) {
  const calls = [];
  const sleeps = [];
  const http = createHttp({
    request: async (url, opts) => {
      calls.push({ url: String(url), ...opts });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    ...extra,
  });
  return { http, calls, sleeps };
}

test('client: parses JSON and sends the bounded, guarded request', async () => {
  const { http, calls } = client([ok({ jobs: [] })]);
  assert.deepEqual(await http.getJson(URL_GH, { type: 'greenhouse' }), { jobs: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(typeof calls[0].lookup, 'function');
  assert.equal(calls[0].timeoutMs, 10_000);
  assert.ok(calls[0].maxBytes > 0);
});

test('client: a redirect is an error, never followed, never retried', async () => {
  const { http, calls } = client([{ status: 302, headers: { location: 'http://169.254.169.254/' }, body: Buffer.alloc(0) }]);
  await assert.rejects(http.getJson(URL_GH, { type: 'greenhouse' }), (e) => e.code === 'EREDIRECT' && e.status === 302);
  assert.equal(calls.length, 1);
});

test('client: refuses a disallowed host before any request is made', async () => {
  const { http, calls } = client([ok({})]);
  await assert.rejects(http.getJson('https://evil.example/x', { type: 'greenhouse' }), (e) => e.code === 'EHOST');
  assert.equal(calls.length, 0);
});

test('client: retries 503 and network errors with growing, jittered delays, then succeeds', async () => {
  const { http, calls, sleeps } = client([
    { status: 503, headers: {}, body: Buffer.alloc(0) },
    new HttpError('reset', { code: 'ECONNRESET', retryable: true }),
    ok({ jobs: [1] }),
  ]);
  assert.deepEqual(await http.getJson(URL_GH, { type: 'greenhouse' }), { jobs: [1] });
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], 'delay grows');
});

test('client: gives up after the retry budget and surfaces the last error', async () => {
  const { http, calls } = client(Array.from({ length: 5 }, () => ({ status: 500, headers: {}, body: Buffer.alloc(0) })));
  await assert.rejects(http.getJson(URL_GH, { type: 'greenhouse' }), (e) => e.status === 500);
  assert.equal(calls.length, 3); // 1 try + 2 retries
});

test('client: 404 and private-address errors are not retried', async () => {
  let r = client([{ status: 404, headers: {}, body: Buffer.alloc(0) }]);
  await assert.rejects(r.http.getJson(URL_GH, { type: 'greenhouse' }), (e) => e.status === 404);
  assert.equal(r.calls.length, 1);
  r = client([new HttpError('private', { code: 'EPRIVATE' })]);
  await assert.rejects(r.http.getJson(URL_GH, { type: 'greenhouse' }), (e) => e.code === 'EPRIVATE');
  assert.equal(r.calls.length, 1);
});

test('client: invalid JSON is a clear error', async () => {
  const { http } = client([{ status: 200, headers: {}, body: Buffer.from('<html>') }]);
  await assert.rejects(http.getJson(URL_GH, { type: 'greenhouse' }), (e) => e.code === 'EJSON');
});

test('client: postJson sends a JSON body with a content-length', async () => {
  const { http, calls } = client([ok({ jobPostings: [] })]);
  await http.postJson('https://nimbus.wd3.myworkdayjobs.com/wday/cxs/nimbus/ext/jobs', { limit: 20 }, { type: 'workday' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"limit":20}');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.equal(calls[0].headers['content-length'], 12);
});

test('backoffDelay: exponential, capped, jitter within [half, full], Retry-After raises the floor', () => {
  const o = { baseDelayMs: 400, maxDelayMs: 5000 };
  assert.equal(backoffDelay(0, { ...o, random: () => 0 }), 200);
  assert.equal(backoffDelay(0, { ...o, random: () => 1 }), 400);
  assert.equal(backoffDelay(10, { ...o, random: () => 1 }), 5000);
  assert.equal(backoffDelay(0, { ...o, random: () => 0, retryAfterMs: 3000 }), 3000);
  assert.equal(backoffDelay(0, { ...o, random: () => 0, retryAfterMs: 60000 }), 5000);
});

// ── Per-request limits (big board feeds) ────────────────────────────────────

test('clampLimit: positive numbers pass up to the ceiling; anything else falls back', () => {
  assert.equal(clampLimit(60_000, 10_000, 120_000), 60_000);
  assert.equal(clampLimit(10 ** 9, 10_000, 120_000), 120_000);
  for (const bad of [undefined, null, 0, -5, NaN, 'soon', Infinity]) assert.equal(clampLimit(bad, 10_000, 120_000), 10_000);
  assert.equal(clampLimit(undefined, 500, 100), 100, 'even the fallback respects the ceiling');
});

test('client: a caller may raise the timeout and body cap for one request, never past LIMITS', async () => {
  const { http, calls } = client([ok([]), ok([]), ok([])]);
  const URL_LEVER = 'https://api.lever.co/v0/postings/nimbus-demo';
  await http.getJson(URL_LEVER, { type: 'lever', timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
  await http.getJson(URL_LEVER, { type: 'lever', timeoutMs: 10 * 60_000, maxBytes: 10 * 1024 ** 3 });
  await http.getJson(URL_LEVER, { type: 'lever' });
  assert.deepEqual(calls.map((c) => [c.timeoutMs, c.maxBytes]), [
    [60_000, 64 * 1024 * 1024],
    [LIMITS.maxTimeoutMs, LIMITS.maxBytes],
    [DEFAULTS.timeoutMs, DEFAULTS.maxBytes],
  ]);
});

test('client: raised limits leave the host allowlist and the address guard in place', async () => {
  const { http, calls } = client([ok([])]);
  await assert.rejects(
    http.getJson('https://evil.example/feed', { type: 'lever', timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 }),
    (e) => e.code === 'EHOST',
  );
  assert.equal(calls.length, 0);
  await http.getJson('https://api.lever.co/v0/postings/nimbus-demo', { type: 'lever', timeoutMs: 60_000 });
  assert.equal(typeof calls[0].lookup, 'function');
});
