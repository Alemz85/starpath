import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage } from '@/lib/messages'
import { findMessageById, messageExcerpt } from './messageCardData'

const msg = (id: string): AgentMessage => ({
  id, created_at: '2026-10-21T08:00:00Z', source: 'chat', kind: 'suggestion', title: 't', body: '', links: [],
  status: 'open', updated_at: '2026-10-21T08:00:00Z', resolved_at: null, resolution_note: null, history: [],
})

test('findMessageById matches the exact id only', () => {
  const list = [msg('m-20261021-aaaa1111'), msg('m-20261021-bbbb2222')]
  assert.equal(findMessageById(list, ' m-20261021-bbbb2222 ')?.id, 'm-20261021-bbbb2222')
  assert.equal(findMessageById(list, 'm-20261021-bbbb'), null)
  assert.equal(findMessageById([], 'm-1'), null)
})

test('messageExcerpt flattens markdown to one plain line', () => {
  const body = '## Heads up\n\nThe **Nimbus** scan found [two roles](https://example.com/x).\n\n- first\n- second\n\n```\ncode\n```'
  assert.equal(messageExcerpt(body), 'Heads up The Nimbus scan found two roles. first; second.')
})

test('messageExcerpt cuts long text on a word edge with an ellipsis', () => {
  const body = 'word '.repeat(100)
  const out = messageExcerpt(body, 50)
  assert.ok(out.endsWith('…'))
  assert.ok(out.length <= 51)
  assert.ok(!/\sw…$/.test(out) || out.endsWith('word…'))
  assert.equal(messageExcerpt('short'), 'short')
  assert.equal(messageExcerpt(''), '')
})
