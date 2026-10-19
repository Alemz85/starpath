import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTodaySummary, URGENT_DAYS } from '@/lib/todayCockpit'
import { makeApplication } from '@/test-utils/fixtures'
import type { ApplicationEntry } from '@/types'

// Pin "today" so every day-count assertion is deterministic.
const NOW = new Date(2026, 5, 25) // 2026-06-25 (local midnight)

const summary = (apps: ApplicationEntry[]) => buildTodaySummary(apps, NOW)

// ─── Deadlines ────────────────────────────────────────────────────────────────

test('an Evaluated app with a dated deadline is listed with its countdown', () => {
  const { deadlines } = summary([
    makeApplication({ company: 'Northwind', role: 'Ops Analyst', status: 'Evaluated', deadline: '2026-06-27' }),
  ])
  assert.equal(deadlines.length, 1)
  assert.equal(deadlines[0].company, 'Northwind')
  assert.equal(deadlines[0].daysLeft, 2)
  assert.equal(deadlines[0].severity, 'critical')
})

test('only pre-submission (Evaluated) rows list a deadline', () => {
  const { deadlines } = summary(
    ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'].map((status, i) =>
      makeApplication({ company: `Co${i}`, status: status as ApplicationEntry['status'], deadline: '2026-06-30' }),
    ),
  )
  assert.equal(deadlines.length, 0)
})

test('missed, rolling and undated deadlines are not listed; far-off ones are', () => {
  const { deadlines } = summary([
    makeApplication({ company: 'Missed',  deadline: '2026-06-24' }),
    makeApplication({ company: 'Rolling', deadline: 'Rolling' }),
    makeApplication({ company: 'Undated', deadline: 'n/d' }),
    makeApplication({ company: 'Far',     deadline: '2026-12-01' }),
  ])
  assert.deepEqual(deadlines.map(d => d.company), ['Far'])
  assert.equal(deadlines[0].severity, 'low')
})

test('a deadline today counts as zero days left', () => {
  const { deadlines } = summary([makeApplication({ deadline: '2026-06-25' })])
  assert.equal(deadlines[0].daysLeft, 0)
})

test('deadlines sort soonest first, ties by company', () => {
  const { deadlines } = summary([
    makeApplication({ company: 'Zeta',  deadline: '2026-07-10' }),
    makeApplication({ company: 'Beta',  deadline: '2026-06-28' }),
    makeApplication({ company: 'Alpha', deadline: '2026-06-28' }),
  ])
  assert.deepEqual(deadlines.map(d => d.company), ['Alpha', 'Beta', 'Zeta'])
})

test('severity bands: ≤2 critical, ≤7 high, ≤31 medium, beyond low', () => {
  const sev = (deadline: string) => summary([makeApplication({ deadline })]).deadlines[0].severity
  assert.equal(sev('2026-06-27'), 'critical') // +2
  assert.equal(sev('2026-06-28'), 'high')     // +3
  assert.equal(sev('2026-07-02'), 'high')     // +7
  assert.equal(sev('2026-07-03'), 'medium')   // +8
  assert.equal(sev('2026-07-26'), 'medium')   // +31
  assert.equal(sev('2026-07-27'), 'low')      // +32
})

test('urgent counts deadlines within URGENT_DAYS', () => {
  assert.equal(URGENT_DAYS, 7)
  const { urgent } = summary([
    makeApplication({ company: 'A', deadline: '2026-06-25' }), // 0
    makeApplication({ company: 'B', deadline: '2026-07-02' }), // 7
    makeApplication({ company: 'C', deadline: '2026-07-03' }), // 8
  ])
  assert.equal(urgent, 2)
})

test('duplicate company+role rows list once', () => {
  const { deadlines } = summary([
    makeApplication({ company: 'Acme', role: 'Analyst', deadline: '2026-06-30' }),
    makeApplication({ company: 'Acme', role: 'Analyst', deadline: '2026-06-30' }),
  ])
  assert.equal(deadlines.length, 1)
})

// ─── Waiting counts ───────────────────────────────────────────────────────────

test('Applied rows count as waiting for response; Interview rows as waiting for next round', () => {
  const s = summary([
    makeApplication({ company: 'A', status: 'Applied' }),
    makeApplication({ company: 'B', status: 'Applied' }),
    makeApplication({ company: 'C', status: 'Interview' }),
    makeApplication({ company: 'D', status: 'Responded' }),
    makeApplication({ company: 'E', status: 'Rejected' }),
    makeApplication({ company: 'F', status: 'Evaluated' }),
  ])
  assert.equal(s.awaitingResponse, 2)
  assert.equal(s.awaitingNextRound, 1)
})

test('an empty tracker yields an empty summary', () => {
  assert.deepEqual(summary([]), { deadlines: [], urgent: 0, awaitingResponse: 0, awaitingNextRound: 0 })
})
