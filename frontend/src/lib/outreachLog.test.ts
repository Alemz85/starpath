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
