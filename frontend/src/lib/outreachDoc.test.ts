import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOutreachBoard,
  appendOutreachTouch,
  updateOutreachOutcome,
  OUTREACH_HEADER,
} from '@/lib/outreachDoc'
import { parseOutreachLog } from '@/lib/outreachLog'

const NOW = new Date(2026, 5, 25) // 2026-06-25

// A realistic outreach.md with the canonical schema, multi-touch contacts, and
// outcomes that exercise every cadence branch.
const LOG = `# Outreach

${OUTREACH_HEADER}
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-01 | Helios | Analyst | Dana Kim | Recruiter | Message | 1 | Pending | first touch |
| 2 | 2026-06-12 | Helios | Analyst | Dana Kim | Recruiter | Message | 2 | Pending | nudge |
| 3 | 2026-06-22 | Northwind | PM | Lee Park | Hiring Manager | Connection | 1 | Pending | sent request |
| 4 | 2026-06-05 | Acme | Ops | Sam Diaz | Peer | Message | 1 | Replied | got a reply |
`

// ─── buildOutreachBoard ───────────────────────────────────────────────────────

test('buildOutreachBoard collapses multi-touch contacts to one record', () => {
  const board = buildOutreachBoard(LOG, NOW)
  assert.equal(board.length, 3) // Dana's two touches fold into one record
  const dana = board.find(c => c.contact === 'Dana Kim')!
  assert.equal(dana.touches, 2)
  assert.equal(dana.lastTouch, '2026-06-12')
  assert.equal(dana.company, 'Helios')
  assert.equal(dana.title, 'Recruiter')
})

test('buildOutreachBoard attaches the shared cadence verdict', () => {
  const board = buildOutreachBoard(LOG, NOW)
  const sam = board.find(c => c.contact === 'Sam Diaz')!
  assert.equal(sam.action, 'done') // Replied → terminal
  const lee = board.find(c => c.contact === 'Lee Park')!
  // Connection sent 3 days ago, first window is 7 → still waiting.
  assert.equal(lee.action, 'waiting')
})

test('buildOutreachBoard goes cold once a contact hits the touch ceiling', () => {
  const board = buildOutreachBoard(LOG, NOW)
  const dana = board.find(c => c.contact === 'Dana Kim')!
  // Message, touch 2 == message_max → ceiling reached → cold (don't pester).
  assert.equal(dana.action, 'cold')
})

test('buildOutreachBoard surfaces a single overdue touch as nudge', () => {
  // One Email touch 1, sent 2026-06-10 → 15 days ago > message_first (5) → nudge.
  const log = `${OUTREACH_HEADER}
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Vertex | SWE | Ada Lo | Recruiter | Email | 1 | Pending | first touch |
`
  const board = buildOutreachBoard(log, NOW)
  assert.equal(board.find(c => c.contact === 'Ada Lo')!.action, 'nudge')
})

test('buildOutreachBoard is empty for a null / absent file', () => {
  assert.deepEqual(buildOutreachBoard(null, NOW), [])
  assert.deepEqual(buildOutreachBoard('', NOW), [])
})

// ─── appendOutreachTouch ──────────────────────────────────────────────────────

test('appendOutreachTouch adds touch 1 for a brand-new contact', () => {
  const next = appendOutreachTouch(LOG, {
    company: 'Globex', role: 'Data', contact: 'Mia Fox',
    title: 'Recruiter', channel: 'InMail', date: '2026-06-25', outcome: 'Pending', notes: 'cold intro',
  })
  const rows = parseOutreachLog(next)
  const mia = rows.find(r => r.contact === 'Mia Fox')!
  assert.equal(mia.touch, 1)
  assert.equal(mia.num, 5) // max was 4
  assert.equal(mia.channel, 'InMail')
  assert.equal(rows.length, 5)
})

test('appendOutreachTouch derives the next touch number for an existing contact', () => {
  const next = appendOutreachTouch(LOG, {
    company: 'Helios', role: 'Analyst', contact: 'Dana Kim',
    title: 'Recruiter', channel: 'Message', date: '2026-06-25', outcome: 'Pending',
  })
  const rows = parseOutreachLog(next)
  const danaRows = rows.filter(r => r.contact === 'Dana Kim')
  assert.equal(danaRows.length, 3)
  assert.equal(Math.max(...danaRows.map(r => r.touch)), 3) // was 2 → now 3
})

test('appendOutreachTouch scaffolds a fresh table when the file is empty', () => {
  const next = appendOutreachTouch(null, {
    company: 'Acme', contact: 'Sam Diaz', channel: 'Message', date: '2026-06-25',
  })
  assert.ok(next.includes(OUTREACH_HEADER))
  const rows = parseOutreachLog(next)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].num, 1)
  assert.equal(rows[0].touch, 1)
})

test('appendOutreachTouch defaults date to today and outcome to Pending', () => {
  const next = appendOutreachTouch('', { company: 'Acme', contact: 'X', channel: 'Email' })
  const rows = parseOutreachLog(next)
  assert.equal(rows[0].outcome, 'Pending')
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/)
})

test('appendOutreachTouch sanitizes pipes and newlines in user input', () => {
  const next = appendOutreachTouch('', {
    company: 'Acme', contact: 'Y', channel: 'Email', notes: 'a | b\nc',
  })
  // The new row must not break the single-line, pipe-delimited table.
  const dataLines = next.split('\n').filter(l => /^\|\s*1\s*\|/.test(l))
  assert.equal(dataLines.length, 1)
  const rows = parseOutreachLog(next)
  assert.ok(!rows[0].notes.includes('|'))
  assert.ok(!rows[0].notes.includes('\n'))
})

// ─── updateOutreachOutcome ────────────────────────────────────────────────────

test('updateOutreachOutcome rewrites the latest matching row outcome', () => {
  const next = updateOutreachOutcome(LOG, 'Helios', 'Dana Kim', 'Replied', 'call booked')
  const rows = parseOutreachLog(next)
  const danaRows = rows.filter(r => r.contact === 'Dana Kim')
  // Touch 2 (latest, 2026-06-12) flips; touch 1 stays Pending.
  const latest = danaRows.find(r => r.touch === 2)!
  assert.equal(latest.outcome, 'Replied')
  assert.equal(latest.notes, 'call booked')
  assert.equal(danaRows.find(r => r.touch === 1)!.outcome, 'Pending')
})

test('updateOutreachOutcome is a no-op for an unknown contact', () => {
  const next = updateOutreachOutcome(LOG, 'Nope', 'Ghost', 'Replied')
  assert.equal(next, LOG)
})

test('updateOutreachOutcome leaves notes alone when not provided', () => {
  const next = updateOutreachOutcome(LOG, 'Acme', 'Sam Diaz', 'Declined')
  const rows = parseOutreachLog(next)
  const sam = rows.find(r => r.contact === 'Sam Diaz')!
  assert.equal(sam.outcome, 'Declined')
  assert.equal(sam.notes, 'got a reply') // preserved
})

test('updateOutreachOutcome then board reflects the new verdict', () => {
  const next = updateOutreachOutcome(LOG, 'Northwind', 'Lee Park', 'Declined')
  const board = buildOutreachBoard(next, NOW)
  assert.equal(board.find(c => c.contact === 'Lee Park')!.action, 'cold')
})
