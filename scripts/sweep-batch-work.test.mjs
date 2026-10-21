// sweep-batch-work: stale worker scratch goes, fresh files and folders stay.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { staleEntries, sweepBatchWork } from './sweep-batch-work.mjs'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const HOUR = 3600_000

test('staleEntries: plain files older than the cutoff only', () => {
  const entries = [
    { name: 'pipeline-filter-01-score.json', isFile: true, mtimeMs: NOW - 30 * HOUR },
    { name: 'pipeline-filter-b01-score.json', isFile: true, mtimeMs: NOW - 2 * HOUR },
    { name: 'merged', isFile: false, mtimeMs: NOW - 99 * HOUR },
    { name: '.keep', isFile: true, mtimeMs: NOW - 99 * HOUR },
  ]
  assert.deepEqual(staleEntries(entries, { now: NOW }), ['pipeline-filter-01-score.json'])
  assert.deepEqual(staleEntries(entries, { now: NOW, hours: 1 }), ['pipeline-filter-01-score.json', 'pipeline-filter-b01-score.json'])
})

test('sweepBatchWork deletes stale files on disk; --dry-run deletes nothing; a missing folder is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpath-work-'))
  try {
    writeFileSync(join(dir, 'old.json'), '{}')
    writeFileSync(join(dir, 'new.json'), '{}')
    mkdirSync(join(dir, 'sub'))
    utimesSync(join(dir, 'old.json'), new Date(NOW - 48 * HOUR), new Date(NOW - 48 * HOUR))
    utimesSync(join(dir, 'new.json'), new Date(NOW - HOUR), new Date(NOW - HOUR))
    assert.deepEqual(sweepBatchWork(dir, { now: NOW, dryRun: true }), ['old.json'])
    assert.equal(readdirSync(dir).length, 3)
    assert.deepEqual(sweepBatchWork(dir, { now: NOW }), ['old.json'])
    assert.deepEqual(readdirSync(dir).sort(), ['new.json', 'sub'])
    assert.deepEqual(sweepBatchWork(join(dir, 'nope')), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
