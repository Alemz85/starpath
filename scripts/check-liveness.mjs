#!/usr/bin/env node

/**
 * check-liveness.mjs — is this job posting still open?
 *
 * Cheapest evidence first (lib/liveness-ladder.mjs): the ATS's per-job API, the
 * org board listing, then the posting page judged on two agreeing signals. Only
 * when all of that is ambiguous does it start Playwright, and then it polls the
 * page every 250 ms until the verdict is decisive instead of waiting a fixed 2 s.
 * Zero Claude API tokens.
 *
 * Usage:
 *   node scripts/check-liveness.mjs '<url1>' ['<url2>'] ...   (single-quote URLs: zsh globs `?`)
 *   node scripts/check-liveness.mjs --file urls.txt
 *   node scripts/check-liveness.mjs --pipeline            # every Pending URL in data/pipeline.md
 *   node scripts/check-liveness.mjs --no-browser <url>    # ladder only; ambiguous stays "uncertain"
 *   node scripts/check-liveness.mjs --record <url>        # write the verdict to data/scan-history.tsv
 *
 * --record: `expired` rows get status `expired` (+ expired_reason) so a dead
 * posting stops resurfacing in triage; an `unreachable` check only counts a
 * failed attempt (fetch_attempts / first_unreachable / last_error) and becomes
 * `expired` after N attempts over H hours (user/profile.yml › scanner.liveness,
 * lib/liveness-state.mjs); an `active` check revives a row marked expired.
 *
 * Exit code: 0 if all active, 1 if any expired, uncertain or unreachable.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import { pollUntilDecisive } from './liveness-core.mjs';
import { http } from './lib/http.mjs';
import { checkPosting, toOutcome } from './lib/liveness-check.mjs';
import { loadWorkdaySites } from './lib/workday-sites.mjs';
import { loadGreenhouseBoards } from './lib/greenhouse-boards.mjs';
import { applyChecks, readLivenessPolicy } from './lib/liveness-state.mjs';
import { parseHistoryFile, upgradeColumns } from './lib/scan-history.mjs';

const HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const PROFILE_PATH = 'user/profile.yml';

/** Everything the page shows that decides liveness: text plus visible apply-ish controls. */
async function samplePage(page, status) {
  const finalUrl = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
  const applyControls = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
    );
    return candidates
      .filter((element) => {
        if (element.closest('nav, header, footer')) return false;
        if (element.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (!element.getClientRects().length) return false;
        return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
      })
      .map((element) => [element.innerText, element.value, element.getAttribute('aria-label'), element.getAttribute('title')]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });
  return { status, finalUrl, bodyText, applyControls };
}

/** The Playwright rung. Lazily starts the browser; throws when the page cannot load. */
function makeBrowserRung() {
  let browser = null;
  let page = null;
  const rung = async (url) => {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
    }
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    const verdict = await pollUntilDecisive({ sample: () => samplePage(page, status) });
    return { result: verdict.result, reason: `${verdict.reason} (${verdict.polls} poll${verdict.polls === 1 ? '' : 's'})` };
  };
  rung.close = async () => { if (browser) await browser.close(); };
  return rung;
}

async function urlsFromArgs(args) {
  if (args.includes('--pipeline')) {
    if (!existsSync(PIPELINE_PATH)) return [];
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    const pending = text.split(/^## Processed/m)[0];
    return [...pending.matchAll(/- \[ \] (https?:\/\/\S+)/g)].map((m) => m[1]);
  }
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1) {
    const text = await readFile(args[fileIdx + 1], 'utf-8');
    return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  return args.filter((a) => !a.startsWith('--'));
}

async function recordChecks(checks) {
  if (!existsSync(HISTORY_PATH)) {
    console.log('\n--record: data/scan-history.tsv does not exist; nothing recorded.');
    return;
  }
  let profile = null;
  try { if (existsSync(PROFILE_PATH)) profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8')); } catch { /* defaults */ }
  const policy = readLivenessPolicy(profile);
  const { columns, rows } = parseHistoryFile(readFileSync(HISTORY_PATH, 'utf-8'));
  const wide = upgradeColumns(columns);
  const outcomes = checks.map((c) => ({ url: c.url, outcome: toOutcome(c) })).filter((c) => c.outcome);
  const { rows: next, changes, unmatched } = applyChecks(rows, wide, outcomes, { now: new Date(), policy });
  const content = wide.join('\t') + '\n' + next.join('\n') + (next.length ? '\n' : '');
  const tmp = `${HISTORY_PATH}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, HISTORY_PATH);
  console.log(`\nscan-history: ${changes.length} row(s) updated` +
    (unmatched.length ? `, ${unmatched.length} URL(s) not in scan-history` : '') +
    ` (unreachable policy: ${policy.attempts} attempts over ≥ ${policy.hours} h).`);
  for (const c of changes) console.log(`  ${c.before} → ${c.after}  ${c.reason}  ${c.url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const urls = await urlsFromArgs(args);

  if (urls.length === 0) {
    console.error('Usage: node scripts/check-liveness.mjs [--no-browser] [--record] <url1> [url2] ...');
    console.error('       node scripts/check-liveness.mjs --file urls.txt | --pipeline');
    process.exit(1);
  }

  const useBrowser = !args.includes('--no-browser');
  const record = args.includes('--record');
  console.log(`Checking ${urls.length} URL(s)...\n`);

  const rung = useBrowser ? makeBrowserRung() : null;
  const checks = [];
  const workdaySites = loadWorkdaySites();
  const greenhouseBoards = loadGreenhouseBoards();
  const tally = { active: 0, expired: 0, uncertain: 0, unreachable: 0 };
  const icons = { active: '✅', expired: '❌', uncertain: '⚠️', unreachable: '🔌' };

  // Sequential — project rule: never Playwright in parallel
  for (const url of urls) {
    const check = await checkPosting(url, { http, browser: rung, workdaySites, greenhouseBoards });
    checks.push(check);
    tally[check.kind]++;
    console.log(`${icons[check.kind]} ${check.kind.padEnd(11)} ${url}`);
    if (check.kind !== 'active') console.log(`            ${check.reason}${check.error ? ` — ${check.error}` : ''}`);
    else console.log(`            via ${check.via}`);
  }

  if (rung) await rung.close();
  if (record) await recordChecks(checks);

  console.log(`\nResults: ${tally.active} active  ${tally.expired} expired  ${tally.uncertain} uncertain  ${tally.unreachable} unreachable`);
  if (tally.expired + tally.uncertain + tally.unreachable > 0) process.exit(1);
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
