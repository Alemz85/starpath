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
 * Providers: each ATS lives in scripts/providers/*.mjs (detect / fetch / optional
 * enrich / optional dedupKey; contract in lib/provider-registry.mjs). Adding an
 * ATS is adding a file there; a malformed provider is skipped, never fatal.
 *
 * Admission: every posting passes ONE gate (lib/admission-gate.mjs) — optional
 * data/blacklist.md → title → language → location → seen-set — the same gate
 * merge-scan-staging.mjs uses for JobSpy rows.
 *
 * Last scan: a completed run stamps data/last-scan.json (lib/last-scan.mjs), which
 * the weekly scheduled run reads: it fires only when no scan of any kind
 * happened in the last 7 days.
 *
 * Board health: data/portal-health.tsv remembers boards that fail; a board that
 * answers a real 404 on 3 consecutive scans is skipped for 30 days
 * (lib/portal-health.mjs). `--company` always probes.
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
  rankOffers,
  formatRelevanceNote,
  parsePostingDate,
} from './scan-core.mjs';
import {
  canonicalizeUrl,
  seedScanSeen,
  postingIdKey,
} from './lib/merge-staging-core.mjs';
import { http as defaultHttp } from './lib/http.mjs';
import { splitLocations } from './lib/listing-fields.mjs';
import {
  HISTORY_COLUMNS,
  parseHistoryFile,
  upgradeColumns,
  buildHistoryRow,
  getCell,
  setCells,
} from './lib/scan-history.mjs';
import { gateFromPortals } from './lib/admission-gate.mjs';
import { buildLastScan, writeLastScan } from './lib/last-scan.mjs';
import { normalizeJob } from './lib/job.mjs';
import { parallelFetch } from './lib/parallel.mjs';
import {
  loadProviders,
  detectProvider,
  makeProviderCtx,
  jobDedupKey,
  DEFAULT_MAX_PAGES,
} from './lib/provider-registry.mjs';
import {
  parseHealth,
  serializeHealth,
  boardKey,
  shouldSkip,
  recordOutcome,
  longEmptyBoards,
} from './lib/portal-health.mjs';

// The per-ATS parsers moved with their providers; re-exported so existing
// callers (and tests) keep importing them from here.
export { parseGreenhouse } from './providers/greenhouse.mjs';
export { parseAshby } from './providers/ashby.mjs';
export { parseLever } from './providers/lever.mjs';
export { parseSmartRecruiters } from './providers/smartrecruiters.mjs';
export { parseWorkday, applyWorkdayDetail } from './providers/workday.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'user/portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const AUDIT_STATE_PATH = 'data/filter-audit-state.json';
const BLACKLIST_PATH = 'data/blacklist.md';
const HEALTH_PATH = 'data/portal-health.tsv';

const AUDIT_REPORT_INTERVAL_DAYS = 30; // how often to print the full keyword health report

const CONCURRENCY = 10;

// Title / language / location filters live in ./scan-core.mjs and are assembled,
// together with the blacklist and the seen-set, by lib/admission-gate.mjs.
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
 * from the freshly fetched posting (never overwriting a value already there);
 * an `expired` row is revived. Handles old rows that may not yet have the scan_dates column.
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
      posting_id: job.externalId || '',
      req_id: job.requisitionId || '',
      locations: (job.locations || []).join('|'),
    };
    const patch = {};
    for (const [name, value] of Object.entries(fill)) {
      if (value && !getCell(row, columns, name)) patch[name] = value;
    }
    // The posting is on its board again: a row an earlier liveness check (or the
    // unreachable policy) declared dead is live, so revive it.
    if (getCell(row, columns, 'status') === 'expired') {
      Object.assign(patch, { status: 'added', expired_reason: '', fetch_attempts: '', first_unreachable: '', last_error: '' });
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
    const idKey = o.dedupKey || postingIdKey(o.source, o.externalId);
    if (idKey) history.idToIndex.set(idKey, history.rows.length);
    history.rows.push(buildHistoryRow({
      ...o,
      postedDate: parsePostingDate(o.postedDate) || '',
    }, date, columns));
  }
  history.columns = columns;
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
 * @param {string} [opts.providersDir] provider modules directory (default scripts/providers)
 * @param {(ms:number)=>Promise<void>} [opts.sleep] injected into provider ctx
 * @param {number} [opts.maxPages] page ceiling per board (default 150)
 * @param {string} [opts.today] ISO date override (tests)
 * @returns {Promise<{rankedOffers: object[], errors: object[], dryRun: boolean, skippedBoards: object[], blacklisted: number}>}
 */
