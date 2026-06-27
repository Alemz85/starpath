#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from user/portals.yml, deduplicates against existing history,
 * ranks the survivors by relevance (best first), and appends them to
 * pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Relevance ranking: postings that clear the 4-pass filter funnel are scored
 * and ordered best-first so the strongest matches sit at the top of the
 * pipeline (and surface first when the user evaluates). The score is a
 * transparent sum of signals — positive-keyword/phrase matches, the
 * seniority_boost band, freshness, and target-city specificity — and the
 * "why" is appended to each pipeline line. Tune the weights via
 * user/portals.yml › title_filter.relevance_weights (optional; safe defaults
 * apply). Scoring lives in scan-core.mjs (pure + unit-tested).
 *
 * Usage:
 *   node scripts/scan.mjs                  # scan all enabled companies
 *   node scripts/scan.mjs --dry-run        # preview without writing files
 *   node scripts/scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import {
  buildTitleFilter,
  buildLangFilter,
  buildLocationFilter,
  rankOffers,
  formatRelevanceNote,
} from './scan-core.mjs';
import {
  canonicalizeUrl,
  seedScanSeen,
  classifyScanOffer,
} from './lib/merge-staging-core.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'user/portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const AUDIT_STATE_PATH = 'data/filter-audit-state.json';

const AUDIT_REPORT_INTERVAL_DAYS = 30; // how often to print the full keyword health report

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Explicit api field takes priority
  if (company.api) {
    if (company.api.includes('greenhouse')) {
      return { type: 'greenhouse', url: company.api };
    }
    if (company.api.includes('smartrecruiters.com')) {
      return { type: 'smartrecruiters', url: company.api, brandFilter: company.sr_brand || null };
    }
    if (company.api.includes('myworkdayjobs.com')) {
      const baseMatch = company.api.match(/(https:\/\/[^/]+\.myworkdayjobs\.com)/);
      return { type: 'workday', url: company.api, baseUrl: baseMatch ? baseMatch[1] : '' };
    }
  }

  const url = company.careers_url || '';

  // Workday: https://{tenant}.wd{shard}.myworkdayjobs.com/{site}
  const workdayMatch = url.match(/(https:\/\/([^/]+)\.wd\d+\.myworkdayjobs\.com)\/([^/?#]+)/);
  if (workdayMatch) {
    const baseUrl = workdayMatch[1];
    const tenant = workdayMatch[2];
    const site = workdayMatch[3];
    return {
      type: 'workday',
      url: `${baseUrl}/wday/cxs/${tenant}/${site}/jobs`,
      baseUrl,
    };
  }

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────
//
// Each parser also carries `postedDate` — the role's TRUE posting/update date
// straight from the ATS payload — so scan-core's relevance ranking can reward
// genuinely-fresh roles over long-open reposts (instead of treating every offer
// in a batch as "posted today", which is all `first_seen` can tell it).
// scan-core.parsePostingDate normalizes the varied shapes (ISO ts, epoch ms,
// bare date); a missing/odd value is fail-open (null → falls back to the scan
// date, i.e. the prior behaviour, never worse).

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedDate: j.first_published || j.updated_at || null,
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    postedDate: j.publishedAt || j.updatedAt || null,
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    postedDate: j.createdAt ?? null, // epoch ms
  }));
}

function parseSmartRecruiters(jobs, companyName, brandFilter) {
  let filtered = jobs;
  if (brandFilter) {
    filtered = jobs.filter(j =>
      j.customField?.some(f => f.fieldLabel === 'Brands' && f.valueLabel === brandFilter)
    );
  }
  return filtered.map(j => ({
    title: j.name || '',
    url: `https://careers.smartrecruiters.com/${j.company?.identifier || companyName}/${j.id}`,
    company: companyName,
    location: j.location?.city || j.location?.fullLocation || '',
    postedDate: j.releasedDate || j.createdOn || null,
  }));
}

