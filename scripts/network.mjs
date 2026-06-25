#!/usr/bin/env node
/**
 * network.mjs — I/O wrapper for the referral / networking tracker.
 *
 * Reads the candidate's connection roster (`data/network.md`) and the pipeline
 * (`data/applications.md` + `data/scouting.md`), matches who they know against
 * the companies they're targeting, and surfaces the best referral path for each
 * — plus the coverage gaps (high-value targets with nobody inside) and latent
 * leads (people they know at companies not yet in the pipeline).
 *
 * The pure logic lives in `scripts/lib/network-core.mjs`; this file only does
 * filesystem reads + output formatting. It NEVER mutates `network.md` — the
 * `network` mode appends rows (see `modes/network.md`); this script only reads.
 *
 * USAGE
 *   node scripts/network.mjs                  JSON map of matches/gaps/leads (default)
 *   node scripts/network.mjs --summary        human-readable dashboard
 *   node scripts/network.mjs --company "Acme" who do I know at one company (JSON)
 *   node scripts/network.mjs --gaps           only pipeline targets with no contact
 *
 * Complements `outreach-cadence.mjs`: that tracks messages already SENT and when
 * to nudge; this tracks who you KNOW and your best way in, *before* the touch.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseNetwork,
  parsePipeline,
  matchNetworkToPipeline,
  pathsForCompany,
  pathLabel,
} from './lib/network-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NETWORK_FILE = join(ROOT, 'data/network.md');
const APPLICATIONS_FILE = join(ROOT, 'data/applications.md');
const SCOUTING_FILE = join(ROOT, 'data/scouting.md');

const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const gapsOnly = args.includes('--gaps');
const companyFlagIdx = args.findIndex((a) => a === '--company');
const companyName = companyFlagIdx >= 0 ? args[companyFlagIdx + 1] : null;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function loadContacts() {
  if (!existsSync(NETWORK_FILE)) return { contacts: null };
  return { contacts: parseNetwork(readFileSync(NETWORK_FILE, 'utf-8')) };
}

function loadPipeline() {
  return parsePipeline(readIf(APPLICATIONS_FILE), readIf(SCOUTING_FILE));
}

function emptyNotice(json) {
  const msg =
    'No network mapped yet. Run `/career-ops network` to start a roster of who ' +
    'you know (or are one intro from) at companies in your pipeline — then this ' +
    'surfaces your warmest referral path for each application. The roster lives ' +
    'in data/network.md.';
  if (json) {
    console.log(JSON.stringify({ metadata: { date: todayStr(), hasNetwork: false }, message: msg }, null, 2));
  } else {
    console.log(`Referral Network — ${todayStr()}\n\n${msg}`);
  }
}

function main() {
  const today = todayStr();
  const { contacts } = loadContacts();

  if (contacts === null) {
    emptyNotice(!summaryMode);
    return;
  }

  const pipeline = loadPipeline();

  // --- Single-company query ---
  if (companyName) {
    const r = pathsForCompany(companyName, contacts, pipeline, today);
    if (summaryMode) {
      printCompany(r);
    } else {
      console.log(JSON.stringify({ metadata: { date: today }, ...r }, null, 2));
    }
    return;
  }

  const res = matchNetworkToPipeline(contacts, pipeline, today);

  if (gapsOnly) {
    if (summaryMode) {
      printGaps(res.gaps, today);
    } else {
      console.log(JSON.stringify({ metadata: { date: today }, gaps: res.gaps }, null, 2));
    }
    return;
  }

  if (summaryMode) {
    printSummary(res, today, contacts.length);
  } else {
    console.log(JSON.stringify({ metadata: { date: today, contacts: contacts.length }, ...res }, null, 2));
  }
}

/* ───── Human-readable renderers ─────────────────────────────────── */

function printSummary(res, today, totalContacts) {
  const c = res.counts;
  console.log(`Referral Network — ${today}`);
  console.log(
    `${totalContacts} contact${totalContacts === 1 ? '' : 's'} mapped · ` +
    `${c.matchedCompanies} pipeline ${c.matchedCompanies === 1 ? 'company has' : 'companies have'} a path in · ` +
    `${c.gaps} target${c.gaps === 1 ? '' : 's'} with nobody inside · ` +
    `${c.orphanContacts} latent lead${c.orphanContacts === 1 ? '' : 's'}\n`,
  );

  if (res.matches.length) {
    console.log('── Warm paths into pipeline companies (best first) ──');
    for (const m of res.matches) {
      const topRole = m.roles[0];
      const roleStr = topRole ? `${topRole.role} (${topRole.score}/10)` : '(no role)';
      console.log(`\n  ${m.company} → ${roleStr}`);
      for (const ct of m.contacts) {
        console.log(`    • [${ct.warmth.toFixed(1)}] ${pathLabel(ct)}${ct.notes ? `  — ${ct.notes}` : ''}`);
      }
      if (m.roles.length > 1) {
        console.log(`    (also targeting: ${m.roles.slice(1).map((r) => `${r.role} ${r.score}/10`).join(', ')})`);
      }
    }
    console.log('');
  } else {
    console.log('No contact yet at any company in your pipeline.\n');
  }

  if (res.gaps.length) {
    console.log('── Coverage gaps: high-value targets with nobody inside ──');
    for (const g of res.gaps.slice(0, 12)) {
      console.log(`  ✗ ${g.company} — ${g.roles[0].role} (${g.roles[0].score}/10)  → find a contact (run /career-ops contacto ${g.company})`);
    }
    if (res.gaps.length > 12) console.log(`  …and ${res.gaps.length - 12} more.`);
    console.log('');
  }

  if (res.orphanContacts.length) {
    console.log('── Latent leads: people you know at companies not in your pipeline ──');
    for (const o of res.orphanContacts.slice(0, 10)) {
      console.log(`  ~ ${o.company}: ${pathLabel(o)}`);
    }
    if (res.orphanContacts.length > 10) console.log(`  …and ${res.orphanContacts.length - 10} more.`);
  }
}

function printCompany(r) {
  console.log(`Referral paths — ${r.company}`);
  if (!r.inPipeline) {
    console.log('(not currently in your pipeline)');
  } else {
    console.log(`Targeting: ${r.roles.map((x) => `${x.role} (${x.score}/10)`).join(', ')}`);
  }
  console.log('');
  if (!r.found) {
    console.log('No contact mapped here yet. Consider /career-ops contacto to find someone, then add them to data/network.md.');
    return;
  }
  for (const ct of r.contacts) {
    console.log(`  • [${ct.warmth.toFixed(1)}] ${pathLabel(ct)}${ct.notes ? `  — ${ct.notes}` : ''}`);
  }
}

function printGaps(gaps, today) {
  console.log(`Referral coverage gaps — ${today}`);
  if (!gaps.length) {
    console.log('\nEvery pipeline company has at least one contact. Nice.');
    return;
  }
  console.log(`${gaps.length} pipeline ${gaps.length === 1 ? 'company has' : 'companies have'} no contact (highest-value first):\n`);
  for (const g of gaps) {
    console.log(`  ✗ ${g.company} — ${g.roles[0].role} (${g.roles[0].score}/10)`);
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
