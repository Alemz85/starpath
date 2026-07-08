import type { ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile } from '@/types'

// ─── Generic markdown table parser ────────────────────────────────────────────

function parseMarkdownTable(md: string): Array<Record<string, string>> {
  const lines = md.split('\n')
  const tableLines = lines.filter(l => l.trim().startsWith('|'))
  if (tableLines.length < 3) return []

  const headers = tableLines[0]
    .split('|')
    .slice(1, -1)
    .map(h => h.trim())

  return tableLines.slice(2).flatMap(row => {
    const cols = row.split('|').slice(1, -1).map(c => c.trim())
    if (cols.length === 0 || cols[0].startsWith('---')) return []
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = cols[i] ?? '' })
    return [obj]
  })
}

// Raw per-row cell arrays for a markdown table (data rows only — header +
// separator dropped). Unlike parseMarkdownTable this keeps cells POSITIONAL, so
// a parser can map them by canonical column order instead of by header name —
// necessary when the header and data rows can disagree on width (see
// parseApplications and applications.md's optional Deadline cell).
function tableDataCells(md: string): string[][] {
  const tableLines = md.split('\n').filter(l => l.trim().startsWith('|'))
  if (tableLines.length < 3) return []
  return tableLines.flatMap(row => {
    const cols = row.split('|').slice(1, -1).map(c => c.trim())
    if (cols.length === 0 || cols[0].startsWith('---')) return []
    return [cols]
  })
}

// ─── Scouting tracker ─────────────────────────────────────────────────────────

export function parseScouting(md: string): ScoutingEntry[] {
  const rows = parseMarkdownTable(md)
  return rows.flatMap(row => {
    const num = parseInt(row['#'] ?? '')
    if (isNaN(num)) return []

    const tierRaw = row['Tier'] ?? ''
    const tier = normalizeTierScouting(tierRaw)

    return [{
      num,
      date:          row['Date'] ?? '',
      company:       row['Company'] ?? '',
      role:          row['Role'] ?? '',
      score:         row['Score'] ?? '',
      tier,
      cfaf:          row['CF/AF'] ?? '',
      report:        row['Report'] ?? '',
      deadline:      row['Deadline'] ?? '',
      promotionHint: row['Promotion Hint'] ?? '',
      notes:         row['Notes'] ?? '',
      // entityId + cities are populated by the SQLite sync layer (which
      // can join against score_history.location). The markdown parser
      // doesn't have that context, so it leaves them empty — anything
      // reading parseScouting() output directly (rare; tests + the
      // Apply button writeback) should fall back to recomputing.
      entityId:      '',
      cities:        [],
    }]
  })
}

function normalizeTierScouting(raw: string): ScoutingEntry['tier'] {
  const t = raw.toLowerCase().trim()
  if (t === 't1') return 'T1'
  if (t === 't2-high' || t === 't2+') return 'T2-high'
  if (t === 't2') return 'T2'
  if (t === 't3') return 'T3'
  return 'T4'
}

// ─── Applications tracker ─────────────────────────────────────────────────────

