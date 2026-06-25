#!/usr/bin/env node
/**
 * respond-plan.mjs — I/O wrapper for the `respond` mode (recruiter-reply drafting).
 *
 * Classifies a pasted recruiter message into the asks it contains and prints a
 * deterministic reply plan: one step per ask (in canonical order), the handling
 * strategy for each, and the canonical pipeline status the reply implies. The
 * `respond` mode (modes/respond.md) runs this to get a stable skeleton, then
 * fills each step with prose grounded in user/* + the story bank.
 *
 * All decision logic lives in the pure module scripts/respond-core.mjs (unit-
 * tested). This file only reads the message (from --message, a --file, or stdin)
 * and renders. It writes NOTHING to the pipeline — per the Ethical Use contract
 * the mode always stops for user review before any send or status writeback.
 *
 *   node scripts/respond-plan.mjs --message "what's your comp expectation?"
 *   node scripts/respond-plan.mjs --file path/to/recruiter-email.txt
 *   pbpaste | node scripts/respond-plan.mjs            # read from stdin
 *   node scripts/respond-plan.mjs --message "..." --json
 *
 * Optional comp framing (when the caller already parsed profile.yml targets):
 *   node scripts/respond-plan.mjs --message "comp?" --target 60000 --floor 50000
 */

import { readFileSync, existsSync } from 'fs';
import { buildReplyPlan, suggestedStatus, compRange, detectAskIds } from './respond-core.mjs';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function readMessage() {
  const inline = flag('--message') || flag('-m');
  if (inline) return inline;
  const file = flag('--file') || flag('-f');
  if (file) {
    if (!existsSync(file)) {
      process.stderr.write(`respond-plan: file not found: ${file}\n`);
      process.exit(1);
    }
    return readFileSync(file, 'utf8');
  }
  // Fall back to stdin (pbpaste | ...). readFileSync(0) blocks until EOF.
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const message = readMessage();
if (!message || !message.trim()) {
  process.stderr.write(
    'respond-plan: no message. Pass --message "...", --file path, or pipe via stdin.\n',
  );
  process.exit(1);
}

const plan = buildReplyPlan(message);
const status = suggestedStatus(message);

// Optional comp framing if the caller passed numbers AND comp is asked.
let comp = null;
const targetArg = flag('--target');
const floorArg = flag('--floor');
if (targetArg != null || detectAskIds(message).includes('comp')) {
  comp = compRange(targetArg, floorArg);
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({ plan, suggestedStatus: status, comp }, null, 2) + '\n');
  process.exit(0);
}

/* ───── human-readable render ─────────────────────────────────────────────── */

const KIND_LABEL = {
  rejection: 'Rejection — graceful decline',
  freeform: 'No standard ask detected — answer directly',
  reply: 'Recruiter reply',
};

console.log(`\n  Reply plan: ${KIND_LABEL[plan.kind] || plan.kind}`);
console.log(`  Suggested pipeline status (for review, not written): ${status}\n`);

plan.steps.forEach((step, i) => {
  console.log(`  ${i + 1}. ${step.label}`);
  console.log(`     → ${step.handling}\n`);
});

if (comp) {
  if (comp.ok) {
    console.log(`  Comp anchor range: ${comp.low}–${comp.high} (state as total comp; never go below ${comp.low}).`);
  } else {
    console.log(`  Comp: ${comp.reason} — defer the number and ask the recruiter for the band first.`);
  }
  console.log('');
}

console.log('  Next: modes/respond.md fills each step with prose from user/* + the story bank,');
console.log('  then STOPS for your review. Nothing is sent and no status is written automatically.\n');
