import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NON_INTERACTIVE_SUFFIX,
  MODEL_IDS,
  claudeArgs,
  humanizeJsonlChunk,
  humanizeJsonlLine,
  formatToolUse,
  formatResultStats,
  formatTokens,
  formatDuration,
  truncate,
  isAuthFailureText,
  diagnoseFailureText,
} from '@/lib/spawnFormat'

// Compact JSONL event builders so each test reads as the event it exercises,
// not as a wall of JSON.
const ev = (o: object) => JSON.stringify(o)
const assistant = (...content: object[]) => ev({ type: 'assistant', message: { content } })

// ─── claudeArgs ──────────────────────────────────────────────────────────────

test('claudeArgs builds the non-interactive flag set and appends the batch suffix', () => {
  const args = claudeArgs('/career-ops scan', 'sonnet')
  assert.deepEqual(args, [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-sonnet-5',
    '-p',
    '/career-ops scan' + NON_INTERACTIVE_SUFFIX,
  ])
})

// Pin the map itself: every alias must resolve to the current generation's
// full model ID. Bump these literals (and MODEL_IDS) together when a new
// Claude family ships — this test is the reminder.
test('MODEL_IDS pins every tier alias to the current generation', () => {
  assert.deepEqual(MODEL_IDS, {
    opus:   'claude-opus-5',
    sonnet: 'claude-sonnet-5',
    haiku:  'claude-haiku-4-5-20251001',
  })
})

test('claudeArgs omits --model entirely when no model is given', () => {
  const args = claudeArgs('/career-ops pipeline')
  assert.equal(args.includes('--model'), false)
  // -p is the second-to-last token; the prompt is last.
  assert.equal(args[args.length - 2], '-p')
  assert.ok(args[args.length - 1].startsWith('/career-ops pipeline'))
  assert.ok(args[args.length - 1].endsWith(NON_INTERACTIVE_SUFFIX))
})

test('claudeArgs resolves each alias to its pinned model ID — never the bare alias', () => {
  for (const m of ['sonnet', 'opus', 'haiku'] as const) {
    const args = claudeArgs('/x', m)
    assert.equal(args[args.indexOf('--model') + 1], MODEL_IDS[m])
    assert.ok(!args.includes(m), `bare alias '${m}' must not reach the CLI`)
  }
})

// ─── truncate ────────────────────────────────────────────────────────────────

test('truncate leaves short strings untouched and ellipsizes long ones to n chars', () => {
  assert.equal(truncate('short', 80), 'short')
  assert.equal(truncate('x'.repeat(80), 80), 'x'.repeat(80))   // exactly n: untouched
  const out = truncate('x'.repeat(200), 80)
  assert.equal(out.length, 80)
  assert.equal(out.endsWith('…'), true)
  assert.equal(out, 'x'.repeat(79) + '…')
})

// ─── formatToolUse ───────────────────────────────────────────────────────────

test('formatToolUse renders file tools as "→ Name path"', () => {
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.md' } }), '→ Read /a/b.md')
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Edit', input: { path: '/c.ts' } }), '→ Edit /c.ts')
  // No path → just the tool name, no trailing space.
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Write', input: {} }), '→ Write')
})

test('formatToolUse renders Bash with a "Bash:" prefix and truncates the command', () => {
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }), '→ Bash: ls -la')
  const long = formatToolUse({ type: 'tool_use', name: 'Bash', input: { command: 'echo ' + 'a'.repeat(200) } })
  assert.ok(long!.startsWith('→ Bash: '))
  assert.ok(long!.endsWith('…'))
})

test('formatToolUse renders Grep/Glob/WebFetch/WebSearch from their primary input', () => {
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }), '→ Grep TODO')
  assert.equal(formatToolUse({ type: 'tool_use', name: 'Glob', input: { path: 'src/**' } }), '→ Glob src/**')
  assert.equal(formatToolUse({ type: 'tool_use', name: 'WebFetch', input: { url: 'https://x.com' } }), '→ WebFetch https://x.com')
  assert.equal(formatToolUse({ type: 'tool_use', name: 'WebSearch', input: { query: 'job listings' } }), '→ WebSearch job listings')
})

