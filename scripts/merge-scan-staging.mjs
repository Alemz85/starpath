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
 * Dedup is layered: canonical URL first (tracking params stripped, Google-Jobs
 * redirect wrappers unwrapped), then normalized + canonicalized (company, role)
 * — boilerplate like "(m/f/d)", " - Remote", req-ids stripped from the title.
 * Both passes matter because aggregators (Indeed, Google Jobs) surface the same
 * posting under several distinct URLs AND slightly different titles, so naive
 * dedup lets one real job re-enter the pipeline two or three times. Low-quality
 * rows (no usable title, placeholder company) are also kept out of the inbox.
 * The merge math lives in the pure, unit-tested
 * scripts/lib/merge-staging-core.mjs.
 *
 * Admission: staging rows pass the SAME gate scan.mjs uses (lib/admission-gate.mjs:
 * optional data/blacklist.md → title → language → location, built from
 * user/portals.yml) before any dedup work, so a filter or blacklist change takes
 * effect for every writer at once and the Python scraper's copy is only a
 * pre-filter, not the authority. The pipeline lines get the same treatment.
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
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import {
  indexHistory,
  mergeHistory,
  filterPipelineLines,
} from './lib/merge-staging-core.mjs';
import { parseHistoryFile, upgradeColumns, fillLocations } from './lib/scan-history.mjs';
import { DEFAULT_LOCATION_ALLOWLIST } from './scan-core.mjs';
import { gateFromPortals } from './lib/admission-gate.mjs';

// ── Paths ───────────────────────────────────────────────────────────────

const SCAN_HISTORY_PATH    = 'data/scan-history.tsv';
const PIPELINE_PATH        = 'data/pipeline.md';
const APPLICATIONS_PATH    = 'data/applications.md';
const PORTALS_PATH         = 'user/portals.yml';
const BLACKLIST_PATH       = 'data/blacklist.md';
const STAGING_HISTORY_PATH = 'data/scan-history.jobspy.tsv';
const STAGING_PIPELINE_PATH = 'data/pipeline.jobspy.md';
const TMP_HISTORY_PATH     = 'data/scan-history.jobspy.tsv.tmp';
const TMP_PIPELINE_PATH    = 'data/pipeline.jobspy.md.tmp';
const ARCHIVE_DIR          = 'batch/jobspy-merged';

// ── History helpers (file IO; merge math lives in merge-staging-core) ────

/** Load existing scan-history: the file's own columns + data rows (header dropped). */
function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) return parseHistoryFile('');
  return parseHistoryFile(readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
}

/** Header upgraded in place: known columns the file lacked are appended. */
function saveHistory(columns, rows) {
  const content = upgradeColumns(columns).join('\t') + '\n' + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(SCAN_HISTORY_PATH, content, 'utf-8');
}

