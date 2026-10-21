// One rule for "which report file belongs to this listing". Every surface that
// ties a report to a listing (the report slide-over, the chat cards, the
// Database row and popover, the Reports list, the cache sync) goes through
// here, so they can't disagree.
//
// A listing is (company, role) exactly as the trackers spell it. Its report is
// found by, in order:
//   1. the report link already stored in the listing's tracker row
//      (`applications.md` / `scouting.md` Report cell), raw or percent-encoded;
//   2. the file name, compared after the clean-up `modes/scouting.md`
//      § File Naming applies when it writes `{Company} - {Role}.md`: drop
//      ( ) [ ] : / \ ? * " < > | and collapse spaces. So a role written
//      "Data Analyst (Lyon, autumn start)" finds
//      `Data Analyst Lyon, autumn start.md`.
// Nothing looser than that: a listing never borrows another listing's report.
//
// Pure, no I/O.

import type { ReportFile } from '@/types'

/** The characters `modes/scouting.md` § File Naming drops from a file name. */
const FILENAME_DROP = /[()[\]:/\\?*"<>|]/g

function cleanPart(s: string): string {
  return s.replace(FILENAME_DROP, '').replace(/\s+/g, ' ').trim()
}

/** `{Company} - {Role}` as the scouting mode writes it to disk (no `.md`). */
export function reportFileStem(company: string, role: string): string {
  return `${cleanPart(company)} - ${cleanPart(role)}`
}

/** Comparison key for a listing or a report: the cleaned name, case-folded. */
export function reportKey(company: string, role: string): string {
  return `${cleanPart(company).toLowerCase()}|${cleanPart(role).toLowerCase()}`
}

/** Same listing, by the file-name rule (case, spacing and dropped characters ignored). */
export function sameReportListing(a: { company: string; role: string }, b: { company: string; role: string }): boolean {
  return reportKey(a.company, a.role) === reportKey(b.company, b.role)
}

/** A relative path in the one form paths are compared in: decoded, forward
 *  slashes, no leading `./`. */
export function normalizeReportPath(p: string): string {
  let out = p.trim()
  try { out = decodeURIComponent(out) } catch {
    try { out = decodeURI(out) } catch { /* keep as written */ }
  }
  return out.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * The target of a tracker Report cell (`[12](reports/tier-1/Foo - Bar.md)`),
 * decoded, or null when the cell holds no `.md` link (`—`, empty).
 * Handles literal parentheses inside the target (balanced), `<…>` targets and
 * percent-encoding (`%28Madrid%29`, `%20`).
 */
export function reportLinkTarget(cell: string | null | undefined): string | null {
  const s = String(cell ?? '')
  const start = s.indexOf('](')
  if (start < 0) return null
  let depth = 1
  let i = start + 2
  for (; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) break }
  }
  if (depth !== 0) return null
  let target = s.slice(start + 2, i).trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim()
  if (!/\.md$/i.test(target)) return null
  return normalizeReportPath(target)
}

/** A tracker row as far as report matching cares. */
export interface ReportLinkRow {
  company: string
  role: string
  report?: string
}

/** The report links the trackers hold for this listing, in row order, deduped. */
export function trackerReportLinks(rows: ReportLinkRow[] | undefined, company: string, role: string): string[] {
  const out: string[] = []
  for (const r of rows ?? []) {
    if (!sameReportListing(r, { company, role })) continue
    const t = reportLinkTarget(r.report)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * The listing's report among the known report files, or null.
 * `rows` are the tracker rows (scouting + applications) whose Report links are
 * tried first; without them only the file-name rule applies.
 */
export function resolveReport<R extends Pick<ReportFile, 'path' | 'company' | 'role'>>(
  reports: R[],
  listing: { company: string; role: string },
  rows?: ReportLinkRow[],
): R | null {
  const links = trackerReportLinks(rows, listing.company, listing.role)
  for (const link of links) {
    const hit = reports.find(r => normalizeReportPath(r.path) === link)
    if (hit) return hit
  }
  return reports.find(r => sameReportListing(r, listing)) ?? null
}

export const REPORT_TIER_DIRS = ['tier-1', 'tier-2', 'tier-3', 'tier-4'] as const

/**
 * Paths to probe on disk for the listing's report when no index is at hand,
 * most specific first: the tracker links, then each tier folder with the name
 * as written and as cleaned, then the legacy flat `reports/` folder.
 */
export function reportPathCandidates(company: string, role: string, rows?: ReportLinkRow[]): string[] {
  const raw = `${company} - ${role}`
  const clean = reportFileStem(company, role)
  const stems = raw === clean ? [clean] : [raw, clean]
  const out = [...trackerReportLinks(rows, company, role)]
  const add = (p: string) => { if (!out.includes(p)) out.push(p) }
  for (const dir of REPORT_TIER_DIRS) for (const stem of stems) add(`reports/${dir}/${stem}.md`)
  for (const stem of stems) add(`reports/${stem}.md`)
  return out
}

/** The listing's file under another folder that mirrors the report naming
 *  (`interview-prep/`): the name as written, then as cleaned. */
export function mirroredPathCandidates(folder: string, company: string, role: string, ext = '.md'): string[] {
  const raw = `${folder}/${company} - ${role}${ext}`
  const clean = `${folder}/${reportFileStem(company, role)}${ext}`
  return raw === clean ? [clean] : [raw, clean]
}

/**
 * Company and role from a report's own title (`# Scouting: {Company} — {Role}`,
 * `# Gap & Growth: …`, or a bare `# {Company} — {Role}`). The title keeps the
 * exact role the trackers use, parentheses included, which the file name
 * can't. Null when there is no such title.
 */
export function reportTitle(markdown: string): { company: string; role: string } | null {
  const m = /^#[ \t]+(.+)$/m.exec(markdown)
  if (!m) return null
  const title = m[1].trim().replace(/^(?:Scouting|Gap\s*&\s*Growth)\s*:\s*/i, '')
  const sep = /\s+[—–]\s+/.exec(title)
  if (!sep) return null
  const company = title.slice(0, sep.index).trim()
  const role = title.slice(sep.index + sep[0].length).trim()
  return company && role ? { company, role } : null
}

/**
 * The listing a report file belongs to: the title's spelling when it names the
 * same listing as the file name (so `… (Madrid)` survives the file-name
 * clean-up), else the file name's.
 */
export function reportIdentity(
  fromPath: { company: string; role: string },
  markdown: string,
): { company: string; role: string } {
  const title = reportTitle(markdown)
  if (title && sameReportListing(title, fromPath)) return title
  return { company: fromPath.company, role: fromPath.role }
}
