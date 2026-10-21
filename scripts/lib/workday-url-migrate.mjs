/**
 * workday-url-migrate.mjs — rewrite the Workday links older scans stored.
 *
 * Until the Workday provider learned the career-site segment, a posting was
 * stored as `https://{tenant}.wdN.myworkdayjobs.com/job/…`, which 404s as a
 * page (the real one is `…/{site}/job/…`). This module adds the site back to
 * the rows in data/scan-history.tsv and data/pipeline.md.
 *
 * Identity does not change: canonicalizeUrl (merge-staging-core) drops the
 * site segment, so a rewritten row and its old form are the same posting and
 * an already-seen job never comes back as new. The ATS posting id column is
 * untouched.
 *
 * The site comes from the user's own portals.yml: the row's company first (a
 * tenant can run several career sites), else the host's only known site. A row
 * whose site cannot be told is left as it is and counted, never guessed.
 *
 * Pure (strings in, strings out); the CLI is scripts/migrate-workday-urls.mjs.
 */

import { workdaySiteOf } from '../providers/workday.mjs';
import { parseHistoryFile, getCell, setCells } from './scan-history.mjs';

const SITELESS_RE = /^(https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)(\/job\/[^\s|]+)$/i;

/** Is this a stored Workday URL with no site segment? */
export function isSitelessWorkdayUrl(url) {
  return SITELESS_RE.test(String(url ?? '').trim());
}

/**
 * Build the site resolver from a parsed portals.yml.
 * @returns {(url:string, company?:string|string[]) => string|null} the site, or null when unknown/ambiguous
 * (`company` may be several candidate names, e.g. every field of a pipeline line)
 */
export function makeSiteResolver(config) {
  const byHostCompany = new Map();
  const byHost = new Map();
  for (const entry of config?.tracked_companies || []) {
    const t = workdaySiteOf(entry);
    if (!t) continue;
    byHostCompany.set(`${t.host}\t${String(entry.name ?? '').trim().toLowerCase()}`, t.site);
    if (!byHost.has(t.host)) byHost.set(t.host, new Set());
    byHost.get(t.host).add(t.site);
  }
  return (url, company = '') => {
    const m = SITELESS_RE.exec(String(url ?? '').trim());
    if (!m) return null;
    const host = new URL(m[1]).hostname.toLowerCase();
    for (const name of [].concat(company)) {
      const named = byHostCompany.get(`${host}\t${String(name).trim().toLowerCase()}`);
      if (named) return named;
    }
    const sites = byHost.get(host);
    return sites && sites.size === 1 ? [...sites][0] : null;
  };
}

/** `https://h/job/…` + site → `https://h/{site}/job/…`. */
export function addSite(url, site) {
  const m = SITELESS_RE.exec(String(url).trim());
  return m ? `${m[1]}/${site}${m[2]}` : url;
}

const emptyStats = () => ({ rewritten: 0, unresolved: 0 });

/** Rewrite the `url` cell of a scan-history.tsv text. */
export function migrateHistoryText(text, resolve) {
  const stats = emptyStats();
  if (!String(text ?? '').trim()) return { text, ...stats };
  const { columns, rows } = parseHistoryFile(text);
  const hasHeader = String(text).split('\n')[0].split('\t')[0] === 'url';
  const out = rows.map((row) => {
    const url = getCell(row, columns, 'url');
    if (!isSitelessWorkdayUrl(url)) return row;
    const site = resolve(url, getCell(row, columns, 'company'));
    if (!site) { stats.unresolved++; return row; }
    stats.rewritten++;
    return setCells(row, columns, { url: addSite(url, site) });
  });
  if (!stats.rewritten) return { text, ...stats };
  const head = hasHeader ? `${columns.join('\t')}\n` : '';
  return { text: `${head}${out.join('\n')}\n`, ...stats };
}

const URL_IN_LINE_RE = /https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/job\/[^\s|]+/gi;

/**
 * Rewrite the Workday URLs on pipeline.md entry lines. That is the pending
 * `- [ ] URL | Company | Title` form and the processed forms
 * (`- [x] #13 | URL | Company | …`, `- [!] FILTERED | Company | URL| …`): any
 * `- [` line, any field. The line's other fields serve as company candidates.
 */
export function migratePipelineText(text, resolve) {
  const stats = emptyStats();
  const lines = String(text ?? '').split('\n').map((line) => {
    if (!line.startsWith('- [') || !URL_IN_LINE_RE.test(line)) return line;
    URL_IN_LINE_RE.lastIndex = 0;
    const fields = line.split('|').map((f) => f.trim());
    return line.replace(URL_IN_LINE_RE, (url) => {
      const site = resolve(url, fields);
      if (!site) { stats.unresolved++; return url; }
      stats.rewritten++;
      return addSite(url, site);
    });
  });
  return { text: stats.rewritten ? lines.join('\n') : text, ...stats };
}
