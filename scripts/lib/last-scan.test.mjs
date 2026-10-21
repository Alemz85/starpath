import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLastScan, writeLastScan, readLastScan, LAST_SCAN_REL } from './last-scan.mjs'

const T = Date.parse('2026-10-28T12:00:00Z')

test('a scan is ok when at least one board answered', () => {
  assert.equal(buildLastScan({ now: T, boards: 10, errors: 2, added: 4 }).ok, true)
  assert.equal(buildLastScan({ now: T, boards: 3, errors: 3 }).ok, false, 'every board failed: it did not scan')
  assert.equal(buildLastScan({ now: T, boards: 0 }).ok, false, 'nothing to scan')
  assert.equal(buildLastScan({ now: T, boards: 1 }).at, '2026-10-28T12:00:00.000Z')
})

test('write then read round-trips, atomically (no temp files left)', () => {
  const root = mkdtempSync(join(tmpdir(), 'last-scan-'))
  try {
    mkdirSync(join(root, 'data'))
    writeLastScan(buildLastScan({ now: T, boards: 5, errors: 1, added: 2 }), root)
    assert.deepEqual(readdirSync(join(root, 'data')), ['last-scan.json'])
    const got = readLastScan(root)
    assert.equal(got.at, T)
    assert.equal(got.ok, true)
    assert.equal(got.added, 2)
    writeLastScan(buildLastScan({ now: T + 1000, boards: 5, errors: 5 }), root)
    assert.equal(readLastScan(root).ok, false)
    assert.ok(JSON.parse(readFileSync(join(root, LAST_SCAN_REL), 'utf8')).version === 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing, empty or malformed marker reads as null, never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'last-scan-'))
  try {
    mkdirSync(join(root, 'data'))
    assert.equal(readLastScan(root), null)
    writeFileSync(join(root, LAST_SCAN_REL), '')
    assert.equal(readLastScan(root), null)
    writeFileSync(join(root, LAST_SCAN_REL), '{"at":"not a date"}')
    assert.equal(readLastScan(root), null)
    writeFileSync(join(root, LAST_SCAN_REL), '{"at":"2026-10-28T12:00:00Z"}')
    assert.equal(readLastScan(root).ok, true, 'an older marker without ok is trusted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
