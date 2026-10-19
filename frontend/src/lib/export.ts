// Tabular export for the Database lens. Serializes the currently-filtered
// score-history entities to CSV (download) or TSV (clipboard → pastes
// cleanly into Sheets/Excel). Pure + renderer-only: the download goes
// through a Blob + synthetic anchor click so no Electron IPC is involved.

import type { ScoreEntry } from '@/types'
import { canonicalizeArchetype } from './archetype'
import { parseEligibilityFlags, verdictOf } from './scoreBands'

export interface ExportColumn {
  header: string
  value: (e: ScoreEntry) => string
}

// Two-decimal score (Want / Ease are stored to 2dp), or blank when missing
// (blocked / unscored). Blank rather than "0.00" so the spreadsheet treats it
// as missing, not as a real zero that would skew downstream averages.
const score = (n: number | null | undefined): string =>
  typeof n === 'number' && n > 0 ? String(Math.round(n * 100) / 100) : ''

// The scouting.md Eligibility cell form (docs/scoring-v2.md §8.2): `green`,
// `amber: <reasons ;-joined>`, `red: <reason>`.
const eligibilityCell = (e: ScoreEntry): string => {
  if (!e.eligibility) return ''
  if (e.eligibility === 'green') return 'green'
  const reasons = parseEligibilityFlags(e.eligibility_flags)
    .filter(f => f.status === e.eligibility)
    .map(f => f.reason)
    .filter(Boolean)
  return reasons.length ? `${e.eligibility}: ${reasons.join('; ')}` : e.eligibility
}

// Mirrors the columns a user actually reads in the OffersTable, plus the
// raw URL (the table only shows it as an icon). Archetype is canonicalized
// to match the chip the table renders, not the verbose backend string.
export const DATABASE_EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'Company',          value: e => e.company },
  { header: 'Role',             value: e => e.role },
  { header: 'Want',             value: e => score(e.want) },
  { header: 'Ease',             value: e => score(e.ease) },
  { header: 'Eligibility',      value: eligibilityCell },
  { header: 'Verdict',          value: e => verdictOf(e) ?? '' },
  { header: 'Tier',             value: e => e.tier || '' },
  { header: 'Location',         value: e => e.location || '' },
  { header: 'Archetype',        value: e => canonicalizeArchetype(e.archetype) },
  { header: 'Liveness',         value: e => e.livenessState ?? 'active' },
  { header: 'Added',            value: e => e.date || '' },
  { header: 'URL',              value: e => e.url || '' },
]

// RFC-4180 CSV escaping: quote a field when it carries a comma, quote, or
// line break; escape embedded quotes by doubling them.
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// The clipboard-TSV convention Sheets/Excel expect has no quoting, so a
// literal tab or newline inside a cell would shift the columns. Collapse
// any such whitespace to a single space.
function tsvCell(v: string): string {
  return v.replace(/[\t\r\n]+/g, ' ')
}

export function serializeRows(
  rows: ScoreEntry[],
  format: 'csv' | 'tsv',
  columns: ExportColumn[] = DATABASE_EXPORT_COLUMNS,
): string {
  const delim = format === 'csv' ? ',' : '\t'
  const esc   = format === 'csv' ? csvCell : tsvCell
  // CRLF for the downloaded CSV (Excel-on-Windows friendly); LF for the
  // clipboard payload, which every spreadsheet handles on paste.
  const eol   = format === 'csv' ? '\r\n' : '\n'
  const header = columns.map(c => esc(c.header)).join(delim)
  const body   = rows.map(r => columns.map(c => esc(c.value(r))).join(delim))
  return [header, ...body].join(eol)
}

export function exportFilename(ext: 'csv'): string {
  const today = new Date().toISOString().slice(0, 10)
  return `starpath-database-${today}.${ext}`
}

// Renderer-only download: Chromium (inside Electron) handles the Save
// dialog off a Blob object URL. Revoke on the next tick so the blob isn't
// leaked once the click has been dispatched.
export function downloadText(filename: string, text: string, mime: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
