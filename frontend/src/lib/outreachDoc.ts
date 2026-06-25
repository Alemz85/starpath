// data/outreach.md document transforms + the view-model the Outreach cockpit
// renders — all pure string→string / string→data functions.
//
// data/outreach.md is the `contacto` mode's contact log: a markdown table the
// user (and the backend) can hand-edit:
//
//   | # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
//   |---|------|---------|------|---------|-------|---------|-------|---------|-------|
//   | 1 | 2026-06-10 | Helios | Analyst | Dana Kim | Recruiter | Message | 1 | Pending | first touch |
//
// The renderer's read path (parse + cadence classify) already lives in
// `outreachLog.ts` — the Today surface added it and this module REUSES its
// parser rather than forking a second table reader. What `outreachLog.ts`
// does NOT have is a *write* path: appending a new touch row or amending an
// existing contact's outcome. Those transforms live here, mirroring the
// pure/tested approach of `applicationsDoc.ts` so the highest-blast-radius
// code in the renderer (it writes the user's on-disk log) stays trivially
// testable, free of zustand/ipc/React.
//
// The Outreach view also needs a richer per-contact record than the Today
// cockpit's `OutreachCadenceEntry` (which carries only what the feed renders).
// `buildOutreachBoard` produces the full collapsed+classified list — touch
// count, title, notes, last outcome, cadence verdict — by reusing the same
// parser and the same cadence math.

import { parseOutreachLog, classifyOutreachLog, type OutreachTouch } from './outreachLog'
import type { OutreachCadenceEntry } from './todayCockpit'

// Canonical column order — keep in lock-step with the schema documented in
// scripts/outreach-cadence.mjs and the parser in outreachLog.ts.
export const OUTREACH_HEADER =
  '| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |'
const OUTREACH_SEPARATOR =
  '|---|------|---------|------|---------|-------|---------|-------|---------|-------|'

// The channels the contacto mode records. Free text is allowed on disk, but the
// view's dropdown offers this canonical set so new rows stay tidy.
export const OUTREACH_CHANNELS = ['Connection', 'Message', 'InMail', 'Email'] as const
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number]

// Outcomes the user picks when logging or amending a touch. These map onto the
// cadence states in outreachLog.ts (normalizeOutcome): Pending/Sent → pending,
// Accepted → accepted, Replied → replied/done, Declined → declined/cold.
export const OUTREACH_OUTCOMES = ['Pending', 'Accepted', 'Replied', 'Declined'] as const
export type OutreachOutcome = (typeof OUTREACH_OUTCOMES)[number]

// ─── Read: the view-model ───────────────────────────────────────────────────

export interface OutreachContact extends OutreachCadenceEntry {
  /** Most recent title logged for this contact. */
  title: string
  /** Total touches sent (max touch number across the contact's rows). */
  touches: number
  /** Most recent outcome free-text as written on disk. */
  outcome: string
  /** Most recent notes cell. */
  notes: string
}

// Collapse touch rows to one record per (company + contact): latest touch wins,
// touch count is the max seen. Same key + merge rules as collapse() in
// outreachLog.ts / outreach-cadence.mjs — kept local because outreachLog.ts
// doesn't export its collapse (it folds it into classifyOutreachLog).
interface Collapsed {
  company: string; role: string; contact: string; title: string
  channel: string; lastTouch: string; touches: number; outcome: string; notes: string
}

function collapse(rows: OutreachTouch[]): Collapsed[] {
  const byKey = new Map<string, Collapsed>()
  for (const r of rows) {
    const key = `${r.company.toLowerCase()}|${r.contact.toLowerCase()}`
    const prev = byKey.get(key)
    if (!prev || r.date > prev.lastTouch || (r.date === prev.lastTouch && r.touch >= prev.touches)) {
      byKey.set(key, {
        company: r.company,
        role: r.role,
        contact: r.contact,
        title: r.title,
        channel: r.channel,
        lastTouch: r.date,
        touches: Math.max(r.touch, prev ? prev.touches : 0),
        outcome: r.outcome,
        notes: r.notes,
      })
    } else if (prev) {
      prev.touches = Math.max(prev.touches, r.touch)
    }
  }
  return [...byKey.values()]
}

// Build the full Outreach-view board: one classified record per contact, joined
// with the per-contact detail the view shows. Cadence verdict comes from the
// shared classifier (classifyOutreachLog) so the view, the Today cockpit, and
// the CLI all agree on nudge/waiting/cold/done.
//
// Pure; `now` injectable for tests.
export function buildOutreachBoard(content: string | null, now: Date = new Date()): OutreachContact[] {
  const collapsed = collapse(parseOutreachLog(content))
  // classifyOutreachLog re-parses + re-collapses identically, so its entries
  // line up 1:1 with `collapsed` on the (company|contact) key. Index by key and
  // merge the cadence verdict onto the detail record.
  const cadence = new Map<string, OutreachCadenceEntry>()
  for (const e of classifyOutreachLog(content, now)) {
    cadence.set(`${e.company.toLowerCase()}|${e.contact.toLowerCase()}`, e)
  }
  return collapsed.map(c => {
    const key = `${c.company.toLowerCase()}|${c.contact.toLowerCase()}`
    const verdict = cadence.get(key)
    return {
      company: c.company,
      role: c.role,
      contact: c.contact,
      title: c.title,
      channel: c.channel,
      lastTouch: c.lastTouch,
      daysSince: verdict?.daysSince ?? null,
      action: verdict?.action ?? 'waiting',
      reason: verdict?.reason ?? '',
      touches: c.touches,
      outcome: c.outcome,
      notes: c.notes,
    }
  })
}

