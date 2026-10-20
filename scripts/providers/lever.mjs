/**
 * lever — api.lever.co postings API.
 * Payload extras: `createdAt` (epoch ms posting date), `categories.allLocations`,
 * the JD text (one explicit deadline cue). Lever exposes no requisition id.
 */
import { resolveDeadline, cleanId } from '../lib/listing-fields.mjs';
import { safeSegment } from '../lib/ats-url.mjs';

export function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map((j) => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    extraLocations: Array.isArray(j.categories?.allLocations) ? j.categories.allLocations : [],
    postedDate: j.createdAt ?? null, // epoch ms
    deadline: resolveDeadline([], [j.descriptionPlain, j.additionalPlain].filter(Boolean).join('\n')),
    externalId: cleanId(j.id),
    requisitionId: '',
  }));
}

export default {
  id: 'lever',

  detect(entry) {
    const m = String(entry.careers_url || '').match(/jobs\.lever\.co\/([^/?#]+)/);
    const slug = m && safeSegment(m[1]);
    if (!slug) return null;
    return { url: `https://api.lever.co/v0/postings/${slug}` };
  },

  async fetch(entry, ctx) {
    const json = await ctx.getJson(ctx.api.url);
    return parseLever(json, entry.name);
  },
};
