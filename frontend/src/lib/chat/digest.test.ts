import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DIGEST_ITEMS, cardDecisionDigest, withCardDigest } from '@/lib/chat/digest'
import { describeDecision } from '@/lib/chat/proposals'
import type { ChatMessage } from '@/lib/chat/types'

const user = (ts: string, content = 'hi'): ChatMessage => ({ role: 'user', content, ts, id: `u-${ts}` })
const reply = (ts: string, decisions?: ChatMessage['proposalDecisions']): ChatMessage =>
  ({ role: 'assistant', content: '…', ts, id: `a-${ts}`, proposalDecisions: decisions })

test('describeDecision reads as a fact about the tracker', () => {
  const move = { kind: 'status' as const, company: 'Acme', role: 'Analyst', status: 'Rejected' as const }
  assert.equal(describeDecision(move, 'applied'), 'moved Acme — Analyst to Rejected')
  assert.equal(
    describeDecision({ ...move, date: '2026-10-18', stage: 'after the interview' }, 'applied'),
    'moved Acme — Analyst to Rejected (2026-10-18, after the interview)',
  )
  assert.equal(describeDecision(move, 'dismissed'), 'dismissed moving Acme — Analyst to Rejected')
  const add = { kind: 'apply' as const, company: 'Acme', role: 'Analyst' }
  assert.equal(describeDecision(add, 'applied'), 'added Acme — Analyst to applications')
  assert.equal(describeDecision({ ...add, status: 'Applied' as const }, 'applied'), 'added Acme — Analyst to applications as Applied')
  assert.equal(describeDecision(add, 'dismissed'), 'dismissed adding Acme — Analyst to applications')
})

test('no reply yet, or no decisions since it: no digest', () => {
  assert.equal(cardDecisionDigest(null), null)
  assert.equal(cardDecisionDigest({ messages: [] }), null)
  assert.equal(cardDecisionDigest({ messages: [user('2026-10-20T09:00:00Z')] }), null)
  assert.equal(cardDecisionDigest({ messages: [user('2026-10-20T09:00:00Z'), reply('2026-10-20T09:01:00Z')] }), null)
})

test('decisions made after the latest reply are listed, oldest first', () => {
  const session = {
    messages: [
      user('2026-10-20T09:00:00Z'),
      reply('2026-10-20T09:01:00Z', {
        'a#p1': { status: 'dismissed' as const, at: '2026-10-20T09:05:00Z', detail: 'dismissed adding Globex — PM to applications' },
        'a#p0': { status: 'applied' as const, at: '2026-10-20T09:02:00Z', detail: 'moved Acme — Analyst to Rejected (2026-10-18, after the interview)' },
      }),
    ],
  }
  assert.equal(
    cardDecisionDigest(session),
    '[Card decisions since your last reply: moved Acme — Analyst to Rejected (2026-10-18, after the interview); dismissed adding Globex — PM to applications.]',
  )
  assert.equal(withCardDigest('thanks', session).split('\n\n')[1], 'thanks')
  assert.equal(withCardDigest('thanks', { messages: [] }), 'thanks')
})

test('decisions the agent already saw (before its latest reply) are not repeated', () => {
  const session = {
    messages: [
      user('2026-10-20T09:00:00Z'),
      reply('2026-10-20T09:01:00Z', { 'a#p0': { status: 'applied' as const, at: '2026-10-20T09:02:00Z', detail: 'moved Acme — Analyst to Rejected' } }),
      user('2026-10-20T09:03:00Z'),
      reply('2026-10-20T09:04:00Z'),
    ],
  }
  assert.equal(cardDecisionDigest(session), null)
  // …but a later click on that older card is new.
  session.messages[1].proposalDecisions!['a#p1'] = { status: 'dismissed', at: '2026-10-20T09:06:00Z' }
  assert.equal(cardDecisionDigest(session), '[Card decisions since your last reply: dismissed a card.]')
})

test('the digest is one line and capped', () => {
  const decisions: NonNullable<ChatMessage['proposalDecisions']> = {}
  for (let i = 0; i < MAX_DIGEST_ITEMS + 3; i++) {
    decisions[`a#p${i}`] = { status: 'applied', at: `2026-10-20T10:${String(i).padStart(2, '0')}:00Z`, detail: `moved\nX${i} — R to Applied` }
  }
  const digest = cardDecisionDigest({ messages: [reply('2026-10-20T09:00:00Z', decisions)] })!
  assert.doesNotMatch(digest, /\n/)
  assert.match(digest, /and 3 more\.\]$/)
  assert.match(digest, /moved X0 — R to Applied/)
})