function parseWorkday(json, companyName, baseUrl) {
  const jobs = json.jobPostings || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: baseUrl && j.externalPath ? `${baseUrl}${j.externalPath}` : j.externalPath || '',
    company: companyName,
    location: j.locationsText || '',
    // Workday exposes only a relative "Posted Today / 30+ Days Ago" string, not
    // an absolute date — too lossy to trust, so leave the scan-date fallback.
    postedDate: null,
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── POST fetch with timeout ────────────────────────────────────────

async function fetchJsonPost(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Workday paginated fetch ────────────────────────────────────────

async function fetchWorkdayJobs(apiUrl, companyName, baseUrl) {
  const allJobs = [];
  let offset = 0;
  const limit = 20;
  while (true) {
    const json = await fetchJsonPost(apiUrl, {
      appliedFacets: {},
      limit,
      offset,
      searchText: '',
    });
    const jobs = parseWorkday(json, companyName, baseUrl);
    allJobs.push(...jobs);
    const total = json.total || 0;
    offset += limit;
    if (allJobs.length >= total || jobs.length === 0 || offset > 3000) break;
  }
  return allJobs;
}

// ── SmartRecruiters paginated fetch ─────────────────────────────────

async function fetchSmartRecruitersJobs(baseUrl, companyName, brandFilter) {
  const allJobs = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const json = await fetchJson(`${baseUrl}?limit=${limit}&offset=${offset}`);
    const page = json.content || [];
    allJobs.push(...page);
    if (page.length < limit || allJobs.length >= (json.totalFound || 0)) break;
    offset += limit;
    if (offset > 3000) break; // safety cap
  }
  return parseSmartRecruiters(allJobs, companyName, brandFilter);
}

// Title / language / location filters live in ./scan-core.mjs — pure,
// word-boundary-aware, and unit-tested (see scan-core.test.mjs). The
// trailing-space negative-keyword leak (e.g. "Lead " missing "Operations
// Lead") is fixed there.
// ── Dedup ───────────────────────────────────────────────────────────

const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscan_dates';

/**
 * Load scan-history.tsv into memory.
 * Returns { rows: string[], urlToIndex: Map<canonicalUrl, rowIndex> }
 * Rows are the data lines (no header), ready to be mutated and re-saved.
 *
 * URLs are keyed under their CANONICAL form (canonicalizeUrl) so a re-seen
 * posting whose URL only differs by a tracking param / redirect wrapper maps
 * back onto the existing row — the same canonical space the dedup pass uses.
 */
function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    return { rows: [], urlToIndex: new Map() };
  }

  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
  const urlToIndex = new Map();
  const rows = [];

  for (const line of lines.slice(1)) { // skip header
    if (!line.trim()) continue;
    const url = line.split('\t')[0];
    if (url) urlToIndex.set(canonicalizeUrl(url), rows.length);
    rows.push(line);
  }

  return { rows, urlToIndex };
}

/** Rewrite the entire scan-history.tsv from in-memory rows. */
function saveHistory(rows) {
  const content = HISTORY_HEADER + '\n' + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(SCAN_HISTORY_PATH, content, 'utf-8');
}

/**
 * For URLs already in scan-history, append today's date to their scan_dates column.
 * Handles old rows that may not yet have the scan_dates column.
 */
function updateScanDates(rows, urlToIndex, reseenUrls, date) {
  for (const url of reseenUrls) {
    const idx = urlToIndex.get(url);
    if (idx === undefined) continue;
    const cols = rows[idx].split('\t');
    if (cols.length < 8) {
      // Migrate old row (pre-location schema): pad to 8 cols then set scan_dates
      while (cols.length < 7) cols.push('');
      cols.push(date);
    } else {
      const existing = cols[7] || '';
      if (!existing.split('|').includes(date)) {
        cols[7] = existing ? `${existing}|${date}` : date;
      }
    }
    rows[idx] = cols.join('\t');
  }
}

/**
 * Collect every raw URL already seen across pipeline.md + applications.md (the
 * scan-history URLs are folded in separately via seedScanSeen's historyRows).
 * Returned RAW — seedScanSeen canonicalizes them into the dedup space.
 */
function loadSeenUrls() {
  const seen = new Set();

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

/**
 * Collect [company, role] pairs already in applications.md (scan-history's own
 * (company, role) keys are folded in by seedScanSeen via historyRows). Returned
 * as raw tuples; seedScanSeen normalizes + canonicalizes them so a `(m/f/d)` /
 * trailing-location title variant collapses onto the same dedup key.
 */
function loadSeenCompanyRoles() {
  const pairs = [];
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim();
      const role = match[2].trim();
      if (company && role && company.toLowerCase() !== 'company') {
        pairs.push([company, role]);
      }
    }
  }
  return pairs;
}

