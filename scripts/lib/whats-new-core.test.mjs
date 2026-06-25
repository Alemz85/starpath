// Unit tests for scripts/lib/whats-new-core.mjs — the pure core behind the
// "what's new & worth my time since last scan" digest. whats-new.mjs only wraps
// these with file I/O + rendering, so this suite pins the logic: scan-history
// parsing, URL-join normalization, cutoff inference, the scan↔score join, the
// priority bucketing, and the ranked digest assembly.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScanHistory,
  normalizeUrl,
  runDates,
  resolveCutoff,
  indexScoresByUrl,
  priorityOf,
  buildDigest,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
} from './whats-new-core.mjs'

const SCAN_HEADER = [
  'url', 'first_seen', 'portal', 'title', 'company', 'location', 'status',
  'scan_dates',
].join('\t')

const SCORE_HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

function scanRow(over = {}) {
  const base = {
    url: 'https://x.test/jobs/1', first_seen: '2026-06-24', portal: 'greenhouse-api',
    title: 'Strategy Intern', company: 'Acme', location: 'Madrid',
    status: 'added', scan_dates: '2026-06-24',
  }
  const m = { ...base, ...over }
  return [m.url, m.first_seen, m.portal, m.title, m.company, m.location, m.status, m.scan_dates].join('\t')
}

function scoreRow(over = {}) {
  const cells = new Array(26).fill('')
  cells[0] = over.date ?? '2026-06-24'
  cells[1] = over.archetype ?? 'Strategy & Operations'
  cells[11] = over.overall ?? '7.5'
  cells[17] = over.company ?? 'Acme'
  cells[18] = over.role ?? 'Strategy Intern'
  cells[25] = over.url ?? 'https://x.test/jobs/1'
  return cells.join('\t')
}

const scanTsv = (...rows) => [SCAN_HEADER, ...rows].join('\n')
const scoreTsv = (...rows) => [SCORE_HEADER, ...rows].join('\n')

/* ───── parseScanHistory ─────────────────────────────────────────── */

test('parseScanHistory reads header rows and splits scan_dates', () => {
  const rows = parseScanHistory(scanTsv(scanRow({ scan_dates: '2026-06-20|2026-06-24' })))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company, 'Acme')
  assert.deepEqual(rows[0].scan_dates_list, ['2026-06-20', '2026-06-24'])
})

test('parseScanHistory tolerates missing header (canonical order)', () => {
  const rows = parseScanHistory(scanRow({ company: 'NoHdr' }))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company, 'NoHdr')
})

test('parseScanHistory skips blank lines and empties', () => {
  assert.deepEqual(parseScanHistory(''), [])
  assert.deepEqual(parseScanHistory('   \n\n'), [])
})

/* ───── normalizeUrl ─────────────────────────────────────────────── */

test('normalizeUrl collapses scheme, host case, and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://Job-Boards.Greenhouse.io/acme/jobs/123/'),
    normalizeUrl('http://job-boards.greenhouse.io/acme/jobs/123'),
  )
})

test('normalizeUrl preserves gh_jid query id but drops tracking params', () => {
  const a = normalizeUrl('https://n26.com/careers/positions/7806657?gh_jid=7806657')
  const b = normalizeUrl('https://n26.com/careers/positions/7806657?gh_jid=7806657&utm=x')
  assert.equal(a, b)
  assert.match(a, /id=7806657$/)
})

test('normalizeUrl returns "" for placeholders and falls back on garbage', () => {
  assert.equal(normalizeUrl('n/d'), '')
  assert.equal(normalizeUrl(''), '')
  assert.equal(normalizeUrl('not a url'), 'not a url')
})

/* ───── runDates / resolveCutoff ─────────────────────────────────── */

test('runDates unions first_seen + scan_dates, newest first, deduped', () => {
  const rows = parseScanHistory(scanTsv(
    scanRow({ first_seen: '2026-06-20', scan_dates: '2026-06-20|2026-06-24' }),
    scanRow({ url: 'https://x.test/2', first_seen: '2026-06-22', scan_dates: '2026-06-22' }),
  ))
  assert.deepEqual(runDates(rows), ['2026-06-24', '2026-06-22', '2026-06-20'])
})

test('resolveCutoff defaults to the latest-run boundary (inclusive)', () => {
  const rows = parseScanHistory(scanTsv(
    scanRow({ first_seen: '2026-06-20', scan_dates: '2026-06-20|2026-06-24' }),
    scanRow({ url: 'https://x.test/2', first_seen: '2026-06-24', scan_dates: '2026-06-24' }),
  ))
  const { cutoff, latestRun, basis } = resolveCutoff(rows)
  assert.equal(latestRun, '2026-06-24')
  assert.equal(cutoff, '2026-06-24')
  assert.equal(basis, 'latest-run')
})

test('resolveCutoff honors explicit since and days', () => {
  const rows = parseScanHistory(scanTsv(scanRow({ first_seen: '2026-06-24', scan_dates: '2026-06-24' })))
  assert.equal(resolveCutoff(rows, { since: '2026-06-01' }).cutoff, '2026-06-01')
  assert.equal(resolveCutoff(rows, { days: 7 }).cutoff, '2026-06-17')
})

test('resolveCutoff single-run cutoff = the only run date', () => {
  const rows = parseScanHistory(scanTsv(scanRow({ first_seen: '2026-06-24', scan_dates: '2026-06-24' })))
  const { cutoff, basis } = resolveCutoff(rows)
  assert.equal(cutoff, '2026-06-24')
  assert.equal(basis, 'single-run')
})

