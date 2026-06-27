#!/usr/bin/env node
/**
 * outreach-cadence.mjs — I/O wrapper for the `contacto` (outreach) cadence.
 *
 * Parses the outreach log at `data/outreach.md`, collapses it to one row per
 * contact (latest touch + total touch count), classifies each via the pure
 * logic in `outreach-core.mjs`, and emits JSON the mode consumes — or a
 * human-readable dashboard with `--summary`.
 *
 *   node scripts/outreach-cadence.mjs            (JSON to stdout)
 *   node scripts/outreach-cadence.mjs --summary  (dashboard)
 *   node scripts/outreach-cadence.mjs --due      (only contacts needing a nudge)
 *
 * The log is the canonical record; this script never mutates it. The `contacto`
 * mode appends rows; this script only reads.
 *
 * --- data/outreach.md table schema ---
 * | # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
 *   #        sequential row id
 *   Date     YYYY-MM-DD the touch was sent
 *   Company  target company (links back to applications/scouting by company+role)
 *   Role     target role (may be blank for speculative outreach)
 *   Contact  person's name
 *   Title    their title (Hiring Manager / Recruiter / Peer / Interviewer)
 *   Channel  Connection | Message | InMail | Email
 *   Touch    1-based touch number for this contact (1 = initial, 2 = first nudge…)
 *   Outcome  free text: Pending | Accepted | Replied | Declined | "no response after X"
 *   Notes    anything (angle used, what to say next, etc.)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyAll } from './outreach-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = join(ROOT, 'data/outreach.md');

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const dueOnly = args.includes('--due');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// --- Parse data/outreach.md into raw touch rows ---
export function parseLog(content) {
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    // parts[0] is '' (leading pipe). Need: #, Date, Company, Role, Contact,
    // Title, Channel, Touch, Outcome, Notes → 10 cells + 2 pipe-edges.
    if (parts.length < 11) continue;
    const num = parseInt(parts[1], 10);
    if (Number.isNaN(num)) continue; // header / separator rows
    rows.push({
      num,
      date: parts[2],
      company: parts[3],
      role: parts[4],
      contact: parts[5],
      title: parts[6],
      channel: parts[7],
      touch: parseInt(parts[8], 10) || 1,
      outcome: parts[9],
      notes: parts[10] || '',
    });
  }
  return rows;
}

// --- Collapse touch rows to one record per (company + contact) ---
// We key on company + contact name so multiple nudges to the same person fold
// into a single cadence record: latest touch wins, touch count is the max
// touch number seen, and the outcome is taken from the most recent row.
export function collapse(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.company.toLowerCase()}|${r.contact.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || (r.date > prev.lastTouch) || (r.date === prev.lastTouch && r.touch >= prev.touches)) {
      byKey.set(key, {
        company: r.company,
        role: r.role,
        contact: r.contact,
        title: r.title,
        channel: r.channel,
        lastTouch: r.date,
        touches: Math.max(r.touch, prev ? prev.touches : 0),
        outcome: r.outcome,
        notes: r.notes,
      });
    } else if (prev) {
      prev.touches = Math.max(prev.touches, r.touch);
    }
  }
  return [...byKey.values()];
}

function main() {
  if (!existsSync(LOG_FILE)) {
    const empty = { metadata: { date: todayStr(), total: 0, actionable: 0 }, entries: [], counts: { nudge: 0, waiting: 0, cold: 0, done: 0 } };
    if (summaryMode) {
      console.log(`Outreach Cadence — ${empty.metadata.date}\n\nNo outreach logged yet. Run \`/career-ops contacto {company}\` to find someone worth reaching, then the touch is recorded to data/outreach.md.`);
    } else {
      console.log(JSON.stringify(empty, null, 2));
    }
    return;
  }

  const content = readFileSync(LOG_FILE, 'utf-8');
  const contacts = collapse(parseLog(content));
  const today = todayStr();
  const { entries, counts, actionable } = classifyAll(contacts, today);

  const shown = dueOnly ? entries.filter((e) => e.action === 'nudge') : entries;

  if (summaryMode) {
    printSummary(shown, counts, today, contacts.length);
  } else {
    console.log(JSON.stringify({
      metadata: { date: today, total: contacts.length, actionable },
      counts,
      entries: shown,
    }, null, 2));
  }
}

// Short leverage label for the dashboard — mirrors contacto.md § Step 2's
// priority order. Blank for neutral so the column stays quiet when the contact
// type is unreadable (no noise where there's no signal).
const LEVERAGE_LABEL = { manager: 'hiring-mgr', peer: 'peer/ref', recruiter: 'recruiter', neutral: '' };

function printSummary(entries, counts, today, total) {
  const ICON = { nudge: 'NUDGE  ', waiting: 'waiting', cold: 'COLD   ', done: 'replied' };
  console.log(`Outreach Cadence Dashboard — ${today}`);
  console.log(`${total} contacts tracked · ${counts.nudge} need a nudge · ${counts.waiting} waiting · ${counts.cold} cold · ${counts.done} replied`);
  // When a nudge is due, name the single most valuable one (top of the sort).
  const topNudge = entries.find((e) => e.action === 'nudge');
  if (topNudge) {
    const who = LEVERAGE_LABEL[topNudge.leverage]
      ? ` (${LEVERAGE_LABEL[topNudge.leverage]})`
      : '';
    console.log(`→ Most valuable nudge: ${topNudge.contact} @ ${topNudge.company}${who}`);
  }
  console.log('');
  if (entries.length === 0) {
    console.log('Nothing to show.');
    return;
  }
  const w = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  console.log(`| ${w('Action', 7)} | ${w('Company', 18)} | ${w('Contact', 18)} | ${w('Lever', 10)} | ${w('Chan', 10)} | ${w('Days', 4)} | ${w('Next nudge', 10)} |`);
  console.log(`|${'-'.repeat(9)}|${'-'.repeat(20)}|${'-'.repeat(20)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(6)}|${'-'.repeat(12)}|`);
  for (const e of entries) {
    console.log(`| ${w(ICON[e.action] || e.action, 7)} | ${w(e.company, 18)} | ${w(e.contact, 18)} | ${w(LEVERAGE_LABEL[e.leverage] ?? '', 10)} | ${w(e.channel, 10)} | ${w(e.daysSince ?? '?', 4)} | ${w(e.nextNudge ?? '-', 10)} |`);
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
