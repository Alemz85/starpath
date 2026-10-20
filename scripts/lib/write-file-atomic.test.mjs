// write-file-atomic.test.mjs — atomic writes land on the real file and never
// replace a profile link with a real file.
//
// Run: node --test scripts/lib/write-file-atomic.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveWriteTarget, writeFileAtomic } from './write-file-atomic.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'starpath-atomic-'))

test('writes a new file and creates its folder', () => {
  const dir = tmp()
  try {
    writeFileAtomic(join(dir, 'a/b/file.md'), 'hello')
    assert.equal(readFileSync(join(dir, 'a/b/file.md'), 'utf-8'), 'hello')
    assert.deepEqual(readdirSync(join(dir, 'a/b')), ['file.md'], 'no temp file left behind')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a write through a file link updates the target and keeps the link', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'profiles/main/data'), { recursive: true })
    const real = join(dir, 'profiles/main/data/applications.md')
    writeFileSync(real, 'old')
    mkdirSync(join(dir, 'data'))
    const link = join(dir, 'data/applications.md')
    symlinkSync('../profiles/main/data/applications.md', link)

    const written = writeFileAtomic(link, 'new')
    assert.ok(lstatSync(link).isSymbolicLink(), 'the canonical path is still a link')
    assert.equal(readFileSync(real, 'utf-8'), 'new')
    assert.equal(written, resolveWriteTarget(real))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a dangling link gets its target created', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'private/data'), { recursive: true })
    symlinkSync('private/data/status-log.tsv', join(dir, 'status-log.tsv'))
    writeFileAtomic(join(dir, 'status-log.tsv'), 'x')
    assert.ok(lstatSync(join(dir, 'status-log.tsv')).isSymbolicLink())
    assert.equal(readFileSync(join(dir, 'private/data/status-log.tsv'), 'utf-8'), 'x')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writes through a directory link (data/ → private/data/)', () => {
  const dir = tmp()
  try {
    mkdirSync(join(dir, 'private/data'), { recursive: true })
    symlinkSync('private/data', join(dir, 'data'))
    writeFileAtomic(join(dir, 'data/scouting.md'), 'rows')
    assert.ok(lstatSync(join(dir, 'data')).isSymbolicLink())
    assert.equal(readFileSync(join(dir, 'private/data/scouting.md'), 'utf-8'), 'rows')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('keeps the existing file mode', () => {
  const dir = tmp()
  try {
    const f = join(dir, 'f.tsv')
    writeFileSync(f, 'a')
    chmodSync(f, 0o600)
    writeFileAtomic(f, 'b')
    assert.equal(statSync(f).mode & 0o777, 0o600)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
