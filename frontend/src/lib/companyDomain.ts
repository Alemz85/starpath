// Company name → domain for the logo fetcher (CompanyLogo → ipc.fetchLogo →
// the main process's `logo:fetch`). Pure and dependency-free so the logic
// that decides whether a company's real logo loads, or it falls back to
// initials, is unit-testable in isolation.
//
// resolveLogoDomain, in order:
//   1. the user's own domain for the company (user/portals.yml: a
//      `company_domains` map, or a tracked company's non-ATS careers_url)
//   2. guessDomain: exact override, a name that is already a domain
//      ("Contoso.io"), word-boundary prefix override ("Google Cloud" →
//      google.com), then the cleaned fallback (strip legal/suffix noise and
//      accents, dot-com it)

export const OVERRIDES: Record<string, string> = {
  'amazon': 'amazon.com', 'aws': 'aws.amazon.com', 'amazon web services': 'aws.amazon.com',
  'apple': 'apple.com', 'google': 'google.com', 'alphabet': 'abc.xyz',
  'meta': 'meta.com', 'facebook': 'meta.com', 'instagram': 'instagram.com', 'whatsapp': 'whatsapp.com',
  'microsoft': 'microsoft.com', 'linkedin': 'linkedin.com', 'github': 'github.com',
  'netflix': 'netflix.com', 'spotify': 'spotify.com', 'airbnb': 'airbnb.com',
  'uber': 'uber.com', 'lyft': 'lyft.com', 'twitter': 'x.com', 'x': 'x.com',
  'openai': 'openai.com', 'anthropic': 'anthropic.com', 'deepmind': 'deepmind.com',
  'nvidia': 'nvidia.com', 'intel': 'intel.com', 'amd': 'amd.com', 'qualcomm': 'qualcomm.com',
  'tesla': 'tesla.com', 'spacex': 'spacex.com', 'palantir': 'palantir.com',
  'snowflake': 'snowflake.com', 'databricks': 'databricks.com', 'datadog': 'datadoghq.com',
  'salesforce': 'salesforce.com', 'adobe': 'adobe.com', 'oracle': 'oracle.com', 'sap': 'sap.com',
  'shopify': 'shopify.com', 'stripe': 'stripe.com', 'twilio': 'twilio.com',
  'atlassian': 'atlassian.com', 'okta': 'okta.com', 'hubspot': 'hubspot.com',
  'zendesk': 'zendesk.com', 'workday': 'workday.com', 'servicenow': 'servicenow.com',
  'mckinsey': 'mckinsey.com', 'mckinsey & company': 'mckinsey.com',
  'bcg': 'bcg.com', 'boston consulting group': 'bcg.com',
  'bain': 'bain.com', 'bain & company': 'bain.com', 'kearney': 'kearney.com',
  'deloitte': 'deloitte.com', 'pwc': 'pwc.com', 'kpmg': 'kpmg.com',
  'ey': 'ey.com', 'ernst & young': 'ey.com', 'accenture': 'accenture.com',
  'capgemini': 'capgemini.com', 'ibm': 'ibm.com',
  'goldman sachs': 'goldmansachs.com', 'jp morgan': 'jpmorgan.com', 'jpmorgan': 'jpmorgan.com',
  'morgan stanley': 'morganstanley.com', 'blackrock': 'blackrock.com', 'ubs': 'ubs.com',
  'booking.com': 'booking.com', 'booking': 'booking.com',
  'klarna': 'klarna.com', 'revolut': 'revolut.com', 'n26': 'n26.com',
  'wise': 'wise.com', 'monzo': 'monzo.com',
  'personio': 'personio.com', 'sumup': 'sumup.com',
  'zalando': 'zalando.com', 'otto': 'otto.de',
  'doctolib': 'doctolib.fr', 'contentsquare': 'contentsquare.com',
  'criteo': 'criteo.com', 'qonto': 'qonto.com', 'alan': 'alan.com',
  'typeform': 'typeform.com', 'factorial': 'factorialhr.com',
  'miro': 'miro.com', 'notion': 'notion.so', 'figma': 'figma.com',
  'canva': 'canva.com', 'vercel': 'vercel.com', 'netlify': 'netlify.com',
  'gitlab': 'gitlab.com', 'docker': 'docker.com', 'hashicorp': 'hashicorp.com',
  'hellofresh': 'hellofresh.com', 'hello fresh': 'hellofresh.com',
  'adyen': 'adyen.com', 'mollie': 'mollie.com',
}

