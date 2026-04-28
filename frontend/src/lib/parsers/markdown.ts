import type { ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile } from '@/types'

// ─── Generic markdown table parser ────────────────────────────────────────────

function parseMarkdownTable(md: string): Array<Record<string, string>> {
  const lines = md.split('\n')
  const tableLines = lines.filter(l => l.trim().startsWith('|'))
  if (tableLines.length < 3) return []

  const headers = tableLines[0]
    .split('|')
    .map(h => h.trim())
    .filter(Boolean)

  return tableLines.slice(2).flatMap(row => {
    const cols = row.split('|').map(c => c.trim()).filter(Boolean)
    if (cols.length === 0 || cols[0] === '---') return []
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = cols[i] ?? '' })
    return [obj]
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
  const rows = parseMarkdownTable(md)
  return rows.flatMap(row => {
    const num = parseInt(row['#'] ?? '')
    if (isNaN(num)) return []

    const knownStatuses = ['Evaluated','Applied','Responded','Interview','Offer','Rejected','Discarded','SKIP']
    const rawStatus = (row['Status'] ?? '').replace(/\*\*/g, '').trim()
    const status = (knownStatuses.includes(rawStatus) ? rawStatus : 'Evaluated') as ApplicationEntry['status']

    return [{
      num,
      date:     row['Date'] ?? '',
      company:  row['Company'] ?? '',
      role:     row['Role'] ?? '',
      score:    row['Score'] ?? '',
      status,
      pdf:      (row['PDF'] ?? '').includes('✅'),
      deadline: row['Deadline'] ?? '',
      report:   row['Report'] ?? '',
      notes:    row['Notes'] ?? '',
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
    // Supported prefixes: bare, "- ", "* ", "- [ ] ", "- [x] " (GFM
    // task-list bullets used in pipeline.md to mark processing state).
    const urlMatch = trimmed.match(/^[-*]?\s*(?:\[[ xX]\]\s+)?((?:https?:\/\/|local:)\S+)/)
    if (!urlMatch) return []

    const url = urlMatch[1]
    // Try to extract date added from surrounding context (not always present)
    const dateMatch = trimmed.match(/\((\d{4}-\d{2}-\d{2})\)/)
    const addedDate = dateMatch?.[1]
    const isStale = addedDate
      ? (now - new Date(addedDate).getTime()) > STALE_MS
      : false

    return [{ url, addedDate, isStale }]
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
