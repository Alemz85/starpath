// What an application asks the candidate to submit — the report header's
// `**Documents:**` line (modes/scouting.md § Documents). Evaluations write it
// from the posting; the apply flow rewrites it once the real form is seen.
//
//   **Documents:** CV required · cover letter optional · transcript required ·
//     references not stated · language test not stated · 1 file, 1 MB max ·
//     from the posting
//
// Fails closed: an item the line doesn't name, or names with a state we don't
// know, stays `not_stated`; nothing here ever defaults to "not asked".

export const DOCUMENT_ITEMS = ['cv', 'cover_letter', 'transcript', 'references', 'language_test'] as const
export type DocumentItem = typeof DOCUMENT_ITEMS[number]
export type DocumentState = 'required' | 'optional' | 'not_asked' | 'not_stated'

export interface ApplicationDocuments {
  items: Record<DocumentItem, DocumentState>
  /** Most files the form takes (`1 file`), when stated. */
  maxFiles: number | null
  /** Largest upload, as written (`1 MB`), when stated. */
  maxSize: string | null
  /** Anything else the line says (`all documents in one PDF`). */
  notes: string[]
  /** Where the line came from: the posting (evaluation) or the real form (apply flow). */
  source: 'posting' | 'form' | null
  /** The day the form was seen, for `from the form YYYY-MM-DD`. */
  sourceDate: string | null
}

export const DOCUMENT_LABELS: Record<DocumentItem, string> = {
  cv: 'CV',
  cover_letter: 'cover letter',
  transcript: 'transcript',
  references: 'references',
  language_test: 'language test',
}

const ITEM_NAMES: Array<[RegExp, DocumentItem]> = [
  [/^(?:cv|r[ée]sum[ée])$/i, 'cv'],
  [/^(?:cover|motivation) letter$/i, 'cover_letter'],
  [/^transcripts?$/i, 'transcript'],
  [/^references?$/i, 'references'],
  [/^language (?:test|certificate)s?$/i, 'language_test'],
]

const STATES: Record<string, DocumentState> = {
  'required': 'required',
  'optional': 'optional',
  'not asked': 'not_asked',
  'not stated': 'not_stated',
}

function emptyItems(): Record<DocumentItem, DocumentState> {
  return { cv: 'not_stated', cover_letter: 'not_stated', transcript: 'not_stated', references: 'not_stated', language_test: 'not_stated' }
}

/** Parse the value after `**Documents:**`. */
export function parseDocumentsValue(raw: string): ApplicationDocuments {
  const out: ApplicationDocuments = { items: emptyItems(), maxFiles: null, maxSize: null, notes: [], source: null, sourceDate: null }
  const value = raw.replace(/\*\*/g, '').trim().replace(/\.$/, '')
  if (!value || /^(?:not stated|n\/d|—|-)$/i.test(value)) return out
  const seen = new Set<DocumentItem>()
  for (const part of value.split(/\s+·\s+/).map(p => p.trim()).filter(Boolean)) {
    const item = /^(.+?)\s*:?\s+(required|optional|not asked|not stated)$/i.exec(part)
    const key = item ? ITEM_NAMES.find(([re]) => re.test(item[1].trim()))?.[1] : undefined
    if (item && key) {
      if (!seen.has(key)) out.items[key] = STATES[item[2].toLowerCase()]
      seen.add(key)
      continue
    }
    const src = /^from the (posting|form)(?:[ ,]+(\d{4}-\d{2}-\d{2}))?$/i.exec(part)
    if (src) {
      out.source = src[1].toLowerCase() as 'posting' | 'form'
      out.sourceDate = src[2] ?? null
      continue
    }
    const limits = /^(?:(\d+)\s+files?)?\s*,?\s*(?:(\d+(?:[.,]\d+)?\s*[KMG]B)\s+max)?$/i.exec(part)
    if (limits && (limits[1] || limits[2])) {
      if (limits[1]) out.maxFiles = Number(limits[1])
      if (limits[2]) out.maxSize = limits[2].replace(/\s*([KMG]B)$/i, (_, u: string) => ` ${u.toUpperCase()}`)
      continue
    }
    out.notes.push(part)
  }
  return out
}

/** The report's `**Documents:**` line, parsed; null when the report has none
 *  (written before the line existed). Only the header block counts. */
export function parseReportDocuments(md: string | null | undefined): ApplicationDocuments | null {
  if (!md) return null
  const head = md.split(/^##\s/m, 1)[0]
  const m = /^[ \t]*\*\*Documents:\*\*[ \t]*(.*)$/im.exec(head)
  return m ? parseDocumentsValue(m[1]) : null
}

function itemsIn(d: ApplicationDocuments, state: DocumentState): string[] {
  return DOCUMENT_ITEMS.filter(k => d.items[k] === state).map(k => DOCUMENT_LABELS[k])
}

function limitsText(d: ApplicationDocuments): string | null {
  const parts = [
    d.maxFiles != null ? `${d.maxFiles} ${d.maxFiles === 1 ? 'file' : 'files'}` : null,
    d.maxSize ? `${d.maxSize} max` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** True when nothing on the line is known. */
export function documentsUnknown(d: ApplicationDocuments): boolean {
  return DOCUMENT_ITEMS.every(k => d.items[k] === 'not_stated') && !limitsText(d) && d.notes.length === 0
}

/** One line for the dossier's job facts: "CV, transcript required · cover
 *  letter optional · 1 file, 1 MB max". Items not stated are left to the
 *  tooltip; a line with nothing known reads "Not stated". */
export function summarizeDocuments(d: ApplicationDocuments): string {
  if (documentsUnknown(d)) return 'Not stated'
  const parts: string[] = []
  const req = itemsIn(d, 'required')
  const opt = itemsIn(d, 'optional')
  const no = itemsIn(d, 'not_asked')
  if (req.length) parts.push(`${req.join(', ')} required`)
  if (opt.length) parts.push(`${opt.join(', ')} optional`)
  if (no.length) parts.push(`${no.join(', ')} not asked`)
  const limits = limitsText(d)
  if (limits) parts.push(limits)
  parts.push(...d.notes)
  const s = parts.join(' · ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const STATE_WORDS: Record<DocumentState, string> = {
  required: 'required', optional: 'optional', not_asked: 'not asked', not_stated: 'not stated',
}

/** The full breakdown for a tooltip, one fact per line, ending with where it came from. */
export function describeDocuments(d: ApplicationDocuments): string {
  const lines = DOCUMENT_ITEMS.map(k => {
    const label = DOCUMENT_LABELS[k]
    return `${label.charAt(0).toUpperCase() + label.slice(1)}: ${STATE_WORDS[d.items[k]]}`
  })
  const limits = limitsText(d)
  if (limits) lines.push(`Uploads: ${limits}`)
  lines.push(...d.notes)
  lines.push(
    d.source === 'form' ? `From the application form${d.sourceDate ? `, ${d.sourceDate}` : ''}`
      : d.source === 'posting' ? 'From the posting; check the form before you start'
        : 'Source not stated; check the form before you start',
  )
  return lines.join('\n')
}
