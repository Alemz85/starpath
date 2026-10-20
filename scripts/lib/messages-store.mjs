/**
 * messages-store.mjs — locked I/O for agent → user Messages
 * (data/agent-messages.jsonl; logic in messages-core.mjs).
 *
 * Every write takes the file's dir lock (dir-lock.mjs, `.agent-messages.jsonl.lock`
 * beside the real file), re-reads the file inside the lock (for dedupe and to
 * validate the id), and appends one record. Appending keeps history intact;
 * a write cut short by a crash leaves at most one unparseable last line, which
 * the parser skips, and the next append starts on a fresh line. The path is
 * resolved through links (write-file-atomic.mjs) so the lock and the file
 * agree for every checkout, worktree and the app.
 *
 * Used by scripts/messages.mjs, scripts/scheduled-run.mjs and the app
 * (electron main, through importRepoModule), so keep it free of process-wide
 * side effects. Unit-tested in messages-store.test.mjs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { acquireLock, lockPathFor, withLockSync } from './dir-lock.mjs'
import { resolveWriteTarget } from './write-file-atomic.mjs'
import {
  buildPost, duplicateOf, foldMessages, makeId, parseRecords, planUpdate, serializeRecord,
} from './messages-core.mjs'

export const MESSAGES_REL = 'data/agent-messages.jsonl'

/** The messages file under a data root (the folder holding data/, user/, …). */
export function messagesPathFor(dataRoot) {
  return join(dataRoot, MESSAGES_REL)
}

/** Every message, folded (missing file → []). */
export function readMessages(file) {
  if (!existsSync(file)) return []
  return foldMessages(parseRecords(readFileSync(file, 'utf-8')).records)
}

function endsWithNewline(file) {
  let size
  try { size = statSync(file).size } catch { return true }
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally { closeSync(fd) }
}

function appendRecord(file, record) {
  const target = resolveWriteTarget(file)
  mkdirSync(dirname(target), { recursive: true })
  // A torn last line (crash mid-write) must not swallow this record.
  const lead = endsWithNewline(target) ? '' : '\n'
  appendFileSync(target, lead + serializeRecord(record))
}

function newId(now) {
  return makeId(now, randomBytes(4).toString('hex'))
}

/* ───── Post ─────────────────────────────────────────────────────── */

/** Post inside a lock already held. Returns { posted, message }. */
export function postMessageUnlocked(file, input, { now = new Date(), id } = {}) {
  const messages = readMessages(file)
  let record = buildPost(input, { id: id ?? newId(now), now })
  // Ids are random; on the off chance of a clash, draw again.
  while (messages.some((m) => m.id === record.id)) record = { ...record, id: newId(now) }
  const dup = duplicateOf(messages, record)
  if (dup) return { posted: false, message: dup }
  appendRecord(file, record)
  return { posted: true, message: foldMessages([record])[0] }
}

/** Post a message (sync, takes the lock). */
export function postMessage(file, input, opts = {}) {
  return withLockSync(lockPathFor(file), () => postMessageUnlocked(file, input, opts), { label: `messages post ${input?.source ?? ''}`.trim(), ...opts.lockOpts })
}

/** Post a message (async lock wait, for the app's main process). */
export async function postMessageAsync(file, input, opts = {}) {
  const handle = await acquireLock(lockPathFor(file), { label: 'messages post (app)', ...opts.lockOpts })
  try { return postMessageUnlocked(file, input, opts) } finally { handle.release() }
}

/* ───── Status changes ───────────────────────────────────────────── */

/** Change status inside a lock already held. Returns { changed, message }. */
export function setMessageStatusUnlocked(file, ref, status, { note = '', now = new Date() } = {}) {
  const messages = readMessages(file)
  const { message, record } = planUpdate(messages, ref, status, { note, now })
  if (!record) return { changed: false, message }
  appendRecord(file, record)
  return { changed: true, message: readMessages(file).find((m) => m.id === message.id) ?? message }
}

/** Resolve / dismiss / reopen a message (sync, takes the lock). */
export function setMessageStatus(file, ref, status, opts = {}) {
  return withLockSync(lockPathFor(file), () => setMessageStatusUnlocked(file, ref, status, opts), { label: `messages ${status}`, ...opts.lockOpts })
}

/** Async-lock variant for the app's main process. */
export async function setMessageStatusAsync(file, ref, status, opts = {}) {
  const handle = await acquireLock(lockPathFor(file), { label: `messages ${status} (app)`, ...opts.lockOpts })
  try { return setMessageStatusUnlocked(file, ref, status, opts) } finally { handle.release() }
}
