// Company name → domain heuristic, feeding the logo fetcher
// (CompanyLogo → ipc.fetchLogo(domain)). Pure and dependency-free so the
// guessing logic — which decides whether a company's real logo loads or it
// falls back to initials — is unit-testable in isolation.
//
// Three passes, in order:
//   1. exact override (lowercased, trimmed)
//   2. word-boundary prefix override ("Google Cloud" → google.com)
//   3. cleaned fallback (strip legal/suffix noise, dot-com it)

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
  'red bull': 'redbull.com', 'redbull': 'redbull.com',
  'booking.com': 'booking.com', 'booking': 'booking.com',
  'klarna': 'klarna.com', 'revolut': 'revolut.com', 'n26': 'n26.com',
  'wise': 'wise.com', 'monzo': 'monzo.com',
  'delivery hero': 'deliveryhero.com', 'deliveroo': 'deliveroo.com', 'glovo': 'glovoapp.com',
  'celonis': 'celonis.com', 'personio': 'personio.com', 'sumup': 'sumup.com',
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

export function guessDomain(company: string): string {
  const lower = company.toLowerCase().trim()
  if (OVERRIDES[lower]) return OVERRIDES[lower]

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
