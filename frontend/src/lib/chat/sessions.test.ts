// Tests for the chat session store — the transforms behind
// {userData}/chat/sessions.json.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSIONS,
  MAX_TITLE_CHARS,
  appendMessage,
  capSessions,
  createSession,
  deleteSession,
  deriveTitle,
  emptySessionsFile,
  getSession,
  listSessions,
  parseSessionsFile,
  serializeSessionsFile,
  setClaudeSessionId,
  setProposalDecision,
} from '@/lib/chat/sessions'
import type { ChatSessionsFile } from '@/lib/chat/types'

const T0 = '2026-08-18T09:00:00.000Z'
const T1 = '2026-08-18T10:00:00.000Z'
const T2 = '2026-08-18T11:00:00.000Z'

function seeded(): { file: ChatSessionsFile; id: string } {
  const created = createSession(emptySessionsFile(), { id: 'a', now: T0 })
  return { file: created.file, id: created.session.id }
}

// ─── create ──────────────────────────────────────────────────────────────────

test('a new session starts empty and is retrievable by id', () => {
  const { file, id } = seeded()
  assert.equal(file.sessions.length, 1)
  const session = getSession(file, id)!
  assert.equal(session.messages.length, 0)
  assert.equal(session.messageCount, 0)
  assert.equal(session.claudeSessionId, null)
  assert.equal(session.title, 'New chat')
})

test('getSession returns null for an unknown id', () => {
  assert.equal(getSession(seeded().file, 'nope'), null)
})

// ─── append ──────────────────────────────────────────────────────────────────

test('appending a message bumps the count and the updated-at stamp', () => {
  const { file, id } = seeded()
  const next = appendMessage(file, id, { role: 'user', content: 'what is urgent?', ts: T1 })
  const session = getSession(next, id)!
  assert.equal(session.messages.length, 1)
  assert.equal(session.messageCount, 1)
  assert.equal(session.updatedAt, T1)
})

test('the first user message names the conversation', () => {
  const { file, id } = seeded()
  const next = appendMessage(file, id, { role: 'user', content: 'Which tier-2s deserve a second look?', ts: T1 })
  assert.equal(getSession(next, id)!.title, 'Which tier-2s deserve a second look?')
  // A later message must not rename it.
  const later = appendMessage(next, id, { role: 'user', content: 'and the tier-3s?', ts: T2 })
  assert.equal(getSession(later, id)!.title, 'Which tier-2s deserve a second look?')
})

test('a title is one line, whitespace-collapsed, and elided at the cap', () => {
  assert.equal(deriveTitle('  first line \n second line '), 'first line')
  assert.equal(deriveTitle('a\t\tb'), 'a b')
  assert.equal(deriveTitle('   '), 'New chat')
  const long = deriveTitle('x'.repeat(200))
  assert.equal(long.length, MAX_TITLE_CHARS)
  assert.ok(long.endsWith('…'))
})

test('appending to an unknown session leaves the file untouched', () => {
  const { file } = seeded()
  assert.equal(appendMessage(file, 'ghost', { role: 'user', content: 'hi', ts: T1 }), file)
})

test('the CLI session id is stored so the next turn can --resume', () => {
  const { file, id } = seeded()
  const next = setClaudeSessionId(file, id, 'cli-abc')
  assert.equal(getSession(next, id)!.claudeSessionId, 'cli-abc')
  // Idempotent — the init event repeats on every resumed turn.
  assert.equal(setClaudeSessionId(next, id, 'cli-abc'), next)
})

// ─── caps ────────────────────────────────────────────────────────────────────

test('a conversation keeps only its most recent turns', () => {
  let { file, id } = seeded()
  for (let i = 0; i < MAX_MESSAGES_PER_SESSION + 10; i++) {
    file = appendMessage(file, id, { role: 'user', content: `m${i}`, ts: T1 })
  }
  const session = getSession(file, id)!
  assert.equal(session.messages.length, MAX_MESSAGES_PER_SESSION)
  assert.equal(session.messageCount, MAX_MESSAGES_PER_SESSION)
  assert.equal(session.messages.at(-1)!.content, `m${MAX_MESSAGES_PER_SESSION + 9}`)
})

