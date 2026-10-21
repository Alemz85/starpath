/**
 * workday — {tenant}.wd{n}.myworkdayjobs.com CXS API (POST search, paginated).
 *
 * The list endpoint carries no absolute date, deadline, posting id or full
 * location list, so `enrich` makes one detail request per job that SURVIVED
 * title/language/dedup (capped per scan); a failed detail request leaves that
 * job as the list described it.
 */
import { resolveDeadline, cleanId } from '../lib/listing-fields.mjs';

const PAGE_LIMIT = 20;
// Per scan, per board. A failed detail fetch just leaves the fields empty.
export const DETAIL_LIMIT = 60;
const DETAIL_CONCURRENCY = 5;

/**
 * The page URL of a posting: `{baseUrl}/{site}{externalPath}` (externalPath is
 * `/job/…`). Without a site it falls back to the siteless form older scans
 * stored, which 404s as a page but still identifies the posting.
 */
export function workdayJobUrl(baseUrl, site, externalPath) {
  if (!externalPath) return '';
  if (!baseUrl) return externalPath;
  return `${baseUrl}${site ? `/${site}` : ''}${externalPath}`;
}

export function parseWorkday(json, companyName, baseUrl, site = '') {
  const jobs = json?.jobPostings || [];
  return jobs.map((j) => ({
    title: j.title || '',
    url: workdayJobUrl(baseUrl, site, j.externalPath),
    company: companyName,
    location: j.locationsText || '',
    // Workday's list endpoint exposes only a relative "Posted Today / 30+ Days
    // Ago" string — too lossy to trust. The absolute date, deadline and full
    // location list come from the per-posting detail call (enrich).
    postedDate: null,
    deadline: null,
    externalId: '',
    // bulletFields[0] is the requisition id ("R-1042"); the path's trailing
    // `_R-1042` is the fallback.
    requisitionId: cleanId(j.bulletFields?.[0]) || cleanId(/_([A-Za-z0-9-]+)$/.exec(j.externalPath || '')?.[1]),
    _workdayPath: j.externalPath || '',
  }));
}

/**
 * Merge a Workday per-posting detail payload into a job. Pure; the caller does
 * the fetch. `startDate` is the absolute posting date, `endDate` (when a tenant
 * sets it) the application end date; the JD body may also state one.
 */
export function applyWorkdayDetail(job, detail) {
  const info = detail?.jobPostingInfo;
  if (!info) return job;
  return {
    ...job,
    postedDate: info.startDate || job.postedDate,
    deadline: resolveDeadline([info.endDate], info.jobDescription) || job.deadline,
    externalId: cleanId(info.jobPostingId || info.id) || job.externalId,
    requisitionId: cleanId(info.jobReqId) || job.requisitionId,
    location: info.location || job.location,
    extraLocations: Array.isArray(info.additionalLocations) ? info.additionalLocations : job.extraLocations,
  };
}

/**
 * The Workday site (career-site name) a portals.yml entry points at, as
 * `{host, tenant, site}`, or null. Postings scanned before the provider stored
 * the site segment have siteless URLs, which are resolved back through this
 * (liveness ladder, migrate-workday-urls). Reads the explicit CXS `api` URL first, then `careers_url`.
 */
export function workdaySiteOf(entry) {
  const api = String(entry?.api || '').match(/^https:\/\/(([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/wday\/cxs\/([^/]+)\/([^/?#]+)/i);
  if (api) return { host: api[1].toLowerCase(), tenant: api[3], site: api[4] };
  const m = String(entry?.careers_url || '').match(/^https:\/\/(([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?([^/?#]+)/i);
  if (m && m[3] !== 'job') return { host: m[1].toLowerCase(), tenant: m[2], site: m[3] };
  return null;
}

export default {
  id: 'workday',

  detect(entry) {
    if (entry.api && String(entry.api).includes('myworkdayjobs.com')) {
      const baseMatch = String(entry.api).match(/(https:\/\/[^/]+\.myworkdayjobs\.com)/);
      return { url: entry.api, baseUrl: baseMatch ? baseMatch[1] : '', site: workdaySiteOf(entry)?.site || '', explicit: true };
    }
    // https://{tenant}.wd{shard}.myworkdayjobs.com/[{locale}/]{site}
    const t = workdaySiteOf(entry);
    if (!t) return null;
    const baseUrl = `https://${t.host}`;
    return { url: `${baseUrl}/wday/cxs/${t.tenant}/${t.site}/jobs`, baseUrl, site: t.site };
  },

  async fetch(entry, ctx) {
    // Workday states `total` on the FIRST page only; later pages say `total: 0`.
    // Remember the first stated total and page until it is reached, or an empty
    // page, or the page ceiling. (A tenant that never states one pages until an
    // empty page.)
    const all = [];
    let total = null;
    for (let page = 0; page < ctx.maxPages; page++) {
      const offset = page * PAGE_LIMIT;
      const json = await ctx.postJson(ctx.api.url, { appliedFacets: {}, limit: PAGE_LIMIT, offset, searchText: '' });
      const jobs = parseWorkday(json, entry.name, ctx.api.baseUrl, ctx.api.site);
      all.push(...jobs);
      if (total === null && Number(json.total) > 0) total = Number(json.total);
      if (jobs.length === 0) break;
      if (total !== null && all.length >= total) break;
    }
    return all;
  },

  async enrich(jobs, ctx) {
    const listSuffix = /\/jobs$/;
    if (!listSuffix.test(ctx.api.url)) return jobs;
    const base = ctx.api.url.replace(listSuffix, '');
    const todo = jobs.filter((j) => j._workdayPath).slice(0, DETAIL_LIMIT);
    const byUrl = new Map();
    await ctx.parallel(todo.map((j) => async () => {
      try {
        const detail = await ctx.getJson(`${base}${j._workdayPath}`, { retries: 1 });
        byUrl.set(j.url, applyWorkdayDetail(j, detail));
      } catch { /* fail-open */ }
    }), DETAIL_CONCURRENCY);
    return jobs.map((j) => byUrl.get(j.url) || j);
  },
};
