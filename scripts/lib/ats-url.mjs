/**
 * ats-url.mjs — safe URL building for the ATS endpoints the scanner and the
 * liveness ladder call.
 *
 * Every API URL we request is assembled from a HARD-CODED host plus path
 * segments that came out of a user-edited `portals.yml` or a pasted posting
 * URL. A segment is only ever used when it is a plain slug/id (`isSafeSegment`):
 * no slashes, dots-only names, percent-escapes, query/fragment characters or
 * whitespace. That keeps a hostile or typo'd value from steering the request to
 * another path on the (already allowlisted) ATS host.
 *
 * `parsePostingUrl` maps a public posting URL to the ATS it belongs to, the org
 * slug and the posting id — and `postingApiUrls` turns that into the per-job and
 * org-board API URLs on the ATS's own API host.
 */

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/;

/** A plain slug or id: safe to put in a request path unescaped. */
export function isSafeSegment(s) {
  const v = String(s ?? '');
  return SEGMENT_RE.test(v) && v !== '.' && v !== '..' && !v.includes('..');
}

/** `isSafeSegment(s) ? s : null` — convenient in a regex-capture pipeline. */
export function safeSegment(s) {
  return isSafeSegment(s) ? String(s) : null;
}

function parse(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

const GH_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.eu.greenhouse.io']);

/**
 * Identify the ATS, org and posting id behind a public posting URL.
 * Returns null for anything that is not an unambiguous posting URL on a known
 * ATS host (company-hosted career pages, `?gh_jid=` embeds, unknown hosts).
 *
 * @param {string} raw
 * @returns {null | {ats:'greenhouse'|'ashby'|'lever'|'smartrecruiters'|'workday', org:string, id:string,
 *                   host:string, eu?:boolean, site?:string, externalPath?:string, tenant?:string}}
 */
export function parsePostingUrl(raw) {
  const u = parse(raw);
  if (!u) return null;
  if (u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  if (GH_HOSTS.has(host)) {
    // /{org}/jobs/{id}
    if (segs.length >= 3 && segs[1] === 'jobs' && /^\d+$/.test(segs[2]) && isSafeSegment(segs[0])) {
      return { ats: 'greenhouse', org: segs[0], id: segs[2], host, eu: host.includes('.eu.') };
    }
    return null;
  }
  if (host === 'jobs.ashbyhq.com') {
    // /{org}/{uuid}[/application]
    if (segs.length >= 2 && isSafeSegment(segs[0]) && /^[0-9a-f-]{8,64}$/i.test(segs[1])) {
      return { ats: 'ashby', org: segs[0], id: segs[1], host };
    }
    return null;
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    // /{org}/{uuid}[/apply]
    if (segs.length >= 2 && isSafeSegment(segs[0]) && /^[0-9a-f-]{8,64}$/i.test(segs[1])) {
      return { ats: 'lever', org: segs[0], id: segs[1], host, eu: host.includes('.eu.') };
    }
    return null;
  }
  if (host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') {
    // /{Company}/{numeric id}[-slug]
    if (segs.length >= 2 && isSafeSegment(segs[0])) {
      const m = /^(\d{6,})(?:-[A-Za-z0-9-]*)?$/.exec(segs[1]);
      if (m) return { ats: 'smartrecruiters', org: segs[0], id: m[1], host };
    }
    return null;
  }
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    // /[{locale}/]{site}/job/{...}/{Title}_{ReqId}
    const rest = [...segs];
    if (rest.length && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(rest[0]) && rest[1] && rest[1] !== 'job') rest.shift();
    const jobIdx = rest.indexOf('job');
    if (jobIdx >= 1 && rest.length > jobIdx + 1) {
      const site = rest[jobIdx - 1];
      const tail = rest.slice(jobIdx + 1);
      if (isSafeSegment(wd[1]) && isSafeSegment(site) && tail.every(isSafeSegment)) {
        const id = tail[tail.length - 1];
        return { ats: 'workday', org: wd[1], tenant: wd[1], site, id, host, externalPath: `/job/${tail.join('/')}` };
      }
    }
    return null;
  }
  return null;
}

/**
 * The API URLs that can answer "is this posting still there?" for a parsed
 * posting. `perJob` is the single-posting endpoint (null when the ATS has none);
 * `board` is the org's full board listing (null when it is paginated or POST
 * only). Hosts are hard-coded; only `isSafeSegment` values are interpolated.
 *
 * @param {NonNullable<ReturnType<typeof parsePostingUrl>>} p
 * @returns {{perJob: string|null, board: string|null, boardType: string, html: string}}
 */
export function postingApiUrls(p, originalUrl) {
  switch (p.ats) {
    case 'greenhouse':
      return {
        perJob: `https://boards-api.${p.eu ? 'eu.' : ''}greenhouse.io/v1/boards/${p.org}/jobs/${p.id}`,
        board: `https://boards-api.${p.eu ? 'eu.' : ''}greenhouse.io/v1/boards/${p.org}/jobs`,
        boardType: 'greenhouse',
        html: originalUrl,
      };
    case 'lever':
      return {
        perJob: `https://api.${p.eu ? 'eu.' : ''}lever.co/v0/postings/${p.org}/${p.id}`,
        board: `https://api.${p.eu ? 'eu.' : ''}lever.co/v0/postings/${p.org}?mode=json`,
        boardType: 'lever',
        html: originalUrl,
      };
    case 'ashby':
      return {
        perJob: null, // Ashby has no public single-posting endpoint
        board: `https://api.ashbyhq.com/posting-api/job-board/${p.org}`,
        boardType: 'ashby',
        html: originalUrl,
      };
    case 'smartrecruiters':
      return {
        perJob: `https://api.smartrecruiters.com/v1/companies/${p.org}/postings/${p.id}`,
        board: null, // paginated: the per-job endpoint is the authority
        boardType: 'smartrecruiters',
        html: originalUrl,
      };
    case 'workday':
      return {
        perJob: `https://${p.host}/wday/cxs/${p.tenant}/${p.site}${p.externalPath}`,
        board: null, // POST + pagination
        boardType: 'workday',
        html: originalUrl,
      };
    default:
      return { perJob: null, board: null, boardType: p.ats, html: originalUrl };
  }
}
