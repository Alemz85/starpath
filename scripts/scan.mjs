#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, Lever, Workday and SmartRecruiters APIs directly,
 * applies title filters from user/portals.yml, deduplicates against existing
 * history, ranks the survivors by relevance (best first), and appends them to
 * pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Transport: every request goes through lib/http.mjs (https only, per-ATS host
 * allowlist for portals.yml URLs, no redirects, private-address guard, bounded
 * timeout/body, retry with jitter).
 *
 * Per listing it also records, in header-named scan-history.tsv columns
 * (lib/scan-history.mjs): posted_date, deadline (only when the source states an
 * ISO date), the ATS-native posting_id / req_id, and `locations` — a multi-city
 * string split into separate locations. A listing passes the location gate when
 * ANY of its locations is allowed.
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
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';
import {
  buildTitleFilter,
  buildLangFilter,
  buildLocationFilter,
  rankOffers,
  formatRelevanceNote,
  parsePostingDate,
  DEFAULT_LOCATION_ALLOWLIST,
} from './scan-core.mjs';
import {
  canonicalizeUrl,
  seedScanSeen,
  classifyScanOffer,
  postingIdKey,
} from './lib/merge-staging-core.mjs';
import { http as defaultHttp } from './lib/http.mjs';
import {
  resolveDeadline,
  splitLocations,
  anyLocationAllowed,
  cleanId,
} from './lib/listing-fields.mjs';
import {
  HISTORY_COLUMNS,
  parseHistoryFile,
  upgradeColumns,
  buildHistoryRow,
  getCell,
  setCells,
} from './lib/scan-history.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'user/portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const AUDIT_STATE_PATH = 'data/filter-audit-state.json';

const AUDIT_REPORT_INTERVAL_DAYS = 30; // how often to print the full keyword health report

const CONCURRENCY = 10;
// Workday's list endpoint carries no absolute date, deadline or full location
// list, so each NEW (post-filter, post-dedup) Workday offer gets one detail
// request. Capped per scan; a failed detail fetch just leaves the fields empty.
const WORKDAY_DETAIL_LIMIT = 60;
const WORKDAY_DETAIL_CONCURRENCY = 5;

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
// Each parser carries, per posting, everything the ATS payload gives us beyond
// title/url/location:
//   postedDate  the TRUE posting/update date (scan-core.parsePostingDate
//               normalizes the varied shapes; missing/odd → null, fail-open to
//               the scan date) — also what the relevance ranking's freshness
//               uses;
//   deadline    the application deadline, ONLY when the source states one as an
//               ISO date (structured field, or an explicit "apply by
//               YYYY-MM-DD" in the JD body) — anything else is null, never
//               guessed (listing-fields.mjs › parseDeadline);
//   postingId   the ATS-native posting id (identity, together with the source);
//   reqId       the requisition id (a label — never an identity on its own);
//   location + extraLocations   the primary location string and any further
//               locations the payload lists; main() splits them into the
//               separate `locations` list.

/** Greenhouse custom `metadata` entries whose name says "deadline"/"closing". */
function greenhouseMetaDeadline(meta) {
  if (!Array.isArray(meta)) return [];
  return meta
    .filter(m => /deadline|closing|close date|apply by/i.test(String(m?.name || '')))
    .map(m => m?.value);
}

export function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedDate: j.first_published || j.updated_at || null,
    deadline: resolveDeadline([j.application_deadline, ...greenhouseMetaDeadline(j.metadata)], j.content),
    postingId: cleanId(j.id),
    reqId: cleanId(j.requisition_id),
  }));
}

export function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    extraLocations: (j.secondaryLocations || []).map(l => l?.location).filter(Boolean),
    postedDate: j.publishedAt || j.updatedAt || null,
    deadline: resolveDeadline([], j.descriptionPlain || j.descriptionHtml),
    postingId: cleanId(j.id),
    reqId: cleanId(j.requisitionId),
  }));
}

export function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    extraLocations: Array.isArray(j.categories?.allLocations) ? j.categories.allLocations : [],
    postedDate: j.createdAt ?? null, // epoch ms
    deadline: resolveDeadline([], [j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n')),
    postingId: cleanId(j.id),
    reqId: '',
  }));
}

