// Listing-URL domain — pure helpers for validating, dedup-normalizing, and
// reading a company hint out of a pasted job URL.
//
// Extracted from components/scouting/AddListingModal.tsx so the dedup-critical
// logic is testable in isolation: `normalizeUrl` is the *key* the modal (and
// `appendToPipeline`) use to decide "is this the same listing I already know
// about?", so a subtle regression here silently produces duplicate Database
// rows or, worse, swallows a genuinely-new listing as a dup. None of these
// touch React/IPC — they're string-in / string-out.

// Pull a guessed company name out of the URL hostname so the live preview can
// confirm the user pasted the right URL before they commit. Heuristic only —
// the real company name comes from the JD scrape, this just helps catch
// obvious typos / wrong-URL pastes.
export function guessCompanyFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    // ATS hosts → pull from the path or subdomain
    if (host.endsWith('greenhouse.io') || host.endsWith('boards.greenhouse.io')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('lever.co')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('ashbyhq.com') || host.endsWith('jobs.ashbyhq.com')) {
      const seg = u.pathname.split('/').filter(Boolean)[0]
      if (seg) return prettify(seg)
    }
    if (host.endsWith('myworkdayjobs.com')) {
      // {tenant}.{whatever}.myworkdayjobs.com → tenant
      const sub = host.split('.')[0]
      if (sub) return prettify(sub)
    }
    if (host.endsWith('welcometothejungle.com')) {
      const idx = u.pathname.indexOf('/companies/')
      if (idx >= 0) {
        const seg = u.pathname.slice(idx + '/companies/'.length).split('/')[0]
        if (seg) return prettify(seg)
      }
    }
    if (host.endsWith('linkedin.com')) return 'LinkedIn job'
    if (host.endsWith('indeed.com')) return 'Indeed listing'
    // Fallback: registrable domain. Take the label before the public suffix —
    // normally the second-to-last (`acme.com` → `acme`), but for the common
    // multi-part suffixes (`acme.co.uk`, `acme.com.au`) that's the eSLD
    // (`co`, `com`), so step back one more to land on the real org label.
    const labels = host.split('.')
    if (labels.length >= 2) {
      let idx = labels.length - 2
      if (labels.length >= 3 && MULTIPART_TLDS.has(labels.slice(-2).join('.'))) {
        idx = labels.length - 3
      }
      return prettify(labels[idx])
    }
    return prettify(host)
  } catch {
    return null
  }
}

// Common two-label public suffixes where the registrable domain is the THIRD
// label from the right (`bbc.co.uk` → `bbc`). Not exhaustive — covers the
// country ccTLD patterns a European/global job search actually surfaces; an
// unlisted suffix just falls back to the second-to-last label (harmless, since
// this is a preview hint, not the stored company).
const MULTIPART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.za', 'co.in', 'co.kr', 'co.il', 'co.jp', 'ne.jp', 'or.jp',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.sg', 'com.hk', 'com.tr',
  'com.cn', 'com.es', 'com.pl', 'com.pt',
])

export function prettify(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Tracking / analytics query params that don't identify a distinct listing.
// Stripped before dedup comparison so the same posting pasted with different
// campaign tags doesn't read as a brand-new evaluation. Conservative — only
// well-known trackers; real listing params (jobId, lever's `lever-origin`,
// Workday paths, etc.) are preserved.
export const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gh_src', 'src', 'source', 'ref', 'referrer', 'trk', 'trackingid',
])

// Canonical form used ONLY for dedup comparison — never written to disk (we
// always store the user's original URL). Lowercases scheme + host, drops the
// `www.` prefix and URL fragment, strips known tracking params, sorts the
// rest so order can't defeat the match, and trims trailing slashes from the
// path. So `https://Acme.com/jobs/42/?utm_source=x#top`,
// `http://www.acme.com/jobs/42`, and `https://acme.com/jobs/42` all collapse
// to one key (modulo scheme, which we keep — http vs https are kept distinct).
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '') || '/'
    const params = new URLSearchParams()
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) params.append(k, v)
    }
    params.sort()
    const qs = params.toString()
    return `${u.protocol.toLowerCase()}//${host}${path}${qs ? '?' + qs : ''}`
  } catch {
    return raw.trim().toLowerCase()
  }
}
