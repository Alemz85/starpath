#!/usr/bin/env node
/**
 * posting-guard.mjs — CLI wrapper around scripts/lib/posting-guard.mjs.
 *
 * Before a worker reads a job posting, check the raw page for prompt-injection
 * tricks (hidden text, invisible characters, instruction-shaped lines, links
 * only a machine sees, homoglyph spoofing). Detection logic is pure and
 * unit-tested in scripts/lib/posting-guard.mjs; this file is thin I/O.
 *
 * Usage:
 *   node scripts/posting-guard.mjs --url <https url>   fetch the raw page and check it
 *   node scripts/posting-guard.mjs --file <path>       check a file inside the working directory (html if it looks like html, else text)
 *   node scripts/posting-guard.mjs                     read the posting from stdin
 *   --today YYYY-MM-DD                                 date that "Posted 3 days ago" is resolved against (default: local today)
 *   --save-text <path>                                 also write the readable posting (JSON-LD job text + visible
 *                                                      text, hidden content removed) to <path> inside the working
 *                                                      directory: the JD file a batch worker reads instead of the page
 *
 * Prints exactly one line of JSON on stdout:
 *   {"verdict":"clean|caution|suspect","line":"<report header value>","signals":[…],"posted":{"date":"YYYY-MM-DD","source":"json-ld|microdata|ats-json|text"}|null,"saved":"<path>"|null}
 * `posted` is the deterministic posted-date extraction (lib/posted-date.mjs)
 * from the same content, or null when none is found.
 * If the page cannot be checked (fetch failure, private/local host, unreadable
 * file) it prints {"verdict":"unchecked","line":"unchecked — <reason>","signals":[],"posted":null}
 * and exits 0: an unreachable page must never fail the evaluation.
 * Exit 2 only on bad usage.
 *
 * Only public http(s) hosts are fetched: loopback, private, link-local and
 * `.local` hosts are refused, including when a redirect or DNS answer points there.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { analyzePosting, formatVerdictLine, jobPostingText, readablePosting } from './lib/posting-guard.mjs';
import { extractPostedDate } from './lib/posted-date.mjs';

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--url', '--file', '--today', '--save-text']);

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node scripts/posting-guard.mjs [--url <https url> | --file <path>] [--today YYYY-MM-DD]  (stdin when neither is given)');
  process.exit(2);
}

const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!VALUE_FLAGS.has(a)) usage(`Unknown argument "${a}"`);
  const v = argv[++i];
  if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
  opts[a.slice(2)] = v;
}
if (opts.url && opts.file) usage('Use --url or --file, not both');
if (opts.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) usage('--today must be YYYY-MM-DD');

/** Local calendar date as YYYY-MM-DD. */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Thrown for any reason the page could not be checked; its message is the short reason. */
class Unchecked extends Error {}

/** True for loopback, private, link-local, unspecified and `.local` hosts (names or IP literals). */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1]);
    return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  return false;
}

async function assertPublic(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Unchecked('refused non-http(s) URL');
  if (isPrivateHost(url.hostname)) throw new Unchecked('refused private or local host');
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    let addrs;
    try { addrs = await lookup(url.hostname, { all: true }); } catch { throw new Unchecked('DNS lookup failed'); }
    if (addrs.some((a) => isPrivateHost(a.address))) throw new Unchecked('refused private or local host');
  }
}

/** Read a response body as text, stopping at MAX_BYTES. */
async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Fetch the raw page, following redirects by hand so every hop is host-checked. */
async function fetchPage(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Unchecked('invalid URL'); }
  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      try { url = new URL(res.headers.get('location'), url); } catch { throw new Unchecked('bad redirect'); }
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Unchecked(`HTTP ${res.status}`); }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !/html|xml|text\//.test(type)) { await res.body?.cancel().catch(() => {}); throw new Unchecked('not a web page'); }
    return readCapped(res);
  }
  throw new Unchecked('too many redirects');
}

const looksLikeHtml = (s) => /<\s*(?:!doctype|html|head|body|div|p|span|a|ul|ol|li|h[1-6]|br|meta|script|section|article)\b/i.test(s);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function shortReason(err) {
  if (err instanceof Unchecked) return err.message;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  return String(err?.cause?.code || err?.message || 'fetch failed').split('\n')[0].slice(0, 60);
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Read a JD file inside the working directory only. Workers may run this
 * script, and their own Read permission stops at the checkout; --file must
 * not become a way to read (and echo samples of) any file on the machine.
 */
function readLocalFile(file) {
  let real;
  try { real = realpathSync(file); } catch { throw new Unchecked('unreadable file'); }
  const root = realpathSync(process.cwd());
  if (real !== root && !real.startsWith(root + sep)) throw new Unchecked('file outside the working directory');
  try { return readFileSync(real, 'utf8'); } catch { throw new Unchecked('unreadable file'); }
}

/** Write the readable posting inside the working directory; null when refused or too thin to use. */
function saveReadable(file, text, url) {
  const root = realpathSync(process.cwd());
  const target = resolve(root, file);
  if (!target.startsWith(root + sep)) return null;
  if (text.replace(/\s+/g, ' ').trim().length < 300) return null;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${url ? `Source: ${url}\n\n` : ''}${text}\n`);
  return file;
}

async function main() {
  let body;
  if (opts.url) {
    body = await fetchPage(opts.url);
  } else if (opts.file) {
    body = readLocalFile(opts.file);
  } else {
    if (process.stdin.isTTY) usage('No input: pass --url, --file, or pipe the posting on stdin');
    body = await readStdin();
  }
  const input = looksLikeHtml(body) ? { html: body } : { text: body };
  const result = analyzePosting({ ...input, pageUrl: opts.url });
  // The JSON-LD description is not page text, but a worker reads it in the
  // saved posting: check its words too.
  const ld = input.html ? jobPostingText(input.html) : '';
  if (ld) {
    const extra = analyzePosting({ text: ld }).signals.filter((sg) => !result.signals.some((r) => r.kind === sg.kind));
    result.signals.push(...extra);
    if (result.signals.some((sg) => sg.severity === 'high')) result.verdict = 'suspect';
    else if (result.signals.length) result.verdict = 'caution';
  }
  const saved = opts['save-text'] ? saveReadable(opts['save-text'], readablePosting(input), opts.url) : null;
  let posted = null;
  try { posted = extractPostedDate({ ...input, today: opts.today ?? localToday() }); } catch { /* invalid --today etc.: no date */ }
  print({ verdict: result.verdict, line: formatVerdictLine(result), signals: result.signals, posted, saved });
}

main().catch((err) => {
  print({ verdict: 'unchecked', line: `unchecked — ${shortReason(err)}`, signals: [], posted: null, saved: null });
});