test('formatToolUse drops TodoWrite entirely (internal scheduling)', () => {
  assert.equal(formatToolUse({ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }), null)
})

test('formatToolUse falls back to name + first stringy input for unknown tools', () => {
  // MCP/browser/agent tools: show the first string value if present.
  assert.equal(
    formatToolUse({ type: 'tool_use', name: 'mcp__browser__navigate', input: { count: 3, url: 'https://job.example' } }),
    '→ mcp__browser__navigate https://job.example',
  )
  // No stringy input → bare name. Missing name → "Tool".
  assert.equal(formatToolUse({ type: 'tool_use', name: 'SomeTool', input: { n: 1 } }), '→ SomeTool')
  assert.equal(formatToolUse({ type: 'tool_use', input: {} }), '→ Tool')
})

// ─── humanizeJsonlLine ───────────────────────────────────────────────────────

test('humanizeJsonlLine maps the result event to a capstone', () => {
  assert.equal(humanizeJsonlLine(ev({ type: 'result', subtype: 'success' })), '✓ Done')
  assert.equal(humanizeJsonlLine(ev({ type: 'result', subtype: 'error_during_execution' })), '× error_during_execution')
  assert.equal(humanizeJsonlLine(ev({ type: 'result' })), '× error')  // missing subtype → "error"
})

test('result capstone appends duration/turns/token stats when the event carries them', () => {
  assert.equal(
    humanizeJsonlLine(ev({
      type: 'result', subtype: 'success', duration_ms: 184_000, num_turns: 41,
      usage: { input_tokens: 1200, cache_creation_input_tokens: 45_000, cache_read_input_tokens: 310_000, output_tokens: 5400 },
    })),
    '✓ Done — 3m 04s · 41 turns · 356.2k in (87% cached) / 5.4k out',
  )
  // Failure capstones get the same tail.
  assert.equal(
    humanizeJsonlLine(ev({ type: 'result', subtype: 'error_during_execution', duration_ms: 9000 })),
    '× error_during_execution — 9s',
  )
})

test('formatResultStats returns null when the event has no stats (older CLI)', () => {
  assert.equal(formatResultStats({ type: 'result', subtype: 'success' }), null)
  assert.equal(formatResultStats({ type: 'result', usage: {} }), null)
})

test('formatResultStats omits the cached tag when nothing was read from cache', () => {
  assert.equal(
    formatResultStats({ usage: { input_tokens: 900, output_tokens: 100 } }),
    '900 in / 100 out',
  )
})

test('formatTokens and formatDuration round the way the panel expects', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_500), '1.5k')
  assert.equal(formatTokens(2_340_000), '2.3M')
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(60_000), '1m 00s')
  assert.equal(formatDuration(184_223), '3m 04s')
})

test('humanizeJsonlLine drops system events and tool_result (user) echoes', () => {
  assert.equal(humanizeJsonlLine(ev({ type: 'system', subtype: 'init' })), null)
  assert.equal(humanizeJsonlLine(ev({ type: 'user', message: { content: [{ type: 'tool_result' }] } })), null)
  assert.equal(humanizeJsonlLine(ev({ type: 'something_unknown' })), null)
})

test('humanizeJsonlLine surfaces assistant prose and tool calls, joined by newline', () => {
  assert.equal(humanizeJsonlLine(assistant({ type: 'text', text: '  Scanning portals  ' })), 'Scanning portals')
  assert.equal(
    humanizeJsonlLine(assistant({ type: 'text', text: 'Reading CV' }, { type: 'tool_use', name: 'Read', input: { file_path: 'user/cv.md' } })),
    'Reading CV\n→ Read user/cv.md',
  )
  // Assistant turn with only an empty text block → nothing to show.
  assert.equal(humanizeJsonlLine(assistant({ type: 'text', text: '   ' })), null)
})

