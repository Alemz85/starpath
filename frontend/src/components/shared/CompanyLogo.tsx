'use client'

import { useState } from 'react'

// ─── Domain guessing ─────────────────────────────────────────────────────────

const OVERRIDES: Record<string, string> = {
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
}

export function guessDomain(company: string): string {
  const lower = company.toLowerCase().trim()
  if (OVERRIDES[lower]) return OVERRIDES[lower]
  for (const [key, domain] of Object.entries(OVERRIDES)) {
    if (lower.startsWith(key)) return domain
  }
  const cleaned = lower
    .replace(/\b(inc|llc|ltd|corp|group|technologies|technology|systems|solutions|co|gmbh|ag|sa|sas|plc|s\.a|s\.l)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
  return `${cleaned || 'unknown'}.com`
}

// ─── Avatar fallback ─────────────────────────────────────────────────────────

const PALETTE: [string, string][] = [
  ['#7C5CFF', '#4A2FA8'], ['#E8B547', '#A8822A'], ['#5CDB8B', '#2E8B57'],
  ['#C77B3B', '#8B4513'], ['#DB5C7A', '#8B2A4A'], ['#5CB8DB', '#2A7A8B'],
  ['#9B5CDB', '#6A2FA8'],
]

function hashPalette(name: string): [string, string] {
  let h = 0
  for (const c of name) h = ((h * 31) + c.charCodeAt(0)) & 0xffff
  return PALETTE[h % PALETTE.length]
}

function initials(company: string): string {
  return company
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?'
}

// ─── Component ────────────────────────────────────────────────────────────────

interface CompanyLogoProps {
  company: string
  size?: number
  className?: string
}

// Three-stage cascade: Clearbit (high-res) → Google favicons (always available) → initials
type Stage = 'clearbit' | 'google' | 'fallback'

export function CompanyLogo({ company, size = 20, className }: CompanyLogoProps) {
  const [stage, setStage] = useState<Stage>('clearbit')
  const domain = guessDomain(company)
  const radius = size <= 16 ? 3 : size <= 24 ? 4 : 6
  const [from, to] = hashPalette(company)
  const abbr = initials(company)
  const fontSize = Math.round(size * 0.38)

  if (stage === 'fallback') {
    return (
      <div
        className={className}
        style={{
          width: size, height: size, minWidth: size, borderRadius: radius,
          background: `linear-gradient(135deg, ${from}, ${to})`,
          fontSize, fontWeight: 600, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          userSelect: 'none', letterSpacing: '-0.01em',
        }}
      >
        {abbr}
      </div>
    )
  }

  const src = stage === 'clearbit'
    ? `https://logo.clearbit.com/${domain}`
    : `https://www.google.com/s2/favicons?domain=${domain}&sz=128`

  return (
    <div
      className={className}
      style={{
        width: size, height: size, minWidth: size, borderRadius: radius,
        background: stage === 'clearbit' && size >= 20 ? '#fff' : 'transparent',
        overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <img
        key={stage}
        src={src}
        alt={company}
        width={size}
        height={size}
        style={{ objectFit: 'contain', width: '100%', height: '100%' }}
        onError={() => setStage(stage === 'clearbit' ? 'google' : 'fallback')}
      />
    </div>
  )
}
