// dir-lock.test.mjs — contention, stale reclaim and release-by-token for the
// mkdir lock. Contention runs real child processes against one lock.
//
// Run: node --test scripts/lib/dir-lock.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OWNER_FILE, RECOVER_SUFFIX, acquireLock, acquireLockSync, lockPathFor, releaseLock,
  staleReason, tryAcquire, withLock,
} from './dir-lock.mjs'

const LIB = fileURLToPath(new URL('./dir-lock.mjs', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'starpath-lock-'))

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' })
  return Number(r.stdout)
}

function plantOwner(lockDir, owner) {
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, OWNER_FILE), JSON.stringify({ host: hostname(), label: 'test', at: Date.now(), token: 'old', ...owner }))
}

test('one holder at a time; a second try fails until release', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    const a = tryAcquire(lock)
    assert.ok(a)
    assert.equal(tryAcquire(lock), null)
    assert.equal(a.release(), true)
    const b = tryAcquire(lock)
    assert.ok(b)
    b.release()
    assert.equal(existsSync(lock), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('release only removes the lock for the matching token', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    const a = tryAcquire(lock)
    assert.equal(releaseLock(lock, 'not-the-token'), false)
    assert.ok(existsSync(lock))
    assert.equal(releaseLock(lock, a.token), true)
    assert.equal(existsSync(lock), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a lock whose owner pid is gone is reclaimed', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    plantOwner(lock, { pid: deadPid() })
    assert.match(staleReason(lock), /is gone/)
    const h = tryAcquire(lock)
    assert.ok(h, 'stale lock reclaimed')
    assert.equal(JSON.parse(readFileSync(join(lock, OWNER_FILE), 'utf-8')).pid, process.pid)
    h.release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a live owner is respected; one held past staleMs is reclaimed', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    plantOwner(lock, { pid: process.pid, at: Date.now() })
    assert.equal(staleReason(lock), null)
    assert.equal(tryAcquire(lock), null)
    plantOwner(lock, { pid: process.pid, at: Date.now() - 10 * 60_000 })
    assert.match(staleReason(lock, { staleMs: 60_000 }), /held for/)
    const h = tryAcquire(lock, { staleMs: 60_000 })
    assert.ok(h)
    h.release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a lock dir without owner.json is only stale once it is old', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    mkdirSync(lock)
    assert.equal(staleReason(lock), null, 'fresh: the owner may still be writing owner.json')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    assert.equal(staleReason(lock), 'no owner')
    const h = tryAcquire(lock)
    assert.ok(h)
    h.release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reclaim waits while another process holds .recover; an abandoned .recover is cleared', () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    plantOwner(lock, { pid: deadPid() })
    mkdirSync(lock + RECOVER_SUFFIX)
    assert.equal(tryAcquire(lock), null, 'someone else is reclaiming')
    assert.ok(existsSync(lock), 'the stale lock is left to the reclaimer')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock + RECOVER_SUFFIX, old, old)
    assert.equal(tryAcquire(lock), null, 'this pass only clears the abandoned .recover')
    assert.equal(existsSync(lock + RECOVER_SUFFIX), false)
    const h = tryAcquire(lock)
    assert.ok(h)
    h.release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('acquire times out with ELOCKED and names the holder', async () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    const h = tryAcquire(lock, { label: 'first' })
    await assert.rejects(acquireLock(lock, { timeoutMs: 60 }), (e) => e.code === 'ELOCKED' && /first/.test(e.message))
    assert.throws(() => acquireLockSync(lock, { timeoutMs: 60 }), (e) => e.code === 'ELOCKED')
    h.release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('withLock releases even when the body throws', async () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.x.lock')
    await assert.rejects(withLock(lock, () => { throw new Error('boom') }), /boom/)
    assert.equal(existsSync(lock), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lockPathFor puts the lock beside the real file, through links', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'profiles/a/data'), { recursive: true })
    writeFileSync(join(dir, 'profiles/a/data/applications.md'), '')
    mkdirSync(join(dir, 'data'))
    symlinkSync('../profiles/a/data/applications.md', join(dir, 'data/applications.md'))
    assert.equal(lockPathFor(join(dir, 'data/applications.md')), lockPathFor(join(dir, 'profiles/a/data/applications.md')))
    assert.match(lockPathFor(join(dir, 'data/applications.md')), /profiles\/a\/data\/\.applications\.md\.lock$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('contention: concurrent processes never lose an increment', async () => {
  const dir = tmp()
  try {
    const lock = join(dir, '.counter.lock')
    const counter = join(dir, 'counter.txt')
    writeFileSync(counter, '0')
    const WORKERS = 6
    const ROUNDS = 25
    const body = `
      import { withLockSync } from ${JSON.stringify(LIB)}
      import { readFileSync, writeFileSync } from 'node:fs'
      for (let i = 0; i < ${ROUNDS}; i++) {
        withLockSync(${JSON.stringify(lock)}, () => {
          const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf-8'))
          // widen the race window: a lost update would show without the lock
          const until = Date.now() + 1; while (Date.now() < until) {}
          writeFileSync(${JSON.stringify(counter)}, String(n + 1))
        }, { timeoutMs: 30000, pollMs: 2 })
      }`
    const runs = Array.from({ length: WORKERS }, () => new Promise((res, rej) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', body], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      p.stderr.on('data', (d) => { err += d })
      p.on('exit', (code) => (code === 0 ? res() : rej(new Error(err))))
    }))
    await Promise.all(runs)
    assert.equal(Number(readFileSync(counter, 'utf-8')), WORKERS * ROUNDS)
    assert.equal(existsSync(lock), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
