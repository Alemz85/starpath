import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOutreachLog, classifyOutreachLog } from '@/lib/outreachLog'

const NOW = new Date(2026, 5, 25) // 2026-06-25

const LOG = `# Outreach

| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Helios | Analyst | Dana Kim | Recruiter | Message | 1 | Pending | first touch |
| 2 | 2026-06-22 | Northwind | PM | Lee Park | Hiring Manager | Connection | 1 | Pending | sent request |
| 3 | 2026-06-01 | Acme | Ops | Sam Diaz | Peer | Message | 1 | Replied | got a reply |
`

test('parseOutreachLog reads only numbered table rows', () => {
  const rows = parseOutreachLog(LOG)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].company, 'Helios')
  assert.equal(rows[0].contact, 'Dana Kim')
  assert.equal(rows[1].channel, 'Connection')
})

test('parseOutreachLog tolerates a null / empty file', () => {
  assert.deepEqual(parseOutreachLog(null), [])
  assert.deepEqual(parseOutreachLog(''), [])
  assert.deepEqual(parseOutreachLog('# Outreach\n\nNothing yet.'), [])
})

test('classifyOutreachLog flags an overdue message as a nudge', () => {
  const entries = classifyOutreachLog(LOG, NOW)
  const helios = entries.find(e => e.company === 'Helios')
  assert.ok(helios)
  // 15 days since touch, message_first window is 5 → nudge due.
  assert.equal(helios!.action, 'nudge')
  assert.equal(helios!.daysSince, 15)
})

test('classifyOutreachLog leaves a recent connection request waiting', () => {
  const entries = classifyOutreachLog(LOG, NOW)
  const nw = entries.find(e => e.company === 'Northwind')
  assert.ok(nw)
  // 3 days since touch, connection_first window is 7 → still waiting.
  assert.equal(nw!.action, 'waiting')
})

test('classifyOutreachLog marks a replied contact done (no nudge)', () => {
  const entries = classifyOutreachLog(LOG, NOW)
  const acme = entries.find(e => e.company === 'Acme')
  assert.ok(acme)
  assert.equal(acme!.action, 'done')
})

test('multiple touches to the same contact collapse to the latest', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-01 | Foo | A | Jo | Recruiter | Message | 1 | Pending | initial |
| 2 | 2026-06-12 | Foo | A | Jo | Recruiter | Message | 2 | Pending | first nudge |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries.length, 1)
  // touch 2 reached the message_max ceiling (2) → cold, no more nudges.
  assert.equal(entries[0].action, 'cold')
})

// ─── parseOutreachLog edge cases ──────────────────────────────────────────────

test('parseOutreachLog skips rows with fewer than 11 pipe-delimited parts', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Helios | Analyst | Dana | Rec | Message | 1 | Pending | ok |
| 2 | too | few | columns |
| bad line without any pipe at all
`
  const rows = parseOutreachLog(log)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company, 'Helios')
})

test('parseOutreachLog skips the header separator row (non-numeric first cell)', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Acme | Ops | Sam | VP | Message | 1 | Pending | note |
`
  const rows = parseOutreachLog(log)
  // Only the data row should parse; the header and separator must be skipped.
  assert.equal(rows.length, 1)
})

test('parseOutreachLog defaults touch to 1 when the column is not a number', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Helios | Analyst | Dana | Rec | Message | NaN | Pending | ok |
`
  const rows = parseOutreachLog(log)
  assert.equal(rows[0].touch, 1)
})

test('parseOutreachLog preserves the notes field', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | Helios | Analyst | Dana | Rec | Message | 1 | Pending | keep this note |
`
  const rows = parseOutreachLog(log)
  assert.equal(rows[0].notes, 'keep this note')
})

// ─── channelFamily resolution ─────────────────────────────────────────────────