test('humanizeJsonlLine surfaces non-JSON lines verbatim (never silently swallowed)', () => {
  assert.equal(humanizeJsonlLine('plain stderr noise'), 'plain stderr noise')
  assert.equal(humanizeJsonlLine('{ not valid json'), '{ not valid json')
})

// ─── humanizeJsonlChunk (the split-line stitching) ───────────────────────────

test('humanizeJsonlChunk emits complete lines and carries the trailing partial', () => {
  const { lines, buffer } = humanizeJsonlChunk('', assistant({ type: 'text', text: 'one' }) + '\n' + '{"type":"resu')
  assert.deepEqual(lines, ['one'])
  assert.equal(buffer, '{"type":"resu')   // incomplete final line held back
})

test('humanizeJsonlChunk stitches a line split across two chunks', () => {
  const full = ev({ type: 'result', subtype: 'success' })
  const a = humanizeJsonlChunk('', full.slice(0, 10))      // no newline yet
  assert.deepEqual(a.lines, [])
  assert.equal(a.buffer, full.slice(0, 10))
  const b = humanizeJsonlChunk(a.buffer, full.slice(10) + '\n')
  assert.deepEqual(b.lines, ['✓ Done'])
  assert.equal(b.buffer, '')
})

test('humanizeJsonlChunk skips blank lines and flattens multi-line events', () => {
  const chunk =
    assistant({ type: 'text', text: 'Step A' }, { type: 'tool_use', name: 'Bash', input: { command: 'node x.mjs' } }) + '\n' +
    '\n' +  // blank line between events
    ev({ type: 'system' }) + '\n'
  const { lines, buffer } = humanizeJsonlChunk('', chunk)
  assert.deepEqual(lines, ['Step A', '→ Bash: node x.mjs'])  // system dropped, blank skipped
  assert.equal(buffer, '')
})

// ─── isAuthFailureText ───────────────────────────────────────────────────────

test('isAuthFailureText matches real auth-death signatures (case-insensitive)', () => {
  for (const s of [
    'OAuth token has expired',
    'API Error: authentication_error',
    'Invalid bearer token',
    'invalid x-api-key',
    'Please run /login to continue',
    '401 Unauthorized',
    'Unauthorized (401)',
  ]) {
    assert.equal(isAuthFailureText(s), true, `should match: ${s}`)
  }
})

test('isAuthFailureText does NOT false-positive on a bare 401 like "401(k)"', () => {
  assert.equal(isAuthFailureText('Evaluated a role with a generous 401(k) match'), false)
  assert.equal(isAuthFailureText('contributed 6% to my 401k this year'), false)
  assert.equal(isAuthFailureText('all good, run finished cleanly'), false)
})

// ─── diagnoseFailureText (cascade order) ─────────────────────────────────────

test('diagnoseFailureText returns the most specific actionable cause, auth first', () => {
  assert.equal(diagnoseFailureText('oauth token has expired'), 'Claude session expired — sign in again to retry.')
  assert.equal(diagnoseFailureText('Error 429: too many requests'), 'Claude is rate-limited right now — wait a moment, then retry.')
  assert.equal(diagnoseFailureText('ENOENT: no such file or directory'), 'A file or command was missing on this machine.')
  assert.equal(diagnoseFailureText('EACCES: permission denied'), 'Permission was denied while running the task.')
  assert.equal(diagnoseFailureText('getaddrinfo ENOTFOUND api.anthropic.com'), 'Network error — check your connection, then retry.')
  assert.equal(diagnoseFailureText('exited with code 2'), null)  // no signal → caller uses exit code
})

test('diagnoseFailureText prefers auth over a co-occurring rate-limit signal', () => {
  // A log can carry both; auth is checked first so the most actionable fix wins.
  assert.equal(
    diagnoseFailureText('429 too many requests\nauthentication_error: token expired'),
    'Claude session expired — sign in again to retry.',
  )
})
