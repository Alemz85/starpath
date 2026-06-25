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

/* ───── Additional readTsv edge cases ───────────────────────────────── */

test('readTsv: a header-only file (no data rows) returns headers and empty rows', async () => {
  const path = tmpTsv()
  writeFileSync(path, 'city\tbaseline_eur\tsource\n')
  const { headers, rows } = await readTsv(path)
  assert.deepEqual(headers, ['city', 'baseline_eur', 'source'])
  assert.deepEqual(rows, [])
})

test('readTsv: extra cells beyond header width are silently dropped from row objects', async () => {
  // The map() only walks header indices, so extra tabs in a row are harmless.
  const path = tmpTsv()
  writeFileSync(path, 'city\tbaseline_eur\nBerlin\t2400\textra-cell\n')
  const { headers, rows } = await readTsv(path)
  assert.deepEqual(headers, ['city', 'baseline_eur'])
  assert.equal(Object.keys(rows[0]).length, 2)
  assert.equal(rows[0].city, 'Berlin')
  assert.equal(rows[0].baseline_eur, '2400')
})

test('readTsv: a file containing only blank lines yields empty headers and rows', async () => {
  const path = tmpTsv()
  writeFileSync(path, '\n\n\n')
  const { headers, rows } = await readTsv(path)
  assert.deepEqual(headers, [])
  assert.deepEqual(rows, [])
})

/* ───── Additional appendTsv edge cases ─────────────────────────────── */

test('appendTsv: numeric values are coerced to strings via String()', async () => {
  // Realistic pattern: callers sometimes pass numbers from arithmetic rather than
  // string literals; verify String() coercion keeps them readable after round-trip.
  const path = tmpTsv()
  const HEADERS = ['city', 'baseline_eur', 'count']
  await appendTsv(path, HEADERS, { city: 'Berlin', baseline_eur: 2400, count: 42 })
  const { rows } = await readTsv(path)
  assert.equal(rows[0].baseline_eur, '2400')
  assert.equal(rows[0].count, '42')
})

test('appendTsv: multiple appends preserve insertion order on read-back', async () => {
  const path = tmpTsv()
  const HEADERS = ['seq', 'val']
  await appendTsv(path, HEADERS, { seq: '1', val: 'a' })
  await appendTsv(path, HEADERS, { seq: '2', val: 'b' })
  await appendTsv(path, HEADERS, { seq: '3', val: 'c' })
  const { rows } = await readTsv(path)
  assert.deepEqual(rows.map(r => r.seq), ['1', '2', '3'])
})

/* ───── Additional isFresh edge cases ───────────────────────────────── */

test('isFresh: days=0 — only the current-day date is fresh, yesterday is stale', () => {
  // ageDays for a date that is `days` days old is exactly <= days, so
  // same-day ISO is fresh and yesterday (>0 days old) is stale.
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('2026-06-25', 0, now), true,  'same-day ISO is fresh at days=0')
  assert.equal(isFresh('2026-06-24', 0, now), false, 'yesterday is stale at days=0')
})

test('isFresh: large days value always accepts historic dates', () => {
  const now = new Date('2026-06-25T00:00:00Z')
  assert.equal(isFresh('2000-01-01', 99999, now), true)
})

/* ───── Additional todayIso edge cases ──────────────────────────────── */

test('todayIso: returns correct date at exact UTC midnight boundaries', () => {
  // Exact UTC midnight: still that day.
  assert.equal(todayIso(new Date('2026-06-25T00:00:00.000Z')), '2026-06-25')
  // One millisecond before midnight: still the prior day.
  assert.equal(todayIso(new Date('2026-06-24T23:59:59.999Z')), '2026-06-24')
  // One millisecond after midnight of June 25: still June 25.
  assert.equal(todayIso(new Date('2026-06-25T00:00:00.001Z')), '2026-06-25')
})
