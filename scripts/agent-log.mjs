#!/usr/bin/env node
/**
 * agent-log.mjs — CLI for the agent issue log (data/agent-log.tsv).
 *
 * Agents (batch eval workers, mode sessions) self-report operational
 * problems here instead of silently working around recurring breakage — a
 * schema mismatch, an unparseable data file, a URL pattern that consistently
 * fails verification, a rubric ambiguity. Maintenance sessions check
 * unresolved entries first. Ported from Alke's chatctx/agent_log.py (a
 * Supabase-backed write helper there); this repo has no DB, so the log is a
 * plain TSV file, shared across search profiles — operational issues are
 * about the tooling, not any one search.
 *
 * All parsing/filtering/aggregation logic is pure in
 * scripts/lib/agent-log-core.mjs (unit-tested); this file is thin I/O per
 * repo convention.
 *
 * Usage:
 *   node scripts/agent-log.mjs log --category <schema|data|url|rubric|other> --subject "<short>" [--severity low|med|high] "<message>"
 *   node scripts/agent-log.mjs list [--unresolved] [--category <c>] [--limit <n>] [--json]
 *   node scripts/agent-log.mjs counts [--json]
 *   node scripts/agent-log.mjs resolve <id> [--note "..."]
 *
 * Missing data/agent-log.tsv → empty result, exit 0, for the read verbs
 * (list/counts). `log` and `resolve` create/update the file on demand.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, SEVERITIES, DEFAULT_SEVERITY,
  parseRows, serializeAll, nextId, buildEntry,
  filterRows, sortNewestFirst, limitRows, computeCounts, resolveRow,
  renderList, renderCounts,
} from './lib/agent-log-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = join(ROOT, 'data/agent-log.tsv');

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const args = rawArgs.slice(1);
const JSON_MODE = args.includes('--json');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

/** Bare positionals: everything that isn't a recognized flag or its value. */
function positionals(flagsWithValue) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsWithValue.has(a)) { i++; continue; }
    if (a === '--json' || a === '--unresolved') continue;
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

function usageFail(message) {
  console.error(`error: ${message}`);
  console.error('usage:');
  console.error('  node scripts/agent-log.mjs log --category <schema|data|url|rubric|other> --subject "<short>" [--severity low|med|high] "<message>"');
  console.error('  node scripts/agent-log.mjs list [--unresolved] [--category <c>] [--limit <n>] [--json]');
  console.error('  node scripts/agent-log.mjs counts [--json]');
  console.error('  node scripts/agent-log.mjs resolve <id> [--note "..."]');
  process.exit(1);
}

function readRows() {
  if (!existsSync(LOG_FILE)) return [];
  return parseRows(readFileSync(LOG_FILE, 'utf-8'));
}

function writeRows(rows) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(LOG_FILE, serializeAll(rows), 'utf-8');
}

function cmdLog() {
  const category = argValue('--category');
  const subject = argValue('--subject');
  const severity = argValue('--severity') || DEFAULT_SEVERITY;
  const message = positionals(new Set(['--category', '--subject', '--severity'])).join(' ').trim();

  if (!category || !CATEGORIES.includes(category)) {
    usageFail(`--category is required and must be one of: ${CATEGORIES.join('|')}`);
  }
  if (!subject || !subject.trim()) {
    usageFail('--subject is required (short join key: file path, table/column, or tool name)');
  }
  if (!SEVERITIES.includes(severity)) {
    usageFail(`--severity must be one of: ${SEVERITIES.join('|')}`);
  }
  if (!message) {
    usageFail('a message is required (what was attempted, what happened, what was expected)');
  }

  const rows = readRows();
  const id = nextId(rows);
  const entry = buildEntry({
    id,
    timestamp: new Date().toISOString(),
    category,
    subject: subject.trim(),
    severity,
    message,
  });
  writeRows([...rows, entry]);

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: true, id, entry }));
  } else {
    console.log(`logged agent-log entry ${id}`);
  }
}

function cmdList() {
  const category = argValue('--category');
  if (category && !CATEGORIES.includes(category)) {
    usageFail(`--category must be one of: ${CATEGORIES.join('|')}`);
  }
  const unresolved = args.includes('--unresolved');
  const limit = argValue('--limit');

  const rows = readRows();
  const filtered = filterRows(rows, { unresolved, category });
  const sorted = sortNewestFirst(filtered);
  const limited = limitRows(sorted, limit);

  if (JSON_MODE) {
    console.log(JSON.stringify({ entries: limited, total: filtered.length }));
    return;
  }
  console.log(renderList(limited));
}

function cmdCounts() {
  const rows = readRows();
  const counts = computeCounts(rows);

  if (JSON_MODE) {
    console.log(JSON.stringify({ counts }));
    return;
  }
  console.log(renderCounts(counts));
}

function cmdResolve() {
  const idArg = positionals(new Set(['--note']))[0];
  if (!idArg) usageFail('resolve requires an id: node scripts/agent-log.mjs resolve <id> [--note "..."]');
  const note = argValue('--note') || '';

  const rows = readRows();
  const { rows: next, found } = resolveRow(rows, idArg, { note, timestamp: new Date().toISOString() });

  if (!found) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ ok: false, error: 'not-found', id: idArg }));
    } else {
      console.error(`error: no agent-log entry with id ${idArg}`);
    }
    process.exit(1);
  }

  writeRows(next);
  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: true, id: Number.parseInt(idArg, 10) }));
  } else {
    console.log(`resolved agent-log entry ${idArg}`);
  }
}

switch (command) {
  case 'log': cmdLog(); break;
  case 'list': cmdList(); break;
  case 'counts': cmdCounts(); break;
  case 'resolve': cmdResolve(); break;
  default:
    usageFail(`unknown command '${command ?? ''}'`);
}
