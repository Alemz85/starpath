/**
 * greenhouse — boards-api.greenhouse.io (and the EU host).
 * Payload extras beyond title/url/location: `first_published` (true posting
 * date), `application_deadline` and deadline-ish `metadata` entries, the JD
 * `content` (scanned for one explicit "apply by YYYY-MM-DD"), `requisition_id`.
 */
import { resolveDeadline, cleanId } from '../lib/listing-fields.mjs';
import { safeSegment } from '../lib/ats-url.mjs';

/** Greenhouse custom `metadata` entries whose name says "deadline"/"closing". */
function greenhouseMetaDeadline(meta) {
  if (!Array.isArray(meta)) return [];
  return meta
    .filter((m) => /deadline|closing|close date|apply by/i.test(String(m?.name || '')))
    .map((m) => m?.value);
}

export function parseGreenhouse(json, companyName) {
  const jobs = json?.jobs || [];
  return jobs.map((j) => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    postedDate: j.first_published || j.updated_at || null,
    deadline: resolveDeadline([j.application_deadline, ...greenhouseMetaDeadline(j.metadata)], j.content),
    externalId: cleanId(j.id),
    requisitionId: cleanId(j.requisition_id),
  }));
}

export default {
  id: 'greenhouse',

  detect(entry) {
    if (entry.api && String(entry.api).includes('greenhouse')) {
      return { url: entry.api, explicit: true };
    }
    const m = String(entry.careers_url || '').match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
    const slug = m && safeSegment(m[1]);
    if (slug && !entry.api) {
      return { url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` };
    }
    return null;
  },

  async fetch(entry, ctx) {
    const json = await ctx.getJson(ctx.api.url);
    return parseGreenhouse(json, entry.name);
  },
};