/* ───── indexScoresByUrl ─────────────────────────────────────────── */

test('indexScoresByUrl keeps the most recent eval per url', () => {
  const idx = indexScoresByUrl([
    ...parseScores(scoreTsv(
      scoreRow({ date: '2026-06-01', overall: '6.0' }),
      scoreRow({ date: '2026-06-20', overall: '8.0' }),
    )),
  ])
  assert.equal(idx.size, 1)
  const [row] = [...idx.values()]
  assert.equal(row.overall, 8.0)
})

// tiny local score parser mirroring targeting-core's (kept local to avoid
// coupling the test to that module's internals beyond what core re-exports).
function parseScores(tsv) {
  const lines = tsv.split('\n').filter((l) => l.trim())
  const header = lines[0].split('\t')
  return lines.slice(1).map((l) => {
    const c = l.split('\t')
    const o = {}
    header.forEach((k, i) => { o[k] = c[i] })
    o.overall = Number(o.overall)
    return o
  })
}

/* ───── priorityOf ───────────────────────────────────────────────── */

test('priorityOf buckets by scanner status and score band', () => {
  assert.equal(priorityOf({ status: 'skipped_expired' }, null), 'noise')
  assert.equal(priorityOf({ status: 'added' }, null), 'needs-eval')
  assert.equal(priorityOf({ status: 'added' }, { overall: 8.2 }), 'prioritize')
  assert.equal(priorityOf({ status: 'added' }, { overall: 7.1 }), 'prioritize')
  assert.equal(priorityOf({ status: 'added' }, { overall: 6.4 }), 'review')
  assert.equal(priorityOf({ status: 'added' }, { overall: 5.0 }), 'low')
  assert.equal(priorityOf({ status: 'added' }, { overall: NaN }), 'needs-eval')
})

/* ───── buildDigest (integration of the pure pieces) ─────────────── */

test('buildDigest surfaces only postings new since the cutoff, ranked', () => {
  const scan = scanTsv(
    // old, before cutoff — excluded
    scanRow({ url: 'https://x.test/old', first_seen: '2026-06-10', scan_dates: '2026-06-10|2026-06-24', company: 'Old' }),
    // new + scored strong → prioritize
    scanRow({ url: 'https://x.test/hi', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'HiFit' }),
    // new + unscored → needs-eval
    scanRow({ url: 'https://x.test/new', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'Fresh' }),
    // new but filtered by scanner → noise (excluded by default)
    scanRow({ url: 'https://x.test/skip', first_seen: '2026-06-24', scan_dates: '2026-06-24', status: 'skipped_title', company: 'Skip' }),
  )
  const score = scoreTsv(
    scoreRow({ url: 'https://x.test/hi', overall: '8.4', company: 'HiFit' }),
    scoreRow({ url: 'https://x.test/old', overall: '9.0', company: 'Old' }),
  )
  const d = buildDigest(parseScanHistory(scan), parseScores(score))

  assert.equal(d.cutoff, '2026-06-24')
  assert.equal(d.latestRun, '2026-06-24')
  assert.equal(d.totalNew, 2) // old excluded, skip excluded
  assert.equal(d.items[0].company, 'HiFit')
  assert.equal(d.items[0].priority, 'prioritize')
  assert.equal(d.items[0].overall, 8.4)
  assert.equal(d.items[1].company, 'Fresh')
  assert.equal(d.items[1].priority, 'needs-eval')
  assert.equal(d.counts.prioritize, 1)
  assert.equal(d.counts['needs-eval'], 1)
  assert.equal(d.prioritize.length, 1)
  assert.equal(d.needsEval.length, 1)
})

test('buildDigest includeNoise keeps scanner-skipped rows last', () => {
  const scan = scanTsv(
    scanRow({ url: 'https://x.test/a', first_seen: '2026-06-24', company: 'A' }),
    scanRow({ url: 'https://x.test/b', first_seen: '2026-06-24', status: 'skipped_title', company: 'B' }),
  )
  const d = buildDigest(parseScanHistory(scan), [], { includeNoise: true, since: '2026-06-24' })
  assert.equal(d.totalNew, 2)
  assert.equal(d.items[d.items.length - 1].priority, 'noise')
})

test('buildDigest computes ageDays and timesSeen against asOf', () => {
  const scan = scanTsv(
    scanRow({ url: 'https://x.test/a', first_seen: '2026-06-20', scan_dates: '2026-06-20|2026-06-22|2026-06-24' }),
  )
  const d = buildDigest(parseScanHistory(scan), [], { since: '2026-06-01', asOf: '2026-06-24' })
  assert.equal(d.items[0].ageDays, 4)
  assert.equal(d.items[0].timesSeen, 3)
})

test('buildDigest joins score even when urls differ by trailing slash/params', () => {
  const scan = scanTsv(
    scanRow({ url: 'https://n26.com/careers/positions/7806657?gh_jid=7806657', first_seen: '2026-06-24', company: 'N26' }),
  )
  const score = scoreTsv(
    scoreRow({ url: 'https://n26.com/careers/positions/7806657?gh_jid=7806657&utm=src', overall: '7.8', company: 'N26' }),
  )
  const d = buildDigest(parseScanHistory(scan), parseScores(score), { since: '2026-06-24' })
  assert.equal(d.items[0].overall, 7.8)
  assert.equal(d.items[0].priority, 'prioritize')
})

/* ───── exported constants ───────────────────────────────────────── */

test('priority labels cover every priority bucket', () => {
  for (const p of PRIORITY_ORDER) assert.ok(PRIORITY_LABELS[p], `label for ${p}`)
})