export function parseApplications(md: string): ApplicationEntry[] {
  // Map cells POSITIONALLY (not by header name) with per-row width detection —
  // mirrors tracker-core.mjs parseAppRow's "FORMAT GOTCHA". applications.md rows
  // carry an OPTIONAL Deadline cell between PDF and Report: merge-tracker.mjs
  // writes the 10-column form, the legacy scaffold produced 9. A header-name map
  // aligns positionally, so a 9-column header over 10-column rows slid Report
  // into the Deadline slot and Notes into Report — losing the real Notes. Width
  // detection per row survives any header/row disagreement. Canonical order:
  //   0:# 1:Date 2:Company 3:Role 4:Score 5:Status 6:PDF [7:Deadline] Report Notes
  return tableDataCells(md).flatMap(cells => {
    const num = parseInt(cells[0] ?? '')
    if (isNaN(num)) return []

    const hasDeadline = cells.length >= 10
    const deadline = hasDeadline ? (cells[7] ?? '') : ''
    const report   = cells[hasDeadline ? 8 : 7] ?? ''
    const notes    = cells[hasDeadline ? 9 : 8] ?? ''

    const knownStatuses = ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP']
    const rawStatus = (cells[5] ?? '').replace(/\*\*/g, '').trim()
    const status = (knownStatuses.includes(rawStatus) ? rawStatus : 'Evaluated') as ApplicationEntry['status']

    return [{
      num,
      date:     cells[1] ?? '',
      company:  cells[2] ?? '',
      role:     cells[3] ?? '',
      score:    cells[4] ?? '',
      status,
      pdf:      (cells[6] ?? '').includes('✅'),
      deadline,
      report,
      notes,
      entityId: '',
      cities:   [],
    }]
  })
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export function parsePipeline(md: string): PipelineUrl[] {
  const lines = md.split('\n')
  const now = Date.now()
  const STALE_MS = 14 * 24 * 60 * 60 * 1000

  return lines.flatMap(line => {
    const trimmed = line.trim()
    // Supported prefixes: bare, "- ", "* ", "- [ ] " (GFM task-list bullets).
    // A CHECKED box ("- [x]") means the entry was already processed — eval
    // flows check entries off in place rather than deleting them, so checked
    // lines must NOT parse as pending or the Inbox count never goes down.
    const urlMatch = trimmed.match(/^[-*]?\s*(?:\[([ xX])\]\s+)?((?:https?:\/\/|local:)\S+)/)
    if (!urlMatch) return []
    if (urlMatch[1] && urlMatch[1] !== ' ') return []

    const url = urlMatch[2]
    // Try to extract date added from surrounding context (not always present)
    const dateMatch = trimmed.match(/\((\d{4}-\d{2}-\d{2})\)/)
    const addedDate = dateMatch?.[1]
    const isStale = addedDate
      ? (now - new Date(addedDate).getTime()) > STALE_MS
      : false

    // Scanner-written lines carry `| Company | Title` and optionally a
    // trailing `| relevance X.X — reasons` note (scan.mjs › pipelineLine).
    // Capture them so the Inbox can rank on real signal instead of guessing
    // the company from the URL host. Manual bare-URL lines just have none.
    //
    // Strip the trailing `(YYYY-MM-DD)` parenthetical BEFORE the pipe-split —
    // it's already captured as addedDate above, and on a pipe-less line
    // (`- [ ] https://job/2 (2020-01-01)`) it would otherwise become fields[0]
    // and surface as the company (a date masquerading as a company in the Inbox).
    const tail = trimmed
      .slice(trimmed.indexOf(url) + url.length)
      .replace(/\s*\((\d{4}-\d{2}-\d{2})\)\s*/, ' ')
    // Company/title only exist on scanner-written lines, which are pipe-delimited.
    // A pipe-less tail (bare URL, or a URL + free-text note) carries no structured
    // fields — never treat its leftover text as a company.
    const hasPipeTail = tail.includes('|')
    const fields = hasPipeTail
      ? tail.split('|').map(s => s.trim()).filter(Boolean)
      : []

    let relevance: number | undefined
    let relevanceNote: string | undefined
    const last = fields[fields.length - 1] ?? ''
    const rel = last.match(/^relevance ([0-9.]+)(?:\s*—\s*(.*))?$/)
    if (rel) {
      relevance = Number(rel[1])
      relevanceNote = rel[2] || undefined
      fields.pop()
    }
    const company = fields[0] || undefined
    const title = fields[1] || undefined

    return [{ url, addedDate, isStale, company, title, relevance, relevanceNote }]
  })
}

// ─── Report files (from file listing) ────────────────────────────────────────

export function parseReportPath(filePath: string): ReportFile | null {
  // e.g. reports/tier-1/Amazon - Business Analyst Intern 2026.md
  const match = filePath.match(/reports\/(tier-[1-4])\/(.+)\.md$/)
  if (!match) return null

  const tierMap: Record<string, string> = {
    'tier-1': 'T1', 'tier-2': 'T2', 'tier-3': 'T3', 'tier-4': 'T4',
  }

  const fileName = match[2]
  // Expect "Company - Role" format
  const dashIdx = fileName.indexOf(' - ')
  const company = dashIdx >= 0 ? fileName.slice(0, dashIdx) : fileName
  const role    = dashIdx >= 0 ? fileName.slice(dashIdx + 3) : ''

  return {
    path: filePath,
    company,
    role,
    tier: tierMap[match[1]] ?? match[1],
    url: '', // populated by the cache sync from the report's `**URL:**` header
  }
}
