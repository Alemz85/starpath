#!/usr/bin/env node
/**
 * followup-cadence.mjs — Follow-up Cadence Tracker for career-ops
 *
 * Parses applications.md + follow-ups.md, calculates follow-up cadence for
 * active applications, extracts contacts, and flags overdue entries.
 *
 * All cadence math, parsing, ranking and rendering lives in the pure, unit-tested
 * scripts/lib/followup-cadence-core.mjs — this file is only I/O + invocation, so
 * the logic is testable in isolation and `today` can be overridden for backdated
 * runs (mirroring scripts/deadlines.mjs).
 *
 * Run: node scripts/followup-cadence.mjs                 (JSON to stdout)
 *      node scripts/followup-cadence.mjs --summary       (human-readable dashboard)
 *      node scripts/followup-cadence.mjs --overdue-only
 *      node scripts/followup-cadence.mjs --applied-days 10
 *      node scripts/followup-cadence.mjs --today 2026-07-01   (override today)
 *
 * Exit code: 1 when there are no applications (the JSON `{ error }` body still
 * prints to stdout so a consumer like daily-brief can tolerate it).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyze, renderSummary, buildCadence } from './lib/followup-cadence-core.mjs';

const CAREER_OPS = dirname(dirname(fileURLToPath(import.meta.url)));
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const FOLLOWUPS_FILE = join(CAREER_OPS, 'data/follow-ups.md');

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const overdueOnly = args.includes('--overdue-only');
const appliedDaysIdx = args.indexOf('--applied-days');
const appliedDaysArg = appliedDaysIdx !== -1 ? args[appliedDaysIdx + 1] : null;
const todayIdx = args.indexOf('--today');
const todayArg = todayIdx !== -1 ? args[todayIdx + 1] : null;
const todayIso = todayArg && /^\d{4}-\d{2}-\d{2}$/.test(todayArg)
  ? todayArg
  : new Date().toISOString().slice(0, 10);

// --- Read source files (the only I/O) ---
function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}
const appsContent = read(APPS_FILE);
const followupsContent = read(FOLLOWUPS_FILE);

// --- Analyze (pure core) ---
const result = analyze({
  appsContent,
  followupsContent,
  todayIso,
  cadence: buildCadence(appliedDaysArg),
  overdueOnly,
  reportExists: (rel) => existsSync(join(CAREER_OPS, rel)),
});

// --- Output ---
if (summaryMode) {
  console.log(renderSummary(result));
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (result.error) process.exit(1);
