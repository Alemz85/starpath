import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyFor, rejectionStage, sortStatusLog, type StatusLogEntry } from './statusLog'

const e = (over: Partial<StatusLogEntry>): StatusLogEntry => ({
  num: 1, date: '2026-06-01', company: 'Nimbus Robotics', role: 'Strategy Analyst',
  from: '', to: 'Evaluated', stage: '', source: 'app', note: '', logged_at: '2026-06-01T10:00:00Z',
  ...over,
})

test('sortStatusLog orders by event date, then by write order', () => {
  const log = [
    e({ date: '2026-06-10', to: 'Interview', from: 'Applied' }),
    e({ date: '2026-06-02', to: 'Applied', from: 'Evaluated' }),
    e({ date: '2026-06-10', to: 'Rejected', from: 'Interview' }),
  ]
  assert.deepEqual(sortStatusLog(log).map(x => x.to), ['Applied', 'Interview', 'Rejected'])
})

test('historyFor matches the number and guards against a reused number', () => {
  const log = [
    e({ to: 'Applied', from: 'Evaluated' }),
    e({ num: 2, company: 'Contoso Labs', role: 'Ops Analyst', to: 'Applied' }),
    e({ company: 'Fabrikam Energy', role: 'Data Analyst', to: 'Offer' }),
    e({ company: '', role: '', to: 'Interview', from: 'Applied', date: '2026-06-05' }),
  ]
  const h = historyFor(log, { num: 1, company: 'nimbus robotics', role: 'Strategy Analyst' })
  assert.deepEqual(h.map(x => x.to), ['Applied', 'Interview'])
})

test('rejectionStage prefers an explicit stage, else infers it from the prior status', () => {
  assert.equal(rejectionStage([e({ to: 'Applied', from: 'Evaluated' })]), null)
  assert.deepEqual(
    rejectionStage([e({ to: 'Applied', from: 'Evaluated' }), e({ date: '2026-06-20', to: 'Rejected', from: 'Interview' })]),
    { stage: 'Interview', from: 'Interview', date: '2026-06-20', explicit: false },
  )
  assert.deepEqual(
    rejectionStage([e({ date: '2026-06-20', to: 'Rejected', from: 'Interview', stage: 'final round' })]),
    { stage: 'final round', from: 'Interview', date: '2026-06-20', explicit: true },
  )
  // an application that was rejected straight away (origin row) has no prior status
  assert.equal(rejectionStage([e({ to: 'Rejected', from: '' })])?.stage, 'unknown')
})
