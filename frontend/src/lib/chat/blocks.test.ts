import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_BLOCK_TAGS, DEADLINE_DAYS_DEFAULT, DEADLINE_DAYS_MAX, DEADLINE_DAYS_MIN, MAX_BLOCKS_PER_MESSAGE,
  MAX_LABEL_CHARS, TOP_LIMIT_DEFAULT, TOP_LIMIT_MAX, TOP_LIMIT_MIN,
  isChatBlockTag, isProposalBlock, moveQuestion, parseChatBlock, parseChatBlocks, sameKey, splitChatContent,
  type ChatBlock, type ChatBlockKind, type ParseChatBlockResult,
} from '@/lib/chat/blocks'

const MSG = 'msg-1'

function fence(tag: string, body: string): string {
  return ['```' + tag, body, '```'].join('\n')
}

function ok(tag: string, body: unknown): ChatBlock {
  const result = parseChatBlock(tag, JSON.stringify(body), false)
  assert.equal(result.status, 'ok', `${tag} ${JSON.stringify(body)} → ${JSON.stringify(result)}`)
  return (result as Extract<ParseChatBlockResult, { status: 'ok' }>).block
}

function invalid(tag: string, body: unknown): string {
  const result = parseChatBlock(tag, typeof body === 'string' ? body : JSON.stringify(body), false)
  assert.equal(result.status, 'invalid', `${tag} ${JSON.stringify(body)} should be invalid`)
  return (result as Extract<ParseChatBlockResult, { status: 'invalid' }>).reason
}

// ─── The catalogue ────────────────────────────────────────────────────────────

test('the catalogue: two proposal tags and six reference tags', () => {
  assert.deepEqual([...CHAT_BLOCK_TAGS], [
    'starpath:apply', 'starpath:status',
    'starpath:application', 'starpath:listing', 'starpath:report', 'starpath:company',
    'starpath:deadlines', 'starpath:top',
  ])
  assert.equal(isChatBlockTag('starpath:application'), true)
  assert.equal(isChatBlockTag('starpath:delete'), false)
  assert.equal(isChatBlockTag('json'), false)
})

test('every block kind parses from a minimal valid body', () => {
  const kinds: Record<ChatBlockKind, ChatBlock> = {
    apply:       ok('starpath:apply', { company: 'Acme', role: 'Analyst' }),
    status:      ok('starpath:status', { company: 'Acme', role: 'Analyst', status: 'Rejected' }),
    application: ok('starpath:application', { company: 'Acme', role: 'Analyst' }),
    listing:     ok('starpath:listing', { company: 'Acme', role: 'Analyst' }),
    report:      ok('starpath:report', { company: 'Acme', role: 'Analyst' }),
    company:     ok('starpath:company', { company: 'Acme' }),
    deadlines:   ok('starpath:deadlines', {}),
    top:         ok('starpath:top', { list: 'companies' }),
  }
  for (const [kind, block] of Object.entries(kinds)) assert.equal(block.kind, kind)
  assert.equal(isProposalBlock(kinds.apply), true)
  assert.equal(isProposalBlock(kinds.status), true)
  assert.equal(isProposalBlock(kinds.application), false)
})

// ─── Reference blocks ─────────────────────────────────────────────────────────

test('application / listing / report carry company, role and an optional label', () => {
  for (const tag of ['starpath:application', 'starpath:listing', 'starpath:report']) {
    assert.deepEqual(
      ok(tag, { company: '  Acme  Corp ', role: 'Data\nAnalyst', label: 'The one closing Friday' }),
      { kind: tag.slice('starpath:'.length), company: 'Acme Corp', role: 'Data Analyst', label: 'The one closing Friday' },
    )
    // An empty label is just absent.
    assert.equal('label' in ok(tag, { company: 'A', role: 'B', label: '  ' }), false)
    assert.match(invalid(tag, { company: 'Acme' }), /role/)
    assert.match(invalid(tag, { role: 'Analyst' }), /company/)
    assert.match(invalid(tag, { company: 42, role: 'Analyst' }), /company must be a string/)
    assert.match(invalid(tag, { company: 'A|B', role: 'Analyst' }), /\|/)
    assert.match(invalid(tag, { company: 'x'.repeat(201), role: 'Analyst' }), /exceeds/)
    assert.match(invalid(tag, { company: 'A', role: 'B', label: 'x'.repeat(MAX_LABEL_CHARS + 1) }), /label/)
    assert.match(invalid(tag, ['Acme', 'Analyst']), /JSON object/)
  }
})

