// Tests for the chat CLI arg builder + the stream-json readers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_SYSTEM_PROMPT_FILE, buildChatClaudeArgs } from '@/lib/chat/args'
import {
  chatToolLabel,
  extractClaudeCliFailure,
  interpretChatEvent,
  newChatStreamState,
  splitStreamChunk,
} from '@/lib/chat/stream'

// ─── Arg builder ─────────────────────────────────────────────────────────────

test('the chat spawn loads modes/chat.md as an appended system prompt', () => {
  const args = buildChatClaudeArgs('what is urgent?')
  const i = args.indexOf('--append-system-prompt-file')
  assert.ok(i >= 0, 'has --append-system-prompt-file')
  assert.equal(args[i + 1], CHAT_SYSTEM_PROMPT_FILE)
  // Repo-relative, like batch/batch-prompt.md — the spawn's cwd is the repo.
  assert.equal(CHAT_SYSTEM_PROMPT_FILE, 'modes/chat.md')
})

test('the chat spawn keeps the app-wide non-interactive stream flags', () => {
  const args = buildChatClaudeArgs('hello')
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(args.includes('--verbose'))
  assert.deepEqual(
    args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json'],
  )
  // Token-level deltas are what makes the transcript type out live.
  assert.ok(args.includes('--include-partial-messages'))
  assert.equal(args.at(-2), '-p')
  assert.equal(args.at(-1), 'hello')
})

test('--resume is present only once the session has a CLI session id', () => {
  const first = buildChatClaudeArgs('hi')
  assert.ok(!first.includes('--resume'))

  const later = buildChatClaudeArgs('and then?', { resumeId: 'abc-123' })
  const i = later.indexOf('--resume')
  assert.ok(i >= 0)
  assert.equal(later[i + 1], 'abc-123')

  // A null/empty id (fresh session row) must not produce a dangling flag.
  assert.ok(!buildChatClaudeArgs('hi', { resumeId: null }).includes('--resume'))
  assert.ok(!buildChatClaudeArgs('hi', { resumeId: '' }).includes('--resume'))
})

test('--model follows the configured alias, and is omitted without one', () => {
  const args = buildChatClaudeArgs('hi', { model: 'opus' })
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus'])
  assert.ok(!buildChatClaudeArgs('hi').includes('--model'))
  assert.ok(!buildChatClaudeArgs('hi', { model: null }).includes('--model'))
})

test('flags come before the prompt so a prompt starting with "-" is never read as one', () => {
  const args = buildChatClaudeArgs('--not-a-flag', { resumeId: 'r', model: 'sonnet' })
  assert.equal(args.indexOf('-p'), args.length - 2)
})

// ─── CLI failure extraction ──────────────────────────────────────────────────

test('a failure reported inside the JSON stream is surfaced instead of an exit code', () => {
  assert.equal(
    extractClaudeCliFailure({
      type: 'assistant',
      error: 'overloaded_error',
      message: { content: [{ type: 'text', text: '  API is overloaded  ' }] },
    }),
    'API is overloaded',
  )
  assert.equal(
    extractClaudeCliFailure({ type: 'result', is_error: true, result: 'Credit balance is too low' }),
    'Credit balance is too low',
  )
})

test('successful events carry no failure', () => {
  assert.equal(extractClaudeCliFailure({ type: 'result', is_error: false, result: 'done' }), null)
  assert.equal(extractClaudeCliFailure({ type: 'assistant', message: { content: [] } }), null)
  assert.equal(extractClaudeCliFailure({ type: 'result', is_error: true, result: '   ' }), null)
  assert.equal(extractClaudeCliFailure('not an object'), null)
  assert.equal(extractClaudeCliFailure(null), null)
})

// ─── Stream interpretation ───────────────────────────────────────────────────

test('the init event hands back the id that later turns resume from', () => {
  const state = newChatStreamState()
  assert.deepEqual(
    interpretChatEvent({ type: 'system', subtype: 'init', session_id: 'sess-9' }, state),
    [{ kind: 'session', id: 'sess-9' }],
  )
})

test('text deltas stream through; the non-partial assistant echo does not double them', () => {
  const state = newChatStreamState()
  const delta = interpretChatEvent(
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Two' } } },
    state,
  )
  assert.deepEqual(delta, [{ kind: 'text', text: 'Two' }])
  const echo = interpretChatEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two' }] } }, state)
  assert.deepEqual(echo, [])
})

test('a tool call becomes one work-log entry, deduped by tool id', () => {
  const state = newChatStreamState()
  const event = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'data/scouting.md' } }] },
  }
  const first = interpretChatEvent(event, state)
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'work')
  assert.deepEqual(interpretChatEvent(event, state), [], 'same tool id is not logged twice')
})

test('tool labels reuse the activity panel formatter, minus its log arrow', () => {
  assert.equal(chatToolLabel('Read', { file_path: 'data/pipeline.md' }), 'Read data/pipeline.md')
  assert.equal(chatToolLabel('Bash', { command: 'node scripts/deadlines.mjs --json' }),
    'Bash: node scripts/deadlines.mjs --json')
  // TodoWrite is internal scheduling — the humanizer drops it, so does the log.
  assert.equal(chatToolLabel('TodoWrite', {}), null)
})

test('the first thinking block is noted once', () => {
  const state = newChatStreamState()
  const event = { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }
  assert.equal(interpretChatEvent(event, state).length, 1)
  assert.deepEqual(interpretChatEvent(event, state), [])
})

test('chunks split mid-line are stitched back together', () => {
  const a = splitStreamChunk('', '{"type":"system","subtype":"init","session_id":"s"}\n{"type":"res')
  assert.equal(a.events.length, 1)
  const b = splitStreamChunk(a.buffer, 'ult","is_error":false}\n')
  assert.equal(b.events.length, 1)
  assert.equal(b.buffer, '')
})

test('an unparseable trailing line (a killed CLI) is dropped, not thrown on', () => {
  const { events } = splitStreamChunk('', '{"type":"system"}\n{"type":"assis\n')
  assert.equal(events.length, 1)
})
