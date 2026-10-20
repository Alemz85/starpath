// Listing dates — when a listing closes, was posted, or was first scanned.
//
// The dates live in data/scan-history.tsv (`deadline`, `posted_date`,
// `first_seen`), joined to a listing by canonical URL, then by company + role.
// Main does the join with the repo's own `indexListingDates`
// (scripts/lib/merge-staging-core.mjs) behind the `listings:dates` IPC, so the
// URL canonicalisation is never re-implemented here. This module holds the
// shared shapes plus the pure readers the views use: which date a card shows
// (`dateCue`) and the posting date Trends buckets by. Keep it free of
// zustand/ipc/React (Electron main imports its types).

import { livenessKey } from '@/lib/scanHistory'
import { parseDeadline } from '@/lib/utils'
import type { ApplicationEntry, ScoreEntry } from '@/types'

/** One listing's dates from scan-history (ISO days, null when absent). */
export interface ListingDates {
  deadline: string | null
  postedDate: string | null
  firstSeen: string | null
}

/** One lookup: `key` is echoed back as the map key (`listingDateKey`). */
export interface ListingDatesQuery {
  key: string
  url?: string
  company: string
  role: string
}

/** key → dates; listings scan-history doesn't know are absent. */
export type ListingDatesMap = Record<string, ListingDates>

/** The store's key for a listing: the same company|role key as liveness. */
export const listingDateKey = (company: string, role: string): string => livenessKey(company, role)

/** One query per distinct listing among the applications and the evaluated
 *  listings, carrying the newest known URL (score-history has it; an
 *  application row only links its report). */
export function buildListingDateQueries(
  applications: Pick<ApplicationEntry, 'company' | 'role'>[],
  scoreHistory: Pick<ScoreEntry, 'company' | 'role' | 'url' | 'date'>[],
): ListingDatesQuery[] {
  const byKey = new Map<string, ListingDatesQuery & { urlDate: string }>()
  const add = (company: string, role: string, url: string, date: string) => {
    if (!company || !role) return
    const key = listingDateKey(company, role)
    const seen = byKey.get(key)
    const goodUrl = /^https?:\/\//i.test(url ?? '') ? url : ''
    if (!seen) {
      byKey.set(key, { key, company, role, url: goodUrl || undefined, urlDate: goodUrl ? date : '' })
      return
    }
    if (goodUrl && (date ?? '') >= seen.urlDate) { seen.url = goodUrl; seen.urlDate = date ?? '' }
  }
  for (const r of scoreHistory) add(r.company, r.role, r.url, r.date)
  for (const a of applications) add(a.company, a.role, '', '')
  return [...byKey.values()].map(({ urlDate: _u, ...q }) => q)
}

/** The posting date scan-history has for a listing, or null. */
export function postedDateOf(map: ListingDatesMap, company: string, role: string): string | null {
  return map[listingDateKey(company, role)]?.postedDate ?? null
}

// ─── Card date cue ───────────────────────────────────────────────────────────

export type DateCueKind = 'deadline' | 'posted' | 'scanned'

export interface DateCue {
  kind: DateCueKind
  /** ISO day. */
  date: string
  /** Whole days from today to `date`: positive = ahead, negative = past. */
  days: number
  /** Short card label: "12d", "3mo", "today", or "5d ago" for a passed deadline. */
  label: string
  /** The tooltip: what the date is, the date itself, and how far away. */
  title: string
  /** A deadline still ahead and within a week. */
  soon: boolean
}

const KIND_TITLE: Record<DateCueKind, string> = {
  deadline: 'Application deadline',
  posted: 'Posted',
  scanned: 'First seen in a scan',
}

function isoDay(raw: string | null | undefined): string | null {
  const d = parseDeadline(raw ?? '')
  if (!d) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function daysFrom(now: Date, iso: string): number {
  const a = new Date(now); a.setHours(0, 0, 0, 0)
  const [y, m, d] = iso.split('-').map(Number)
  const b = new Date(y, m - 1, d)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** "12d" under two months, "3mo" under two years, "2y" beyond. */
export function compactSpan(days: number): string {
  const n = Math.abs(days)
  if (n === 0) return 'today'
  if (n < 60) return `${n}d`
  if (n < 730) return `${Math.round(n / 30)}mo`
  return `${Math.round(n / 365)}y`
}

function longSpan(days: number): string {
  const n = Math.abs(days)
  if (n === 0) return 'today'
  const unit = `${n} day${n === 1 ? '' : 's'}`
  return days > 0 ? `in ${unit}` : `${unit} ago`
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The one date a card shows, in order of availability: the application
 * deadline (the row's own Deadline cell when it holds a real date, else the
 * scan's), else the posting date, else the first-scan date. Null when none is
 * known.
 */
export function dateCue(
  app: Pick<ApplicationEntry, 'deadline'>,
  dates: ListingDates | null | undefined,
  now: Date = new Date(),
): DateCue | null {
  const candidates: Array<[DateCueKind, string | null]> = [
    ['deadline', isoDay(app.deadline) ?? isoDay(dates?.deadline)],
    ['posted', isoDay(dates?.postedDate)],
    ['scanned', isoDay(dates?.firstSeen)],
  ]
  const hit = candidates.find(([, d]) => d)
  if (!hit) return null
  const [kind, date] = hit as [DateCueKind, string]
  const days = daysFrom(now, date)
  const span = compactSpan(days)
  const label = kind === 'deadline' && days < 0 ? `${span} ago` : span
  const note = kind === 'scanned' ? ' (no posting date on file)' : ''
  return {
    kind,
    date,
    days,
    label,
    title: `${KIND_TITLE[kind]} ${longDate(date)} · ${longSpan(days)}${note}`,
    soon: kind === 'deadline' && days >= 0 && days <= 7,
  }
}