export function parseSmartRecruiters(jobs, companyName, brandFilter) {
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
    // SmartRecruiters has no standard deadline field; some tenants add a custom
    // one ("Application deadline", "Closing date") with an ISO value.
    deadline: resolveDeadline(
      (j.customField || [])
        .filter(f => /deadline|closing|close date|apply by/i.test(String(f?.fieldLabel || '')))
        .map(f => f?.valueLabel ?? f?.valueId),
    ),
    postingId: cleanId(j.id),
    reqId: cleanId(j.refNumber),
  }));
}

export function parseWorkday(json, companyName, baseUrl) {
  const jobs = json.jobPostings || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: baseUrl && j.externalPath ? `${baseUrl}${j.externalPath}` : j.externalPath || '',
    company: companyName,
    location: j.locationsText || '',
    // Workday's list endpoint exposes only a relative "Posted Today / 30+ Days
    // Ago" string — too lossy to trust. The absolute date, deadline and full
    // location list come from the per-posting detail call (enrichWorkday).
    postedDate: null,
    deadline: null,
    postingId: '',
    // bulletFields[0] is the requisition id ("R-1042"); the path's trailing
    // `_R-1042` is the fallback.
    reqId: cleanId(j.bulletFields?.[0]) || cleanId(/_([A-Za-z0-9-]+)$/.exec(j.externalPath || '')?.[1]),
    _workdayPath: j.externalPath || '',
  }));
}

/**
 * Merge a Workday per-posting detail payload into an offer. Pure; the caller
 * does the fetch. `startDate` is the absolute posting date, `endDate` (when a
 * tenant sets it) the application end date; the JD body may also state one.
 */