export async function runScan({
  argv = process.argv.slice(2),
  http: client = defaultHttp,
  log = console.log,
  providersDir,
  sleep,
  maxPages = DEFAULT_MAX_PAGES,
  today,
} = {}) {
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

  const date = today || new Date().toISOString().slice(0, 10);
  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];

  // 2. The providers, then the enabled companies each one claims.
  const { providers } = await loadProviders({ dir: providersDir, log });
  const detected = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ entry: c, hit: detectProvider(c, providers) }));
  const claimed = detected.filter(d => d.hit);
  const skippedCount = companies.filter(c => c.enabled !== false).length - claimed.length;

  // 3. Dedup sets — seeded through the SAME canonical primitives the JobSpy
  //    merge path uses, so a re-seen posting whose URL only differs by a
  //    tracking param, or a `(m/f/d)` / trailing-location title variant of a
  //    role already in scan-history, collapses onto the existing entry instead
  //    of re-entering the pipeline.
  const history = loadHistory();
  const seen = seedScanSeen({
    urls: loadSeenUrls(),                       // pipeline.md + applications.md URLs
    historyRows: history.rows,                  // scan-history URLs + (company, role) keys + posting ids
    historyColumns: history.columns,
    companyRolePairs: loadSeenCompanyRoles(),   // applications.md (company, role) pairs
  });
  // A provider that normalises its identity key does so for history rows too.
  for (const { hit } of claimed) {
    if (typeof hit.provider.dedupKey !== 'function') continue;
    for (const row of history.rows) {
      if (getCell(row, history.columns, 'portal') !== `${hit.provider.id}-api`) continue;
      const id = getCell(row, history.columns, 'posting_id');
      if (id) seen.seenIds.add(jobDedupKey(hit.provider, { externalId: id }, `${hit.provider.id}-api`));
    }
  }

  // The ONE admission gate: blacklist → title → language → location → seen-set.
  const blacklistText = existsSync(BLACKLIST_PATH) ? readFileSync(BLACKLIST_PATH, 'utf-8') : '';
  const gate = gateFromPortals(config, { auditStats, blacklistText, seen });

  // 4. Board health: skip boards that keep answering a real 404.
  const health = existsSync(HEALTH_PATH) ? parseHealth(readFileSync(HEALTH_PATH, 'utf-8')) : new Map();
  const healthBefore = serializeHealth(health);
  const skippedBoards = [];
  let blacklisted = 0;
  const targets = [];
  for (const d of claimed) {
    if (gate.blocksCompany(d.entry.name)) {
      blacklisted++;
      log(`⊘ ${d.entry.name} · blacklisted (${BLACKLIST_PATH}) — not fetched`);
      continue;
    }
    const key = boardKey(d.hit.provider.id, d.hit.api.url);
    const skip = filterCompany ? { skip: false } : shouldSkip(health, key, date);
    if (skip.skip) {
      skippedBoards.push({ company: d.entry.name, until: skip.until, reason: skip.reason });
      log(`⊘ ${d.entry.name} · dead board (${skip.reason}) — skipped until ${skip.until}`);
      continue;
    }
    targets.push({ ...d, key });
  }

  log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) log('(dry run — no files will be written)\n');

  // 5. Fetch all APIs
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLangFiltered = 0;
  let totalLocationFiltered = 0;
  let totalBlacklisted = 0;
  let totalDupes = 0;
  let totalReseen = 0;
  const newOffers = [];
  const reseen = new Map();     // history row index → fresh posting (scan_dates bump + back-fill)
  const batchByKey = new Map(); // (company, role) key → offer kept this run (for location union)
  const errors = [];

  const tasks = targets.map(({ entry: company, hit, key: boardId }) => async () => {
    const { provider, api } = hit;
    const startedAt = Date.now();
    log(`→ ${company.name} (${provider.id})`);
    let kept = 0;
    const ctx = makeProviderCtx(provider, { http: client, api, maxPages, sleep, log });
    const source = `${provider.id}-api`;
    /** Normalise a provider's posting and stamp its source and identity key. */
    const prep = (raw) => {
      const job = normalizeJob(raw, { company: company.name });
      if (!job) return null;
      const stamped = { ...job, source };
      stamped.dedupKey = jobDedupKey(provider, stamped, source);
      return gate.withLocations(stamped);
    };
    try {
      const raw = await provider.fetch(company, ctx);
      const jobs = (Array.isArray(raw) ? raw : []).map(prep).filter(Boolean);
      totalFound += jobs.length;

      // Phase 1 — blacklist / title / language, then READ-ONLY canonical dedup.
      // Known postings are final here (re-seen → scan_dates bump + back-fill);
      // the rest are candidates.
      const candidates = [];
      for (const job of jobs) {
        const s = gate.screen(job);
        if (!s.ok) {
          if (s.stage === 'blacklist') totalBlacklisted++;
          else if (s.stage === 'title') totalFiltered++;
          else totalLangFiltered++;
          continue;
        }
        // Canonical dedup: exact (canonical) URL first, then the ATS posting id,
        // then normalized (company, role).
        const { decision, canonicalUrl, idKey } = gate.classify(job);
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

      // A provider may need a costly per-posting detail call for the real date /
      // location / id (Workday); it only ever runs on the survivors above.
      const enriched = typeof provider.enrich === 'function'
        ? (await provider.enrich(candidates, ctx)).map(prep).filter(Boolean)
        : candidates;

      // Phase 2 — location gate, then claim the dedup keys (intra-scan dupes
      // among this company's candidates are caught here).
      for (const job of enriched) {
        if (!gate.locate(job).ok) {
          totalLocationFiltered++;
          continue;
        }
        const c = gate.classify(job);
        if (c.decision !== 'new') {
          totalDupes++;
          // The same role listed again for another city in this very run:
          // fold the extra cities into the offer we kept instead of dropping them.
          if (c.decision === 'duplicate-role' && batchByKey.has(c.key)) {
            const kept0 = batchByKey.get(c.key);
            kept0.locations = splitLocations([...kept0.locations, ...job.locations], { knownPlaces: gate.knownPlaces });
          }
          continue;
        }
        gate.claim(c);
        const { _workdayPath, ...offer } = job;
        newOffers.push(offer);
        if (c.key) batchByKey.set(c.key, offer);
        kept++;
      }
      recordOutcome(health, {
        board: boardId, company: company.name, provider: provider.id, today: date,
        outcome: jobs.length === 0 ? 'empty' : 'ok',
      });
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✓ ${company.name} · ${jobs.length} jobs · ${kept} kept (${took}s)`);
    } catch (err) {
      const took = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`  ✗ ${company.name} · ${err.message} (${took}s)`);
      errors.push({ company: company.name, error: err.message });
      recordOutcome(health, {
        board: boardId, company: company.name, provider: provider.id, today: date,
        outcome: err.status === 404 ? '404' : 'error', error: err.message,
      });
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
    if (serializeHealth(health) !== healthBefore) {
      writeFileSync(HEALTH_PATH, serializeHealth(health), 'utf-8');
    }
    // The weekly scheduled run counts a scan of any kind (lib/last-scan.mjs); a
    // single-company probe (`--company`) is not a scan of the portal list.
    // Non-fatal: the scan's results are already saved.
    if (!filterCompany) {
      try {
        writeLastScan(buildLastScan({ boards: targets.length, errors: errors.length, added: newOffers.length }));
      } catch (err) {
        log(`  ! could not record the scan time (${err.message})`);
      }
    }
  }

  // 6. Print summary
  log(`\n${'━'.repeat(45)}`);
  log(`Portal Scan — ${date}`);
  log(`${'━'.repeat(45)}`);
  log(`Companies scanned:     ${targets.length}`);
  log(`Total jobs found:      ${totalFound}`);
  if (blacklisted > 0 || totalBlacklisted > 0) {
    log(`Blacklisted:           ${blacklisted} companies not fetched, ${totalBlacklisted} postings removed`);
  }
  log(`Filtered by title:     ${totalFiltered} removed`);
  log(`Filtered by language:  ${totalLangFiltered} removed`);
  log(`Filtered by location:  ${totalLocationFiltered} removed`);
  log(`Duplicates:            ${totalDupes} skipped (${totalReseen} still open → scan_dates updated)`);
  log(`New offers added:      ${newOffers.length}`);

  if (skippedBoards.length > 0) {
    log(`Dead boards skipped:   ${skippedBoards.length} (${skippedBoards.map(b => `${b.company} until ${b.until}`).join(', ')})`);
  }
  for (const b of longEmptyBoards(health)) {
    log(`⚠  ${b.company}: board returned no postings on ${b.consecutive_empty} scans in a row — has the careers page moved?`);
  }

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

  const passCount = totalFound - totalFiltered - totalLangFiltered - totalLocationFiltered - totalBlacklisted;
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

  return { rankedOffers, errors, dryRun, skippedBoards, blacklisted };
}

// CLI entry (skipped when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScan().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
