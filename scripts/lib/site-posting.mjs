/**
 * site-posting.mjs — job descriptions and liveness for company career sites
 * that are not an ATS (amazon.jobs, jobs.picnic.app, careers.factorial.com).
 *
 * Each of these serves a real 404 for a posting that is gone and, for a live
 * one, either a public search JSON (amazon.jobs) or a page carrying
 * schema.org `JobPosting` JSON-LD / a server-rendered description. Because the
 * host is known and registered (lib/ats-url.mjs, lib/http.mjs allowlists), a
 * 404/410 here is decisive on its own, unlike on an unknown page where two
 * signals must agree.
 *
 * Pure: HTML/JSON in, verdict/JD out. All fetching stays in the ladder.
 */

import { htmlToText, jobPostingsFromJsonLd, judgePostingHtml } from './liveness-ladder.mjs';
import { cleanId } from './listing-fields.mjs';

const MIN_MAIN_CHARS = 700;

// ── amazon.jobs search JSON ─────────────────────────────────────────────────

/** The search hit whose `id_icims` is the posting id, or undefined. */
export function amazonHit(json, id) {
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
  return jobs.find((j) => cleanId(j?.id_icims) === cleanId(id));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "September 23, 2026" → "2026-09-23" (a local-time Date parse would shift the day). */
function longDateToIso(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s ?? '').trim());
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return mi < 0 ? s : `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Raw JD fields of an amazon.jobs hit (the caller normalises dates and clips). */
export function amazonJdFields(hit) {
  const body = [hit.description, hit.basic_qualifications && `Basic qualifications\n${hit.basic_qualifications}`,
    hit.preferred_qualifications && `Preferred qualifications\n${hit.preferred_qualifications}`].filter(Boolean).join('\n\n');
  return { title: hit.title, location: hit.normalized_location || hit.location, body, posted: longDateToIso(hit.posted_date), deadline: [] };
}

// ── JSON-LD from a page ─────────────────────────────────────────────────────

function ldLocation(p) {
  const locs = [].concat(p.jobLocation || []);
  const names = locs.map((l) => {
    const a = l?.address;
    if (!a || typeof a !== 'object') return '';
    return [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'object' ? a.addressCountry?.name : a.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean);
  return [...new Set(names)].join(' | ');
}

/**
 * Next.js ships JSON-LD inside the RSC stream as an escaped string, so there is
 * no `<script type="application/ld+json">` to parse. The fields we need are
 * plain string values: pull them out with a tolerant regex.
 */
function rscField(html, name) {
  const m = new RegExp(`${name}\\\\*"\\s*:\\s*\\\\*"([^"\\\\]+)`).exec(html);
  return m ? m[1] : '';
}

/** Does the page declare a JobPosting at all (script tag or RSC stream)? */
const mentionsJobPosting = (html) => /JobPosting/.test(html);

function mainText(html) {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  return htmlToText(main ?? '');
}

/**
 * Normalised JD fields from a company-site page. `description` stays raw
 * (HTML or text); the ladder runs it through its own clip/htmlToText.
 */
export function siteJdFromHtml(ats, html) {
  const h = String(html ?? '');
  const ld = jobPostingsFromJsonLd(h)[0];
  if (ld) {
    const description = String(ld.description ?? '');
    const truncated = /(\.\.\.|…)\s*$/.test(htmlToText(description));
    return {
      title: ld.title,
      location: ldLocation(ld),
      body: truncated ? mainText(h) || description : description,
      posted: ld.datePosted,
      deadline: [ld.validThrough],
    };
  }
  if (ats === 'picnic' && mentionsJobPosting(h)) {
    // The RSC JSON-LD description is cut short; the rendered <main> is the full JD.
    const text = mainText(h);
    const title = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(h)?.[1] ?? /<title[^>]*>([^<|]*)/i.exec(h)?.[1] ?? '';
    return { title: htmlToText(title), location: '', body: text, posted: rscField(h, 'datePosted'), deadline: [rscField(h, 'validThrough')] };
  }
  return null;
}

// ── liveness of a company-site page ─────────────────────────────────────────

/**
 * Judge a fetched company-site posting page.
 * @param {'amazon'|'picnic'|'factorial'} ats
 * @param {{status:number, headers?:object, text?:string}} res
 * @param {string} id the posting id from the URL
 * @returns {{result:'active'|'expired'|null, reason:string, jd?:ReturnType<typeof siteJdFromHtml>}}
 */
export function judgeSitePage(ats, res, id, { now = new Date() } = {}) {
  const html = res.text || '';
  if (res.status === 404 || res.status === 410) {
    return { result: 'expired', reason: `${ats} site: HTTP ${res.status} for the posting` };
  }
  if (res.status < 200 || res.status >= 300) return { result: null, reason: `${ats} site: HTTP ${res.status}` };

  const posts = jobPostingsFromJsonLd(html);
  if (ats === 'factorial' && posts.length) {
    // The page's own id must be the one asked for (an unknown slug can bounce to another posting).
    const own = posts.some((p) => cleanId(p?.identifier?.value ?? p?.identifier) === cleanId(id));
    if (!own) return { result: null, reason: 'factorial site: JSON-LD is for a different posting' };
  }
  if (posts.length) {
    const past = posts.every((p) => {
      const t = Date.parse(p.validThrough);
      return Number.isFinite(t) && t < now.getTime();
    });
    return past
      ? { result: 'expired', reason: `${ats} site: JSON-LD validThrough is in the past` }
      : { result: 'active', reason: `${ats} site: page carries a JobPosting`, jd: siteJdFromHtml(ats, html) };
  }
  if (ats === 'picnic' && mentionsJobPosting(html) && mainText(html).length >= MIN_MAIN_CHARS) {
    return { result: 'active', reason: 'picnic site: JobPosting and a full description on the page', jd: siteJdFromHtml(ats, html) };
  }
  if (ats === 'factorial' && !/<h1\b/i.test(html)) {
    // A closed posting 200s with the generic job list: no JobPosting and no posting heading.
    return { result: 'expired', reason: 'factorial site: the page is the generic job list (no JobPosting, no posting heading)' };
  }
  // Nothing posting-shaped: fall back to the generic two-signal judge (a listing page, "no longer available" …).
  const generic = judgePostingHtml(res, { now });
  return { result: generic.result, reason: generic.reason };
}
