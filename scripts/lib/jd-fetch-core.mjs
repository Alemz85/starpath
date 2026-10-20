// jd-fetch-core.mjs — fetch a posting's job description for the archive
// backfill (scripts/archive-posting.mjs). No I/O of its own: the transport is
// injected (`http` from lib/http.mjs in the CLI, a fake in the tests).
//
// Route per listing URL:
//   • Greenhouse / Lever / Ashby / SmartRecruiters listing URLs → the ATS's
//     public postings API (allow-listed hosts in lib/http.mjs).
//   • Anything else → the page itself: the JSON-LD `JobPosting` when the page
//     has one, else the page's readable text when it is long enough to be a
//     posting. HTTPS only, no redirects, no private addresses (http.mjs).
//
// Outcomes: `ok` (text found), `gone` (404/410, or a "no longer available"
// page), `unreachable` (network/5xx/redirect/blocked — try again later),
// `unextractable` (reachable, but no posting text in it). Nothing is ever
// invented: a failed fetch yields no text.

// ── Route planning ───────────────────────────────────────────────────────────

const GREENHOUSE_HOSTS = {
  'boards.greenhouse.io': 'boards-api.greenhouse.io',
  'job-boards.greenhouse.io': 'boards-api.greenhouse.io',
  'boards.eu.greenhouse.io': 'boards-api.eu.greenhouse.io',
  'job-boards.eu.greenhouse.io': 'boards-api.eu.greenhouse.io',
};
const LEVER_HOSTS = { 'jobs.lever.co': 'api.lever.co', 'jobs.eu.lever.co': 'api.eu.lever.co' };

/**
 * How to fetch a listing URL.
 * @returns {{ kind: 'greenhouse'|'lever'|'ashby'|'smartrecruiters'|'page', apiUrl?: string, type?: string, id?: string, source: string, pageUrl: string } | null}
 *   null when the URL is not an http(s) URL.
 */
export function planFetch(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const pageUrl = u.toString();
  const page = { kind: 'page', source: 'page-html', pageUrl };

  if (GREENHOUSE_HOSTS[host]) {
    const board = segs[0];
    const id = segs[1] === 'jobs' && /^\d+$/.test(segs[2] ?? '') ? segs[2] : (/^\d+$/.test(u.searchParams.get('gh_jid') ?? '') ? u.searchParams.get('gh_jid') : '');
    if (board && id) {
      return { kind: 'greenhouse', type: 'greenhouse', id, source: 'greenhouse-api', pageUrl,
        apiUrl: `https://${GREENHOUSE_HOSTS[host]}/v1/boards/${encodeURIComponent(board)}/jobs/${id}` };
    }
    return page;
  }
  if (LEVER_HOSTS[host]) {
    const [co, id] = segs;
    if (co && /^[0-9a-f-]{20,}$/i.test(id ?? '')) {
      return { kind: 'lever', type: 'lever', id, source: 'lever-api', pageUrl,
        apiUrl: `https://${LEVER_HOSTS[host]}/v0/postings/${encodeURIComponent(co)}/${id}` };
    }
    return page;
  }
  if (host === 'jobs.ashbyhq.com') {
    const [co, id] = segs;
    if (co && /^[0-9a-f-]{20,}$/i.test(id ?? '')) {
      return { kind: 'ashby', type: 'ashby', id, source: 'ashby-api', pageUrl,
        apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(co)}?includeCompensation=true` };
    }
    return page;
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    const [co, idSlug] = segs;
    const id = /^(\d{6,})/.exec(idSlug ?? '')?.[1];
    if (co && id) {
      return { kind: 'smartrecruiters', type: 'smartrecruiters', id, source: 'smartrecruiters-api', pageUrl,
        apiUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(co)}/postings/${id}` };
    }
    return page;
  }
  return page;
}

// ── HTML → text ──────────────────────────────────────────────────────────────

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', euro: '€', pound: '£', copy: '©', reg: '®' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML → readable markdown-ish text: headings, list items, paragraphs and
 * line breaks survive; tags, scripts and styles do not. Wording is untouched.
 * Greenhouse ships its `content` entity-escaped (`&lt;p&gt;`), so escaped
 * markup is unescaped first.
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  if (/&lt;\/?[a-z][^&]*&gt;/i.test(s) && !/<\/?(p|div|ul|li|h\d|br)\b/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) => `\n\n${'#'.repeat(Math.min(6, Math.max(2, Number(n))))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|ul|ol|section|article|tr|table)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(strong|b)\b[^>]*>/gi, '**')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ── Payload → posting text ───────────────────────────────────────────────────

/** Join non-empty blocks with a blank line. */
const blocks = (...parts) => parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n');

export function greenhouseText(json) {
  const text = htmlToText(json?.content ?? '');
  return { title: json?.title ?? '', text };
}

export function leverText(json) {
  const lists = (json?.lists ?? []).map((l) => `## ${l.text ?? ''}\n\n${htmlToText(l.content ?? '').trim()}`);
  const text = blocks(
    json?.descriptionPlain ?? htmlToText(json?.description ?? ''),
    ...lists,
    json?.additionalPlain ?? htmlToText(json?.additional ?? ''),
  );
  return { title: json?.text ?? '', text };
}

