/**
 * merge-staging-core.mjs — pure merge math for the JobSpy staging → canonical
 * merge, extracted from merge-scan-staging.mjs so it can be unit-tested in
 * isolation (no filesystem).
 *
 * The script (merge-scan-staging.mjs) keeps the file IO + rename/archive
 * choreography; the parsing/dedup/append math lives here.
 *
 * ── Why a (company, role) dedup pass on top of URL dedup ──────────────────
 * Aggregators (Indeed, Google Jobs) surface the SAME posting under MULTIPLE
 * distinct URLs — Google's redirect link, Indeed's `job_url`, the employer's
 * `job_url_direct`, tracking-param variants, etc. URL-only dedup therefore
 * lets one real job re-enter the pipeline several times across runs, forcing
 * the user to triage the same role two or three times.
 *
 * This module collapses staging rows to a normalized (company, role) key —
 * built on the same primitives the rest of the system uses (see
 * lib/dedup-index.mjs) — and drops a staging row when that key already exists
 * in scan-history OR was already accepted earlier in the same merge. URL
 * dedup still runs first (it's exact and cheap); company+role dedup is the
 * semantic safety net.
 *
 * ── Two extra quality layers added on top of the base scheme ──────────────
 *  1. URL canonicalization (canonicalizeUrl): strips tracking params and
 *     unwraps Google-Jobs redirect wrappers BEFORE the exact-URL compare, so
 *     `…/job?utm_source=x` and the bare `…/job` collapse to one row instead
 *     of two. This catches a whole class of cross-URL dupes that the
 *     (company, role) pass would otherwise have to clean up — and that it
 *     CAN'T clean up when the title/company strings also differ slightly.
 *  2. Role canonicalization (canonicalizeRole): strips the boilerplate
 *     aggregators staple onto titles — `(m/f/d)`, ` - Remote`, ` | Dublin`,
 *     contract/seniority/req-id noise — so near-duplicate title variants of
 *     the same job collapse to one (company, role) key instead of slipping
 *     through as "different roles".
 *
 * Both layers are conservative: when in doubt they keep the row (fail-open on
 * dedup, so we never silently lose a genuinely new posting), and low-quality
 * guarding (isLowQualityRow) only drops rows with no usable signal at all.
 */

import { normalizeCompany, normalizeRole } from './dedup-index.mjs';

export const HISTORY_HEADER =
  'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates';

// scan-history.tsv column order (0-indexed)
const COL_URL = 0;
const COL_TITLE = 3;
const COL_COMPANY = 4;

// ── URL canonicalization ───────────────────────────────────────────────────

// Query params that never identify the posting — pure tracking / session noise.
const TRACKING_PARAM_RE =
  /^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref|referrer|source|src|campaign|cmp|spreadsheet|trk|trackingid|recommended|from|origin|sid|cid|igshid|_ga|gh_src)$/i;

/**
 * Canonicalize a job URL for exact-match dedup. Best-effort and fail-open:
 * any URL we can't parse is returned trimmed-but-otherwise-untouched so it
 * still dedups against an identical raw string.
 *
 * Steps:
 *  - unwrap Google-Jobs / generic redirect wrappers (?url=…, ?q=…, ?continue=…)
 *  - lowercase scheme + host, drop a leading `www.`
 *  - strip tracking query params (keep functional ones like `jk`, `gh_jid`)
 *  - drop the fragment and any trailing slash on the path
 */
export function canonicalizeUrl(raw) {
  if (!raw) return raw;
  const trimmed = String(raw).trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // Unwrap one level of redirect wrapper (Google Jobs, generic ?url=/?q=).
  for (const k of ['url', 'q', 'continue', 'target', 'redirect']) {
    const inner = url.searchParams.get(k);
    if (inner && /^https?:\/\//i.test(inner)) {
      try {
        url = new URL(inner);
        break;
      } catch {
        /* keep outer */
      }
    }
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';

  // Drop tracking params, keep the rest in a stable (sorted) order.
  const kept = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (!TRACKING_PARAM_RE.test(k)) kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);

  // Normalize trailing slash on the path (but keep a bare "/").
  let out = url.toString();
  out = out.replace(/\/(\?|$)/, '$1');
  return out;
}

