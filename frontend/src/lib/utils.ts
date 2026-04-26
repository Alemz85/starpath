import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function deadlineUrgency(deadline: string): 'urgent' | 'month' | 'upcoming' | 'missed' | 'none' {
  if (!deadline || deadline === 'n/d' || deadline === '—' || deadline === '') return 'none'
  if (deadline.toLowerCase() === 'rolling') return 'upcoming'

  const d = new Date(deadline)
  if (isNaN(d.getTime())) return 'none'

  const now = new Date()
  const diffDays = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return 'missed'
  if (diffDays <= 7) return 'urgent'
  if (diffDays <= 31) return 'month'
  return 'upcoming'
}

export function urgencyBadge(urgency: ReturnType<typeof deadlineUrgency>) {
  switch (urgency) {
    case 'urgent':   return { label: 'URGENT',     color: 'text-danger bg-danger/10 border-danger/30' }
    case 'month':    return { label: 'THIS MONTH',  color: 'text-warning bg-warning/10 border-warning/30' }
    case 'upcoming': return { label: 'UPCOMING',    color: 'text-info bg-info/10 border-info/30' }
    case 'missed':   return { label: 'MISSED',      color: 'text-text-4 bg-bg-elevated border-border-default' }
    default:         return null
  }
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function extractReportLink(mdLink: string): string | null {
  // [text](path) → path
  const match = mdLink.match(/\[.*?\]\((.*?)\)/)
  return match?.[1] ?? null
}

export function companyLogoUrl(company: string): string {
  const domainMap: Record<string, string> = {
    'Amazon':     'amazon.com',
    'Google':     'google.com',
    'Microsoft':  'microsoft.com',
    'Anthropic':  'anthropic.com',
    'OpenAI':     'openai.com',
    'Celonis':    'celonis.com',
    'Glovo':      'glovoapp.com',
    'Stripe':     'stripe.com',
    'Revolut':    'revolut.com',
    'N26':        'n26.com',
    'Factorial':  'factorialhr.com',
    'EY':         'ey.com',
    'Adyen':      'adyen.com',
    'HelloFresh': 'hellofresh.com',
    'SumUp':      'sumup.com',
  }
  const domain = domainMap[company] ?? `${slugify(company)}.com`
  return `https://logo.clearbit.com/${domain}`
}