test('company needs only a company', () => {
  assert.deepEqual(ok('starpath:company', { company: 'Acme', role: 'ignored' }), { kind: 'company', company: 'Acme' })
  assert.match(invalid('starpath:company', {}), /company/)
})

test('deadlines: days defaults, clamps into range, and must be a whole number', () => {
  assert.deepEqual(ok('starpath:deadlines', {}), { kind: 'deadlines', days: DEADLINE_DAYS_DEFAULT })
  assert.deepEqual(ok('starpath:deadlines', { days: 30, label: 'This month' }), { kind: 'deadlines', days: 30, label: 'This month' })
  assert.equal((ok('starpath:deadlines', { days: 0 }) as { days: number }).days, DEADLINE_DAYS_MIN)
  assert.equal((ok('starpath:deadlines', { days: 1000 }) as { days: number }).days, DEADLINE_DAYS_MAX)
  assert.match(invalid('starpath:deadlines', { days: 2.5 }), /whole number/)
  assert.match(invalid('starpath:deadlines', { days: '7' }), /whole number/)
})

test('top: list is an enum; limit defaults and clamps', () => {
  for (const list of ['companies', 'locations', 'archetypes']) {
    assert.deepEqual(ok('starpath:top', { list }), { kind: 'top', list, limit: TOP_LIMIT_DEFAULT })
  }
  assert.equal((ok('starpath:top', { list: 'companies', limit: 1 }) as { limit: number }).limit, TOP_LIMIT_MIN)
  assert.equal((ok('starpath:top', { list: 'companies', limit: 50 }) as { limit: number }).limit, TOP_LIMIT_MAX)
  assert.match(invalid('starpath:top', { list: 'salaries' }), /list must be one of/)
  assert.match(invalid('starpath:top', {}), /list must be one of/)
  assert.match(invalid('starpath:top', { list: 'companies', limit: 'five' }), /whole number/)
})

// ─── Proposal blocks through the block parser ─────────────────────────────────

test('status carries the optional date and stage the card pre-fills', () => {
  assert.deepEqual(
    ok('starpath:status', { company: 'Acme', role: 'Analyst', status: 'Rejected', date: '2026-10-18', stage: 'after the interview' }),
    { kind: 'status', proposal: { kind: 'status', company: 'Acme', role: 'Analyst', status: 'Rejected', date: '2026-10-18', stage: 'after the interview' } },
  )
  assert.match(invalid('starpath:status', { company: 'A', role: 'B', status: 'Rejected', date: '18/10/2026' }), /YYYY-MM-DD/)
  assert.match(invalid('starpath:status', { company: 'A', role: 'B', status: 'Rejected', date: '2026-02-30' }), /real calendar date/)
  assert.match(invalid('starpath:status', { company: 'A', role: 'B', status: 'Ghosted' }), /status must be one of/)
  assert.equal(moveQuestion('Rejected'), 'Move to Rejected?')
})

// ─── Streaming states ─────────────────────────────────────────────────────────

test('parseChatBlock: ok | pending | invalid | not-a-block', () => {
  assert.equal(parseChatBlock('json', '{}', true).status, 'not-a-block')
  assert.equal(parseChatBlock('starpath:nope', '{}', false).status, 'not-a-block')
  // Broken JSON: pending while streaming, invalid once final.
  assert.equal(parseChatBlock('starpath:listing', '{"company":"Ac', true).status, 'pending')
  assert.equal(parseChatBlock('starpath:listing', '{"company":"Ac', false).status, 'invalid')
  // Valid JSON, bad payload: same.
  assert.equal(parseChatBlock('starpath:top', '{"list":"x"}', true).status, 'pending')
  assert.equal(parseChatBlock('starpath:top', '{"list":"x"}', false).status, 'invalid')
  // Never throws on garbage.
  for (const body of ['', 'null', '[]', '"x"', '{', '}}}', '\u0000']) {
    for (const streaming of [true, false]) {
      assert.doesNotThrow(() => parseChatBlock('starpath:application', body, streaming))
    }
  }
})

