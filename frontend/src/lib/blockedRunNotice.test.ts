import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentPosted, blockedRunNotice, messageSourceFor } from './blockedRunNotice'
import { PERMISSION_BLOCKED_PREFIX, humanizeJsonlChunk } from './spawnFormat'

const scanArgs = ['-p', '/career-ops scan']

test('a blocked run the agent did not report gets one keyed alert', () => {
  const argv = blockedRunNotice({
    id: 'spawn-1',
    label: 'Full scan',
    args: scanArgs,
    output: ['→ node scripts/scan.mjs', `${PERMISSION_BLOCKED_PREFIX} Bash: node scripts/check-liveness.mjs --no-browser https://example.com/x`],
  })
  assert.ok(argv)
  assert.equal(argv[0], 'scripts/messages.mjs')
  assert.deepEqual(argv.slice(1, 7), ['post', '--source', 'scan', '--kind', 'alert', '--title'])
  assert.equal(argv[7], 'Full scan was blocked by its permissions')
  assert.match(argv[9], /check-liveness/)
  assert.deepEqual(argv.slice(-2), ['--key', 'blocked:spawn-1'])
})

test('no alert when the run was not blocked, or the agent already posted', () => {
  assert.equal(blockedRunNotice({ id: 'a', label: 'Full scan', args: scanArgs, output: ['done'] }), null)
  assert.equal(blockedRunNotice({
    id: 'b', label: 'Full scan', args: scanArgs,
    output: ['→ node scripts/messages.mjs post --source scan --kind alert --title "x"', `${PERMISSION_BLOCKED_PREFIX} Bash: rm x`],
  }), null)
})

test('agentPosted spots both spellings of the post command', () => {
  assert.ok(agentPosted(['$ node scripts/messages.mjs post --source eval']))
  assert.ok(agentPosted(['$ npm run messages -- post --title x']))
  assert.ok(!agentPosted(['$ node scripts/messages.mjs list']))
})

test('messageSourceFor maps app spawns onto Messages sources', () => {
  assert.equal(messageSourceFor(scanArgs), 'scan')
  assert.equal(messageSourceFor(['--append-system-prompt-file', 'x', '-p', 'go']), 'eval')
  assert.equal(messageSourceFor(['-p', '/career-ops pdf for X']), 'apply')
  assert.equal(messageSourceFor(['-p', '/career-ops positioning']), 'worker')
})

test('a run that recovered and finished posts no alert; one that stopped still does', () => {
  const denial = { tool_name: 'Bash', tool_input: { command: 'node scripts/agent-log.mjs list' } }
  const stream = (extra: object) => humanizeJsonlChunk('', JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, permission_denials: [denial], ...extra,
  }) + '\n').lines
  assert.equal(blockedRunNotice({ id: 'r', label: 'Full scan', args: scanArgs, output: stream({}) }), null)
  assert.ok(blockedRunNotice({ id: 's', label: 'Full scan', args: scanArgs, output: stream({ is_error: true }) }))
})
