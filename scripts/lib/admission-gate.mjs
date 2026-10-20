/**
 * admission-gate.mjs — the one place that decides whether a scanned posting may
 * enter the pipeline.
 *
 * Every writer used to carry its own copy of the filter chain and kept parity
 * with the others by hand: scan.mjs ran title → language → dedup → location,
 * the JobSpy scraper ran its own Python copy, and the merge ran dedup only. The
 * gate assembles the chain ONCE, from user/portals.yml:
 *
 *   blacklist → title → language → location → seen-set
 *
 * and scan.mjs, merge-scan-staging.mjs and any future writer call it.
 *
 * Stages (a job is rejected at the first stage that says no):
 *   blacklist   company or URL domain on data/blacklist.md (opt-in, hand-edited)
 *   title       positive/negative keyword filter (scan-core.buildTitleFilter)
 *   language    lang_blocklist
 *   location    kept when ANY of the job's locations is allowed
 *   seen        canonical URL → ATS posting id → normalized (company, role)
 *
 * `admit()` runs the whole chain in that order; `prefilter()` is everything but
 * the seen-set (the JobSpy merge runs its own dedup after it). scan.mjs uses the same stage
 * functions staged — `screen` (blacklist/title/language), `classify` (seen,
 * read-only), then `locate` and `claim` — because a Workday posting's real
 * location only arrives with a per-posting detail request, which is worth
 * making only for postings that are not already known. The stages themselves
 * are shared, so the verdict for a given posting is the same either way
 * (pinned by admission-gate.test.mjs).
 *
 * Pure: no IO. `loadGateConfig` does the reads and hands the pieces in.
 */

import { normalizeCompany } from './dedup-index.mjs';
import {
  buildTitleFilter,
  buildLangFilter,
  buildLocationFilter,
  DEFAULT_LOCATION_ALLOWLIST,
} from '../scan-core.mjs';
import { classifyScanOffer } from './merge-staging-core.mjs';
import { splitLocations, anyLocationAllowed } from './listing-fields.mjs';

// ── Blacklist ───────────────────────────────────────────────────────────────

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Parse data/blacklist.md. Only list items count (`- …` / `* …`); headings and
 * prose are the user's notes. An item is `company: Name`, `domain: host`, or a
 * bare value (a host-looking one is a domain, anything else a company). A
 * trailing ` # comment` is dropped.
 *
 * @param {string} text
 * @returns {{companies: Set<string>, domains: string[], count: number}}
 */
