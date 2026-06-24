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

export function upsertApplicationRow(raw: string, args: {
  company: string
  role: string
  overall: number
  tier: string
  reportPath?: string
}): string {
  const lines = raw.split('\n')

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
