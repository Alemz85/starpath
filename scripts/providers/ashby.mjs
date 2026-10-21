/**
 * ashby — api.ashbyhq.com posting API.
 * Payload extras: `publishedAt` (true posting date), `secondaryLocations`, the
 * JD body (one explicit deadline cue), `requisitionId`, and — because the URL
 * asks for `includeCompensation=true` — numeric salary components.
 */
import { resolveDeadline, cleanId } from '../lib/listing-fields.mjs';
import { safeSegment } from '../lib/ats-url.mjs';
import { normalizeSalary } from '../lib/job.mjs';

const PERIOD = { YEAR: 'year', MONTH: 'month', WEEK: 'week', DAY: 'day', HOUR: 'hour' };

/** Real numeric Salary components only; a summary string like "€60K – €80K" is never parsed. */
function ashbySalary(j) {
  const comps = j?.compensation?.summaryComponents;
  if (!Array.isArray(comps)) return null;
  const c = comps.find((x) => String(x?.compensationType || '').toLowerCase() === 'salary');
  if (!c) return null;
  const interval = String(c.interval || '').toUpperCase();
  const period = PERIOD[Object.keys(PERIOD).find((k) => interval.includes(k))] || '';
  return normalizeSalary({ min: c.minValue, max: c.maxValue, currency: c.currencyCode, period });
}

export function parseAshby(json, companyName) {
  const jobs = json?.jobs || [];
  return jobs.map((j) => {
    const job = {
      title: j.title || '',
      url: j.jobUrl || '',
      company: companyName,
      location: j.location || '',
      extraLocations: (j.secondaryLocations || []).map((l) => l?.location).filter(Boolean),
      postedDate: j.publishedAt || j.updatedAt || null,
      deadline: resolveDeadline([], j.descriptionPlain || j.descriptionHtml),
      externalId: cleanId(j.id),
      requisitionId: cleanId(j.requisitionId),
    };
    const salary = ashbySalary(j);
    if (salary) job.salary = salary;
    return job;
  });
}

export default {
  id: 'ashby',

  detect(entry) {
    const m = String(entry.careers_url || '').match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
    const slug = m && safeSegment(m[1]);
    if (!slug) return null;
    return { url: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true` };
  },

  async fetch(entry, ctx) {
    const json = await ctx.getBoardJson(ctx.api.url);
    return parseAshby(json, entry.name);
  },
};