// ── Pipeline writer ─────────────────────────────────────────────────

/**
 * Render one pipeline checkbox line. Offers are expected to arrive ranked
 * best-first (see rankOffers); when an offer carries a `.relevance` score we
 * append a compact "relevance X.X — why" note to the line's tail. The frontend
 * pipeline parser only reads the leading URL (regex-anchored at line start), so
 * the trailing note is purely human-facing and never breaks dedup or parsing.
 */
function pipelineLine(o) {
  const base = `- [ ] ${o.url} | ${o.company} | ${o.title}`;
  const note = formatRelevanceNote(o.relevance);
  return note ? `${base} | ${note}` : base;
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pending" section and append after it
  const marker = '## Pending';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pending section — append at end before Processed
    const procIdx = text.indexOf('## Processed');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(pipelineLine).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pending content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(pipelineLine).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

/** Append new offer rows to the in-memory history rows array. */
function addToHistory(rows, urlToIndex, offers, date) {
  for (const o of offers) {
    urlToIndex.set(canonicalizeUrl(o.url), rows.length);
    const location = (o.location || '').replace(/\t/g, ' '); // sanitize tabs
    rows.push(`${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\t${location}\tadded\t${date}`);
  }
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // Audit stats are always tracked (zero cost — just memory counters)
  const auditStats = { negativeHits: {}, noPositiveMatch: 0 };

  // Load audit state to decide whether to print the monthly health report
  let auditState = { lastReportDate: null };
  try {
    if (existsSync(AUDIT_STATE_PATH)) {
      auditState = JSON.parse(readFileSync(AUDIT_STATE_PATH, 'utf-8'));
    }
  } catch { /* ignore malformed state */ }

  // 1. Read user/portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: user/portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter, auditStats);
  const langFilter = buildLangFilter(config);
  // Optional user override; falls back to the generic EU/UK allowlist.
  const locationFilter = buildLocationFilter(config.location_allowlist);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets — seeded through the SAME canonical primitives the
  //    JobSpy merge path uses (canonicalizeUrl + companyRoleKey), so a re-seen
  //    posting whose URL only differs by a tracking param, or a `(m/f/d)` /
  //    trailing-location title variant of a role already in scan-history,
  //    collapses onto the existing entry instead of re-entering the pipeline.
  const history = loadHistory();
  const { seenUrls, seenKeys } = seedScanSeen({
    urls: loadSeenUrls(),                       // pipeline.md + applications.md URLs
    historyRows: history.rows,                  // scan-history URLs + (company, role) keys
    companyRolePairs: loadSeenCompanyRoles(),   // applications.md (company, role) pairs
  });

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLangFiltered = 0;
  let totalLocationFiltered = 0;
  let totalDupes = 0;
  let totalReseen = 0;
  const newOffers = [];
  const reseenUrls = new Set(); // URLs in scan-history seen again today
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url, brandFilter, baseUrl } = company._api;
    const startedAt = Date.now();
    process.stdout.write(`→ ${company.name} (${type})\n`);
    let kept = 0;
    try {
      let jobs;
      if (type === 'workday') {
        jobs = await fetchWorkdayJobs(url, company.name, baseUrl);
      } else if (type === 'smartrecruiters') {
        jobs = await fetchSmartRecruitersJobs(url, company.name, brandFilter);
      } else {
        const json = await fetchJson(url);
        jobs = PARSERS[type](json, company.name);
      }
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title)) {
          totalFiltered++;
          continue;
        }
        if (!langFilter(job.title)) {
          totalLangFiltered++;
          continue;
        }
        if (!locationFilter(job.location)) {
          totalLocationFiltered++;
          continue;
        }
        // Canonical dedup: exact (canonical) URL first, then normalized
        // (company, role). Mirrors mergeHistory's precedence so the live
        // scanner and the merge path agree on "already seen".
        const { decision, canonicalUrl, key } = classifyScanOffer(job, { seenUrls, seenKeys });
        if (decision === 'duplicate-url') {
          totalDupes++;
          // Bump scan_dates only when the canonical URL is a known scan-history
          // row (not a pipeline/apps-only URL we don't own).
          if (history.urlToIndex.has(canonicalUrl)) {
            reseenUrls.add(canonicalUrl);
            totalReseen++;
          }
          continue;
        }
        if (decision === 'duplicate-role') {
          totalDupes++;
          continue;
        }
        // New: mark as seen (canonical) to avoid intra-scan dupes.
        seenUrls.add(canonicalUrl);
        if (key) seenKeys.add(key);
        newOffers.push({ ...job, source: `${type}-api` });
        kept++;
      }
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`  ✓ ${company.name} · ${jobs.length} jobs · ${kept} kept (${took}s)\n`);
    } catch (err) {
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      process.stdout.write(`  ✗ ${company.name} · ${err.message} (${took}s)\n`);
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 4b. Rank survivors best-first by relevance, so the strongest matches land at
  // the top of the pipeline (and surface first when the user evaluates). Every
  // offer in this batch is first-SEEN today, but each carries the ATS payload's
  // true `postedDate`, so freshness now separates a role posted this morning
  // from a long-open repost instead of treating the whole batch as equally new.
  // Weights and the seniority_boost list both come from user/portals.yml (no
  // hardcoded user data). See scan-core.mjs › rankOffers / scoreRelevance.
  const rankedOffers = rankOffers(newOffers, config.title_filter || {}, {
    now: date,
    locationAllowlist: config.location_allowlist,
  });

  // 5. Write results (ranked order — best matches first in pipeline + history)
  if (!dryRun) {
    if (rankedOffers.length > 0) {
      appendToPipeline(rankedOffers);
      addToHistory(history.rows, history.urlToIndex, rankedOffers, date);
    }
    if (reseenUrls.size > 0) {
      updateScanDates(history.rows, history.urlToIndex, reseenUrls, date);
    }
    if (newOffers.length > 0 || reseenUrls.size > 0) {
      saveHistory(history.rows);
    }
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by language:  ${totalLangFiltered} removed`);
  console.log(`Filtered by location:  ${totalLocationFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped (${totalReseen} still open → scan_dates updated)`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (rankedOffers.length > 0) {
    console.log('\nNew offers (ranked by relevance, best first):');
    for (const o of rankedOffers) {
      const score = o.relevance ? o.relevance.score.toFixed(1).padStart(4) : ' n/a';
      console.log(`  [${score}] ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);

  // ── Silent filter health check (runs every scan, reports conditionally) ──────

  const passCount = totalFound - totalFiltered - totalLangFiltered - totalLocationFiltered;
  const passRate = totalFound > 0 ? (passCount / totalFound * 100) : 100;

  const daysSinceLastReport = auditState.lastReportDate
    ? (Date.now() - new Date(auditState.lastReportDate).getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;

  const overFilter = totalFound > 10 && passRate < 5;
  const monthlyDue = daysSinceLastReport >= AUDIT_REPORT_INTERVAL_DAYS && totalFound > 0;

  const sortedHits = Object.entries(auditStats.negativeHits).sort(([, a], [, b]) => b - a);
  const zeroHitKeywords = sortedHits.filter(([, c]) => c === 0).map(([k]) => k);

  if (overFilter || monthlyDue) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(overFilter
      ? `⚠  FILTER HEALTH — Over-filter detected`
      : `Filter health check (monthly)`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`Pass rate: ${passRate.toFixed(1)}%  (${passCount} of ${totalFound} postings)`);

    const topBlockers = sortedHits.filter(([, c]) => c > 0).slice(0, 5);
    if (topBlockers.length > 0) {
      console.log(`Top blockers:`);
      for (const [keyword, count] of topBlockers) {
        const pct = totalFiltered > 0 ? (count / totalFiltered * 100).toFixed(0) : '0';
        console.log(`  "${keyword}" — ${count} blocked (${pct}%)`);
      }
    }

    if (zeroHitKeywords.length > 0) {
      console.log(`Zero-hit keywords this scan (${zeroHitKeywords.length} — possible dead weight):`);
      console.log(`  ${zeroHitKeywords.slice(0, 8).map(k => `"${k}"`).join(', ')}`);
    }

    if (overFilter) {
      console.log(`\n→ Filters may be too aggressive. Review top blockers above.`);
      console.log(`  Use /career-ops to ask Claude for removal suggestions.`);
    }

    // Save last report date
    if (!dryRun) {
      try {
        writeFileSync(AUDIT_STATE_PATH, JSON.stringify({ lastReportDate: date }, null, 2), 'utf-8');
      } catch { /* non-fatal */ }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
