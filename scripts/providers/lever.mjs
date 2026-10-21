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

// A big company's Lever feed is one JSON array of every posting with its full
// description (13 MB is real); the 10 s client default timed out on it, so the
// board was never scanned. Capped by lib/http.mjs › LIMITS.
export const BOARD_FEED = Object.freeze({ timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });

export default {
  id: 'lever',
  boardFeed: BOARD_FEED,

  detect(entry) {
    const m = String(entry.careers_url || '').match(/jobs\.lever\.co\/([^/?#]+)/);
    const slug = m && safeSegment(m[1]);
    if (!slug) return null;
    return { url: `https://api.lever.co/v0/postings/${slug}` };
  },

  async fetch(entry, ctx) {
    const json = await ctx.getBoardJson(ctx.api.url);
    return parseLever(json, entry.name);
  },
};
