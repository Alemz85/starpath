import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDate,
  formatRelative,
  parseDeadline,
  deadlineUrgency,
  deadlineLabel,
  deadlineTime,
  urgencyBadge,
  slugify,
  extractReportLink,
  companyLogoUrl,
} from '@/lib/utils'

// Fixed local-noon clock. The deadline helpers parse dates to LOCAL midnight
// and diff against the local-midnight of `now`, so a local `NOW` keeps every
// day-count assertion exact and independent of the runner's timezone.
const NOW = new Date(2026, 5, 25, 12, 0, 0) // 2026-06-25, local noon

// ─── formatDate ──────────────────────────────────────────────────────────────

test('formatDate renders en-GB "DD Mon YYYY"', () => {
  // Midday-UTC so the local calendar day is the 30th in every real timezone.
  assert.equal(formatDate('2026-06-30T12:00:00Z'), '30 Jun 2026')
})

test('formatDate keeps a date-only string in the en-GB shape', () => {
  assert.match(formatDate('2026-06-30'), /^\d{2} \w{3,4} \d{4}$/)
})

test('formatDate is forgiving: empty → dash, garbage → echoed back', () => {
  assert.equal(formatDate(''), '—')
  assert.equal(formatDate('not-a-date'), 'not-a-date')
})

// ─── formatRelative (clock injected) ─────────────────────────────────────────

const REL_NOW = new Date('2026-06-25T00:00:00Z')

test('formatRelative: empty → dash, garbage → echoed back', () => {
  assert.equal(formatRelative(''), '—')
  assert.equal(formatRelative('nope'), 'nope')
})

test('formatRelative picks the day/week/month/year bucket by distance', () => {
  // Non-auto magnitudes keep their digit across locales (en "3 days ago",
  // es "hace 3 días"), so assert on the number rather than the locale word.
  assert.match(formatRelative('2026-06-22T00:00:00Z', REL_NOW), /3/) // 3 days
  assert.match(formatRelative('2026-06-04T00:00:00Z', REL_NOW), /3/) // 21d → 3 weeks
  assert.match(formatRelative('2026-03-27T00:00:00Z', REL_NOW), /3/) // 90d → 3 months
  assert.match(formatRelative('2024-04-18T00:00:00Z', REL_NOW), /2/) // ~2 years
})

test('formatRelative handles the future direction', () => {
  assert.match(formatRelative('2026-06-28T00:00:00Z', REL_NOW), /3/) // in 3 days
})

// ─── parseDeadline (timezone-safe; the regression guard) ─────────────────────

test('parseDeadline builds a LOCAL-midnight date from a bare ISO day', () => {
  const d = parseDeadline('2026-06-30')!
  assert.ok(d instanceof Date)
  // Read local components — `new Date("2026-06-30")` would be UTC midnight and
  // land on Jun 29 in any behind-UTC zone; the local constructor never does.
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 5) // June (0-based)
  assert.equal(d.getDate(), 30)
  assert.equal(d.getHours(), 0)
})

test('parseDeadline returns null for non-dates', () => {
  for (const v of ['', '   ', 'n/d', 'N/D', '—', 'rolling', 'Rolling', 'tbd']) {
    assert.equal(parseDeadline(v), null, `expected null for ${JSON.stringify(v)}`)
  }
})

// ─── deadlineUrgency (bucket thresholds, clock injected) ─────────────────────

test('deadlineUrgency: rolling is always upcoming, non-dates are none', () => {
  assert.equal(deadlineUrgency('rolling', NOW), 'upcoming')
  assert.equal(deadlineUrgency('Rolling', NOW), 'upcoming')
  assert.equal(deadlineUrgency('', NOW), 'none')
  assert.equal(deadlineUrgency('n/d', NOW), 'none')
  assert.equal(deadlineUrgency('—', NOW), 'none')
})

test('deadlineUrgency buckets by days-until at the exact boundaries', () => {
  assert.equal(deadlineUrgency('2026-06-20', NOW), 'missed')   // past
  assert.equal(deadlineUrgency('2026-06-25', NOW), 'urgent')   // today (0d)
  assert.equal(deadlineUrgency('2026-07-02', NOW), 'urgent')   // +7d (inclusive)
  assert.equal(deadlineUrgency('2026-07-03', NOW), 'month')    // +8d
  assert.equal(deadlineUrgency('2026-07-26', NOW), 'month')    // +31d (inclusive)
  assert.equal(deadlineUrgency('2026-07-27', NOW), 'upcoming') // +32d
})

