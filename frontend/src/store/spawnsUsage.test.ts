// The wiring end to end, with a stubbed preload: a claude spawn streams its
// result event, exits, and one row lands in batch/logs/app-usage.tsv.

import { test } from 'node:test'
import assert from 'node:assert/strict'

type Cb = (id: string, v: never) => void
const files = new Map<string, string>()
const outputCbs: Cb[] = []
const doneCbs: Cb[] = []
const spawned: string[] = []

;(globalThis as { window?: unknown }).window = {
  electron: {
    readFile: async (p: string) => files.get(p) ?? null,
    writeFile: async (p: string, c: string) => { files.set(p, c) },
    spawn: async (id: string) => { spawned.push(id) },
    kill: async () => undefined,
    onSpawnOutput: (cb: Cb) => { outputCbs.push(cb) },
    onSpawnDone: (cb: Cb) => { doneCbs.push(cb) },
  },
}

const { useSpawnsStore } = await import('@/store/spawns')
const { APP_USAGE_HEADER } = await import('@/lib/usage')

const emit = (id: string, chunk: string) => outputCbs.forEach(cb => cb(id, chunk as never))
const exit = (id: string, code: number) => doneCbs.forEach(cb => cb(id, code as never))
const settle = () => new Promise(r => setTimeout(r, 10))

const result = (cost: number) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 61000, num_turns: 12, total_cost_usd: cost,
  usage: { input_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 18000, output_tokens: 900 },
}) + '\n'

test('a finished claude spawn appends one row to app-usage.tsv with the CLI numbers', async () => {
  const st = useSpawnsStore.getState()
  st.start('add-1', 'Add listing: Nimbus Robotics', 'claude', ['--append-system-prompt-file', 'batch/batch-prompt.md', '-p', 'Evaluate'])
  assert.ok(spawned.includes('add-1'))
  emit('add-1', JSON.stringify({ type: 'system' }) + '\n' + result(0.37).slice(0, 25))   // result split mid-line
  emit('add-1', result(0.37).slice(25))
  exit('add-1', 0)
  await settle()

  const lines = (files.get('batch/logs/app-usage.tsv') ?? '').trim().split('\n')
  assert.equal(lines[0], APP_USAGE_HEADER)
  assert.equal(lines.length, 2)
  const c = lines[1].split('\t')
  assert.equal(c[1], 'add-1')
  assert.deepEqual(c.slice(3, 4).concat(c.slice(6, 14)), ['completed', '50', '2000', '18000', '900', '0.37', '61000', '12', 'app:evaluate'])
  assert.equal(c[14], 'Add listing: Nimbus Robotics')
  assert.equal(useSpawnsStore.getState().spawns['add-1'].usage?.costUsd, 0.37)
})

test('two spawns finishing together both land, and a node spawn or a stopped run adds nothing', async () => {
  const st = useSpawnsStore.getState()
  st.start('a', 'Tailor CV: A', 'claude', ['-p', '/career-ops pdf for A'])
  st.start('b', 'Draft: B', 'claude', ['-p', '/career-ops apply for B'])
  st.start('n', 'Merge', 'node', ['scripts/merge-scouting.mjs'])
  st.start('k', 'Stopped', 'claude', ['-p', 'x'])
  emit('a', result(0.1)); emit('b', result(0.2)); emit('n', 'merged\n'); emit('k', result(0.3))
  st.kill('k')
  exit('a', 0); exit('b', 0); exit('n', 0); exit('k', 143)
  await settle()

  const rows = (files.get('batch/logs/app-usage.tsv') ?? '').trim().split('\n').slice(1).map(l => l.split('\t'))
  assert.deepEqual(rows.map(r => r[1]).sort(), ['a', 'add-1', 'b'])
  assert.equal(rows.find(r => r[1] === 'a')![13], 'app:pdf')
  assert.equal(rows.find(r => r[1] === 'b')![13], 'app:apply')
})

test('a claude spawn that dies before its result event records nothing', async () => {
  const before = files.get('batch/logs/app-usage.tsv')
  useSpawnsStore.getState().start('d', 'Dies', 'claude', ['-p', 'x'])
  emit('d', 'Error: boom\n')
  exit('d', 1)
  await settle()
  assert.equal(files.get('batch/logs/app-usage.tsv'), before)
})