/** Lowercase, trimmed, accents folded ("Crème Studio" → "creme studio"): the lookup key for a name. */
export function nameKey(company: string): string {
  return company.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/

export function guessDomain(company: string): string {
  const lower = nameKey(company)
  if (OVERRIDES[lower]) return OVERRIDES[lower]
  if (DOMAIN_RE.test(lower)) return lower

  // Word-boundary prefix match: an override key counts only when the company
  // name continues with a non-alphanumeric separator (e.g. "Google Cloud",
  // "Klarna Bank"). A bare letter-prefix must NOT match — otherwise short keys
  // hijack unrelated names ("Xero" → x.com, "Amdocs" → amd.com, "Sapient" →
  // sap.com). Those now fall through to the cleaned fallback instead.
  for (const [key, domain] of Object.entries(OVERRIDES)) {
    if (lower.startsWith(key)) {
      const next = lower[key.length]
      if (next === undefined || /[^a-z0-9]/.test(next)) return domain
    }
  }

  const cleaned = lower
    .replace(/\b(inc|llc|ltd|corp|group|technologies|technology|systems|solutions|co|gmbh|ag|sa|sas|plc|s\.a|s\.l)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
  return `${cleaned || 'unknown'}.com`
}

// Job-board hosts: a careers_url on one of these says nothing about the
// company's own domain.
const ATS_HOSTS = [
  'greenhouse.io', 'ashbyhq.com', 'lever.co', 'smartrecruiters.com', 'myworkdayjobs.com',
  'workable.com', 'teamtailor.com', 'personio.de', 'personio.com', 'recruitee.com',
  'successfactors.com', 'successfactors.eu', 'icims.com', 'taleo.net', 'jobvite.com',
  'bamboohr.com', 'join.com', 'linkedin.com', 'indeed.com', 'welcometothejungle.com',
]

/**
 * The company's own domain from a careers URL ("https://jobs.nimbus.app/…" →
 * nimbus.app), or null when the URL is on a job board or doesn't parse.
 */
export function domainFromCareersUrl(url: string): string | null {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return null }
  if (ATS_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return null
  host = host.replace(/^(www|jobs|careers|career|work|join)\./, '')
  return DOMAIN_RE.test(host) ? host : null
}

export interface PortalsLike {
  company_domains?: Record<string, unknown> | null
  tracked_companies?: Array<{ name?: unknown; careers_url?: unknown; domain?: unknown }> | null
}

export interface UserDomains {
  /** `company_domains` map and per-entry `domain:` keys: always win. */
  explicit: Record<string, string>
  /** Hosts of tracked companies' careers_url (job boards skipped). */
  careers: Record<string, string>
}

/** The user's name → domain maps from a parsed user/portals.yml, keyed by nameKey(). */
export function userDomains(portals: PortalsLike | null | undefined): UserDomains {
  const out: UserDomains = { explicit: {}, careers: {} }
  const clean = (d: unknown) => {
    const v = typeof d === 'string' ? d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
    return DOMAIN_RE.test(v) ? v : null
  }
  for (const c of portals?.tracked_companies ?? []) {
    if (typeof c?.name !== 'string') continue
    const own = clean(c.domain)
    if (own) out.explicit[nameKey(c.name)] = own
    const host = typeof c.careers_url === 'string' ? domainFromCareersUrl(c.careers_url) : null
    if (host) out.careers[nameKey(c.name)] = host
  }
  for (const [name, d] of Object.entries(portals?.company_domains ?? {})) {
    const v = clean(d)
    if (v) out.explicit[nameKey(name)] = v
  }
  return out
}

/**
 * The domain to fetch a company's logo from. A well-known brand keeps its
 * override even when its careers site lives on another domain, unless
 * the user named a domain for it explicitly.
 */
export function resolveLogoDomain(company: string, user?: UserDomains): string {
  const key = nameKey(company)
  return user?.explicit[key] ?? OVERRIDES[key] ?? user?.careers[key] ?? guessDomain(company)
}
