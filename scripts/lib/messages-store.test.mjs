// messages-store.test.mjs — locked appends to data/agent-messages.jsonl,
// through a data-dir link, under concurrency, and the messages.mjs CLI.
// Fixtures are fictional.
//
// Run: node --test scripts/lib/messages-store.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { messagesPathFor, postMessage, postMessageAsync, readMessages, setMessageStatus, setMessageStatusAsync } from './messages-store.mjs'
import { lockPathFor, tryAcquire } from './dir-lock.mjs'

const CLI = fileURLToPath(new URL('../messages.mjs', import.meta.url))
const STORE = new URL('./messages-store.mjs', import.meta.url).href

/** A data root whose data/ is a link into private/, as at the repo root. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'starpath-messages-'))
  mkdirSync(join(root, 'private/data'), { recursive: true })
  symlinkSync(join(root, 'private/data'), join(root, 'data'))
  return root
}

test('post → resolve round trip, through the data link, nothing rewritten', () => {
  const root = makeRoot()
  try {
    const file = messagesPathFor(root)
    const a = postMessage(file, { title: 'Portal returns 403', kind: 'alert', source: 'scheduler', body: '**Fabrikam** board', links: ['https://example.com'] })
    assert.equal(a.posted, true)
    assert.match(a.message.id, /^m-\d{8}-[0-9a-f]{8}$/)
    assert.equal(a.message.status, 'open')
    assert.ok(existsSync(join(root, 'private/data/agent-messages.jsonl')))
    assert.ok(lstatSync(join(root, 'data')).isSymbolicLink())

    const before = readFileSync(file, 'utf-8')
    const r = setMessageStatus(file, a.message.id, 'resolved', { note: 'board moved' })
    assert.equal(r.changed, true)
    assert.equal(r.message.status, 'resolved')
    assert.equal(r.message.resolution_note, 'board moved')
    assert.ok(readFileSync(file, 'utf-8').startsWith(before), 'append-only')

    assert.equal(setMessageStatus(file, a.message.id, 'resolved').changed, false)
    assert.throws(() => setMessageStatus(file, 'm-nope', 'dismissed'), { code: 'ENOMSG' })
    assert.equal(readMessages(file).length, 1)
    assert.ok(!existsSync(lockPathFor(file)), 'lock released')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a keyed post is skipped while open, posted again once resolved', async () => {
  const root = makeRoot()
  try {
    const file = messagesPathFor(root)
    const first = await postMessageAsync(file, { title: 'Raise the Match floor?', kind: 'approval', source: 'calibrate', key: 'calib:match-floor' })
    const dup = postMessage(file, { title: 'Raise the Match floor? (again)', source: 'calibrate', key: 'calib:match-floor' })
    assert.equal(dup.posted, false)
    assert.equal(dup.message.id, first.message.id)
    await setMessageStatusAsync(file, first.message.id, 'resolved')
    assert.equal(postMessage(file, { title: 'Raise it again', key: 'calib:match-floor' }).posted, true)
    assert.equal(readMessages(file).length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a torn last line is skipped and does not swallow the next post', () => {
  const root = makeRoot()
  try {
    const file = messagesPathFor(root)
    postMessage(file, { title: 'one' })
    appendFileSync(file, '{"type":"post","id":"m-torn","tit')
    postMessage(file, { title: 'two' })
    assert.deepEqual(readMessages(file).map((m) => m.title), ['one', 'two'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a held lock makes a post time out with ELOCKED', () => {
  const root = makeRoot()
  try {
    const file = messagesPathFor(root)
    const held = tryAcquire(lockPathFor(file))
    try {
      assert.throws(() => postMessage(file, { title: 'blocked' }, { lockOpts: { timeoutMs: 100 } }), { code: 'ELOCKED' })
    } finally { held.release() }
    assert.equal(readMessages(file).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('concurrent posts from many processes all land, one line each', async () => {
  const root = makeRoot()
  try {
    const file = messagesPathFor(root)
    const N = 12
    const body = (i) => `import { postMessage } from ${JSON.stringify(STORE)}
for (let k = 0; k < 5; k++) postMessage(${JSON.stringify(file)}, { title: 'worker ${i} post ' + k, source: 'eval' })`
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', body(i)], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', (d) => { err += d })
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))))
    })))
    const raw = readFileSync(file, 'utf-8')
    assert.equal(raw.trim().split('\n').length, N * 5)
    const msgs = readMessages(file)
    assert.equal(msgs.length, N * 5)
    assert.equal(new Set(msgs.map((m) => m.id)).size, N * 5)
    assert.ok(!existsSync(lockPathFor(file)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI: post, list, show, resolve, dismiss, reopen, count', () => {
  const root = makeRoot()
  try {
    const env = { ...process.env, CAREER_OPS_ROOT: root }
    const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf-8', input })

    const p = run(['post', '--title', 'Need your OK: drop Lyon from target cities?', '--kind', 'approval',
      '--body', '-', '--link', 'user/profile.yml', '--link', 'app:nimbus|analyst', '--json'], 'Three **rejections** cite relocation.')
    assert.equal(p.status, 0, p.stderr)
    const { posted, message } = JSON.parse(p.stdout)
    assert.equal(posted, true)
    assert.equal(message.body, 'Three **rejections** cite relocation.')
    assert.deepEqual(message.links.map((l) => l.kind), ['file', 'application'])

    const j = run(['post', '--from-json', JSON.stringify({ title: 'Weekly run', source: 'scheduler', kind: 'fyi', key: 'run-1' })])
    assert.match(j.stdout, /^posted m-/)
    assert.match(run(['post', '--from-json', '-'], JSON.stringify({ title: 'Weekly run', key: 'run-1' })).stdout, /^skipped/)

    assert.equal(JSON.parse(run(['count', '--json']).stdout).open, 2)
    const listed = JSON.parse(run(['list', '--open', '--json']).stdout)
    assert.deepEqual(listed.map((m) => m.title), ['Weekly run', 'Need your OK: drop Lyon from target cities?'])
    assert.match(run(['show', message.id.slice(-8)]).stdout, /rejections/)

    assert.match(run(['resolve', message.id, '--note', 'yes, dropped']).stdout, /now resolved/)
    assert.match(run(['dismiss', listed[0].id]).stdout, /now dismissed/)
    assert.match(run(['count']).stdout, /^0 open/)
    assert.equal(JSON.parse(run(['list', '--closed', '--json']).stdout).length, 2)
    assert.match(run(['reopen', message.id]).stdout, /now open/)
    assert.equal(JSON.parse(run(['count', '--json']).stdout).open, 1)

    const bad = run(['post', '--title', 'x', '--kind', 'urgent'])
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /kind must be one of/)
    assert.equal(run(['resolve']).status, 1)
    assert.equal(run(['frobnicate']).status, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