test('channelFamily maps all connection-like aliases to "connection"', () => {
  // We verify via classify/classifyOutreachLog end-to-end, using a recent touch
  // that's within the 7-day connection_first window → should be "waiting".
  for (const channel of ['Connection', 'connect', 'LinkedIn Connection', 'Connection Request', 'Request']) {
    const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-23 | Acme | R | Jo | T | ${channel} | 1 | Pending | - |
`
    const entries = classifyOutreachLog(log, NOW)
    assert.equal(entries[0].action, 'waiting',
      `channel "${channel}" should be connection_first window → waiting (2d < 7d)`)
  }
})

test('channelFamily defaults to "message" for unknown channel strings', () => {
  // An unrecognized channel, with 6 days since touch — message_first is 5 days → nudge.
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-19 | Acme | R | Jo | T | LinkedIn DM | 1 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  // 6 days since, message_first = 5 → overdue → nudge
  assert.equal(entries[0].action, 'nudge')
})

// ─── normalizeOutcome resolution ──────────────────────────────────────────────

test('normalizeOutcome: declined keywords → cold action', () => {
  for (const outcome of ['Rejected', 'Ignored', 'Ghosted', 'Dead', 'Not Interested']) {
    const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-01 | A | R | J | T | Message | 1 | ${outcome} | - |
`
    const entries = classifyOutreachLog(log, NOW)
    assert.equal(entries[0].action, 'cold',
      `outcome "${outcome}" should produce cold`)
  }
})

test('normalizeOutcome: accepted keyword → connection accepted → uses message window', () => {
  // Connection accepted 8 days ago. state='accepted' → effFamily='message',
  // message_first window = 5 days → 8 >= 5 → nudge.
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-17 | Acme | R | Dana | T | Connection | 1 | Connected | - |
`
  const entries = classifyOutreachLog(log, NOW)
  // 8 days since, effFamily=message, window=5 → nudge
  assert.equal(entries[0].action, 'nudge')
})

test('normalizeOutcome: accepted + within message window → waiting', () => {
  // Connection accepted 3 days ago. effFamily=message, window=5 → 3 < 5 → waiting.
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-22 | Acme | R | Dana | T | Connection | 1 | Connection Accepted | - |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries[0].action, 'waiting')
})

test('normalizeOutcome: replied keywords → done action', () => {
  for (const outcome of ['Replied', 'Responded', 'Call Booked', 'Meeting', 'Intro']) {
    const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-10 | A | R | J | T | Message | 1 | ${outcome} | - |
`
    const entries = classifyOutreachLog(log, NOW)
    assert.equal(entries[0].action, 'done',
      `outcome "${outcome}" should produce done`)
  }
})

// ─── Touch-ceiling edge cases ──────────────────────────────────────────────────

test('connection touch ceiling: exactly 2 touches without reply → cold', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-08 | Acme | R | Jo | T | Connection | 1 | Pending | - |
| 2 | 2026-06-15 | Acme | R | Jo | T | Connection | 2 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries[0].action, 'cold')
})

test('connection at touch 1 is not yet at the ceiling → normal cadence applies', () => {
  // 1 touch, 8 days since → connection_first = 7 → overdue → nudge
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-17 | Acme | R | Jo | T | Connection | 1 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries[0].action, 'nudge')
})

// ─── Invalid / null last-touch date ───────────────────────────────────────────

test('a row with a non-date last-touch produces a nudge with no dSince (null)', () => {
  // parseDate returns null for bad dates → classify takes the dSince===null branch
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | bad-date | Acme | R | Jo | T | Message | 1 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries[0].action, 'nudge')
  assert.ok(entries[0].reason?.includes('No valid last-touch date'))
  assert.equal(entries[0].daysSince, null)
})

// ─── Collapse with same-date rows ─────────────────────────────────────────────

test('collapse picks the higher touch count when two rows share the same date', () => {
  // Both rows on the same date; touch 2 should win over touch 1 for the same key.
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-12 | Foo | A | Jo | T | Message | 1 | Pending | - |
| 2 | 2026-06-12 | Foo | A | Jo | T | Message | 2 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  assert.equal(entries.length, 1)
  // touch 2 = message_max ceiling → cold
  assert.equal(entries[0].action, 'cold')
})

// ─── daysSince propagation ─────────────────────────────────────────────────────

test('classifyOutreachLog computes daysSince correctly from lastTouch', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-20 | Acme | R | Jo | T | Message | 1 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  // NOW is 2026-06-25; lastTouch = 2026-06-20 → 5 days → exactly at window (message_first=5)
  assert.equal(entries[0].daysSince, 5)
  assert.equal(entries[0].action, 'nudge')  // >= 5
})

test('classifyOutreachLog marks contact waiting when within the message window', () => {
  const log = `| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-23 | Acme | R | Jo | T | Message | 1 | Pending | - |
`
  const entries = classifyOutreachLog(log, NOW)
  // 2 days < message_first 5 → waiting
  assert.equal(entries[0].action, 'waiting')
  assert.equal(entries[0].daysSince, 2)
})
