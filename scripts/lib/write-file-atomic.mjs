/**
 * write-file-atomic.mjs — replace a file's contents in one step, through links.
 *
 * Write-temp-then-rename gives readers either the old file or the new one,
 * never half of it. But renaming onto a *symlink* replaces the link itself
 * with a real file, and canonical tracker paths (data/applications.md, …) are
 * links into the active profile (CLAUDE.md § Profiles). So the target is
 * resolved first and the temp file is written beside the real file, then
 * renamed onto it; the link stays a link.
 *
 * Unit-tested in write-file-atomic.test.mjs.
 */

import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, writeSync, chmodSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * The real path a write to `file` should land on. Follows file links (also a
 * dangling one, whose target does not exist yet) and directory links in the
 * parent chain. A path that does not exist resolves through its parent.
 */
export function resolveWriteTarget(file, depth = 0) {
  if (depth > 32) throw new Error(`write-file-atomic: too many levels of links at ${file}`)
  const abs = resolve(file)
  try {
    return realpathSync(abs)
  } catch { /* missing, or a dangling link */ }
  let st = null
  try { st = lstatSync(abs) } catch { /* does not exist at all */ }
  if (st?.isSymbolicLink()) {
    return resolveWriteTarget(resolve(dirname(abs), readlinkSync(abs)), depth + 1)
  }
  const parent = dirname(abs)
  if (parent === abs) return abs
  return join(resolveWriteTarget(parent, depth + 1), basename(abs))
}

/**
 * Atomically write `content` to `file` (through links). Creates missing
 * parent folders, keeps an existing file's mode, fsyncs before the rename.
 * Returns the real path written.
 */
export function writeFileAtomic(file, content, { encoding = 'utf-8' } = {}) {
  const target = resolveWriteTarget(file)
  mkdirSync(dirname(target), { recursive: true })
  let mode = null
  try { mode = statSync(target).mode & 0o7777 } catch { /* new file */ }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', mode ?? 0o644)
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content, encoding) : content)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    rmSync(tmp, { force: true })
    throw e
  }
  closeSync(fd)
  try {
    if (mode !== null) chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return target
}
