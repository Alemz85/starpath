// applications.md document transforms — pure string→string functions.
//
// data/applications.md is a thin markdown table the user can also hand-edit:
//
//   | # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |
//   |---|------|---------|------|-------|--------|-----|----------|--------|-------|
//   | 1 | 2026-04-27 | Acme | ML Eng | 8.4/10 | Evaluated | ❌ | n/d | [#1](…) | … |
//
// These helpers were extracted out of `store/data.ts` so the table-mutation
// logic — which writes directly to the user's on-disk applications.md and is
// therefore the highest-blast-radius code in the renderer — lives in one
// pure, dependency-free, unit-tested place. The store imports them and owns
// only the I/O (read file → transform → write file → refresh). Keep this
// module free of zustand/ipc/React so it stays trivially testable.
//
// applications.md holds at most one row per (company, role) — see CLAUDE.md
// "Pipeline Integrity". upsertApplicationRow refreshes an existing listing's
// Score / Report in place (or appends when it's new); updateApplicationStatus
// rewrites the Status cell of matching rows. Neither touches unrelated cells.

import type { AppStatus } from '@/types'

export function isTableSeparator(line: string): boolean {
  return /^\|\s*-+/.test(line)
}

export function isTableDataRow(line: string): boolean {
  return line.startsWith('|') && !isTableSeparator(line) && !/^\|\s*#\s*\|/i.test(line)
}

export function splitRow(line: string): string[] {
  // Strip the leading and trailing pipe, split, trim cells.
  return line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim())
}

export function joinRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

// Index of the first data row matching (company, role), case-insensitive —
// the single identity key for a listing across applications.md. Shared by the
// upsert (skip / refresh) and consistent with ApplyAction's findApplication.
// Returns -1 when not present.
export function findApplicationRowIndex(lines: string[], company: string, role: string): number {
  const c = company.trim().toLowerCase()
  const r = role.trim().toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDataRow(lines[i])) continue
    const cells = splitRow(lines[i])
    if (cells.length < 6) continue
    if (cells[2].toLowerCase() === c && cells[3].toLowerCase() === r) return i
  }
  return -1
}

export function tierFolder(tier: string): string {
  if (tier === 'T1') return 'tier-1'
  if (tier === 'T2' || tier === 'T2-high') return 'tier-2'
  if (tier === 'T3') return 'tier-3'
  return 'tier-4'
}

// applications.md's canonical shape is 10 columns — a Deadline cell between PDF
// and Report (merge-tracker.mjs writes it; CLAUDE.md onboarding documents it).
// Files scaffolded before that carried a 9-col header + 9-col rows. Mutating
// such a file in 10-col terms corrupts it: an appended 10-cell row misaligns
// under a 9-col header, and the refresh path (cells[8] = Report) would overwrite
// the NOTES cell of a 9-col row. So upgrade the whole table to 10 columns ONCE,
// before any mutation — insert the Deadline header/separator cell and pad each
// genuine 9-col data row's missing Deadline with `n/d`. Rows already at 10 cells
// (the corrupted 9-col-header/10-col-row state) are left untouched, so the
// upgrade is idempotent and safe on mixed files. A table already at 10 columns
// (or with no recognizable header) is returned verbatim.
const DEADLINE_INSERT_AT = 7 // between PDF (6) and Report (7) in the 9-col order