export function applyWorkdayDetail(offer, detail) {
  const info = detail?.jobPostingInfo;
  if (!info) return offer;
  return {
    ...offer,
    postedDate: info.startDate || offer.postedDate,
    deadline: resolveDeadline([info.endDate], info.jobDescription) || offer.deadline,
    postingId: cleanId(info.jobPostingId || info.id) || offer.postingId,
    reqId: cleanId(info.jobReqId) || offer.reqId,
    location: info.location || offer.location,
    extraLocations: Array.isArray(info.additionalLocations) ? info.additionalLocations : offer.extraLocations,
  };
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch (all through lib/http.mjs: https + ATS host allowlist, no redirects,
// private-address guard, timeout, retry with jitter, bounded body) ─────────

// ── Workday paginated fetch ────────────────────────────────────────

// Workday reports `total` on the first page only; later pages carry
// `total: 0`, so the count is remembered from the first page that states it.
// Without one (a tenant that never says), paging continues until an empty
// page, capped by WORKDAY_MAX_OFFSET.
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_OFFSET = 3000;

export async function fetchWorkdayJobs(client, apiUrl, companyName, baseUrl) {
  const allJobs = [];
  let offset = 0;
  let total = null;
  while (true) {
    const json = await client.postJson(apiUrl, {
      appliedFacets: {},
      limit: WORKDAY_PAGE,
      offset,
      searchText: '',
    }, { type: 'workday' });
    const jobs = parseWorkday(json, companyName, baseUrl);
    allJobs.push(...jobs);
    if (total === null && Number(json.total) > 0) total = Number(json.total);
    offset += WORKDAY_PAGE;
    if (jobs.length === 0 || offset > WORKDAY_MAX_OFFSET) break;
    if (total !== null && allJobs.length >= total) break;
  }
  return allJobs;
}

/**
 * One detail request per NEW Workday offer (capped), to learn the absolute
 * posting date, deadline, posting id and the full location list. Fail-open: a
 * failed request leaves that offer as the list endpoint described it.
 */
async function enrichWorkday(client, offers, apiUrl) {
  const listSuffix = /\/jobs$/;
  if (!listSuffix.test(apiUrl)) return offers;
  const base = apiUrl.replace(listSuffix, '');
  const todo = offers.filter(o => o._workdayPath).slice(0, WORKDAY_DETAIL_LIMIT);
  const byUrl = new Map();
  await parallelFetch(todo.map(o => async () => {
    try {
      const detail = await client.getJson(`${base}${o._workdayPath}`, { type: 'workday', retries: 1 });
      byUrl.set(o.url, applyWorkdayDetail(o, detail));
    } catch { /* fail-open */ }
  }), WORKDAY_DETAIL_CONCURRENCY);
  return offers.map(o => byUrl.get(o.url) || o);
}

// ── SmartRecruiters paginated fetch ─────────────────────────────────

async function fetchSmartRecruitersJobs(client, baseUrl, companyName, brandFilter) {
  const allJobs = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const json = await client.getJson(`${baseUrl}?limit=${limit}&offset=${offset}`, { type: 'smartrecruiters' });
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

/**
 * Load scan-history.tsv into memory.
 * Returns { columns, rows: string[], urlToIndex: Map<canonicalUrl, rowIndex>,
 *           idToIndex: Map<portal:postingId, rowIndex> }
 * `columns` is the file's own header (old 8-column files included); rows are
 * the data lines (no header), ready to be mutated and re-saved.
 *
 * URLs are keyed under their CANONICAL form (canonicalizeUrl) so a re-seen
 * posting whose URL only differs by a tracking param / redirect wrapper maps
 * back onto the existing row — the same canonical space the dedup pass uses.
 */
function loadHistory() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    return { columns: [...HISTORY_COLUMNS], rows: [], urlToIndex: new Map(), idToIndex: new Map() };
  }

  const { columns, rows } = parseHistoryFile(readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
  const urlToIndex = new Map();
  const idToIndex = new Map();
  rows.forEach((line, i) => {
    const url = line.split('\t')[0];
    if (url) urlToIndex.set(canonicalizeUrl(url), i);
    const idKey = postingIdKey(getCell(line, columns, 'portal'), getCell(line, columns, 'posting_id'));
    if (idKey) idToIndex.set(idKey, i);
  });

  return { columns, rows, urlToIndex, idToIndex };
}

/**
 * Rewrite the entire scan-history.tsv from in-memory rows. The header is
 * upgraded in place (known columns the file lacked are appended; existing
 * order and unknown columns are kept), so an old 8-column file becomes the
 * wide schema on its first write and old rows just have empty trailing cells.
 */
function saveHistory(columns, rows) {
  const content = upgradeColumns(columns).join('\t') + '\n' + rows.join('\n') + (rows.length > 0 ? '\n' : '');
  writeFileSync(SCAN_HISTORY_PATH, content, 'utf-8');
}

/**
 * For listings already in scan-history, append today's date to their
 * scan_dates column and back-fill any date/id/location cell the old row lacks
 * from the freshly fetched posting (never overwriting a value already there).
 * Handles old rows that may not yet have the scan_dates column.
 */
function updateScanDates(rows, columns, reseen, date) {
  const scanIdx = columns.indexOf('scan_dates');
  for (const [idx, job] of reseen) {
    let row = rows[idx];
    const cols = row.split('\t');
    if (cols.length <= scanIdx) {
      // Migrate old row (pre-location schema): pad up to scan_dates, then set it
      while (cols.length < scanIdx) cols.push('');
      cols.push(date);
    } else {
      const existing = cols[scanIdx] || '';
      if (!existing.split('|').includes(date)) {
        cols[scanIdx] = existing ? `${existing}|${date}` : date;
      }
    }
    row = cols.join('\t');
    const fill = {
      posted_date: parsePostingDate(job.postedDate) || '',
      deadline: job.deadline || '',
      posting_id: job.postingId || '',
      req_id: job.reqId || '',
      locations: (job.locations || []).join('|'),
    };
    const patch = {};
    for (const [name, value] of Object.entries(fill)) {
      if (value && !getCell(row, columns, name)) patch[name] = value;
    }
    rows[idx] = Object.keys(patch).length ? setCells(row, columns, patch) : row;
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
function addToHistory(history, offers, date) {
  const columns = upgradeColumns(history.columns);
  for (const o of offers) {
    history.urlToIndex.set(canonicalizeUrl(o.url), history.rows.length);
    const idKey = postingIdKey(o.source, o.postingId);
    if (idKey) history.idToIndex.set(idKey, history.rows.length);
    history.rows.push(buildHistoryRow({
      ...o,
      postedDate: parsePostingDate(o.postedDate) || '',
    }, date, columns));
  }
  history.columns = columns;
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

/**
 * Run one scan. Exported so tests can drive it with a fake HTTP client in a
 * temp working directory; the CLI entry at the bottom just calls it.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] CLI args (`--dry-run`, `--company <name>`)
 * @param {ReturnType<typeof import('./lib/http.mjs').createHttp>} [opts.http] transport
 * @param {(line:string)=>void} [opts.log] stdout sink (default console.log)
 * @returns {Promise<{rankedOffers: object[], errors: object[], dryRun: boolean}>}
 */
export async function runScan({ argv = process.argv.slice(2), http: client = defaultHttp, log = console.log } = {}) {
  const args = argv;
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
    throw new Error('user/portals.yml not found. Run onboarding first.');
  }
  // Ensure required directories exist (fresh setup) — never on a dry run.
  if (!dryRun) mkdirSync('data', { recursive: true });

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter, auditStats);
  const langFilter = buildLangFilter(config);
  // Optional user override; falls back to the generic EU/UK allowlist.
  const locationFilter = buildLocationFilter(config.location_allowlist);
  // Names the location splitter may treat as separate places in a bare
  // "CityA, CityB" string: the effective allowlist (user's or the default).
  const userAllowlist = Array.isArray(config.location_allowlist) ? config.location_allowlist.filter(Boolean) : [];
  const knownPlaces = userAllowlist.length ? userAllowlist : DEFAULT_LOCATION_ALLOWLIST;

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) log('(dry run — no files will be written)\n');

  // 3. Load dedup sets — seeded through the SAME canonical primitives the
  //    JobSpy merge path uses (canonicalizeUrl + companyRoleKey), so a re-seen
  //    posting whose URL only differs by a tracking param, or a `(m/f/d)` /
  //    trailing-location title variant of a role already in scan-history,
  //    collapses onto the existing entry instead of re-entering the pipeline.
  const history = loadHistory();
  const { seenUrls, seenKeys, seenIds } = seedScanSeen({
    urls: loadSeenUrls(),                       // pipeline.md + applications.md URLs
    historyRows: history.rows,                  // scan-history URLs + (company, role) keys + posting ids
    historyColumns: history.columns,
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
  const reseen = new Map();     // history row index → fresh posting (scan_dates bump + back-fill)
  const batchByKey = new Map(); // (company, role) key → offer kept this run (for location union)
  const errors = [];

  /** A listing's separate locations: its primary string plus any extras the ATS listed. */
  const withLocations = (job) => ({
    ...job,
    locations: splitLocations([job.location, ...(job.extraLocations || [])], { knownPlaces }),
  });
  /**
   * Location gate: kept when ANY of the listing's locations is allowed, so a
   * role open in several cities stays if one of them is a target. (A source
   * string the splitter reduced to nothing falls back to the raw string.)
   */
  const locationOk = (job) =>
    job.locations.length === 0 && job.location
      ? locationFilter(job.location)
      : anyLocationAllowed(job.locations, locationFilter);

  const tasks = targets.map(company => async () => {
    const { type, url, brandFilter, baseUrl } = company._api;
    const startedAt = Date.now();
    log(`→ ${company.name} (${type})`);
    let kept = 0;
    try {
      let jobs;
      if (type === 'workday') {
        jobs = await fetchWorkdayJobs(client, url, company.name, baseUrl);
      } else if (type === 'smartrecruiters') {
        jobs = await fetchSmartRecruitersJobs(client, url, company.name, brandFilter);
      } else {
        const json = await client.getJson(url, { type });
        jobs = PARSERS[type](json, company.name);
      }
      totalFound += jobs.length;
      const source = `${type}-api`;

      // Phase 1 — title / language, then READ-ONLY canonical dedup. Known
      // postings are final here (re-seen → scan_dates bump + back-fill); the
      // rest are candidates.
      const candidates = [];
      for (const raw of jobs) {
        if (!titleFilter(raw.title)) {
          totalFiltered++;
          continue;
        }
        if (!langFilter(raw.title)) {
          totalLangFiltered++;
          continue;
        }
        const job = withLocations({ ...raw, source });
        // Canonical dedup: exact (canonical) URL first, then the ATS posting id,
        // then normalized (company, role). Mirrors mergeHistory's precedence so
        // the live scanner and the merge path agree on "already seen".
        const { decision, canonicalUrl, idKey } = classifyScanOffer(job, { seenUrls, seenKeys, seenIds });
        if (decision === 'duplicate-url' || decision === 'duplicate-id') {
          totalDupes++;
          // Bump scan_dates only when the posting is a known scan-history row
          // (not a pipeline/apps-only URL we don't own).
          const idx = history.urlToIndex.get(canonicalUrl) ?? (idKey ? history.idToIndex.get(idKey) : undefined);
          if (idx !== undefined) {
            reseen.set(idx, job);
            totalReseen++;
          }
          continue;
        }
        if (decision === 'duplicate-role') {
          totalDupes++;
          continue;
        }
        candidates.push(job);
      }

      // Workday: the list gives neither date nor deadline nor the real location
      // list, so enrich the survivors (capped) before the location gate.
      const enriched = type === 'workday'
        ? (await enrichWorkday(client, candidates, url)).map(withLocations)
        : candidates;

      // Phase 2 — location gate, then claim the dedup keys (intra-scan dupes
      // among this company's candidates are caught here).
      for (const job of enriched) {
        if (!locationOk(job)) {
          totalLocationFiltered++;
          continue;
        }
        const { decision, canonicalUrl, key, idKey } = classifyScanOffer(job, { seenUrls, seenKeys, seenIds });
        if (decision !== 'new') {
          totalDupes++;
          // The same role listed again for another city in this very run:
          // fold the extra cities into the offer we kept instead of dropping them.
          if (decision === 'duplicate-role' && batchByKey.has(key)) {
            const kept0 = batchByKey.get(key);
            kept0.locations = splitLocations([...kept0.locations, ...job.locations], { knownPlaces });
          }
          continue;
        }
        seenUrls.add(canonicalUrl);
        if (idKey) seenIds.add(idKey);
        if (key) seenKeys.add(key);
        const { _workdayPath, ...offer } = job;
        newOffers.push(offer);
        if (key) batchByKey.set(key, offer);
        kept++;
      }
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✓ ${company.name} · ${jobs.length} jobs · ${kept} kept (${took}s)`);
    } catch (err) {
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✗ ${company.name} · ${err.message} (${took}s)`);
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
      addToHistory(history, rankedOffers, date);
    }
    if (reseen.size > 0) {
      updateScanDates(history.rows, history.columns, reseen, date);
    }
    if (newOffers.length > 0 || reseen.size > 0) {
      saveHistory(history.columns, history.rows);
    }
  }

  // 6. Print summary
  log(`\n${'━'.repeat(45)}`);
  log(`Portal Scan — ${date}`);
  log(`${'━'.repeat(45)}`);
  log(`Companies scanned:     ${targets.length}`);
  log(`Total jobs found:      ${totalFound}`);
  log(`Filtered by title:     ${totalFiltered} removed`);
  log(`Filtered by language:  ${totalLangFiltered} removed`);
  log(`Filtered by location:  ${totalLocationFiltered} removed`);
  log(`Duplicates:            ${totalDupes} skipped (${totalReseen} still open → scan_dates updated)`);
  log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (rankedOffers.length > 0) {
    log('\nNew offers (ranked by relevance, best first):');
    for (const o of rankedOffers) {
      const score = o.relevance ? o.relevance.score.toFixed(1).padStart(4) : ' n/a';
      log(`  [${score}] ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      log('\n(dry run — run without --dry-run to save results)');
    } else {
      log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  log(`\n→ Run /career-ops pipeline to evaluate new offers.`);

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
    log(`\n${'─'.repeat(50)}`);
    log(overFilter
      ? `⚠  FILTER HEALTH — Over-filter detected`
      : `Filter health check (monthly)`);
    log(`${'─'.repeat(50)}`);
    log(`Pass rate: ${passRate.toFixed(1)}%  (${passCount} of ${totalFound} postings)`);

    const topBlockers = sortedHits.filter(([, c]) => c > 0).slice(0, 5);
    if (topBlockers.length > 0) {
      log(`Top blockers:`);
      for (const [keyword, count] of topBlockers) {
        const pct = totalFiltered > 0 ? (count / totalFiltered * 100).toFixed(0) : '0';
        log(`  "${keyword}" — ${count} blocked (${pct}%)`);
      }
    }

    if (zeroHitKeywords.length > 0) {
      log(`Zero-hit keywords this scan (${zeroHitKeywords.length} — possible dead weight):`);
      log(`  ${zeroHitKeywords.slice(0, 8).map(k => `"${k}"`).join(', ')}`);
    }

    if (overFilter) {
      log(`\n→ Filters may be too aggressive. Review top blockers above.`);
      log(`  Use /career-ops to ask Claude for removal suggestions.`);
    }

    // Save last report date
    if (!dryRun) {
      try {
        writeFileSync(AUDIT_STATE_PATH, JSON.stringify({ lastReportDate: date }, null, 2), 'utf-8');
      } catch { /* non-fatal */ }
    }
  }

  return { rankedOffers, errors, dryRun };
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScan().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
