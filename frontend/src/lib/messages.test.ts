import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkLabel, messagesBadge, relativeTime, splitMessages, type AgentMessage } from './messages'

const msg = (id: string, over: Partial<AgentMessage> = {}): AgentMessage => ({
  id, created_at: '2026-07-10T09:00:00.000Z', source: 'session', kind: 'fyi', title: id, body: '', links: [],
  status: 'open', updated_at: '2026-07-10T09:00:00.000Z', resolved_at: null, resolution_note: null, history: [],
  ...over,
})

test('splitMessages: open newest first, closed most recently closed first', () => {
  const { open, closed } = splitMessages([
    msg('a', { created_at: '2026-07-10T08:00:00Z' }),
    msg('b', { created_at: '2026-07-10T10:00:00Z' }),
    msg('c', { status: 'resolved', resolved_at: '2026-07-11T00:00:00Z' }),
    msg('d', { status: 'dismissed', resolved_at: '2026-07-12T00:00:00Z' }),
  ])
  assert.deepEqual(open.map(m => m.id), ['b', 'a'])
  assert.deepEqual(closed.map(m => m.id), ['d', 'c'])
})

test('messagesBadge: accent only when an open message asks to act', () => {
  assert.deepEqual(messagesBadge([msg('a'), msg('b', { kind: 'suggestion' })]), { count: 2, accent: false })
  assert.deepEqual(messagesBadge([msg('a'), msg('b', { kind: 'approval' })]), { count: 2, accent: true })
  assert.deepEqual(messagesBadge([msg('a', { kind: 'alert', status: 'resolved' })]), { count: 0, accent: false })
})

test('linkLabel: label, report file name, host, application', () => {
  assert.equal(linkLabel({ kind: 'url', target: 'https://example.com/x', label: 'Listing' }), 'Listing')
  assert.equal(linkLabel({ kind: 'report', target: 'reports/tier-1/Nimbus Robotics - Strategy Analyst.md' }), 'Nimbus Robotics - Strategy Analyst')
  assert.equal(linkLabel({ kind: 'url', target: 'https://www.example.com/jobs/1' }), 'example.com')
  assert.equal(linkLabel({ kind: 'application', target: 'nimbus|analyst' }), 'Application')
  assert.equal(linkLabel({ kind: 'file', target: 'data/scheduled-runs.log' }), 'data/scheduled-runs.log')
})

test('relativeTime', () => {
  const now = new Date('2026-07-10T12:00:00Z')
  assert.equal(relativeTime('2026-07-10T11:59:40Z', now), 'just now')
  assert.equal(relativeTime('2026-07-10T11:30:00Z', now), '30 min ago')
  assert.equal(relativeTime('2026-07-10T07:00:00Z', now), '5 h ago')
  assert.equal(relativeTime('2026-07-09T10:00:00Z', now), 'yesterday')
  assert.equal(relativeTime('2026-07-07T12:00:00Z', now), '3 days ago')
  assert.equal(relativeTime(null, now), '')
  assert.equal(relativeTime('garbage', now), '')
})