/** Normalized (company, role) keys already in scan-history — pipeline dedup seed. */
function companyRoleKeysInHistory(rows, columns) {
  return indexHistory(rows, columns).companyRoleSeen;
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

/** The admission gate's pre-dedup chain, from user/portals.yml + data/blacklist.md. */
function loadPrefilter(log) {
  let portals = {};
  try {
    if (existsSync(PORTALS_PATH)) portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  } catch (err) {
    log(`[merge] ! could not read ${PORTALS_PATH} (${String(err.message).split('\n')[0]}) — merging without title/location filters`);
  }
  const blacklistText = existsSync(BLACKLIST_PATH) ? readFileSync(BLACKLIST_PATH, 'utf-8') : '';
  const gate = gateFromPortals(portals, { blacklistText });
  return (job) => gate.prefilter(job);
}

export function runMerge({ log = console.log } = {}) {
  const stagingHistoryExists = existsSync(STAGING_HISTORY_PATH);
  const stagingPipelineExists = existsSync(STAGING_PIPELINE_PATH);

  if (!stagingHistoryExists && !stagingPipelineExists) {
    log('[merge] No JobSpy staging files — nothing to merge.');
    return 0;
  }

  // Atomically rename to .tmp before processing to isolate
  if (stagingHistoryExists) {
    renameSync(STAGING_HISTORY_PATH, TMP_HISTORY_PATH);
  }
  if (stagingPipelineExists) {
    renameSync(STAGING_PIPELINE_PATH, TMP_PIPELINE_PATH);
  }

  const prefilter = loadPrefilter(log);

  // 1. Merge scan-history (URL dedup → (company, role) dedup → append)
  const today = new Date().toISOString().slice(0, 10);
  const existing = loadHistory();
  const columns = upgradeColumns(existing.columns);
  const existingRows = existing.rows;
  // Keys already on disk before this merge — seed for the pipeline dedup pass.
  const historyKeys = companyRoleKeysInHistory(existingRows, columns);

  let appended = 0;
  let updatedScanDates = 0;
  let historyDupRoles = 0;
  let historyDupUrls = 0;
  let rows = existingRows;
  let rejectedUrls = new Set();
  let gateDrops = {};

  if (stagingHistoryExists) {
    const staging = parseHistoryFile(readFileSync(TMP_HISTORY_PATH, 'utf-8'));
    // The aggregator gives one location string; split it into `locations` here
    // (one implementation, shared with scan.mjs).
    const stagingLines = fillLocations(staging.rows, staging.columns, DEFAULT_LOCATION_ALLOWLIST);
    const result = mergeHistory(existingRows, stagingLines, today, { columns, stagingColumns: staging.columns, prefilter });
    rows = result.rows;
    appended = result.appended;
    updatedScanDates = result.updatedScanDates;
    historyDupRoles = result.droppedDuplicateRole;
    historyDupUrls = result.droppedDuplicateUrl;
    rejectedUrls = result.rejectedUrls;
    gateDrops = result.gateDrops;
    saveHistory(columns, rows);
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
  let pipelineLowQuality = 0;
  let pipelineGateDrops = 0;
  if (stagingPipelineExists) {
    const stagingLines = readFileSync(TMP_PIPELINE_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim());

    const seenUrls = new Set([...urlsInPipeline(), ...urlsInApplications()]);
    const seenKeys = new Set(historyKeys);
    const result = filterPipelineLines(stagingLines, { seenUrls, seenKeys, prefilter, rejectedUrls });
    pipelineAppended = result.appended;
    pipelineDupRoles = result.droppedDuplicateRole;
    pipelineLowQuality = result.droppedLowQuality;
    pipelineGateDrops = result.droppedByGate;
    if (result.toAppend.length > 0) appendToPipelineMd(result.toAppend);
  }

  // 3. Archive staging
  const stamp = archiveStaging(stagingHistoryExists, stagingPipelineExists);

  // Build a compact, itemized "dropped" breakdown so the user can trust the
  // merge: cross-URL (company, role) dupes, tracking-param URL twins, and
  // low-quality rows kept out of the inbox are each reported when non-zero.
  const dupRoles = historyDupRoles + pipelineDupRoles;
  const dropParts = [];
  if (dupRoles > 0) {
    dropParts.push(
      `${dupRoles} cross-URL (company, role) dup` +
      ` (${historyDupRoles} history, ${pipelineDupRoles} pipeline)`
    );
  }
  if (historyDupUrls > 0) dropParts.push(`${historyDupUrls} tracking-param URL twin`);
  if (pipelineLowQuality > 0) dropParts.push(`${pipelineLowQuality} low-quality`);
  const gateTotal = Object.values(gateDrops).reduce((a, b) => a + b, 0);
  if (gateTotal > 0) {
    dropParts.push(`${gateTotal} by the admission gate (${Object.entries(gateDrops).map(([k, v]) => `${v} ${k}`).join(', ')})`);
  } else if (pipelineGateDrops > 0) {
    dropParts.push(`${pipelineGateDrops} pipeline line(s) by the admission gate`);
  }
  const dropNote = dropParts.length ? ` Dropped ${dropParts.join(', ')}.` : '';

  log(
    `[merge] Done — scan-history: +${appended} new, ${updatedScanDates} re-seen; ` +
    `pipeline.md: +${pipelineAppended} new.${dropNote} ` +
    `Staging archived to ${ARCHIVE_DIR}/${stamp}.{tsv,md}.`
  );
  return 0;
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runMerge());
}