// ─── deadlineLabel (compact card read, clock injected) ───────────────────────

test('deadlineLabel reads the nearest dates as words', () => {
  assert.equal(deadlineLabel('2026-06-20', NOW), 'Closed')
  assert.equal(deadlineLabel('2026-06-25', NOW), 'Today')
  assert.equal(deadlineLabel('2026-06-26', NOW), 'Tomorrow')
  assert.equal(deadlineLabel('2026-06-28', NOW), 'in 3d')
  assert.equal(deadlineLabel('2026-07-09', NOW), 'in 14d') // +14d (inclusive)
})

test('deadlineLabel falls back to a "Mon D" date past two weeks', () => {
  const label = deadlineLabel('2026-07-10', NOW)! // +15d
  assert.ok(label && !['Today', 'Tomorrow', 'Closed'].includes(label))
  assert.doesNotMatch(label, /^in /)
  assert.match(label, /10/) // day-of-month survives any locale's month name
})

test('deadlineLabel returns null when there is no real date', () => {
  assert.equal(deadlineLabel('rolling', NOW), null)
  assert.equal(deadlineLabel('n/d', NOW), null)
  assert.equal(deadlineLabel('', NOW), null)
})

// ─── deadlineTime (sort key) ─────────────────────────────────────────────────

test('deadlineTime mirrors parseDeadline and sinks non-dates to +Infinity', () => {
  assert.equal(deadlineTime('2026-06-30'), parseDeadline('2026-06-30')!.getTime())
  assert.equal(deadlineTime('rolling'), Number.POSITIVE_INFINITY)
  assert.equal(deadlineTime('n/d'), Number.POSITIVE_INFINITY)
  assert.equal(deadlineTime(''), Number.POSITIVE_INFINITY)
  // Earlier deadline sorts before a later one; both before a non-date.
  assert.ok(deadlineTime('2026-06-20') < deadlineTime('2026-06-30'))
  assert.ok(deadlineTime('2026-06-30') < deadlineTime('rolling'))
})

// ─── urgencyBadge ────────────────────────────────────────────────────────────

test('urgencyBadge maps every live bucket to a label + color, none → null', () => {
  assert.equal(urgencyBadge('urgent')?.label, 'URGENT')
  assert.equal(urgencyBadge('month')?.label, 'THIS MONTH')
  assert.equal(urgencyBadge('upcoming')?.label, 'UPCOMING')
  assert.equal(urgencyBadge('missed')?.label, 'MISSED')
  assert.ok(urgencyBadge('urgent')?.color.includes('text-danger'))
  assert.equal(urgencyBadge('none'), null)
})

// ─── slugify ─────────────────────────────────────────────────────────────────

test('slugify lowercases, collapses non-alphanumerics, trims edge dashes', () => {
  assert.equal(slugify('Hello World!'), 'hello-world')
  assert.equal(slugify('  Acme  Corp.  '), 'acme-corp')
  assert.equal(slugify('a_b/c'), 'a-b-c')
  assert.equal(slugify('C++'), 'c')
})

// ─── extractReportLink ───────────────────────────────────────────────────────

test('extractReportLink pulls the path out of a markdown link', () => {
  assert.equal(extractReportLink('[42](reports/tier-1/x.md)'), 'reports/tier-1/x.md')
  assert.equal(extractReportLink('[a](one) [b](two)'), 'one') // first, non-greedy
  assert.equal(extractReportLink('no link here'), null)
})

// ─── companyLogoUrl ──────────────────────────────────────────────────────────

test('companyLogoUrl uses the known-domain map, else a slugified guess', () => {
  assert.equal(companyLogoUrl('Google'), 'https://logo.clearbit.com/google.com')
  assert.equal(companyLogoUrl('Glovo'), 'https://logo.clearbit.com/glovoapp.com')
  assert.equal(companyLogoUrl('Some New Co'), 'https://logo.clearbit.com/some-new-co.com')
})
