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
 * the same key the rest of the system uses (see lib/dedup-index.mjs) — and
 * drops a staging row when that key already exists in scan-history OR was
 * already accepted earlier in the same merge. URL dedup still runs first
 * (it's exact and cheap); company+role dedup is the semantic safety net.
 */

import { normalizeCompany, normalizeRole } from './dedup-index.mjs';

export const HISTORY_HEADER =
  'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates';

// scan-history.tsv column order (0-indexed)
const COL_URL = 0;
const COL_TITLE = 3;
const COL_COMPANY = 4;

/**
 * Build the normalized dedup key for a (company, role) pair, matching the
 * scheme used by lib/dedup-index.mjs. Returns '' when either side is blank
 * so callers can choose to skip key-based dedup for malformed rows.
 */
export function companyRoleKey(company, role) {
  const c = normalizeCompany(company || '');
  const r = normalizeRole(role || '');
  if (!c || !r) return '';
  return `${c}\t${r}`;
}

/** Split a TSV body into non-empty data lines, dropping a leading header row. */
export function dataLines(text, { hasHeader = true } = {}) {
  if (!text) return [];
  const lines = text.split('\n');
  return (hasHeader ? lines.slice(1) : lines).filter((l) => l.trim());
}

/**
 * Index existing scan-history rows: a URL→rowIndex map (for re-seen scan-date
 * bumps) plus the set of normalized (company, role) keys already present.
 *
 * `rows` is the array of raw TSV data lines (no header).
 */
export function indexHistory(rows) {
  const urlToIndex = new Map();
  const companyRoleSeen = new Set();
  rows.forEach((line, i) => {
    const cols = line.split('\t');
    const url = cols[COL_URL];
    if (url) urlToIndex.set(url, i);
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
 *   1. Known URL  → bump that row's scan_dates to `today` (re-seen).
 *   2. Known (company, role) — already in history or accepted this run, under
 *      a different URL → DROP as a cross-URL duplicate.
 *   3. Otherwise   → append as a new row.
 *
 * Pure: takes the current rows + staging lines, returns the new rows array
 * and counters. Does not touch the filesystem.
 *
 * @returns {{rows: string[], appended: number, updatedScanDates: number,
 *            droppedDuplicateRole: number, acceptedKeys: Set<string>,
 *            acceptedUrls: Set<string>}}
 */
export function mergeHistory(existingRows, stagingLines, today) {
  const rows = existingRows.slice();
  const { urlToIndex, companyRoleSeen } = indexHistory(rows);

  let appended = 0;
  let updatedScanDates = 0;
  let droppedDuplicateRole = 0;
  const acceptedKeys = new Set();
  const acceptedUrls = new Set();

  for (const line of stagingLines) {
    const cols = line.split('\t');
    const url = cols[COL_URL];
    if (!url) continue;

    // 1. Exact URL already known → re-seen, bump scan date.
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
 * A line is dropped if its URL is already in the pipeline or applications,
 * OR if its (company, role) key was already appended this run / already lives
 * in scan-history (passed via `seenKeys`, typically the keys accepted by
 * mergeHistory plus the pre-existing history keys). The latter stops the same
 * aggregator job — surfaced under a Google URL and an Indeed URL in the same
 * batch — from landing in the pipeline twice.
 *
 * Pure: returns the lines to append and counters; no IO.
 *
 * @returns {{toAppend: string[], appended: number, droppedUrl: number,
 *            droppedDuplicateRole: number}}
 */
export function filterPipelineLines(
  stagingLines,
  { seenUrls = new Set(), seenKeys = new Set() } = {}
) {
  const urlSeen = new Set(seenUrls);
  const keySeen = new Set(seenKeys);
  const toAppend = [];
  let droppedUrl = 0;
  let droppedDuplicateRole = 0;

  for (const line of stagingLines) {
    const parsed = parsePipelineLine(line);
    if (!parsed) continue;
    const { url, company, title } = parsed;

    if (urlSeen.has(url)) {
      droppedUrl++;
      continue;
    }
    const key = companyRoleKey(company, title);
    if (key && keySeen.has(key)) {
      droppedDuplicateRole++;
      continue;
    }

    toAppend.push(line);
    urlSeen.add(url);
    if (key) keySeen.add(key);
  }

  return {
    toAppend,
    appended: toAppend.length,
    droppedUrl,
    droppedDuplicateRole,
  };
}
