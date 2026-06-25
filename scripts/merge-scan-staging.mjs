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
 *   - data/pipeline.md (lines appended into ## Pending; URL- AND (company,role)-deduped)
 *
 * Dedup is two-layered: exact URL first, then normalized (company, role). The
 * second pass matters because aggregators (Indeed, Google Jobs) surface the
 * same posting under several distinct URLs, so URL-only dedup lets one real
 * job re-enter the pipeline two or three times. The merge math lives in the
 * pure, unit-tested scripts/lib/merge-staging-core.mjs.
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
import {
  HISTORY_HEADER as CORE_HISTORY_HEADER,
  dataLines,
  indexHistory,
  mergeHistory,
  filterPipelineLines,
} from './lib/merge-staging-core.mjs';

// ── Paths ───────────────────────────────────────────────────────────────

const SCAN_HISTORY_PATH    = 'data/scan-history.tsv';
const PIPELINE_PATH        = 'data/pipeline.md';
const APPLICATIONS_PATH    = 'data/applications.md';
const STAGING_HISTORY_PATH = 'data/scan-history.jobspy.tsv';
const STAGING_PIPELINE_PATH = 'data/pipeline.jobspy.md';
const TMP_HISTORY_PATH     = 'data/scan-history.jobspy.tsv.tmp';
const TMP_PIPELINE_PATH    = 'data/pipeline.jobspy.md.tmp';
const ARCHIVE_DIR          = 'batch/jobspy-merged';

const HISTORY_HEADER = CORE_HISTORY_HEADER;

// ── History helpers (file IO; merge math lives in merge-staging-core) ────

/** Load existing scan-history data rows (header dropped). */
function loadHistoryRows() {
  if (!existsSync(SCAN_HISTORY_PATH)) return [];
  return dataLines(readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
}

function saveHistory(rows) {
  const content = HISTORY_HEADER + '\n' + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(SCAN_HISTORY_PATH, content, 'utf-8');
}

/** Normalized (company, role) keys already in scan-history — pipeline dedup seed. */
function companyRoleKeysInHistory(rows) {
  return indexHistory(rows).companyRoleSeen;
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

  // 1. Merge scan-history (URL dedup → (company, role) dedup → append)
  const today = new Date().toISOString().slice(0, 10);
  const existingRows = loadHistoryRows();
  // Keys already on disk before this merge — seed for the pipeline dedup pass.
  const historyKeys = companyRoleKeysInHistory(existingRows);

  let appended = 0;
  let updatedScanDates = 0;
  let historyDupRoles = 0;
  let rows = existingRows;

  if (stagingHistoryExists) {
    const stagingLines = dataLines(readFileSync(TMP_HISTORY_PATH, 'utf-8'));
    const result = mergeHistory(existingRows, stagingLines, today);
    rows = result.rows;
    appended = result.appended;
    updatedScanDates = result.updatedScanDates;
    historyDupRoles = result.droppedDuplicateRole;
    saveHistory(rows);
  }

  // 2. Merge pipeline.md — dedup against pipeline + applications URLs, plus
  //    (company, role) keys that ALREADY existed in scan-history before this
  //    run. We seed with historyKeys (not the keys accepted this run): a
  //    brand-new job appended to history this run must still reach the
  //    pipeline, while a cross-URL duplicate — whose original is on disk, so
  //    its key is in historyKeys — is correctly suppressed. Within-batch
  //    pipeline dedup is handled inside filterPipelineLines.
  let pipelineAppended = 0;
  let pipelineDupRoles = 0;
  if (stagingPipelineExists) {
    const stagingLines = readFileSync(TMP_PIPELINE_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim());

    const seenUrls = new Set([...urlsInPipeline(), ...urlsInApplications()]);
    const seenKeys = new Set(historyKeys);
    const result = filterPipelineLines(stagingLines, { seenUrls, seenKeys });
    pipelineAppended = result.appended;
    pipelineDupRoles = result.droppedDuplicateRole;
    if (result.toAppend.length > 0) appendToPipelineMd(result.toAppend);
  }

  // 3. Archive staging
  const stamp = archiveStaging(stagingHistoryExists, stagingPipelineExists);

  const dupNote =
    historyDupRoles + pipelineDupRoles > 0
      ? ` Dropped ${historyDupRoles} history + ${pipelineDupRoles} pipeline ` +
        `cross-URL (company, role) duplicates.`
      : '';
  console.log(
    `[merge] Done — scan-history: +${appended} new, ${updatedScanDates} re-seen; ` +
    `pipeline.md: +${pipelineAppended} new.${dupNote} ` +
    `Staging archived to ${ARCHIVE_DIR}/${stamp}.{tsv,md}.`
  );
  return 0;
}

process.exit(main());
