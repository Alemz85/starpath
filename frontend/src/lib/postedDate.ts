// The posting date of a listing: which of the three places that can know it
// wins, and how the report's `**Posted:**` header line is read.
//
//   1. scan-history `posted_date` (the job board's own date, via `listings:dates`)
//   2. the evaluation report's `**Posted:** YYYY-MM-DD` header line (the only
//      source for a listing the user added by URL, which never passed a scan)
//   3. the evaluation date (a last resort the caller may choose not to show)
//
// Pure and dependency-free so the Trends chart and the report slide-over share
// one rule. Nothing here ever invents a date: anything that is not a real
// calendar day is treated as absent.

export type PostedSource = 'scan' | 'report' | 'evaluated'

export interface PostedPick {
  /** ISO day (YYYY-MM-DD). */
  date: string
  source: PostedSource
}

/** The leading `YYYY-MM-DD` of `raw` when it is a real calendar day, else
 *  null. Trailing text (`2026-10-02 (from the ATS)`, a `T…` timestamp) is
 *  ignored; `n/d`, `—`, empty, `Oct 2`, `2026-02-30` are null. */
export function isoDayOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(raw.replace(/^[*_`\s]+/, ''))
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** The date in a report's `**Posted:**` header line, or null (no line, `n/d`,
 *  `—`, empty, not a date). Only the header block counts: the search stops at
 *  the first `## ` heading so a body table cell can't be mistaken for it. */
export function parseReportPosted(md: string | null | undefined): string | null {
  if (!md) return null
  const body = md.split(/^##\s/m, 1)[0]
  const m = /^[ \t]*\*\*Posted:\*\*[ \t]*(.*)$/im.exec(body)
  return m ? isoDayOf(m[1]) : null
}

/**
 * Scan-history posting date, else the report's, else the evaluation date.
 * Each input may be missing or malformed (it is validated here); null when
 * none is a real day.
 */
export function pickPostedDate(input: {
  scanPosted?: string | null
  reportPosted?: string | null
  evaluated?: string | null
}): PostedPick | null {
  const scan = isoDayOf(input.scanPosted)
  if (scan) return { date: scan, source: 'scan' }
  const report = isoDayOf(input.reportPosted)
  if (report) return { date: report, source: 'report' }
  const evaluated = isoDayOf(input.evaluated)
  return evaluated ? { date: evaluated, source: 'evaluated' } : null
}
