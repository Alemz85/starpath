/**
 * posted-date.mjs — deterministic "when was this listing posted" extractor.
 * Pure: no IO. Reads structured data first (JSON-LD, microdata, known ATS
 * JSON), then the visible text ("Posted 3 days ago"). It never guesses: a
 * value that is ambiguous, coarse ("30+ days ago", "a month ago"), in the
 * future, older than two years, or not a real calendar date is skipped and
 * the next source gets its turn.
 *
 * Dates are taken as written. A timestamp's leading YYYY-MM-DD is the answer;
 * no timezone shifting. Relative phrases are resolved against the caller's
 * local `today`. Hidden text never counts (it goes through the visible-text
 * extractor of posting-guard.mjs).
 */

import { extractVisibleText } from './posting-guard.mjs';

// ── Calendar helpers ────────────────────────────────────────────────────────

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms (UTC midnight) of a valid `YYYY-MM-DD`, else null. */
function ymdToMs(s) {
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? t : null;
}

const msToYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

function addDays(ymd, delta) {
  return msToYmd(ymdToMs(ymd) + delta * DAY_MS);
}

/** `date` if it is a real date, not after `today`, and within two years of it; else null. */
function acceptable(date, today) {
  const t = ymdToMs(date);
  const now = ymdToMs(today);
  if (t === null || t > now) return null;
  const n = new Date(now);
  const cutoff = Date.UTC(n.getUTCFullYear() - 2, n.getUTCMonth(), n.getUTCDate());
  return t < cutoff ? null : date;
}

/** Leading `YYYY-MM-DD` of an ISO date or timestamp, else null. */
function leadingIsoDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d{4}-\d{2}-\d{2})(?![\d-])(?:[T\s].*)?$/s.exec(v);
  return m ? m[1] : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

// ── Source: JSON-LD ─────────────────────────────────────────────────────────

const LD_JSON_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

const hasJobPostingType = (node) => {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && /(?:^|[/#:])JobPosting$/i.test(x));
};

/** Depth-first walk through arrays, `@graph` and nested objects for JobPosting nodes. */
function* jobPostings(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* jobPostings(n, depth + 1);
    return;
  }
  if (hasJobPostingType(node)) yield node;
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* jobPostings(v, depth + 1);
}

function fromJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(LD_JSON_RE)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const job of jobPostings(data)) {
      const d = leadingIsoDate(job.datePosted);
      if (d) out.push(d);
    }
  }
  return out;
}

// ── Source: microdata ───────────────────────────────────────────────────────

function fromMicrodata(html) {
  const out = [];
  for (const m of html.matchAll(/<[a-zA-Z][^>]*\bitemprop\s*=\s*(["'])datePosted\1[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
    const a = attr('content') ?? attr('datetime');
    const d = a ? leadingIsoDate(a[1] ?? a[2]) : null;
    if (d) out.push(d);
  }
  return out;
}

// ── Source: embedded ATS JSON ───────────────────────────────────────────────

// ISO-valued keys, in priority order. updated_at / updatedAt / validThrough
// and any deadline field are deliberately absent.
const ATS_ISO_KEYS = ['datePosted', 'publishedAt', 'published_at', 'first_published', 'postedOn'];

/**
 * Within one key, a page naming several different dates (a listing index, a
 * "similar jobs" widget) is ambiguous, so only an unambiguous key counts.
 */
function fromAtsJson(html) {
  const out = [];
  for (const key of ATS_ISO_KEYS) {
    const re = new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"(\\d{4}-\\d{2}-\\d{2})(?![\\d-])[^"\\\\]*\\\\?"`, 'g');
    const dates = new Set([...html.matchAll(re)].map((m) => m[1]));
    if (dates.size === 1) out.push([...dates][0]);
  }
  // Lever: "createdAt" as epoch milliseconds (13 digits), converted in UTC.
  const lever = new Set(
    [...html.matchAll(/\\?"createdAt\\?"\s*:\s*(\d{13})(?!\d)/g)].map((m) => msToYmd(Number(m[1]))),
  );
  if (lever.size === 1) out.push([...lever][0]);
  return out;
}

// ── Source: visible text ────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const LABEL = '(?<![a-z])(?:date\\s+posted|posted\\s+date|posting\\s+date|posted(?:\\s+on)?)\\s*[:\\-–—]?\\s*';
const NUM_WORDS = { a: 1, an: 1, one: 1 };

const ABS_ISO_RE = new RegExp(`${LABEL}(\\d{4}-\\d{2}-\\d{2})(?![\\d-])`, 'i');
const ABS_DMY_RE = new RegExp(`${LABEL}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})(?![\\d])`, 'i');
const ABS_MDY_RE = new RegExp(`${LABEL}${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\d])`, 'i');
const REL_RE = /(?<![a-z])posted\s*[:\-–—]?\s*(?:(today|yesterday)|(\d+|an?|one)\s+(day|week)s?\s+ago)(?![a-z])/i;

/** Date phrases on one line, in reading order, resolved against `today`. */
function datesInLine(line, today) {
  const out = [];
  const rel = REL_RE.exec(line);
  if (rel) {
    if (rel[1]) out.push(rel[1].toLowerCase() === 'today' ? today : addDays(today, -1));
    else {
      const n = /^\d+$/.test(rel[2]) ? Number(rel[2]) : NUM_WORDS[rel[2].toLowerCase()];
      out.push(addDays(today, -n * (rel[3].toLowerCase() === 'week' ? 7 : 1)));
    }
  }
  // "30+ days ago", "a month ago", "3 months ago": only a bound is known, so no date.
  let m = ABS_ISO_RE.exec(line);
  if (m) out.push(m[1]);
  m = ABS_DMY_RE.exec(line);
  if (m) out.push(`${m[3]}-${pad2(MONTHS[m[2].toLowerCase()])}-${pad2(Number(m[1]))}`);
  m = ABS_MDY_RE.exec(line);
  if (m) out.push(`${m[3]}-${pad2(MONTHS[m[1].toLowerCase()])}-${pad2(Number(m[2]))}`);
  return out;
}

function fromText(visible, today) {
  const out = [];
  for (const line of visible.split('\n')) out.push(...datesInLine(line, today));
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * The listing's posted date, from the first source that yields an acceptable
 * one. Sources in priority order: `json-ld`, `microdata`, `ats-json`, `text`.
 * Candidates after `today`, more than two years before it, or not real
 * calendar dates are rejected and the search continues.
 *
 * @param {{ html?: string, text?: string, today: string }} input `today` is the caller's local date, `YYYY-MM-DD`.
 * @returns {{ date: string, source: 'json-ld'|'microdata'|'ats-json'|'text' } | null}
 */
export function extractPostedDate({ html, text, today } = {}) {
  if (typeof today !== 'string' || ymdToMs(today) === null) {
    throw new TypeError('extractPostedDate: `today` must be a valid YYYY-MM-DD string');
  }
  const h = typeof html === 'string' ? html : '';
  const visible = [extractVisibleText({ html: h, text: h ? undefined : text }), h && typeof text === 'string' ? text : '']
    .filter(Boolean)
    .join('\n');
  const sources = [
    ['json-ld', () => (h ? fromJsonLd(h) : [])],
    ['microdata', () => (h ? fromMicrodata(h) : [])],
    ['ats-json', () => (h ? fromAtsJson(h) : [])],
    ['text', () => fromText(visible, today)],
  ];
  for (const [source, collect] of sources) {
    for (const cand of collect()) {
      const date = acceptable(cand, today);
      if (date) return { date, source };
    }
  }
  return null;
}