test('the oldest conversations fall off once the count cap is passed', () => {
  let file = emptySessionsFile()
  for (let i = 0; i < MAX_SESSIONS + 5; i++) {
    file = createSession(file, { id: `s${i}`, now: T0 }).file
  }
  assert.equal(file.sessions.length, MAX_SESSIONS)
  assert.equal(getSession(file, 's0'), null)
  assert.ok(getSession(file, `s${MAX_SESSIONS + 4}`))
})

test('capSessions is idempotent on a file already within the caps', () => {
  const { file } = seeded()
  assert.deepEqual(capSessions(file), file)
})

// ─── delete ──────────────────────────────────────────────────────────────────

test('deleting removes exactly one conversation', () => {
  let file = createSession(emptySessionsFile(), { id: 'a', now: T0 }).file
  file = createSession(file, { id: 'b', now: T1 }).file
  const next = deleteSession(file, 'a')
  assert.equal(next.sessions.length, 1)
  assert.equal(getSession(next, 'a'), null)
  assert.ok(getSession(next, 'b'))
})

test('deleting an unknown id is a no-op', () => {
  const { file } = seeded()
  assert.equal(deleteSession(file, 'ghost'), file)
})

// ─── listing + round-trip ────────────────────────────────────────────────────

test('the rail lists newest first and never carries message bodies', () => {
  let file = createSession(emptySessionsFile(), { id: 'old', now: T0 }).file
  file = createSession(file, { id: 'new', now: T2 }).file
  const list = listSessions(file)
  assert.deepEqual(list.map(s => s.id), ['new', 'old'])
  assert.ok(!('messages' in list[0]))
})

test('a written file parses back to the same content', () => {
  let { file, id } = seeded()
  file = appendMessage(file, id, { role: 'user', content: 'hello', ts: T1 })
  file = appendMessage(file, id, { role: 'assistant', content: '# Answer\n\nTwo deadlines.', ts: T2 })
  file = setClaudeSessionId(file, id, 'cli-1')
  const round = parseSessionsFile(serializeSessionsFile(file))
  assert.deepEqual(round, file)
})

test('a corrupt or foreign file degrades to no history instead of throwing', () => {
  assert.deepEqual(parseSessionsFile(null), emptySessionsFile())
  assert.deepEqual(parseSessionsFile('not json'), emptySessionsFile())
  assert.deepEqual(parseSessionsFile('{"version":2,"sessions":[]}'), emptySessionsFile())
  // A single malformed session is dropped; the healthy ones survive.
  const mixed = parseSessionsFile(JSON.stringify({
    version: 1,
    sessions: [
      { nope: true },
      { id: 'ok', startedAt: T0, messages: [{ role: 'user', content: 'hi', ts: T0 }, { bad: 1 }] },
    ],
  }))
  assert.equal(mixed.sessions.length, 1)
  assert.equal(mixed.sessions[0].messages.length, 1)
  assert.equal(mixed.sessions[0].messageCount, 1)
})

// ─── proposal decisions ───────────────────────────────────────────────────────

const DECISION = { status: 'applied' as const, at: T1, detail: 'row added' }

function withProposalTurn(): { file: ChatSessionsFile; id: string } {
  const { file, id } = seeded()
  const next = appendMessage(file, id, {
    role: 'assistant', content: 'proposed', ts: T1, id: 'm1',
  })
  return { file: next, id }
}

test('a decision is recorded against the message that produced the fence', () => {
  const { file, id } = withProposalTurn()
  const next = setProposalDecision(file, id, 'm1', 'm1#p0', DECISION)
  assert.deepEqual(getSession(next, id)!.messages[0].proposalDecisions, { 'm1#p0': DECISION })
})