test('a block still arriving renders as pending, then as a card', () => {
  const head = 'Here it is:\n\n```starpath:application\n{"company":"Acme","ro'
  const mid = splitChatContent(head, MSG, true)
  assert.deepEqual(mid.map(s => s.kind), ['markdown', 'pending'])
  assert.deepEqual(mid[1], { kind: 'pending', id: 'msg-1#p0', index: 0, tag: 'starpath:application' })

  // Closed but the reply is still streaming and nothing follows the fence:
  // still allowed to be incomplete.
  const closedBad = 'Here:\n\n' + fence('starpath:application', '{"company":"Acme"}')
  assert.deepEqual(splitChatContent(closedBad, MSG, true).map(s => s.kind), ['markdown', 'pending'])

  const done = 'Here it is:\n\n' + fence('starpath:application', '{"company":"Acme","role":"Analyst"}') + '\n\nThat one.'
  const final = splitChatContent(done, MSG, false)
  assert.deepEqual(final.map(s => s.kind), ['markdown', 'block', 'markdown'])
  // The same complete block is a card mid-stream too.
  assert.deepEqual(splitChatContent(done, MSG, true).map(s => s.kind), ['markdown', 'block', 'markdown'])
})

test('a bad block followed by more text is invalid even mid-stream', () => {
  const text = fence('starpath:top', '{"list":"salaries"}') + '\n\nMore prose arriving'
  const segments = splitChatContent(text, MSG, true)
  assert.deepEqual(segments.map(s => s.kind), ['markdown'])
  assert.match((segments[0] as { text: string }).text, /```starpath:top/)
})

test('once final, an unclosed or invalid block is a plain code block', () => {
  const cut = 'Look:\n\n```starpath:company\n{"company":'
  const segments = splitChatContent(cut, MSG, false)
  assert.deepEqual(segments.map(s => s.kind), ['markdown'])
  assert.match((segments[0] as { text: string }).text, /starpath:company/)
  assert.deepEqual(parseChatBlocks(cut, MSG).map(b => b.status === 'invalid' && b.reason), ['the block was cut off'])
})

// ─── Ids and mixing ───────────────────────────────────────────────────────────

test('ids count every recognised fence, so mixed turns get stable distinct ids', () => {
  const text = [
    fence('starpath:application', '{"company":"Acme","role":"Analyst"}'),
    fence('json', '{"not":"a card"}'),
    fence('starpath:status', '{"company":"Acme","role":"Analyst","status":"Rejected"}'),
    fence('starpath:deadlines', '{"days":7}'),
  ].join('\n\n')
  const segments = splitChatContent(text, MSG)
  const cards = segments.filter(s => s.kind === 'block') as Array<{ id: string; block: ChatBlock }>
  assert.deepEqual(cards.map(c => c.id), ['msg-1#p0', 'msg-1#p1', 'msg-1#p2'])
  assert.deepEqual(cards.map(c => c.block.kind), ['application', 'status', 'deadlines'])
  // The plain json fence stays prose.
  assert.ok(segments.some(s => s.kind === 'markdown' && /```json/.test(s.text)))
})

test('a reply saved before reference cards keeps its proposal ids', () => {
  // Only apply/status fences existed then; they still number 0, 1.
  const old = [
    fence('starpath:apply', '{"company":"Acme","role":"Analyst"}'),
    'Also:',
    fence('starpath:status', '{"company":"Globex","role":"PM","status":"Applied"}'),
  ].join('\n\n')
  const ids = parseChatBlocks(old, 'saved-msg').map(b => b.id)
  assert.deepEqual(ids, ['saved-msg#p0', 'saved-msg#p1'])
})

test('a reference block nested in another fence is not a card', () => {
  const text = ['````markdown', fence('starpath:company', '{"company":"Acme"}'), '````'].join('\n')
  assert.deepEqual(parseChatBlocks(text, MSG), [])
  assert.deepEqual(splitChatContent(text, MSG).map(s => s.kind), ['markdown'])
})

test('cards past the per-message cap fall back to code', () => {
  const one = fence('starpath:company', '{"company":"Acme"}')
  const text = Array.from({ length: MAX_BLOCKS_PER_MESSAGE + 2 }, () => one).join('\n\n')
  assert.equal(splitChatContent(text, MSG).filter(s => s.kind === 'block').length, MAX_BLOCKS_PER_MESSAGE)
  assert.equal(parseChatBlocks(text, MSG).filter(b => b.status === 'invalid').length, 2)
})

test('sameKey matches the trackers: case and spacing, never fuzzy', () => {
  assert.equal(sameKey('Acme  Corp', ' acme corp'), true)
  assert.equal(sameKey('Acme', 'Acme Corp'), false)
})
