#!/usr/bin/env node

/**
 * merge-scan-staging.mjs — merge JobSpy staging files into canonical files
 *
 * Inputs (staging, written by scripts/jobspy/scan.py):
 *   - data/scan-history.jobspy.tsv
 *   - data/pipeline.jobspy.md
 *
 * Outputs (canonical, also written by scripts/scan.mjs):
 *   - data/scan-history.tsv (rows appended; existing URLs get scan_dates updated)
 *   - data/pipeline.md (lines appended into ## Pending; URL-deduped)
 *
 * After a successful merge, staging files are moved to
 *   batch/jobspy-merged/{ISO_DATE}-{HMS}.{tsv,md}
 * as an audit trail.
 *
 * No-op if staging files don't exist (JobSpy disabled or had no new rows).
 *
 * Run sequentially, AFTER both scan.mjs and scan.py have exited — no race
 * with the other writers since this is the sole touchpoint into the
 * canonical files at merge time.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
} from 'fs';
import { join } from 'path';

// ── Paths ───────────────────────────────────────────────────────────────

const SCAN_HISTORY_PATH    = 'data/scan-history.tsv';
const PIPELINE_PATH        = 'data/pipeline.md';
const APPLICATIONS_PATH    = 'data/applications.md';
const STAGING_HISTORY_PATH = 'data/scan-history.jobspy.tsv';
const STAGING_PIPELINE_PATH = 'data/pipeline.jobspy.md';
const TMP_HISTORY_PATH     = 'data/scan-history.jobspy.tsv.tmp';
const TMP_PIPELINE_PATH    = 'data/pipeline.jobspy.md.tmp';
const ARCHIVE_DIR          = 'batch/jobspy-merged';

const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates';

// ── History helpers (mirror scan.mjs) ──────────────────────────────────

function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    return { rows: [], urlToIndex: new Map() };
  }
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
  const urlToIndex = new Map();
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const url = line.split('\t')[0];
    if (url) urlToIndex.set(url, rows.length);
    rows.push(line);
  }
  return { rows, urlToIndex };
}

function saveHistory(rows) {
  const content = HISTORY_HEADER + '\n' + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(SCAN_HISTORY_PATH, content, 'utf-8');
}

function appendScanDate(row, date) {
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

// ── Pipeline helpers ───────────────────────────────────────────────────

function urlsInPipeline() {
  if (!existsSync(PIPELINE_PATH)) return new Set();
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const seen = new Set();
  for (const m of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
    seen.add(m[1]);
  }
  return seen;
}

function urlsInApplications() {
  if (!existsSync(APPLICATIONS_PATH)) return new Set();
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const seen = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(m[0]);
  }
  return seen;
}

/** Append checkbox lines to the ## Pending section — mirrors scan.mjs:399 */
function appendToPipelineMd(lines) {
  if (lines.length === 0) return;
  let text = existsSync(PIPELINE_PATH)
    ? readFileSync(PIPELINE_PATH, 'utf-8')
    : '# Pipeline — Pending Evaluations\n\n## Pending\n';

  const marker = '## Pending';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Processed');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + lines.join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + lines.join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

// ── Archive ────────────────────────────────────────────────────────────

// ── Archive ────────────────────────────────────────────────────────────

function archiveStaging(tmpHistoryExists, tmpPipelineExists) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-05-05T17-43-12
  if (tmpHistoryExists && existsSync(TMP_HISTORY_PATH)) {
    renameSync(TMP_HISTORY_PATH, join(ARCHIVE_DIR, `${stamp}.tsv`));
  }
  if (tmpPipelineExists && existsSync(TMP_PIPELINE_PATH)) {
    renameSync(TMP_PIPELINE_PATH, join(ARCHIVE_DIR, `${stamp}.md`));
  }
  return stamp;
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const stagingHistoryExists = existsSync(STAGING_HISTORY_PATH);
  const stagingPipelineExists = existsSync(STAGING_PIPELINE_PATH);

  if (!stagingHistoryExists && !stagingPipelineExists) {
    console.log('[merge] No JobSpy staging files — nothing to merge.');
    return 0;
  }

  // Atomically rename to .tmp before processing to isolate
  if (stagingHistoryExists) {
    renameSync(STAGING_HISTORY_PATH, TMP_HISTORY_PATH);
  }
  if (stagingPipelineExists) {
    renameSync(STAGING_PIPELINE_PATH, TMP_PIPELINE_PATH);
  }

  // 1. Merge scan-history
  const today = new Date().toISOString().slice(0, 10);
  const { rows, urlToIndex } = loadHistory();
  let appended = 0;
  let updatedScanDates = 0;

  if (stagingHistoryExists) {
    const stagingLines = readFileSync(TMP_HISTORY_PATH, 'utf-8')
      .split('\n')
      .slice(1)               // skip staging header
      .filter(l => l.trim());

    for (const line of stagingLines) {
      const url = line.split('\t')[0];
      if (!url) continue;
      if (urlToIndex.has(url)) {
        const idx = urlToIndex.get(url);
        rows[idx] = appendScanDate(rows[idx], today);
        updatedScanDates++;
      } else {
        urlToIndex.set(url, rows.length);
        rows.push(line);
        appended++;
      }
    }
    saveHistory(rows);
  }

  // 2. Merge pipeline.md (URL-deduped against pipeline + applications)
  let pipelineAppended = 0;
  if (stagingPipelineExists) {
    const stagingLines = readFileSync(TMP_PIPELINE_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim());

    const seenInPipeline = urlsInPipeline();
    const seenInApps = urlsInApplications();
    const toAppend = [];
    for (const line of stagingLines) {
      const m = line.match(/- \[[ x]\] (https?:\/\/\S+)/);
      if (!m) continue;
      const url = m[1];
      if (seenInPipeline.has(url) || seenInApps.has(url)) continue;
      toAppend.push(line);
      seenInPipeline.add(url); // intra-batch dedup
      pipelineAppended++;
    }
    if (toAppend.length > 0) appendToPipelineMd(toAppend);
  }

  // 3. Archive staging
  const stamp = archiveStaging(stagingHistoryExists, stagingPipelineExists);

  console.log(
    `[merge] Done — scan-history: +${appended} new, ${updatedScanDates} re-seen; ` +
    `pipeline.md: +${pipelineAppended} new. ` +
    `Staging archived to ${ARCHIVE_DIR}/${stamp}.{tsv,md}.`
  );
  return 0;
}

process.exit(main());
