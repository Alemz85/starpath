#!/usr/bin/env node
/**
 * deadlines.mjs — CLI for the deadlines mode
 *
 * Reads closing dates from data/applications.md and data/scouting.md (T1/T2
 * only), ranks entries by true urgency, and prints a "act today / this week /
 * watch" breakdown to stdout.
 *
 * Usage:
 *   node scripts/deadlines.mjs              (markdown to stdout)
 *   node scripts/deadlines.mjs --json       (raw structured data)
 *   node scripts/deadlines.mjs --today 2026-07-01  (override today for testing)
 *
 * Exit code: 0 if no urgent deadlines, 1 if ≥1 urgent entry (pipeline use).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseApplicationsDeadlines,
  parseScoutingDeadlines,
  classifyDeadlines,
  countMissingApplicationsDeadlines,
  countMissingScoutingDeadlines,
  renderDeadlines,
} from './lib/deadlines-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ── CLI args ──────────────────────────────────────────────────────────────*/
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const todayIdx = args.indexOf('--today');
const todayOverride = todayIdx !== -1 ? args[todayIdx + 1] : null;
const todayIso = todayOverride || new Date().toISOString().slice(0, 10);

/* ── Read source files ──────────────────────────────────────────────────────*/
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf-8');
}

const appsMd = readFile('data/applications.md');
const scoutingMd = readFile('data/scouting.md');

/* ── Parse + classify ───────────────────────────────────────────────────────*/
const appEntries = parseApplicationsDeadlines(appsMd);
const scoutEntries = parseScoutingDeadlines(scoutingMd);
const allEntries = [...appEntries, ...scoutEntries];

const classified = classifyDeadlines(allEntries, todayIso);
const ndApps = countMissingApplicationsDeadlines(appsMd);
const ndScouting = countMissingScoutingDeadlines(scoutingMd);

/* ── Output ─────────────────────────────────────────────────────────────────*/
if (jsonMode) {
  console.log(JSON.stringify({ asOf: todayIso, classified, ndApps, ndScouting }, null, 2));
} else {
  const markdown = renderDeadlines(classified, ndApps, ndScouting);
  console.log(markdown);
}

/* ── Exit code ──────────────────────────────────────────────────────────────*/
// Exit 1 when there are urgent entries — allows pipeline use: `node scripts/deadlines.mjs || alert`
const hasUrgent = classified.counts.urgent > 0;
if (hasUrgent) process.exit(1);