// ── Role canonicalization ──────────────────────────────────────────────────

// Boilerplate aggregators staple onto titles. Stripped before normalizeRole so
// "Data Analyst (m/f/d)", "Data Analyst - Remote" and "Data Analyst | Dublin"
// all collapse to the same (company, role) key.
const GENDER_TAG_RE = /\(\s*[mwfdx](?:\s*[\/|]\s*[mwfdx])+\s*\)/gi; // (m/f/d) (w/m/x) …
const PARENTHETICAL_NOISE_RE =
  /\(\s*(?:remote|hybrid|on[- ]?site|onsite|full[- ]?time|part[- ]?time|permanent|contract|temporary|intern(?:ship)?|working student|werkstudent|maternity cover|fixed[- ]?term|\d+\s*%|h\/f|all genders?|any gender|d\/f\/m|f\/m\/d|m\/f|m\/w\/d)\s*\)/gi;
// Trailing location / modality after a separator: " - Remote", " | Dublin", " – Berlin (Hybrid)"
const TRAILING_SEP_NOISE_RE =
  /\s*[-|–—•·/]\s*(?:remote|hybrid|on[- ]?site|onsite|full[- ]?time|part[- ]?time|permanent|contract|temporary|relocation|visa sponsorship|eu|emea|dublin|berlin|london|madrid|paris|amsterdam|munich|barcelona|copenhagen|stockholm|[a-z .]{2,30})\s*$/i;
