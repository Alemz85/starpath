/**
 * dir-lock.mjs — a cross-process lock built on `mkdir`.
 *
 * `mkdir` is atomic on every local filesystem: exactly one caller creates the
 * directory, everyone else gets EEXIST. The holder writes `owner.json`
 * ({ pid, token, host, label, at }) inside it and releases by token, so a
 * process can never remove a lock it does not own (one that was reclaimed
 * from it after it stalled, say).
 *
 * Stale reclaim. A lock is stale when its owner is a dead pid on this host,
 * when it has been held longer than `staleMs`, or when it has no owner.json
 * and the directory is older than `orphanMs` (a crash between mkdir and the
 * owner write). Reclaiming is serialised behind a sibling `<lock>.recover`
 * directory: only the process holding it may delete the stale lock, and it
 * re-reads owner.json first, so two waiters that both saw the same stale
 * owner cannot delete a fresh lock the other one just took.
 *
 * Use `lockPathFor(file)` to lock a data file: the lock sits next to the
 * file's *resolved* path, so every checkout, worktree and the app agree on
 * one lock per real file (and per profile, since profile files are links).
 *
 * Unit-tested in dir-lock.test.mjs.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveWriteTarget } from './write-file-atomic.mjs'

export const OWNER_FILE = 'owner.json'
export const RECOVER_SUFFIX = '.recover'

const DEFAULTS = {
  timeoutMs: 15_000,  // how long acquire waits before giving up
  pollMs: 25,
  staleMs: 120_000,   // a holder older than this is presumed hung
  orphanMs: 5_000,    // a lock dir with no owner.json older than this is a crash leftover
}

/** The lock directory for a data file: `.<name>.lock` beside its real path. */
export function lockPathFor(file) {
  const real = resolveWriteTarget(file)
  return join(dirname(real), `.${basename(real)}.lock`)
}

function readOwner(lockDir) {
  try { return JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf-8')) } catch { return null }
}

function ageMs(path, now) {
  try { return now - statSync(path).mtimeMs } catch { return null }
}

/** Is `pid` a live process on this machine? EPERM means alive but not ours. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * Why the lock at `lockDir` is stale, or null when it is live (or gone).
 * `isAlive` is injectable for tests.
 */
export function staleReason(lockDir, { staleMs = DEFAULTS.staleMs, orphanMs = DEFAULTS.orphanMs, now = Date.now(), isAlive = pidAlive } = {}) {
  const owner = readOwner(lockDir)
  if (!owner) {
    const age = ageMs(lockDir, now)
    if (age === null) return null
    return age > orphanMs ? 'no owner' : null
  }
  if (owner.host === hostname() && !isAlive(owner.pid)) return `owner pid ${owner.pid} is gone`
  if (typeof owner.at === 'number' && now - owner.at > staleMs) return `held for ${Math.round((now - owner.at) / 1000)}s`
  return null
}

/**
 * Remove a stale lock, serialised behind `<lockDir>.recover`. Returns true
 * when it removed something. Only deletes when the owner it re-reads under the
 * recover lock is still the stale one.
 */
export function reclaimStale(lockDir, opts = {}) {
  const recover = lockDir + RECOVER_SUFFIX
  const now = opts.now ?? Date.now()
  try {
    mkdirSync(recover)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    // Someone else is reclaiming. A recover dir left by a crash mid-reclaim
    // would block everyone forever, so clear it once it is clearly abandoned.
    const age = ageMs(recover, now)
    if (age !== null && age > (opts.orphanMs ?? DEFAULTS.orphanMs)) rmSync(recover, { recursive: true, force: true })
    return false
  }
  try {
    if (!staleReason(lockDir, opts)) return false
    const judged = readOwner(lockDir)?.token ?? null
    // Move it aside first so the delete can't race a new mkdir of the name.
    const grave = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
    try { renameSync(lockDir, grave) } catch (e) { if (e.code === 'ENOENT') return false; throw e }
    // A slow-but-alive owner may have released and someone new taken the lock
    // between the check and the rename: put theirs back.
    if ((readOwner(grave)?.token ?? null) !== judged) {
      try { renameSync(grave, lockDir); return false } catch { /* name taken again; theirs is lost */ }
    }
    rmSync(grave, { recursive: true, force: true })
    return true
  } finally {
    rmSync(recover, { recursive: true, force: true })
  }
}

/**
 * One attempt to take the lock. Returns a handle `{ lockDir, token, release }`
 * or null when someone else holds it (after reclaiming it once if stale).
 */
export function tryAcquire(lockDir, opts = {}) {
  mkdirSync(dirname(lockDir), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (attempt === 0 && reclaimStale(lockDir, opts)) continue
      return null
    }
    const token = randomBytes(12).toString('hex')
    const owner = { pid: process.pid, token, host: hostname(), label: opts.label ?? '', at: Date.now() }
    try {
      writeFileSync(join(lockDir, OWNER_FILE), JSON.stringify(owner) + '\n')
    } catch (e) {
      rmSync(lockDir, { recursive: true, force: true })
      throw e
    }
    return { lockDir, token, release: () => releaseLock(lockDir, token) }
  }
  return null
}

/** Release a lock we hold. False (and nothing removed) when the token no longer matches. */
export function releaseLock(lockDir, token) {
  const owner = readOwner(lockDir)
  if (!owner || owner.token !== token) return false
  rmSync(lockDir, { recursive: true, force: true })
  return true
}

function lockTimeout(lockDir, opts) {
  const owner = readOwner(lockDir)
  const who = owner ? ` (held by pid ${owner.pid}${owner.label ? `, ${owner.label}` : ''})` : ''
  const err = new Error(`Timed out after ${opts.timeoutMs ?? DEFAULTS.timeoutMs}ms waiting for lock ${lockDir}${who}`)
  err.code = 'ELOCKED'
  return err
}

/** Wait for the lock (async). Throws an ELOCKED error on timeout. */
export async function acquireLock(lockDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const handle = tryAcquire(lockDir, opts)
    if (handle) return handle
    if (Date.now() >= deadline) throw lockTimeout(lockDir, opts)
    await new Promise((r) => setTimeout(r, pollMs + Math.floor(Math.random() * pollMs)))
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4))

/** Wait for the lock (blocking), for synchronous scripts. */
export function acquireLockSync(lockDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const handle = tryAcquire(lockDir, opts)
    if (handle) return handle
    if (Date.now() >= deadline) throw lockTimeout(lockDir, opts)
    Atomics.wait(sleepCell, 0, 0, pollMs + Math.floor(Math.random() * pollMs))
  }
}

/** Run `fn` while holding the lock; always releases. */
export async function withLock(lockDir, fn, opts = {}) {
  const handle = await acquireLock(lockDir, opts)
  try { return await fn(handle) } finally { handle.release() }
}

/** Synchronous `withLock`. */
export function withLockSync(lockDir, fn, opts = {}) {
  const handle = acquireLockSync(lockDir, opts)
  try { return fn(handle) } finally { handle.release() }
}
