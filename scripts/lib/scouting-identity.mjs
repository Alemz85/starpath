// scouting-identity.mjs — is an incoming scouting addition the SAME listing as
// an existing data/scouting.md row, or a different one?
//
// merge-scouting used to fold an addition into any same-company row whose role
// matched loosely, which overwrote sibling listings (a longer title for another
// track, the same title in another city). The rule here:
//
//   1. Posting identity decides when both sides have one: the ATS posting id
//      (lib/ats-url.mjs parsePostingUrl), else the canonical posting URL
//      (merge-staging-core canonicalizeUrl). Equal → same listing, different →
//      different listing, whatever the numbers and titles say.
//   2. Same company and same row number → same listing (a re-eval that kept
//      the row's number).
//   3. Otherwise (older rows with no URL) only the same company, the same role
//      after boilerplate is dropped (case, spacing, gender tags, req ids) and,
//      when both sides know it, the same city counts as the same listing.
//   4. A similar but not identical role, or an identity source that names
//      several listings for one company + role + date, is ambiguous: the
//      addition becomes its own row and the merge warns, naming both rows.
//
// A side's URL and city come from its report header (`**URL:**`,
// `**Location:**`, trusted only when its `**Date:**` is the row's date: report
// files are named `{Company} - {Role}.md`, so a later listing with the same
// title overwrites the file) and, failing that, from data/score-history.tsv
// rows with the same company, role and date. The TSV itself carries no URL.
//
// Pure; the merge script owns the file reads. Unit-tested in
// scouting-identity.test.mjs.

import { canonicalizeUrl, postingIdKey } from './merge-staging-core.mjs';
import { parsePostingUrl } from './ats-url.mjs';
import { companyKey, normalizeRoleForIndex, roleVariantMatch, roleFuzzyMatch } from './scouting-core.mjs';

