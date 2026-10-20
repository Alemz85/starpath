/**
 * smartrecruiters — api.smartrecruiters.com postings API (paginated).
 * Payload extras: `releasedDate` (true posting date), `refNumber`, and an
 * optional tenant custom field carrying an ISO deadline. `sr_brand` in
 * portals.yml narrows a multi-brand tenant to one brand.
 */
import { resolveDeadline, cleanId } from '../lib/listing-fields.mjs';

const PAGE_LIMIT = 100;

export function parseSmartRecruiters(jobs, companyName, brandFilter) {
  let filtered = jobs;
  if (brandFilter) {
    filtered = jobs.filter((j) =>
      j.customField?.some((f) => f.fieldLabel === 'Brands' && f.valueLabel === brandFilter),
    );
  }
  return filtered.map((j) => ({
    title: j.name || '',
    url: `https://careers.smartrecruiters.com/${j.company?.identifier || companyName}/${j.id}`,
    company: companyName,
    location: j.location?.city || j.location?.fullLocation || '',
    postedDate: j.releasedDate || j.createdOn || null,
    // SmartRecruiters has no standard deadline field; some tenants add a custom
    // one ("Application deadline", "Closing date") with an ISO value.
    deadline: resolveDeadline(
      (j.customField || [])
        .filter((f) => /deadline|closing|close date|apply by/i.test(String(f?.fieldLabel || '')))
        .map((f) => f?.valueLabel ?? f?.valueId),
    ),
    externalId: cleanId(j.id),
    requisitionId: cleanId(j.refNumber),
  }));
}

export default {
  id: 'smartrecruiters',

  detect(entry) {
    if (entry.api && String(entry.api).includes('smartrecruiters.com')) {
      return { url: entry.api, brandFilter: entry.sr_brand || null, explicit: true };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const all = [];
    for (let page = 0; page < ctx.maxPages; page++) {
      const offset = page * PAGE_LIMIT;
      const json = await ctx.getJson(`${ctx.api.url}?limit=${PAGE_LIMIT}&offset=${offset}`);
      const batch = json.content || [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT || all.length >= (json.totalFound || 0)) break;
    }
    return parseSmartRecruiters(all, entry.name, ctx.api.brandFilter);
  },
};