export function ensureDeadlineColumn(raw: string): string {
  const lines = raw.split('\n')
  const headerIdx = lines.findIndex(l => /^\|\s*#\s*\|/i.test(l))
  if (headerIdx === -1) return raw

  const headerCells = splitRow(lines[headerIdx])
  // Already 10-col (has Deadline) or an unfamiliar width → leave it alone.
  if (headerCells.length !== 9) return raw
  if (headerCells.some(c => c.toLowerCase() === 'deadline')) return raw

  const migrated = lines.map((line, i) => {
    if (i === headerIdx) {
      const c = splitRow(line); c.splice(DEADLINE_INSERT_AT, 0, 'Deadline'); return joinRow(c)
    }
    if (isTableSeparator(line)) {
      const c = splitRow(line); c.splice(DEADLINE_INSERT_AT, 0, '--------'); return joinRow(c)
    }
    if (isTableDataRow(line)) {
      const c = splitRow(line)
      if (c.length === 9) c.splice(DEADLINE_INSERT_AT, 0, 'n/d') // pad only genuine 9-col rows
      return joinRow(c)
    }
    return line
  })
  return migrated.join('\n')
}

export function upsertApplicationRow(raw: string, args: {
  company: string
  role: string
  overall: number
  tier: string
  reportPath?: string
}): string {
  // Self-heal a legacy 9-col file to the canonical 10-col shape first, so both
  // the refresh path (cells[8] = Report) and appended 10-cell rows land in the
  // right columns instead of clobbering Notes / misaligning the table.
  const lines = ensureDeadlineColumn(raw).split('\n')

  // Upsert on (company, role): applications.md holds at most one row per
  // listing. If it's already tracked, refresh the Score in place (and the
  // Report link when a fresh path is given) — preserving Status / Date / PDF /
  // Deadline / Notes — instead of appending a duplicate. The frontend Apply
  // path used to append blindly, which is the documented source of same-listing
  // dupes (CLAUDE.md "Pipeline Integrity"); `node scripts/dedup-tracker.mjs`
  // cleans up any that already slipped in.
  const existingIdx = findApplicationRowIndex(lines, args.company, args.role)
  if (existingIdx !== -1) {
    const cells = splitRow(lines[existingIdx])
    if (args.overall > 0 && cells.length > 4) cells[4] = `${args.overall.toFixed(1)}/10`
    if (args.reportPath && cells.length > 8) cells[8] = `[#${cells[0] || ''}](${args.reportPath})`
    lines[existingIdx] = joinRow(cells)
    return lines.join('\n')
  }

  // Find the highest existing # so we can increment.
  let maxNum = 0
  for (const line of lines) {
    if (!isTableDataRow(line)) continue
    const cells = splitRow(line)
    const n = parseInt(cells[0] ?? '', 10)
    if (Number.isFinite(n) && n > maxNum) maxNum = n
  }

  const num = maxNum + 1
  const today = new Date().toISOString().slice(0, 10)
  const score = args.overall > 0 ? `${args.overall.toFixed(1)}/10` : '—'
  const reportLink = args.reportPath
    ? `[#${num}](${args.reportPath})`
    : `[#${num}](reports/${tierFolder(args.tier)}/${args.company} - ${args.role}.md)`
  const newRow = joinRow([
    String(num),
    today,
    args.company,
    args.role,
    score,
    'Evaluated',
    '❌',
    'n/d',
    reportLink,
    '',
  ])

  // Find last existing data row index, otherwise append after the separator.
  let insertAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isTableDataRow(lines[i])) { insertAt = i; break }
  }
  if (insertAt === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (isTableSeparator(lines[i])) { insertAt = i; break }
    }
  }

  if (insertAt === -1) {
    // No table at all — append at end.
    return raw.trimEnd() + '\n' + newRow + '\n'
  }
  const next = [...lines]
  next.splice(insertAt + 1, 0, newRow)
  return next.join('\n')
}

// Column indices in the canonical 10-column table. Only the cells this patch
// can write are named; the rest are addressed by the functions above.
const COL_STATUS = 5
const COL_DEADLINE = 7
const COL_NOTES = 9

/** The cells a caller may set on an existing row. An absent key leaves the
 *  cell exactly as it was — this never blanks anything by omission. */
export interface ApplicationFieldPatch {
  status?: AppStatus
  /** `YYYY-MM-DD` | `Rolling` | `n/d` — validated by the caller. */
  deadline?: string
  notes?: string
}

/**
 * Set named cells on the (company, role) row, leaving every other cell alone.
 *
 * `updateApplicationStatus` already covers the Status-only case and stays the
 * path the status dropdown uses; this exists because a write that arrives with
 * Status AND Deadline AND Notes at once (a chat proposal card) would otherwise
 * need three passes or a second row-finding implementation.
 *
 * Runs `ensureDeadlineColumn` first for the same reason `upsertApplicationRow`
 * does — and here it is load-bearing rather than defensive: on a legacy 9-col
 * file, index 7 is Report and index 9 doesn't exist, so patching Deadline
 * without the upgrade would overwrite the report link. Status alone is safe
 * either way (index 5 in both layouts), which is why the existing function
 * never needed this.
 *
 * Returns `raw` unchanged when no row matches or the patch is empty — the
 * caller checks `findApplicationRowIndex` when it needs to distinguish
 * "nothing to change" from "no such listing".
 */
export function updateApplicationFields(
  raw: string,
  company: string,
  role: string,
  patch: ApplicationFieldPatch,
): string {
  if (patch.status === undefined && patch.deadline === undefined && patch.notes === undefined) {
    return raw
  }

  const upgraded = ensureDeadlineColumn(raw)
  const lines = upgraded.split('\n')
  const index = findApplicationRowIndex(lines, company, role)
  if (index === -1) return raw

  const cells = splitRow(lines[index])
  // A row too short to hold the cell is left alone rather than padded — the
  // upgrade above already normalized every genuine row, so a short row here is
  // something hand-edited that this function has no business reshaping.
  if (patch.status !== undefined && cells.length > COL_STATUS) cells[COL_STATUS] = patch.status
  if (patch.deadline !== undefined && cells.length > COL_DEADLINE) cells[COL_DEADLINE] = patch.deadline
  if (patch.notes !== undefined && cells.length > COL_NOTES) cells[COL_NOTES] = patch.notes
  lines[index] = joinRow(cells)
  return lines.join('\n')
}

export function updateApplicationStatus(
  raw: string,
  company: string,
  role: string,
  status: AppStatus,
): string {
  const lines = raw.split('\n')
  const c = company.trim().toLowerCase()
  const r = role.trim().toLowerCase()
  let mutated = false
  for (let i = 0; i < lines.length; i++) {
    if (!isTableDataRow(lines[i])) continue
    const cells = splitRow(lines[i])
    if (cells.length < 6) continue
    if (cells[2].toLowerCase() === c && cells[3].toLowerCase() === r) {
      cells[5] = status
      lines[i] = joinRow(cells)
      mutated = true
    }
  }
  return mutated ? lines.join('\n') : raw
}
