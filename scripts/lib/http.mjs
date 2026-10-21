/**
 * http.mjs — the one transport every scanner fetch goes through.
 *
 * scan.mjs used to call bare `fetch(url)` on whatever `user/portals.yml` said:
 * redirects were followed (so an allowlisted host could bounce the request
 * anywhere), nothing stopped a typo'd or hostile entry from pointing at
 * `http://192.168.0.1/` or `http://169.254.169.254/`, and a response body of
 * any size was buffered. This module closes those:
 *
 *   • https only, default port only, no URL credentials.
 *   • Per-ATS host allowlist (`ATS_HOSTS`): a `portals.yml` URL has to land on
 *     the ATS it claims to be (`assertAtsUrl`). Exact hosts, or a `*.suffix`
 *     for tenant-per-subdomain ATSs (Workday).
 *   • Redirects are refused (`redirect: 'error'` semantics): a 3xx is a hard
 *     error, never followed. The ATS APIs we call do not redirect.
 *   • Private-address guard (`isPrivateAddress`): RFC1918, loopback,
 *     link-local, CGNAT, multicast/reserved, unique-local/link-local IPv6 and
 *     IPv4 embedded in IPv6 (mapped `::ffff:a.b.c.d`, NAT64, 6to4 is not
 *     special-cased because it carries a routable v4). The check happens in the
 *     socket's own `lookup` hook, i.e. on the exact address the connection is
 *     made to — no resolve-then-fetch gap for DNS rebinding, and NO
 *     process-wide DNS patching: the guard is scoped to this module's requests.
 *   • Bounded: connect/total timeout, response body capped (also after gzip),
 *     retries only for transient failures (network error / 429 / 5xx) with
 *     exponential backoff + jitter. A caller may raise the timeout and body cap
 *     for one request (a big board feed), never past `LIMITS`.
 *
 * Everything with side effects (DNS, sockets, sleeping, randomness) is
 * injectable, so the whole thing is unit-tested without a network.
 */

import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

// ── Host allowlists ─────────────────────────────────────────────────────────

/**
 * Hosts each ATS API may be reached on. An entry starting with `*.` matches any
 * subdomain of the suffix (not the bare suffix). Add a host here only when the
 * ATS documents it as its API endpoint.
 */
export const ATS_HOSTS = Object.freeze({
  greenhouse: ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'],
  ashby: ['api.ashbyhq.com'],
  lever: ['api.lever.co', 'api.eu.lever.co'],
  workday: ['*.myworkdayjobs.com'],
  smartrecruiters: ['api.smartrecruiters.com'],
});

/**
 * Company career sites (not ATSs) with a public, no-auth JSON endpoint. Kept
 * apart from ATS_HOSTS, which is exactly the set of types the scanner detects;
 * the liveness ladder passes these as `hosts`.
 */
export const SITE_API_HOSTS = Object.freeze({
  amazon: ['www.amazon.jobs'],
});

/**
 * Hosts a POSTING PAGE (the human-readable HTML a candidate opens) is served
 * from, per ATS. Only the liveness ladder fetches these (`getText`); same
 * matching rules as ATS_HOSTS.
 */
export const ATS_PAGE_HOSTS = Object.freeze({
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.eu.greenhouse.io'],
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
  workday: ['*.myworkdayjobs.com'],
  smartrecruiters: ['careers.smartrecruiters.com', 'jobs.smartrecruiters.com'],
  // Company career sites that ship `JobPosting` JSON-LD (or a server-rendered JD).
  amazon: ['amazon.jobs', 'www.amazon.jobs'],
  picnic: ['jobs.picnic.app'],
  factorial: ['careers.factorial.com'],
});

export class HttpError extends Error {
  /** @param {string} message @param {{code?:string,status?:number,retryable?:boolean}} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = info.code || 'EHTTP';
    this.status = info.status ?? null;
    this.retryable = Boolean(info.retryable);
  }
}

/** Does `host` match one allowlist entry (exact, or `*.suffix`)? */
export function hostMatches(host, entry) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const e = String(entry).toLowerCase();
  if (e.startsWith('*.')) {
    const suffix = e.slice(1); // ".myworkdayjobs.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return h === e;
}

/**
 * Validate a URL for scanning: https, default port, no credentials, a hostname
 * (not a bare IP), and — when `type` names an ATS — a host on that ATS's
 * allowlist. Returns the parsed URL; throws HttpError otherwise.
 *
 * @param {string} raw
 * @param {{type?: keyof typeof ATS_HOSTS, hosts?: string[]}} [opts]
 *        `type` looks up ATS_HOSTS; `hosts` overrides with an explicit list.
 */
export function assertAtsUrl(raw, { type, hosts } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new HttpError(`invalid URL`, { code: 'EBADURL' });
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(`only https is allowed (got ${url.protocol.replace(':', '')})`, { code: 'EBADURL' });
  }
  if (url.username || url.password) {
    throw new HttpError('credentials in URL are not allowed', { code: 'EBADURL' });
  }
  if (url.port && url.port !== '443') {
    throw new HttpError(`non-default port ${url.port} is not allowed`, { code: 'EBADURL' });
  }
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
    throw new HttpError('IP-literal hosts are not allowed', { code: 'EBADURL' });
  }
  const allowed = hosts || (type ? ATS_HOSTS[type] : null);
  if (type && !allowed) throw new HttpError(`unknown ATS type "${type}"`, { code: 'EBADURL' });
  if (allowed && !allowed.some((e) => hostMatches(host, e))) {
    throw new HttpError(`host ${host} is not an allowed ${type || 'scanner'} host`, { code: 'EHOST' });
  }
  return url;
}

