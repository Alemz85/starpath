// cache-tsv.test.mjs — the shared TSV/freshness foundation under the three
// scoring caches (col-cache, tax-cache, comp-cache). These helpers decide
// every cache hit/miss, so the freshness boundary and the round-trip parse
// are worth pinning directly rather than only through full scoreListing runs.
//
// Run: node --test scripts/lib/cache-tsv.test.mjs
// (also picked up by the root `node --test "scripts/**/*.test.mjs"` glob).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'

import { readTsv, appendTsv, isFresh, todayIso } from './cache-tsv.mjs'
import { roundToBand } from './tax-cache.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

// readTsv/appendTsv resolve relativePath against process.cwd(); an absolute
// path short-circuits that resolve(), so tests can use a real temp file
// without depending on the cwd being the repo root.
const tmpFiles = []
function tmpTsv() {
  const p = join(tmpdir(), `cache-tsv-${Date.now()}-${Math.random().toString(36).slice(2)}.tsv`)
  tmpFiles.push(p)
  return p
}
after(() => { for (const p of tmpFiles) rmSync(p, { force: true }) })

/* ───── isFresh — the cache hit/miss boundary ────────────────────── */

test('isFresh: a row inside the window is fresh', () => {
  const now = new Date('2026-06-25T12:00:00Z')
  assert.equal(isFresh('2026-06-25', 60, now), true)
  assert.equal(isFresh('2026-05-01', 60, now), true)
})

test('isFresh: a row older than the window is stale', () => {
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('2026-01-01', 60, now), false)   // ~175 days old
})

test('isFresh: the boundary is inclusive (ageDays <= days)', () => {
  const then = '2026-04-26'
  const thenMs = new Date(then).getTime()
  // exactly `days` old → still fresh
  assert.equal(isFresh(then, 60, new Date(thenMs + 60 * DAY_MS)), true)
  // one second past → stale
  assert.equal(isFresh(then, 60, new Date(thenMs + 60 * DAY_MS + 1000)), false)
})

test('isFresh: missing / empty iso is never fresh', () => {
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('', 60, now), false)
  assert.equal(isFresh(null, 60, now), false)
  assert.equal(isFresh(undefined, 60, now), false)
})

test('isFresh: an unparseable date is never fresh (NaN guard)', () => {
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('not-a-date', 60, now), false)
  assert.equal(isFresh('2026-13-99', 60, now), false)
})

test('isFresh: a future-dated row counts as fresh (negative age)', () => {
  // Clock skew / a row dated ahead of `now` reads as definitely-not-stale.
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('2026-12-31', 60, now), true)
})

test('isFresh: defaults to the wall clock when no now is passed', () => {
  // Today is trivially within a 1-day window; a long-ago date is not.
  assert.equal(isFresh(todayIso(), 1), true)
  assert.equal(isFresh('2000-01-01', 60), false)
})

/* ───── todayIso ─────────────────────────────────────────────────── */

test('todayIso: returns the injected clock as a UTC YYYY-MM-DD slice', () => {
  assert.equal(todayIso(new Date('2026-06-25T12:00:00Z')), '2026-06-25')
  assert.equal(todayIso(new Date('2026-06-25T23:59:59Z')), '2026-06-25')
  // UTC-based: an instant past UTC midnight rolls to the next date.
  assert.equal(todayIso(new Date('2026-06-26T00:30:00Z')), '2026-06-26')
})

/* ───── readTsv / appendTsv round-trip ───────────────────────────── */

test('readTsv: a missing file yields empty headers and rows', async () => {
  const { headers, rows } = await readTsv(tmpTsv())
  assert.deepEqual(headers, [])
  assert.deepEqual(rows, [])
})

test('appendTsv: writes the header on first append, then row objects round-trip', async () => {
  const path = tmpTsv()
  const HEADERS = ['city', 'baseline_eur', 'source', 'last_updated']

  await appendTsv(path, HEADERS, { city: 'Berlin', baseline_eur: '2400', source: 'numbeo', last_updated: '2026-06-25' })
  await appendTsv(path, HEADERS, { city: 'Munich', baseline_eur: '2600', source: 'numbeo', last_updated: '2026-06-24' })

  const { headers, rows } = await readTsv(path)
  assert.deepEqual(headers, HEADERS)
  assert.equal(rows.length, 2)                 // header written once, not per append
  assert.deepEqual(rows[0], { city: 'Berlin', baseline_eur: '2400', source: 'numbeo', last_updated: '2026-06-25' })
  assert.equal(rows[1].city, 'Munich')
})

test('appendTsv: a missing key serializes as an empty cell, not "undefined"', async () => {
  const path = tmpTsv()
  const HEADERS = ['city', 'baseline_eur', 'source', 'last_updated']
  await appendTsv(path, HEADERS, { city: 'Paris' })
  const { rows } = await readTsv(path)
  assert.equal(rows[0].city, 'Paris')
  assert.equal(rows[0].baseline_eur, '')
  assert.equal(rows[0].source, '')
})

test('readTsv: a short row pads missing trailing cells to empty strings', async () => {
  const path = tmpTsv()
  writeFileSync(path, 'city\tbaseline_eur\tsource\n' + 'Lisbon\t1900\n')  // source cell absent
  const { rows } = await readTsv(path)
  assert.equal(rows[0].baseline_eur, '1900')
  assert.equal(rows[0].source, '')
})

test('readTsv: blank lines (incl. a trailing newline) are skipped', async () => {
  const path = tmpTsv()
  writeFileSync(path, 'city\tbaseline_eur\nBerlin\t2400\n\n')
  const { rows } = await readTsv(path)
  assert.equal(rows.length, 1)
})

/* ───── roundToBand — the tax-cache key banding ──────────────────── */

test('roundToBand: snaps gross to the nearest €5K band', () => {
  assert.equal(roundToBand(42000), 40000)
  assert.equal(roundToBand(43000), 45000)
  assert.equal(roundToBand(45000), 45000)
  assert.equal(roundToBand(0), 0)
})

test('roundToBand: the €2.5K midpoint rounds up (Math.round half-up)', () => {
  assert.equal(roundToBand(42500), 45000)
  assert.equal(roundToBand(47500), 50000)
})