// Req-id / job-id suffixes: "(JR0099)", "#12345", "- Req 12345", "Ref: ABC-123"
const REQ_ID_RE =
  /\s*(?:[#(]\s*(?:jr|req|ref|id|r)?[-\s]?\d{3,}[a-z0-9-]*\s*\)?|\b(?:req|ref|job\s*id|requisition)\b[:#]?\s*[a-z]?\d{3,}[a-z0-9-]*)\s*$/i;

/**
 * Canonicalize a raw job title for (company, role) dedup. Strips the
 * boilerplate aggregators append, then defers to the system's normalizeRole
 * for the lowercase/whitespace pass. Conservative: if stripping would empty
 * the title, the un-stripped title is normalized instead (fail-open).
 */
export function canonicalizeRole(title) {
  if (!title) return normalizeRole(title || '');
  let t = String(title);
  t = t.replace(GENDER_TAG_RE, ' ');
  t = t.replace(PARENTHETICAL_NOISE_RE, ' ');
  // Strip req-ids and one trailing location/modality clause (each at most once
  // per pass; loop a couple of times to peel stacked suffixes like "… - Remote (m/f/d)").
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(REQ_ID_RE, '');
    t = t.replace(GENDER_TAG_RE, ' ');
    t = t.replace(TRAILING_SEP_NOISE_RE, '');
    if (t === before) break;
  }
  const stripped = normalizeRole(t);
  return stripped || normalizeRole(title);
}

/**
 * Build the normalized dedup key for a (company, role) pair, matching the
 * scheme used by lib/dedup-index.mjs but applying the extra role
 * canonicalization first. Returns '' when either side is blank so callers can
 * choose to skip key-based dedup for malformed rows.
 */
export function companyRoleKey(company, role) {
  const c = normalizeCompany(company || '');
  const r = canonicalizeRole(role || '');
  if (!c || !r) return '';
  return `${c}\t${r}`;
}

// ── Low-quality row guarding ────────────────────────────────────────────────

// Titles with no usable signal — aggregator placeholders, "apply" CTAs, etc.
const JUNK_TITLE_RE =
  /^(?:apply(?:\s*now)?|see\s+(?:job|details)|view\s+job|click\s+here|multiple\s+(?:positions|roles|openings)|various\s+roles?|n\/?a|tbd|unknown|job\s+opening|new\s+job|hiring|we'?re\s+hiring|open\s+position)$/i;
// Placeholder company strings aggregators emit when the employer is masked.
const JUNK_COMPANY_RE =
  /^(?:confidential|company\s*name|undisclosed|private|n\/?a|unknown|recruiter|staffing|agency|hidden|employer)$/i;

/**
 * True when a parsed posting carries no usable signal and should be kept OUT
 * of the pipeline (it still lands in scan-history as a raw record — we only
 * gate the human-facing inbox). Conservative: only flags clearly-empty or
 * placeholder titles/companies, never a real-looking role.
 *
 * @param {{title?: string, company?: string}} posting
 */
export function isLowQualityRow({ title = '', company = '' } = {}) {
  const t = String(title).replace(/\s+/g, ' ').trim();
  const c = String(company).replace(/\s+/g, ' ').trim();
  if (!t) return true; // a pipeline line with no title is untriageable
  if (JUNK_TITLE_RE.test(t)) return true;
  if (c && JUNK_COMPANY_RE.test(c)) return true;
  // Degenerate single-character / numeric-only titles.
  if (t.replace(/[^a-z0-9]/gi, '').length < 2) return true;
  return false;
}

/** Split a TSV body into non-empty data lines, dropping a leading header row. */
export function dataLines(text, { hasHeader = true } = {}) {
  if (!text) return [];
  const lines = text.split('\n');
  return (hasHeader ? lines.slice(1) : lines).filter((l) => l.trim());
}

/**
 * Index existing scan-history rows: a canonical-URL→rowIndex map (for re-seen
 * scan-date bumps) plus the set of normalized (company, role) keys already
 * present.
 *
 * `rows` is the array of raw TSV data lines (no header). URLs are stored under
 * their canonical form so a re-seen posting whose URL only differs by a
 * tracking param still maps onto the existing row.
 */
export function indexHistory(rows) {
  const urlToIndex = new Map();
  const companyRoleSeen = new Set();
  rows.forEach((line, i) => {
    const cols = line.split('\t');
    const url = cols[COL_URL];
    if (url) urlToIndex.set(canonicalizeUrl(url), i);
    const key = companyRoleKey(cols[COL_COMPANY], cols[COL_TITLE]);
    if (key) companyRoleSeen.add(key);
  });
  return { urlToIndex, companyRoleSeen };
}

/** Append/refresh the scan_dates column (index 7) with `date`, idempotently. */
export function appendScanDate(row, date) {
  const cols = row.split('\t');
  if (cols.length < 8) {
    while (cols.length < 7) cols.push('');
    cols.push(date);
  } else {
    const existing = cols[7] || '';
    if (!existing.split('|').includes(date)) {
      cols[7] = existing ? `${existing}|${date}` : date;
    }
  }
  return cols.join('\t');
}

/**
 * Merge staging scan-history lines into existing rows.
 *
 * Dedup precedence per staging row:
 *   1. Known canonical URL → bump that row's scan_dates to `today` (re-seen).
 *   2. Known (company, role) — already in history or accepted this run, under
 *      a different URL → DROP as a cross-URL duplicate.
 *   3. Otherwise   → append as a new row.
 *
 * Pure: takes the current rows + staging lines, returns the new rows array
 * and counters. Does not touch the filesystem.
 *
 * `droppedDuplicateUrl` counts intra-batch tracking-param URL twins — the same
 * canonical URL appearing twice in ONE staging file (the first lands as a new
 * row, the rest as `updatedScanDates` re-seen bumps would double-count, so we
 * drop them outright instead). A canonical URL that matches a row already on
 * disk is a normal re-seen bump (`updatedScanDates`), not a twin.
 *
 * @returns {{rows: string[], appended: number, updatedScanDates: number,
 *            droppedDuplicateRole: number, droppedDuplicateUrl: number,
 *            acceptedKeys: Set<string>, acceptedUrls: Set<string>}}
 *
 * `acceptedUrls` holds CANONICAL urls (so the pipeline pass can compare against
 * the same canonical space).
 */
export function mergeHistory(existingRows, stagingLines, today) {
  const rows = existingRows.slice();
  const { urlToIndex, companyRoleSeen } = indexHistory(rows);

  let appended = 0;
  let updatedScanDates = 0;
  let droppedDuplicateRole = 0;
  let droppedDuplicateUrl = 0;
  const acceptedKeys = new Set();
  const acceptedUrls = new Set();
  // Canonical URLs first APPENDED this run, so a second tracking-param twin in
  // the same staging file is dropped rather than re-bumping the fresh row's
  // scan date (which would double-count it as "re-seen").
  const appendedUrls = new Set();

  for (const line of stagingLines) {
    const cols = line.split('\t');
    const rawUrl = cols[COL_URL];
    if (!rawUrl) continue;
    const url = canonicalizeUrl(rawUrl);

    // 1a. Same canonical URL already appended earlier in this very batch
    //     (tracking-param twins) → drop without re-bumping.
    if (appendedUrls.has(url)) {
      droppedDuplicateUrl++;
      continue;
    }

    // 1b. Canonical URL already on disk → re-seen, bump scan date.
    if (urlToIndex.has(url)) {
      const idx = urlToIndex.get(url);
      rows[idx] = appendScanDate(rows[idx], today);
      updatedScanDates++;
      acceptedUrls.add(url);
      continue;
    }

    // 2. Same (company, role) under a different URL → cross-URL duplicate.
    const key = companyRoleKey(cols[COL_COMPANY], cols[COL_TITLE]);
    if (key && companyRoleSeen.has(key)) {
      droppedDuplicateRole++;
      continue;
    }

    // 3. Genuinely new.
    urlToIndex.set(url, rows.length);
    appendedUrls.add(url);
    if (key) {
      companyRoleSeen.add(key);
      acceptedKeys.add(key);
    }
    rows.push(line);
    acceptedUrls.add(url);
    appended++;
  }

  return {
    rows,
    appended,
    updatedScanDates,
    droppedDuplicateRole,
    droppedDuplicateUrl,
    acceptedKeys,
    acceptedUrls,
  };
}

const PIPELINE_LINE_RE = /- \[[ x]\] (https?:\/\/\S+)(?:\s*\|\s*([^|]*?)\s*\|\s*(.*))?$/;

/** Parse a staging pipeline line `- [ ] URL | Company | Title`. */
export function parsePipelineLine(line) {
  const m = line.match(PIPELINE_LINE_RE);
  if (!m) return null;
  return {
    url: m[1],
    company: (m[2] || '').trim(),
    title: (m[3] || '').trim(),
  };
}

/**
 * Filter staging pipeline lines down to the ones worth appending.
 *
 * A line is dropped if:
 *   - its canonical URL is already in the pipeline/applications (or appeared
 *     earlier in this batch under a tracking-param twin), OR
 *   - its (company, role) key was already appended this run / already lives in
 *     scan-history (passed via `seenKeys`), OR
 *   - it's a low-quality row (no usable title / placeholder company) — these
 *     are kept out of the human-facing inbox.
 *
 * Pure: returns the lines to append and counters; no IO. Caller-provided
 * `seenUrls` may be raw URLs — they're canonicalized internally so the compare
 * happens in one consistent space.
 *
 * @returns {{toAppend: string[], appended: number, droppedUrl: number,
 *            droppedDuplicateRole: number, droppedLowQuality: number}}
 */
export function filterPipelineLines(
  stagingLines,
  { seenUrls = new Set(), seenKeys = new Set() } = {}
) {
  const urlSeen = new Set([...seenUrls].map(canonicalizeUrl));
  const keySeen = new Set(seenKeys);
  const toAppend = [];
  let droppedUrl = 0;
  let droppedDuplicateRole = 0;
  let droppedLowQuality = 0;

  for (const line of stagingLines) {
    const parsed = parsePipelineLine(line);
    if (!parsed) continue;
    const { url, company, title } = parsed;
    const canon = canonicalizeUrl(url);

    if (urlSeen.has(canon)) {
      droppedUrl++;
      continue;
    }
    if (isLowQualityRow({ title, company })) {
      droppedLowQuality++;
      urlSeen.add(canon); // don't let a twin of this junk slip through later
      continue;
    }
    const key = companyRoleKey(company, title);
    if (key && keySeen.has(key)) {
      droppedDuplicateRole++;
      continue;
    }

    toAppend.push(line);
    urlSeen.add(canon);
    if (key) keySeen.add(key);
  }

  return {
    toAppend,
    appended: toAppend.length,
    droppedUrl,
    droppedDuplicateRole,
    droppedLowQuality,
  };
}