// ── Address guard ───────────────────────────────────────────────────────────

/** Parse a dotted IPv4 into 4 octets, or null. */
function v4Octets(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateV4(o) {
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 literal to 16 bytes, or null. Accepts an embedded dotted v4 tail. */
function v6Bytes(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  let tail = null;
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.') && lastColon !== -1) {
    const o = v4Octets(s.slice(lastColon + 1));
    if (!o) return null;
    tail = o;
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill('0'), ...rest]
    : head;
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 0xff);
  }
  if (tail) out.splice(12, 4, ...tail);
  return out;
}

function isPrivateV6(b) {
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d
  const zeros10 = b.slice(0, 10).every((x) => x === 0);
  if (zeros10 && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(b.slice(12));
  if (b.slice(0, 12).every((x) => x === 0)) return isPrivateV4(b.slice(12));
  // NAT64 64:ff9b::/96 embeds a v4 — judge the embedded address
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isPrivateV4(b.slice(12));
  }
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 docs
  return false;
}

/**
 * True when `ip` is an address a public scanner must never connect to.
 * Unparseable input is treated as private (fail closed).
 */
export function isPrivateAddress(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return true;
  const bare = s.replace(/^\[|\]$/g, '');
  if (net.isIPv4(bare)) {
    const o = v4Octets(bare);
    return o ? isPrivateV4(o) : true;
  }
  if (net.isIPv6(bare) || bare.includes(':')) {
    const b = v6Bytes(bare);
    return b ? isPrivateV6(b) : true;
  }
  return true;
}

/**
 * A `lookup` function for `https.request` that resolves a name and refuses to
 * hand the socket any private address. Because the socket connects to exactly
 * the address returned here, a name that resolves to a public address at check
 * time cannot be re-pointed at an internal one before connect.
 *
 * @param {typeof dns.lookup} [lookupImpl] injectable resolver (dns.lookup shape)
 */
export function guardedLookup(lookupImpl = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (list.length === 0) return callback(new HttpError(`no address for ${hostname}`, { code: 'ENOTFOUND', retryable: true }));
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) {
        return callback(new HttpError(`${hostname} resolves to a private address (${bad.address})`, { code: 'EPRIVATE' }));
      }
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

// ── Default transport (node:https) ──────────────────────────────────────────

/**
 * One request over node:https. Resolves with `{status, headers, body: Buffer}`;
 * rejects with HttpError for oversize bodies, timeouts and socket errors. Never
 * follows redirects (https.request has no such behaviour; the caller treats 3xx
 * as an error).
 */
