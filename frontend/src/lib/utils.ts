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

// Locale-aware relative time. Uses Intl.RelativeTimeFormat with
// numeric: 'auto' so today/yesterday render as words rather than
// "0 days ago" / "1 day ago".
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatRelative(iso: string, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const days = Math.floor((+now - +d) / (1000 * 60 * 60 * 24))
  if (Math.abs(days) < 7)   return RTF.format(-days, 'day')
  if (Math.abs(days) < 30)  return RTF.format(-Math.round(days / 7),  'week')
  if (Math.abs(days) < 365) return RTF.format(-Math.round(days / 30), 'month')
  return RTF.format(-Math.round(days / 365), 'year')
}

// Parse a deadline string to a LOCAL-midnight Date, or null when it isn't a
// real calendar date (empty, 'n/d', '—', 'rolling', or unparseable). A bare
// ISO date ("2026-06-30") is built from its Y/M/D components in local time —
// `new Date("2026-06-30")` would parse as UTC midnight, which lands on the
// previous day in any behind-UTC timezone and shifts the day-count math. This
// is the single source of truth both the urgency bucket and the card label
// build on, so they can never disagree about which day a deadline falls on.
export function parseDeadline(deadline: string): Date | null {
  const d = (deadline ?? '').trim()
  if (!d) return null
  const lower = d.toLowerCase()
  if (lower === 'n/d' || lower === '—' || lower === 'rolling') return null
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  const parsed = new Date(d)
  if (isNaN(parsed.getTime())) return null
  parsed.setHours(0, 0, 0, 0)
  return parsed
}

// Whole calendar days from `now`'s local midnight to the target's local
// midnight. Negative = in the past, 0 = today.
function daysUntil(target: Date, now: Date): number {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

export function deadlineUrgency(deadline: string, now: Date = new Date()): 'urgent' | 'month' | 'upcoming' | 'missed' | 'none' {
  if ((deadline ?? '').trim().toLowerCase() === 'rolling') return 'upcoming'
  const target = parseDeadline(deadline)
  if (!target) return 'none'

  const days = daysUntil(target, now)
  if (days < 0) return 'missed'
  if (days <= 7) return 'urgent'
  if (days <= 31) return 'month'
  return 'upcoming'
}

// Compact, precise deadline read for a card — "Today" / "Tomorrow" / "in 3d" /
// "Jun 30" / "Closed". Returns null when there's no real calendar date so the
// caller can fall back to the coarse urgency badge label (e.g. for Rolling).
export function deadlineLabel(deadline: string, now: Date = new Date()): string | null {
  const target = parseDeadline(deadline)
  if (!target) return null
  const days = daysUntil(target, now)
  if (days < 0)   return 'Closed'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days <= 14) return `in ${days}d`
  return target.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Sortable timestamp for a deadline; non-dates sink to the end (+Infinity).
export function deadlineTime(deadline: string): number {
  return parseDeadline(deadline)?.getTime() ?? Number.POSITIVE_INFINITY
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