const GENDER_TAG_RE = /\(\s*[mwfdhx](?:\s*[\/|]\s*[mwfdhx])+\s*\)/gi;
const REQ_ID_RE = /(?:[#(]\s*(?:jr|req|ref|id|r)?[-\s]?\d{4,}[a-z0-9-]*\s*\)?|\b(?:req|ref|job\s*id|requisition)\b[:#]?\s*[a-z]?\d{3,}[a-z0-9-]*)/gi;

/**
 * The role with only boilerplate removed: case, spacing, punctuation, gender
 * tags and req ids. Every real word (city, track, level, season) stays, so two
 * titles that differ in one of those never share a key.
 */
export function strictRoleKey(role) {
  return String(role ?? '').toLowerCase()
    .replace(GENDER_TAG_RE, ' ')
    .replace(REQ_ID_RE, ' ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

/**
 * Identity key for a posting URL: `id:<ats>:<org>:<posting id>` for a known ATS
 * posting URL, else `url:<canonical url>`; '' when there is no http(s) URL.
 */
export function postingKey(url) {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  const p = parsePostingUrl(raw);
  if (p) {
    const k = postingIdKey(`${p.ats}:${String(p.org).toLowerCase()}`, p.id);
    if (k) return `id:${k}`;
  }
  const canon = canonicalizeUrl(raw);
  return canon ? `url:${canon}` : '';
}

const NO_CITY = new Set(['', 'n d', 'na', 'n a', 'nd', 'tbd', 'remote', 'unknown', 'various', 'multiple', 'multiple locations']);

/**
 * The city part of a location ("Lyon, France · hybrid 2 days" → "lyon"),
 * lowercased with diacritics folded; '' when the cell names no city.
 */
export function cityKey(location) {
  const first = String(location ?? '').split(/[,(·|;]|\s[-–—]\s/)[0];
  const k = first.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return NO_CITY.has(k) ? '' : k;
}

/** `**URL:**`, `**Location:**` and `**Date:**` from the top of a report ('' when absent). */
export function parseReportHeader(text) {
  const t = String(text ?? '');
  const field = (name) => (new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'im').exec(t)?.[1] ?? '').trim();
  const url = field('URL').split(/\s+/)[0] || '';
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(field('Date'))?.[1] ?? '';
  return { url: /^https?:\/\//i.test(url) ? url : '', location: field('Location'), date };
}

const historyKey = (company, role, date) => `${companyKey(company)}\t${strictRoleKey(role)}\t${String(date ?? '').trim()}`;

/**
 * Index data/score-history.tsv (header-named columns) by company + role +
 * date → { keys: Set<postingKey>, cities: Set<cityKey> }. Rows without the
 * columns are ignored; a missing or garbled file gives an empty index.
 */
export function indexScoreHistory(text) {
  const out = new Map();
  const lines = String(text ?? '').split(/\r?\n/);
  const header = (lines[0] || '').split('\t').map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const [ci, ri, di, ui, li] = ['company', 'role', 'date', 'url', 'location'].map(col);
  if (ci < 0 || ri < 0 || di < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split('\t');
    const k = historyKey(c[ci], c[ri], c[di]);
    if (!out.has(k)) out.set(k, { keys: new Set(), cities: new Set() });
    const e = out.get(k);
    const pk = ui >= 0 ? postingKey(c[ui]) : '';
    if (pk) e.keys.add(pk);
    const city = li >= 0 ? cityKey(c[li]) : '';
    if (city) e.cities.add(city);
  }
  return out;
}

/**
 * Resolve one side's identity.
 *   { company, role, date }  the row or addition
 *   report                   parseReportHeader() of its report, or null
 *   history                  indexScoreHistory() result, or null
 * → { key, city, ambiguous, source } — `ambiguous` when score-history holds
 * several listings for this company + role + date and nothing narrower said
 * which one this is.
 */
export function resolveIdentity({ company, role, date } = {}, { report = null, history = null } = {}) {
  let key = '';
  let city = '';
  let source = '';
  let ambiguous = false;
  if (report && (!report.date || report.date === String(date ?? '').trim())) {
    key = postingKey(report.url);
    city = cityKey(report.location);
    if (key) source = 'report';
  }
  const h = history?.get(historyKey(company, role, date));
  if (h) {
    if (!key) {
      if (h.keys.size === 1) { key = [...h.keys][0]; source = 'score-history'; }
      else if (h.keys.size > 1) ambiguous = true;
    }
    if (!city) {
      if (h.cities.size === 1) city = [...h.cities][0];
      else if (h.cities.size > 1 && !key) ambiguous = true;
    }
  }
  return { key, city, ambiguous, source };
}

/**
 * Compare an addition with one existing row. Both are
 * `{ num, company, role, date, identity }` (identity from resolveIdentity).
 * → { verdict: 'same' | 'different' | 'ambiguous' | 'unrelated', rank, reason }
 * `rank` orders same-listing evidence: 0 posting identity, 1 row number,
 * 2 company + role (+ city).
 */
export function compareListing(addition, row) {
  const a = addition.identity || {};
  const b = row.identity || {};
  const sameCompany = companyKey(addition.company) === companyKey(row.company);
  const exactRole = strictRoleKey(addition.role) === strictRoleKey(row.role) && strictRoleKey(row.role) !== '';
  const similarRole = exactRole || normalizeRoleForIndex(addition.role) === normalizeRoleForIndex(row.role)
    || roleVariantMatch(addition.role, row.role) || roleFuzzyMatch(addition.role, row.role);
  if (a.key && b.key) {
    if (a.key === b.key) return { verdict: 'same', rank: 0, reason: 'same posting' };
    return { verdict: sameCompany && similarRole ? 'different' : 'unrelated', rank: 0, reason: 'different posting URL' };
  }
  if (!sameCompany) return { verdict: 'unrelated', rank: 9, reason: 'other company' };
  if (Number(addition.num) === Number(row.num)) return { verdict: 'same', rank: 1, reason: 'same row number' };
  if (a.city && b.city && a.city !== b.city) {
    return similarRole ? { verdict: 'different', rank: 2, reason: `different location (${b.city} vs ${a.city})` } : { verdict: 'unrelated', rank: 9, reason: 'other role' };
  }
  if (exactRole) {
    if (a.ambiguous || b.ambiguous) return { verdict: 'ambiguous', rank: 2, reason: 'same role, but score-history has several listings for it that day' };
    return { verdict: 'same', rank: 2, reason: a.city && b.city ? 'same company, role and location' : 'same company and role' };
  }
  if (similarRole) return { verdict: 'ambiguous', rank: 2, reason: 'similar role, no URL to tell them apart' };
  return { verdict: 'unrelated', rank: 9, reason: 'other role' };
}

/**
 * Pick the row an addition re-evaluates, if any.
 * → { row: the same-listing row or null, reason, conflicts: [{ row, verdict, reason }] }
 * `conflicts` lists the same-company rows that look alike but were judged a
 * different listing or could not be told apart (for the merge's warning).
 * Only 'same' ever selects a row: a similar title alone never overwrites one.
 */
export function findSameListing(addition, rows) {
  let best = null;
  const conflicts = [];
  for (const row of rows) {
    const c = compareListing(addition, row);
    if (c.verdict === 'same') {
      if (!best || c.rank < best.c.rank) best = { row, c };
    } else if (c.verdict === 'different' || c.verdict === 'ambiguous') {
      conflicts.push({ row, verdict: c.verdict, reason: c.reason });
    }
  }
  return best ? { row: best.row, reason: best.c.reason, conflicts: [] } : { row: null, reason: '', conflicts };
}
