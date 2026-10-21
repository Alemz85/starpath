// The lookups behind the chat's reference cards: each card carries only a key
// (company + role, a company, a day window) and reads the live rows from the
// data store through these. Pure, so the matching rules are tested without
// React.

import { sameKey } from '@/lib/chat/blocks'
import { buildTodaySummary, type DeadlineItem } from '@/lib/todayCockpit'
import { latestPerListing } from '@/lib/trendsAnalytics'
import type { ApplicationEntry, ReportFile, ScoreEntry, ScoutingEntry } from '@/types'
import { resolveReport, type ReportLinkRow } from '@/lib/reportMatch'

const matches = (row: { company: string; role: string }, company: string, role: string) =>
  sameKey(row.company, company) && sameKey(row.role, role)

export function findApplication(apps: ApplicationEntry[], company: string, role: string): ApplicationEntry | null {
  return apps.find(a => matches(a, company, role)) ?? null
}

/** The listing's latest evaluation (score-history is append-only, so a
 *  re-score is a second row). Undated rows rank oldest. */
export function latestEvaluation(history: ScoreEntry[], company: string, role: string): ScoreEntry | null {
  let best: ScoreEntry | null = null
  for (const e of history) {
    if (!matches(e, company, role)) continue
    if (!best || (e.date ?? '') >= (best.date ?? '')) best = e
  }
  return best
}

export function findScouting(rows: ScoutingEntry[], company: string, role: string): ScoutingEntry | null {
  let best: ScoutingEntry | null = null
  for (const r of rows) {
    if (matches(r, company, role) && (!best || r.num > best.num)) best = r
  }
  return best
}

/** The listing's report file: by the tracker row's report link, then the
 *  file-name rule (lib/reportMatch), so a role with parentheses still finds a
 *  file saved without them. */
export function findReport(
  reports: ReportFile[],
  company: string,
  role: string,
  trackerRows?: ReportLinkRow[],
): ReportFile | null {
  return resolveReport(reports, { company, role }, trackerRows)
}

/** One role at a company, as the company card lists it. */
export interface CompanyRow {
  role: string
  match: number | null
  ease: number | null
  evaluation: ScoreEntry | null
  application: ApplicationEntry | null
}

/** Everything known about one company: every evaluated role (its latest
 *  evaluation) joined with its application row, applications first, then by
 *  Priority. The company name is taken as the trackers spell it. */
export function companyOverview(
  history: ScoreEntry[],
  apps: ApplicationEntry[],
  company: string,
): { name: string; rows: CompanyRow[]; evaluated: number; applied: number } | null {
  const evaluations = latestPerListing(history.filter(e => sameKey(e.company, company)))
  const applications = apps.filter(a => sameKey(a.company, company))
  if (evaluations.length === 0 && applications.length === 0) return null

  const rows: CompanyRow[] = []
  const seen = new Set<string>()
  for (const application of applications) {
    const evaluation = evaluations.find(e => sameKey(e.role, application.role)) ?? null
    seen.add(application.role.trim().toLowerCase())
    rows.push({
      role: application.role,
      match: evaluation?.match ?? null,
      ease: evaluation?.ease ?? null,
      evaluation,
      application,
    })
  }
  for (const evaluation of evaluations) {
    if (seen.has(evaluation.role.trim().toLowerCase())) continue
    seen.add(evaluation.role.trim().toLowerCase())
    rows.push({ role: evaluation.role, match: evaluation.match, ease: evaluation.ease, evaluation, application: null })
  }
  const priority = (r: CompanyRow) => (r.match ?? 0) * (r.ease ?? 0)
  rows.sort((a, b) =>
    Number(!!b.application) - Number(!!a.application) || priority(b) - priority(a) || a.role.localeCompare(b.role))

  const name = applications[0]?.company ?? evaluations[0]?.company ?? company
  return { name, rows, evaluated: evaluations.length, applied: applications.length }
}

/** Deadlines of applications not yet sent, due within `days` (0 = today). */
export function deadlinesWithin(apps: ApplicationEntry[], days: number, now: Date = new Date()): DeadlineItem[] {
  return buildTodaySummary(apps, now).deadlines.filter(d => d.daysLeft <= days)
}

/** Today as YYYY-MM-DD in local time — the latest date a status change may carry. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
