// Today cockpit aggregation — upcoming deadlines + where applications stand.
//
// Pure synthesis layer for the Today view. Given the parsed applications
// tracker it produces:
//   - the deadline list: every listing the user has decided to apply to (an
//     applications.md row still at `Evaluated`, i.e. not yet sent) whose
//     deadline is today or later, soonest first;
//   - the two "waiting on them" counts: applications sent with no reply yet
//     (`Applied`) and processes waiting on the next interview round
//     (`Interview` — mid-process or all rounds done).
//
// Everything here is a pure function of its inputs — no filesystem, no DOM, no
// zustand, and an injectable `now` clock — so it is unit-testable. The view
// (`components/today/`) owns the I/O and the navigation wiring.

import { parseDeadline } from './utils'
import { livenessKey } from './scanHistory'
import type { ApplicationEntry } from '@/types'

const DAY_MS = 1000 * 60 * 60 * 24

/** Deadlines this close (in days) count as urgent — the danger tone in the view
 *  and the number on the sidebar badge. */
export const URGENT_DAYS = 7

/** Statuses for which a deadline still matters: decided to apply, not yet sent. */
const PRE_SUBMISSION: ReadonlySet<string> = new Set(['Evaluated'])

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DeadlineItem {
  /** Stable key for React lists — company|role. */
  id: string
  company: string
  role: string
  /** The tracker's deadline cell, verbatim (ISO in practice). */
  deadline: string
  /** Local-midnight Date the deadline parsed to. */
  date: Date
  /** Whole days until the deadline; 0 = closes today. */
  daysLeft: number
  /** critical ≤2d · high ≤7d · medium ≤31d · low beyond. */
  severity: 'critical' | 'high' | 'medium' | 'low'
}

export interface TodaySummary {
  /** Upcoming deadlines, soonest first (ties broken by company). */
  deadlines: DeadlineItem[]
  /** Deadlines within URGENT_DAYS — drives the sidebar badge. */
  urgent: number
  /** Applications sent, no response yet (`Applied`). */
  awaitingResponse: number
  /** Interview processes waiting on the next round (`Interview`). */
  awaitingNextRound: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntil(target: Date, now: Date): number {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / DAY_MS)
}

function severityFor(days: number): DeadlineItem['severity'] {
  if (days <= 2) return 'critical'
  if (days <= URGENT_DAYS) return 'high'
  if (days <= 31) return 'medium'
  return 'low'
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

/**
 * Build the Today summary from the applications tracker.
 * @param applications  parsed data/applications.md rows
 * @param now           injectable clock (defaults to real time) for deterministic tests
 */
export function buildTodaySummary(applications: ApplicationEntry[], now: Date = new Date()): TodaySummary {
  const deadlines: DeadlineItem[] = []
  const seen = new Set<string>()
  let awaitingResponse = 0
  let awaitingNextRound = 0

  for (const a of applications) {
    if (a.status === 'Applied') awaitingResponse++
    if (a.status === 'Interview') awaitingNextRound++

    if (!PRE_SUBMISSION.has(a.status)) continue
    const date = parseDeadline(a.deadline)
    if (!date) continue                 // rolling / n/d — no date to list
    const daysLeft = daysUntil(date, now)
    if (daysLeft < 0) continue          // already closed

    const id = livenessKey(a.company, a.role)
    if (seen.has(id)) continue
    seen.add(id)
    deadlines.push({
      id,
      company: a.company,
      role: a.role,
      deadline: a.deadline,
      date,
      daysLeft,
      severity: severityFor(daysLeft),
    })
  }

  deadlines.sort((x, y) => (x.daysLeft - y.daysLeft) || x.company.localeCompare(y.company))

  return {
    deadlines,
    urgent: deadlines.filter(d => d.daysLeft <= URGENT_DAYS).length,
    awaitingResponse,
    awaitingNextRound,
  }
}