export function ashbyText(json, id) {
  const job = (json?.jobs ?? []).find((j) => j.id === id);
  if (!job) return { title: '', text: '', missing: true };
  return { title: job.title ?? '', text: (job.descriptionPlain ?? htmlToText(job.descriptionHtml ?? '')).trim() };
}

export function smartrecruitersText(json) {
  const sections = json?.jobAd?.sections ?? {};
  const order = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];
  const text = blocks(...order.filter((k) => sections[k]?.text).map((k) => {
    const t = htmlToText(sections[k].text);
    return sections[k].title ? `## ${sections[k].title}\n\n${t}` : t;
  }));
  return { title: json?.name ?? '', text };
}

// ── Page extraction ──────────────────────────────────────────────────────────

const CLOSED_RE = /\b(no longer (?:available|accepting|open)|(?:position|role|job|vacancy|posting) (?:has been|is|was) (?:filled|closed|removed|taken down)|this job (?:has expired|is closed)|page (?:you(?:'|’)re looking for )?(?:was )?not found|job (?:no longer exists|not found)|expired)\b/i;

/** The first JSON-LD `JobPosting` in a page, as `{ title, text }`, or null. */
export function jobPostingFromJsonLd(html) {
  for (const m of String(html ?? '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
      const type = node['@type'];
      if ((Array.isArray(type) ? type : [type]).includes('JobPosting') && node.description) {
        return { title: String(node.title ?? ''), text: htmlToText(String(node.description)) };
      }
    }
  }
  return null;
}

/** Minimum characters for page text to count as a posting rather than a shell. */
export const MIN_PAGE_TEXT = 700;

/**
 * Posting text from an arbitrary careers page.
 * @returns {{ status: 'ok', title: string, text: string } | { status: 'gone'|'unextractable', reason: string }}
 */
export function extractFromPage(html) {
  const ld = jobPostingFromJsonLd(html);
  if (ld && ld.text.length >= 200) return { status: 'ok', ...ld };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? '')?.[1];
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html ?? '')?.[2];
  const text = htmlToText(main ?? String(html ?? '').replace(/^[\s\S]*?<body\b[^>]*>/i, ''));
  if (CLOSED_RE.test(text.slice(0, 1500)) && text.length < 2500) {
    return { status: 'gone', reason: 'the page says the posting is closed' };
  }
  if (text.length >= MIN_PAGE_TEXT) return { status: 'ok', title: decodeEntities(title ?? '').trim(), text };
  return { status: 'unextractable', reason: 'no posting text found in the page' };
}

// ── Fetch ────────────────────────────────────────────────────────────────────

const statusOutcome = (err) =>
  err?.status === 404 || err?.status === 410
    ? { status: 'gone', reason: `HTTP ${err.status}` }
    : { status: 'unreachable', reason: err?.message ?? 'request failed' };

/**
 * Fetch a listing's description.
 *
 * @param {string} url
 * @param {{ getJson: Function, send: Function }} http  the lib/http.mjs client
 * @returns {Promise<{ status: 'ok', text: string, title: string, source: string }
 *                  | { status: 'gone'|'unreachable'|'unextractable'|'unsupported', reason: string }>}
 */
export async function fetchPosting(url, http) {
  const plan = planFetch(url);
  if (!plan) return { status: 'unsupported', reason: 'no listing URL' };
  try {
    if (plan.apiUrl) {
      const json = await http.getJson(plan.apiUrl, { type: plan.type });
      const got = plan.kind === 'greenhouse' ? greenhouseText(json)
        : plan.kind === 'lever' ? leverText(json)
          : plan.kind === 'ashby' ? ashbyText(json, plan.id)
            : smartrecruitersText(json);
      if (got.missing) return { status: 'gone', reason: 'the posting is no longer on the board' };
      if (!got.text) return { status: 'unextractable', reason: 'the API returned no description' };
      return { status: 'ok', ...got, source: plan.source };
    }
    const host = new URL(plan.pageUrl).hostname;
    const res = await http.send(plan.pageUrl, {
      hosts: [host],
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const html = res.body.toString('utf8');
    const got = extractFromPage(html);
    return got.status === 'ok' ? { ...got, source: plan.source } : got;
  } catch (err) {
    return statusOutcome(err);
  }
}