test('a second decision on another block of the same message is additive', () => {
  const { file, id } = withProposalTurn()
  const once = setProposalDecision(file, id, 'm1', 'm1#p0', DECISION)
  const twice = setProposalDecision(once, id, 'm1', 'm1#p1', { status: 'dismissed', at: T2 })
  assert.deepEqual(getSession(twice, id)!.messages[0].proposalDecisions, {
    'm1#p0': DECISION,
    'm1#p1': { status: 'dismissed', at: T2 },
  })
})

test('a decision is final — re-deciding the same block is a no-op', () => {
  const { file, id } = withProposalTurn()
  const once = setProposalDecision(file, id, 'm1', 'm1#p0', DECISION)
  const again = setProposalDecision(once, id, 'm1', 'm1#p0', { status: 'dismissed', at: T2 })
  assert.equal(again, once)  // same object — nothing was rewritten
  assert.deepEqual(getSession(again, id)!.messages[0].proposalDecisions, { 'm1#p0': DECISION })
})

test('an unknown session, message or empty block id leaves the file untouched', () => {
  const { file, id } = withProposalTurn()
  assert.equal(setProposalDecision(file, 'nope', 'm1', 'm1#p0', DECISION), file)
  assert.equal(setProposalDecision(file, id, 'missing', 'm1#p0', DECISION), file)
  assert.equal(setProposalDecision(file, id, 'm1', '', DECISION), file)
})

test('recording a decision does not reorder the session rail', () => {
  const { file, id } = withProposalTurn()
  const before = getSession(file, id)!.updatedAt
  const next = setProposalDecision(file, id, 'm1', 'm1#p0', DECISION)
  assert.equal(getSession(next, id)!.updatedAt, before)
})

test('message ids and decisions survive a save/load round-trip', () => {
  const { file, id } = withProposalTurn()
  const decided = setProposalDecision(file, id, 'm1', 'm1#p0', DECISION)
  const round = parseSessionsFile(serializeSessionsFile(decided))
  assert.deepEqual(round, decided)
  assert.equal(getSession(round, id)!.messages[0].id, 'm1')
  assert.deepEqual(getSession(round, id)!.messages[0].proposalDecisions, { 'm1#p0': DECISION })
})

test('a session persisted before proposal cards existed still loads', () => {
  // No `id`, no `proposalDecisions` — the pre-feature message shape.
  const legacy = parseSessionsFile(JSON.stringify({
    version: 1,
    sessions: [{
      id: 'old', startedAt: T0, updatedAt: T0, title: 'Old chat',
      messages: [{ role: 'user', content: 'hi', ts: T0 }],
    }],
  }))
  assert.equal(legacy.sessions.length, 1)
  const message = legacy.sessions[0].messages[0]
  assert.equal(message.content, 'hi')
  assert.equal(message.id, undefined)
  assert.equal(message.proposalDecisions, undefined)
})

test('corrupt decision records are dropped without losing the message', () => {
  const loaded = parseSessionsFile(JSON.stringify({
    version: 1,
    sessions: [{
      id: 's', startedAt: T0, messages: [{
        role: 'assistant', content: 'x', ts: T0, id: 'm1',
        proposalDecisions: {
          good: { status: 'applied', at: T1 },
          noStatus: { at: T1 },
          badStatus: { status: 'failed', at: T1 },   // transient — never persisted
          notAnObject: 'applied',
          noTimestamp: { status: 'dismissed' },
        },
      }],
    }],
  }))
  assert.equal(loaded.sessions[0].messages.length, 1)
  assert.deepEqual(loaded.sessions[0].messages[0].proposalDecisions, {
    good: { status: 'applied', at: T1 },
  })
})

test('a non-string message id is dropped rather than poisoning block ids', () => {
  const loaded = parseSessionsFile(JSON.stringify({
    version: 1,
    sessions: [{
      id: 's', startedAt: T0,
      messages: [{ role: 'user', content: 'x', ts: T0, id: 42 }],
    }],
  }))
  assert.equal(loaded.sessions[0].messages[0].id, undefined)
})
