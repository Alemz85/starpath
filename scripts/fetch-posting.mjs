#!/usr/bin/env node

/**
 * fetch-posting.mjs — a posting's job description straight from the ATS API.
 *
 * The same endpoints the liveness ladder uses (Greenhouse, Lever, SmartRecruiters,
 * Workday per-job; the Ashby board entry) return the JD body along with the
 * answer to "is it still open?", so one request gives a worker both — no browser
 * and no WebFetch. Zero Claude API tokens.
 *
 * Usage:
 *   node scripts/fetch-posting.mjs <posting-url>          # readable text
 *   node scripts/fetch-posting.mjs <posting-url> --json   # the same, as JSON
 *
 * Exit code:
 *   0  JD printed; the first line says `Verification: active …`
 *   2  the posting is closed (`Verification: expired …`), nothing else printed
 *   3  the ATS endpoints could not answer (unsupported host, ambiguous, or
 *      unreachable): fall back to the page itself (Playwright, or WebFetch in a
 *      headless worker) and mark the verification unconfirmed
 */

import { pathToFileURL } from 'url';
import { http } from './lib/http.mjs';
import { climbLadder } from './lib/liveness-ladder.mjs';

const VIA = {
  'api-job': 'the ATS per-job API',
  'api-board': 'the ATS org board listing',
  html: 'the posting page',
};

/** Run the ladder and shape the result for printing. Pure given `http`. */
export async function fetchPosting(url, { http: client = http, now = new Date() } = {}) {
  const ladder = await climbLadder(url, { http: client, now });
  const v = ladder.verdict;
  if (!v) {
    const why = ladder.ats ? 'ambiguous or unreachable' : 'not a posting URL on a supported ATS';
    return { url, status: 'unknown', verification: `unknown (${why})`, exitCode: 3, errors: ladder.errors };
  }
  if (v.result === 'expired') {
    return { url, status: 'expired', verification: `expired (${v.reason}; via ${VIA[v.via] || v.via})`, exitCode: 2 };
  }
  if (!v.jd || !v.jd.description) {
    return {
      url, status: 'active', verification: `active (${v.reason}; via ${VIA[v.via] || v.via})`,
      exitCode: 3, note: 'live, but this rung returns no job description', errors: ladder.errors,
    };
  }
  return {
    url, status: 'active', verification: `active (confirmed via ${VIA[v.via] || v.via})`, exitCode: 0,
    title: v.jd.title, location: v.jd.location, postedDate: v.jd.postedDate, deadline: v.jd.deadline,
    description: v.jd.description,
  };
}

export function render(r) {
  const lines = [`URL: ${r.url}`, `Verification: ${r.verification}`];
  if (r.exitCode === 0) {
    lines.push(`Title: ${r.title || 'n/d'}`, `Location: ${r.location || 'n/d'}`,
      `Posted: ${r.postedDate || 'n/d'}`, `Deadline: ${r.deadline || 'n/d'}`, '', '--- Job description ---', r.description);
  } else if (r.note) {
    lines.push(`Note: ${r.note}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: node scripts/fetch-posting.mjs <posting-url> [--json]');
    process.exit(1);
  }
  const r = await fetchPosting(url);
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  process.exit(r.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
