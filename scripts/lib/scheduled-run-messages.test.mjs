// scheduled-run-messages.test.mjs — which weekly runs leave the user a
// message, and what it says. Fixtures are fictional.
//
// Run: node --test scripts/lib/scheduled-run-messages.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { messageForRun, runStartDate, topPicksSince } from './scheduled-run-messages.mjs'
import { buildPost } from './messages-core.mjs'

const HEADER = 'date\tarchetype\twant\tease\tpriority\teligibility\tverdict\tcompany\trole\ttier\turl'
const row = (date, verdict, company, role, want, ease, url = '') =>
  [date, 'Strategy & Operations', want, ease, Math.sqrt(want * ease).toFixed(2), 'green', verdict, company, role, 'T1', url].join('\t')
const TSV = [
  HEADER,
  row('2026-07-01', 'go', 'Old Corp', 'Analyst', 9, 9),
  row('2026-07-08', 'stretch', 'Litware', 'Pricing Analyst', 8, 5.5),
  row('2026-07-08', 'go', 'Nimbus Robotics', 'Strategy Analyst', 8.5, 7.5, 'https://example.com/nimbus'),
  row('2026-07-08', 'skip', 'Contoso', 'Inside Sales', 5, 8),
  row('2026-07-08', 'go', 'Fabrikam', 'Ops Analyst', 7.5, 7.2),
].join('\n')

const run = (status, extra = {}) => ({
  id: '2026-07-08T10-00-00-abc123', trigger: 'scheduled', startedAt: '2026-07-08T10:00:00.000Z', finishedAt: '2026-07-08T11:00:00.000Z',
  status, stages: [], summary: {}, error: null, ...extra,
})

test('topPicksSince: go before stretch, by priority, only from the run on', () => {
  const picks = topPicksSince(TSV, '2026-07-08')
  assert.deepEqual(picks.map((p) => p.company), ['Nimbus Robotics', 'Fabrikam', 'Litware'])
  assert.equal(picks[0].url, 'https://example.com/nimbus')
  assert.deepEqual(topPicksSince('', '2026-07-08'), [])
  assert.equal(topPicksSince(TSV, '2026-07-08', 1).length, 1)
})

test('runStartDate: local date of the start', () => {
  assert.match(runStartDate(run('completed')), /^2026-07-0[78]$/)
  assert.equal(runStartDate(null), null)
})

test('a failed run is an alert keyed by day, so same-day retries share it', () => {
  const r = run('failed', { error: 'scan exited 1', stages: [{ name: 'scan', status: 'failed' }] })
  const m = messageForRun({ outcome: 'failed', run: r }, { trigger: 'scheduled' })
  assert.equal(m.kind, 'alert')
  assert.equal(m.key, 'scheduler:failed:2026-07-08')
  assert.match(m.title, /failed \(scan\)/)
  assert.match(m.body, /retries every 2 hours/)
  const retry = messageForRun({ outcome: 'failed', run: { ...r, id: 'another' } }, { trigger: 'scheduled' })
  assert.equal(retry.key, m.key)
  // It is a valid post.
  assert.doesNotThrow(() => buildPost(m, { id: 'm-x', now: new Date() }))
})

test('stopped and blocked runs alert only when the schedule ran them', () => {
  assert.equal(messageForRun({ outcome: 'interrupted', run: run('interrupted') }, { trigger: 'manual' }), null)
  assert.equal(messageForRun({ outcome: 'interrupted', run: run('interrupted') }, { trigger: 'scheduled' }).kind, 'alert')
  assert.equal(messageForRun({ outcome: 'blocked', missing: ['user/cv.md'] }, { trigger: 'manual' }), null)
  const b = messageForRun({ outcome: 'blocked', missing: ['user/cv.md'] }, { trigger: 'scheduled', now: new Date('2026-07-08T12:00:00').getTime() })
  assert.equal(b.key, 'scheduler:blocked:2026-07-08')
  assert.match(b.body, /`user\/cv.md`/)
})

test('skips, locks, dry runs and quiet runs post nothing', () => {
  for (const outcome of ['skipped', 'locked', 'dry-run']) assert.equal(messageForRun({ outcome }), null)
  assert.equal(messageForRun({ outcome: 'completed', run: run('completed', { summary: { scanNew: 0, evalCompleted: 0 } }) }), null)
})

test('a run that found something is an fyi with the top picks and their links', () => {
  const r = run('completed', { summary: { scanNew: 14, queued: 6, evalCompleted: 6, evaluations: true } })
  const m = messageForRun({ outcome: 'completed', run: r }, { picks: topPicksSince(TSV, '2026-07-08') })
  assert.equal(m.kind, 'fyi')
  assert.equal(m.key, `scheduler:run:${r.id}`)
  assert.equal(m.title, 'Weekly run: 2 go picks')
  assert.match(m.body, /14 new listings, 6 queued for evaluation, 6 evaluated/)
  assert.match(m.body, /- Nimbus Robotics: Strategy Analyst \(go, Want 8.5 · Ease 7.5\)/)
  assert.deepEqual(m.links, [{ kind: 'url', target: 'https://example.com/nimbus', label: 'Nimbus Robotics: Strategy Analyst' }])
})

test('scan-only run: says the queue waits in Scout', () => {
  const r = run('partial', { summary: { scanNew: 3, queued: 3, evaluations: false } })
  const m = messageForRun({ outcome: 'partial', run: r })
  assert.match(m.title, /^Weekly run: 3 new listings/)
  assert.match(m.body, /3 listings are queued; evaluations are off/)
})