// ─── Write: table transforms ────────────────────────────────────────────────

function escapeCell(s: string): string {
  // The log is one row per line and pipe-delimited, so a literal '|' or newline
  // in user input would corrupt the table. Replace pipes with a fullwidth
  // variant and collapse newlines to spaces — same defensive posture a
  // hand-written row would need.
  return (s ?? '').replace(/\|/g, '∣').replace(/[\r\n]+/g, ' ').trim()
}

function isHeaderOrSeparator(line: string): boolean {
  if (/^\|\s*-+/.test(line)) return true        // GFM separator
  return /^\|\s*#\s*\|/.test(line)               // header row (| # | …)
}

function isDataRow(line: string): boolean {
  return line.trim().startsWith('|') && !isHeaderOrSeparator(line)
}

function joinRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

// The highest existing row number, so a fresh row increments it.
function maxNum(rows: OutreachTouch[]): number {
  let m = 0
  for (const r of rows) if (Number.isFinite(r.num) && r.num > m) m = r.num
  return m
}

export interface LogTouchArgs {
  company: string
  role?: string
  contact: string
  title?: string
  channel: string
  /** YYYY-MM-DD; defaults to today when omitted. */
  date?: string
  outcome?: string
  notes?: string
}

// Append a new touch row for a contact. The Touch number is derived: if the
// contact already exists in the log, it's max(existing touch)+1; otherwise 1.
// This is the writeback the "Log a touch" / "Nudge again" actions call — it
// NEVER rewrites existing rows (the log is append-only history of every touch),
// it only adds the latest one. Mirrors how the contacto mode appends.
export function appendOutreachTouch(raw: string | null, args: LogTouchArgs): string {
  const content = raw ?? ''
  const rows = parseOutreachLog(content)
  const num = maxNum(rows) + 1

  const c = args.company.trim().toLowerCase()
  const k = args.contact.trim().toLowerCase()
  const priorTouches = rows
    .filter(r => r.company.toLowerCase() === c && r.contact.toLowerCase() === k)
    .reduce((m, r) => Math.max(m, r.touch), 0)
  const touch = priorTouches + 1

  const date = args.date?.trim() || new Date().toISOString().slice(0, 10)
  const newRow = joinRow([
    String(num),
    date,
    escapeCell(args.company),
    escapeCell(args.role ?? ''),
    escapeCell(args.contact),
    escapeCell(args.title ?? ''),
    escapeCell(args.channel),
    String(touch),
    escapeCell(args.outcome ?? 'Pending'),
    escapeCell(args.notes ?? ''),
  ])

  const lines = content.length ? content.split('\n') : []

  // Find the last data row to insert after; else the separator; else create the
  // whole table fresh (the common case until the user logs their first contact).
  let insertAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isDataRow(lines[i])) { insertAt = i; break }
  }
  if (insertAt === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\|\s*-+/.test(lines[i])) { insertAt = i; break }
    }
  }

  if (insertAt === -1) {
    // No table on disk yet — scaffold a titled table so the file reads well and
    // the backend cadence script (which keys off the same schema) can parse it.
    const head = content.trim()
      ? content.trimEnd() + '\n\n'
      : '# Outreach\n\n'
    return head + OUTREACH_HEADER + '\n' + OUTREACH_SEPARATOR + '\n' + newRow + '\n'
  }

  const next = [...lines]
  next.splice(insertAt + 1, 0, newRow)
  return next.join('\n')
}

// Amend the most recent row of an existing (company, contact) in place —
// rewriting only the Outcome (and optionally Notes) cell. Used by the "Mark
// replied / declined / accepted" affordance, which records *what happened* to
// the last touch rather than logging a new one. Returns the input unchanged
// when no matching row exists.
export function updateOutreachOutcome(
  raw: string | null,
  company: string,
  contact: string,
  outcome: string,
  notes?: string,
): string {
  const content = raw ?? ''
  if (!content) return content
  const lines = content.split('\n')
  const c = company.trim().toLowerCase()
  const k = contact.trim().toLowerCase()

  // Find the latest matching row (by date, then by line order as a tiebreak).
  let bestIdx = -1
  let bestDate = ''
  for (let i = 0; i < lines.length; i++) {
    if (!isDataRow(lines[i])) continue
    const cells = lines[i].split('|').map(s => s.trim())
    // leading '' + 10 cells + trailing '' = 12 parts.
    if (cells.length < 11) continue
    if (Number.isNaN(parseInt(cells[1], 10))) continue
    if (cells[3].toLowerCase() !== c || cells[5].toLowerCase() !== k) continue
    const date = cells[2]
    if (bestIdx === -1 || date >= bestDate) { bestIdx = i; bestDate = date }
  }
  if (bestIdx === -1) return content

  const cells = lines[bestIdx].split('|').map(s => s.trim())
  // cells: ['', '#', date, company, role, contact, title, channel, touch, outcome, notes, '']
  cells[9] = escapeCell(outcome)
  if (notes !== undefined) cells[10] = escapeCell(notes)
  // Rebuild without the empty edge cells.
  lines[bestIdx] = joinRow(cells.slice(1, 11))
  return lines.join('\n')
}