export function parseBlacklist(text) {
  const companies = new Set();
  const domains = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    let value = m[1].replace(/\s+#.*$/, '').trim();
    let kind = '';
    const p = /^(company|domain)\s*:\s*(.*)$/i.exec(value);
    if (p) { kind = p[1].toLowerCase(); value = p[2].trim(); }
    if (!value) continue;
    if (!kind) kind = DOMAIN_RE.test(value) || /^https?:\/\//i.test(value) ? 'domain' : 'company';
    if (kind === 'domain') {
      const host = value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
      if (DOMAIN_RE.test(host)) domains.push(host);
    } else {
      const key = normalizeCompany(value);
      if (key) companies.add(key);
    }
  }
  return { companies, domains, count: companies.size + domains.length };
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Why a job is blacklisted ('' when it is not). */
export function blacklistReason(blacklist, { company, url }) {
  if (!blacklist || blacklist.count === 0) return '';
  const key = normalizeCompany(company || '');
  if (key && blacklist.companies.has(key)) return `company "${company}"`;
  const host = hostOf(url);
  if (host) {
    const d = blacklist.domains.find((x) => host === x || host.endsWith(`.${x}`));
    if (d) return `domain ${d}`;
  }
  return '';
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {(title:string)=>boolean} [opts.titleFilter]    true = keep
 * @param {(title:string)=>boolean} [opts.langFilter]     true = keep
 * @param {(location:string)=>boolean} [opts.locationFilter] true = keep
 * @param {string[]} [opts.knownPlaces] names the location splitter may treat as separate places
 * @param {ReturnType<typeof parseBlacklist>} [opts.blacklist]
 * @param {{seenUrls:Set<string>, seenKeys:Set<string>, seenIds?:Set<string>}} [opts.seen]
 */
export function createAdmissionGate({
  titleFilter = () => true,
  langFilter = () => true,
  locationFilter = () => true,
  knownPlaces = [],
  blacklist = null,
  seen = { seenUrls: new Set(), seenKeys: new Set(), seenIds: new Set() },
} = {}) {
  const seenSets = { seenUrls: seen.seenUrls, seenKeys: seen.seenKeys, seenIds: seen.seenIds || new Set() };
  const stats = { blacklist: 0, title: 0, language: 0, location: 0, duplicate: 0, admitted: 0 };

  /**
   * A job's separate locations: its primary string plus any extras the source
   * listed, split into single places. Always recomputed from those strings
   * (a Workday posting changes them after its detail fetch); a job that carries
   * only a ready `locations` list keeps it.
   */
  const withLocations = (job) => {
    const split = splitLocations([job.location, ...(job.extraLocations || [])].filter(Boolean), { knownPlaces });
    return { ...job, locations: split.length ? split : (job.locations || []) };
  };

  /** blacklist → title → language. */
  function screen(job) {
    const why = blacklistReason(blacklist, job);
    if (why) { stats.blacklist++; return { ok: false, stage: 'blacklist', reason: why }; }
    if (!titleFilter(job.title)) { stats.title++; return { ok: false, stage: 'title' }; }
    if (!langFilter(job.title)) { stats.language++; return { ok: false, stage: 'language' }; }
    return { ok: true };
  }

  /**
   * Location gate: kept when ANY of the job's locations is allowed. A source
   * string the splitter reduced to nothing falls back to the raw string.
   */
  function locate(job) {
    const j = withLocations(job);
    const ok = j.locations.length === 0 && j.location
      ? locationFilter(j.location)
      : anyLocationAllowed(j.locations, locationFilter);
    if (!ok) { stats.location++; return { ok: false, stage: 'location' }; }
    return { ok: true };
  }

  /** blacklist → title → language → location: everything but the seen-set. */
  function prefilter(job) {
    const j = withLocations(job);
    const s = screen(j);
    return s.ok ? locate(j) : s;
  }

  /** Seen-set verdict, read-only: canonical URL → posting id → (company, role). */
  function classify(job) {
    return classifyScanOffer(job, seenSets);
  }

  /** Claim a 'new' job's keys so later jobs in the same run dedup against it. */
  function claim(c) {
    if (c.canonicalUrl) seenSets.seenUrls.add(c.canonicalUrl);
    if (c.idKey) seenSets.seenIds.add(c.idKey);
    if (c.key) seenSets.seenKeys.add(c.key);
  }

  /**
   * The whole chain in order: blacklist → title → language → location → seen.
   * On success the job's keys are claimed. `classification` is returned for
   * every verdict that reached the seen stage (re-seen bookkeeping needs it).
   */
  function admit(job) {
    const j = withLocations(job);
    const pre = prefilter(j);
    if (!pre.ok) return { ...pre, job: j };
    const c = classify(j);
    if (c.decision !== 'new') { stats.duplicate++; return { ok: false, stage: 'seen', decision: c.decision, classification: c, job: j }; }
    claim(c);
    stats.admitted++;
    return { ok: true, stage: 'admitted', classification: c, job: j };
  }

  return {
    withLocations,
    screen,
    locate,
    prefilter,
    classify,
    claim,
    admit,
    /** Is this company blacklisted outright? (lets a scan skip the board request) */
    knownPlaces,
    blocksCompany: (company) => Boolean(blacklistReason(blacklist, { company, url: '' })),
    seen: seenSets,
    stats,
  };
}

/**
 * Build the filter half of the gate from a parsed user/portals.yml, the way
 * every caller must (so they cannot drift): title keywords, language
 * blocklist, location allowlist, and the places the location splitter knows.
 *
 * @param {object} portals parsed portals.yml ({} when absent)
 * @param {{auditStats?: object, blacklistText?: string, seen?: object}} [extra]
 */
export function gateFromPortals(portals, { auditStats, blacklistText = '', seen } = {}) {
  const cfg = portals || {};
  const userAllowlist = Array.isArray(cfg.location_allowlist) ? cfg.location_allowlist.filter(Boolean) : [];
  return createAdmissionGate({
    titleFilter: buildTitleFilter(cfg.title_filter, auditStats),
    langFilter: buildLangFilter(cfg),
    // Optional user override; falls back to the generic EU/UK allowlist.
    locationFilter: buildLocationFilter(cfg.location_allowlist),
    knownPlaces: userAllowlist.length ? userAllowlist : DEFAULT_LOCATION_ALLOWLIST,
    blacklist: parseBlacklist(blacklistText),
    seen,
  });
}
