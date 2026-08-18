#!/usr/bin/env node
/**
 * session-handoff.mjs — CLI for the session handoff log
 * (data/session-handoff.md).
 *
 * A session that leaves something unresolved writes a handoff; the next
 * session reads it when the conversation reaches backwards ("what were we
 * in the middle of?"). This is the one surface for the conversational
 * thread — NOT domain facts. A scoring correction still goes to
 * user/_profile.md, a tooling defect to agent-log.mjs, an application
 * status change to applications.md; a domain fact copied in here becomes a
 * duplicate that drifts from the record a later session trusts. Ported
 * from Alke's chatctx/session.py (Supabase-backed there); this repo has no
 * DB, so the log is an append-only markdown file instead.
 *
 * All parsing/rendering logic is pure in
 * scripts/lib/session-handoff-core.mjs (unit-tested); this file is thin
 * I/O per repo convention.
 *
 * Usage:
 *   node scripts/session-handoff.mjs write --slug <kebab-slug> [--message "..."]   (or pipe the body via stdin)
 *   node scripts/session-handoff.mjs read [--limit <n>] [--json]
 *   node scripts/session-handoff.mjs show <id> [--json]
 *
 * Missing data/session-handoff.md → empty result, exit 0, for the read
 * verbs (read/show). `write` creates the file on demand.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_READ_LIMIT,
  parseEntries, nextId, validateSlug, appendEntry,
  renderEntry, renderCompactList,
} from './lib/session-handoff-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = join(ROOT, 'data/session-handoff.md');

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
    if (a === '--json') continue;
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

function usageFail(message) {
  console.error(`error: ${message}`);
  console.error('usage:');
  console.error('  node scripts/session-handoff.mjs write --slug <kebab-slug> [--message "..."]');
  console.error('  node scripts/session-handoff.mjs read [--limit <n>] [--json]');
  console.error('  node scripts/session-handoff.mjs show <id> [--json]');
  process.exit(1);
}

function readLog() {
  if (!existsSync(LOG_FILE)) return '';
  return readFileSync(LOG_FILE, 'utf-8');
}

function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function cmdWrite() {
  const slug = argValue('--slug');
  const v = validateSlug(slug);
  if (!v.valid) usageFail(v.reason);

  let message = argValue('--message');
  if (message == null) {
    // No --message: fall back to stdin, but only when it's actually piped —
    // reading fd 0 on an interactive TTY with nothing redirected would hang
    // forever waiting for EOF.
    if (process.stdin.isTTY) {
      usageFail('a body is required: pass --message "..." or pipe it via stdin');
    }
    message = readStdinSync();
  }
  message = String(message ?? '').trim();
  if (!message) usageFail('a body is required: pass --message "..." or pipe it via stdin');

  const content = readLog();
  const entries = parseEntries(content);
  const id = nextId(entries);
  const entry = { id, timestamp: new Date().toISOString(), slug, body: message };

  const next = appendEntry(content, entry);
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(LOG_FILE, next, 'utf-8');

  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: true, id, entry }));
  } else {
    console.log(`recorded session handoff ${id}`);
  }
}

function cmdRead() {
  const entries = parseEntries(readLog());
  const limitArg = argValue('--limit');
  const parsedLimit = Number.parseInt(limitArg, 10);
  const n = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_READ_LIMIT;
  const shown = entries.slice(-n); // newest LAST — chronological tail

  if (JSON_MODE) {
    console.log(JSON.stringify({ entries: shown, total: entries.length }));
    return;
  }
  console.log(renderCompactList(shown));
}

function cmdShow() {
  const idArg = positionals(new Set())[0];
  if (!idArg) usageFail('show requires an id: node scripts/session-handoff.mjs show <id>');

  const entries = parseEntries(readLog());
  const id = Number.parseInt(idArg, 10);
  const entry = entries.find((e) => e.id === id);

  if (!entry) {
    if (JSON_MODE) {
      console.log(JSON.stringify({ ok: false, error: 'not-found', id: idArg }));
    } else {
      console.error(`error: no session handoff with id ${idArg}`);
    }
    process.exit(1);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ entry }));
  } else {
    console.log(renderEntry(entry));
  }
}

switch (command) {
  case 'write': cmdWrite(); break;
  case 'read': cmdRead(); break;
  case 'show': cmdShow(); break;
  default:
    usageFail(`unknown command '${command ?? ''}'`);
}
