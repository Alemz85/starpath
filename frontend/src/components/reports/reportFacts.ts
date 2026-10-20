// Pure string parsing behind the report dossier's header and summary card:
// the report's own TL;DR (shown verbatim, never rewritten), the fields of its
// `Role summary` table, the work-mode half of its `**Location:**` line, and
// the date the scanner first saw the listing. Kept out of the component so
// the parsing is testable without React.

export interface ReportSummary {
  /** The report's sentence, verbatim (inline markdown left as written). */
  text: string
  /** Where it came from: the `TL;DR` row, or the Recommendation section
   *  when the report has no TL;DR (T2 / T3 reports). */
  source: 'tldr' | 'recommendation'
}

const TLDR_KEY = /^tl;?\s*dr$/i

// Cells of a markdown table row, outer pipes dropped.
function cells(line: string): string[] | null {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  return t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}

const isSeparatorRow = (c: string[]) => c.every(x => /^:?-{2,}:?$/.test(x))

/** The report's TL;DR, verbatim. Looks for a `| TL;DR | … |` table row (the
 *  T1 Role summary) or a `**TL;DR:** …` line; falls back to the first
 *  paragraph of the Recommendation section. Null when the report has
 *  neither: the dossier then says so instead of inventing a summary. */
export function reportSummary(md: string): ReportSummary | null {
  for (const line of md.split('\n')) {
    const c = cells(line)
    if (c && c.length >= 2 && TLDR_KEY.test(c[0].replace(/\*/g, '')) && c[1]) {
      return { text: c[1], source: 'tldr' }
    }
    const bold = /^\s*\*\*tl;?\s*dr:?\*\*:?\s*(.+?)\s*$/i.exec(line)
    if (bold) return { text: bold[1], source: 'tldr' }
  }
  const rec = sectionBody(md, /recommendation/i)
  if (rec) {
    const para = rec.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith('|'))
    if (para) return { text: para.replace(/\s*\n\s*/g, ' '), source: 'recommendation' }
  }
  return null
}

// Body of the first `## …` section whose title matches (the template's
// "D) " prefixes are allowed), up to the next `#`/`##` heading.
function sectionBody(md: string, title: RegExp): string | null {
  const lines = md.split('\n')
  const start = lines.findIndex(l => {
    const m = /^##\s+(?:[A-Z]\)\s+)?(.+?)\s*$/.exec(l)
    return !!m && title.test(m[1])
  })
  if (start < 0) return null
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l) || /^---\s*$/.test(l)) break
    out.push(l)
  }
  return out.join('\n').trim() || null
}

/** The `Role summary` table as field → value (Domain, Function, Seniority,
 *  Remote, TL;DR …). Keys keep the report's casing. */
export function roleSummaryFields(md: string): Record<string, string> {
  const body = sectionBody(md, /role summary/i)
  const out: Record<string, string> = {}
  if (!body) return out
  let header = true
  for (const line of body.split('\n')) {
    const c = cells(line)
    if (!c || c.length < 2) continue
    if (header) { header = false; continue }       // "| Field | Value |"
    if (isSeparatorRow(c)) continue
    if (c[0] && c[1]) out[c[0].replace(/\*/g, '')] = c[1]
  }
  return out
}

/** Split a report `**Location:**` value into its place and the work
 *  arrangement written after the middle dot: "Lyon, France · hybrid, two
 *  office days" → place "Lyon, France", workMode "hybrid, two office days". */
export function splitLocationLine(line: string): { place: string; workMode: string } {
  const i = line.indexOf(' · ')
  if (i < 0) return { place: line.trim(), workMode: '' }
  return { place: line.slice(0, i).trim(), workMode: line.slice(i + 3).trim() }
}

/** The `first_seen` date `data/scan-history.tsv` holds for a listing URL
 *  (columns found by header name), or null. The scanner's first sighting
 *  is the closest thing to a posting date the data has. */
export function firstSeenFor(scanHistoryTsv: string | null, url: string): string | null {
  if (!scanHistoryTsv || !url) return null
  const lines = scanHistoryTsv.split('\n')
  const head = (lines[0] ?? '').split('\t').map(h => h.trim().toLowerCase())
  const urlCol = head.indexOf('url')
  const seenCol = head.indexOf('first_seen')
  if (urlCol < 0 || seenCol < 0) return null
  let best: string | null = null
  for (const line of lines.slice(1)) {
    const c = line.split('\t')
    if (c[urlCol]?.trim() !== url) continue
    const d = c[seenCol]?.trim()
    if (d && (!best || d < best)) best = d
  }
  return best
}

/** "full-time" + "permanent" → "Full-time · permanent". Empty parts drop. */
export function contractLabel(employmentType: string, duration: string): string {
  const parts = [employmentType, duration].map(s => (s ?? '').trim()).filter(s => s && s !== '—')
  const joined = [...new Set(parts.map(p => p.toLowerCase()))].join(' · ')
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : ''
}