export function nodeRequest(url, { method = 'GET', headers = {}, body, timeoutMs, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = https.request(url, { method, headers, lookup, agent: false }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes && !res.headers['content-encoding']) {
        res.destroy();
        req.destroy();
        return done(reject, new HttpError(`response too large (${declared} bytes > ${maxBytes})`, { code: 'ETOOBIG' }));
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc && enc !== 'identity') {
        res.destroy();
        return done(reject, new HttpError(`unsupported content-encoding ${enc}`, { code: 'EENCODING' }));
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          stream.destroy();
          res.destroy();
          req.destroy();
          done(reject, new HttpError(`response too large (> ${maxBytes} bytes)`, { code: 'ETOOBIG' }));
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => done(resolve, { status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on('error', (e) => done(reject, new HttpError(e.message, { code: e.code || 'ESTREAM', retryable: true })));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new HttpError(`timeout after ${timeoutMs}ms`, { code: 'ETIMEDOUT', retryable: true }));
    }, timeoutMs);
    req.on('error', (e) => {
      if (e instanceof HttpError) return done(reject, e);
      // Errors raised inside our guarded lookup surface here with the HttpError
      // as `cause` on some Node versions — unwrap so EPRIVATE stays non-retryable.
      if (e.cause instanceof HttpError) return done(reject, e.cause);
      done(reject, new HttpError(e.message, { code: e.code || 'ENET', retryable: true }));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── Client ──────────────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 25 * 1024 * 1024,
  retries: 2,
  baseDelayMs: 400,
  maxDelayMs: 5_000,
});

/**
 * Hard ceilings on what any caller may ask for. A big board feed (a 13 MB
 * Lever JSON) needs more than DEFAULTS, so providers and `portals.yml` board
 * entries may raise the timeout and body cap for their board request
 * (provider-registry.mjs › boardFeedLimits), never past these.
 */
export const LIMITS = Object.freeze({
  maxTimeoutMs: 120_000,
  maxBytes: 100 * 1024 * 1024,
});

/** `value` when it is a positive finite number, capped at `max`; else `fallback`. */
export function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
  return Math.min(n, max);
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Backoff delay for attempt `n` (0-based): exponential from `baseDelayMs`,
 * capped at `maxDelayMs`, with full jitter in [delay/2, delay]. A numeric
 * `retryAfterMs` (from a Retry-After header) raises the floor, still capped.
 */
export function backoffDelay(n, { baseDelayMs, maxDelayMs, random = Math.random, retryAfterMs = 0 }) {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** n);
  const jittered = exp / 2 + random() * (exp / 2);
  return Math.min(maxDelayMs, Math.max(jittered, retryAfterMs || 0));
}

function retryAfterMs(headers) {
  const raw = headers?.['retry-after'];
  if (!raw) return 0;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
}

/**
 * Build a scanner HTTP client.
 *
 * @param {object} [deps]
 * @param {typeof nodeRequest} [deps.request] transport (injectable for tests)
 * @param {typeof dns.lookup} [deps.lookup]   resolver for the address guard
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {()=>number} [deps.random]
 * @param {Partial<typeof DEFAULTS>} [deps.defaults]
 */
export function createHttp({ request = nodeRequest, lookup = dns.lookup, sleep, random = Math.random, defaults = {} } = {}) {
  const cfg = { ...DEFAULTS, ...defaults };
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const guarded = guardedLookup(lookup);

  async function send(rawUrl, opts = {}) {
    const url = assertAtsUrl(rawUrl, { type: opts.type, hosts: opts.hosts });
    const method = opts.method || 'GET';
    const payload = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    const headers = {
      'user-agent': 'starpath-scanner',
      accept: 'application/json',
      'accept-encoding': 'gzip',
      ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...(opts.headers || {}),
    };
    const retries = opts.retries ?? cfg.retries;
    const maxBytes = clampLimit(opts.maxBytes, cfg.maxBytes, LIMITS.maxBytes);
    const timeoutMs = clampLimit(opts.timeoutMs, cfg.timeoutMs, LIMITS.maxTimeoutMs);

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let retryHint = 0;
      try {
        const res = await request(url, { method, headers, body: payload, timeoutMs, maxBytes, lookup: guarded });
        // `okStatus`: statuses the caller wants handed back instead of thrown (the
        // liveness ladder reads a 404 page, or the Location of a redirect it will
        // not follow). Redirects are still never followed.
        if (opts.okStatus && opts.okStatus.includes(res.status)) return res;
        if (res.status >= 300 && res.status < 400) {
          throw new HttpError(`redirect (HTTP ${res.status}) refused`, { code: 'EREDIRECT', status: res.status });
        }
        if (res.status < 200 || res.status >= 300) {
          retryHint = retryAfterMs(res.headers);
          throw new HttpError(`HTTP ${res.status}`, { code: 'ESTATUS', status: res.status, retryable: RETRYABLE_STATUS.has(res.status) });
        }
        return res;
      } catch (err) {
        lastErr = err instanceof HttpError ? err : new HttpError(err.message, { code: err.code, retryable: true });
        if (!lastErr.retryable || attempt === retries) break;
        await wait(backoffDelay(attempt, { ...cfg, random, retryAfterMs: retryHint }));
      }
    }
    throw lastErr;
  }

  async function json(rawUrl, opts = {}) {
    const res = await send(rawUrl, opts);
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new HttpError('invalid JSON in response', { code: 'EJSON', status: res.status });
    }
  }

  /**
   * GET a posting page → `{status, headers, text}`. The URL must be on the
   * page-host allowlist of `type` (ATS_PAGE_HOSTS). Statuses in `okStatus`
   * (default 404/410 and 3xx) come back instead of throwing.
   */
  async function text(rawUrl, opts = {}) {
    const hosts = ATS_PAGE_HOSTS[opts.type];
    if (!hosts) throw new HttpError(`unknown ATS type "${opts.type}"`, { code: 'EBADURL' });
    const res = await send(rawUrl, {
      retries: 1,
      maxBytes: 3 * 1024 * 1024,
      okStatus: [301, 302, 303, 307, 308, 404, 410],
      ...opts,
      hosts,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', ...(opts.headers || {}) },
    });
    return { status: res.status, headers: res.headers, text: res.body.toString('utf8') };
  }

  return {
    send,
    getText: text,
    /** GET → parsed JSON. */
    getJson: (url, opts) => json(url, { ...opts, method: 'GET' }),
    /** POST a JSON body → parsed JSON. */
    postJson: (url, body, opts) => json(url, { ...opts, method: 'POST', json: body }),
  };
}

/** Process-wide default client (real DNS, real sockets). */
export const http = createHttp();
