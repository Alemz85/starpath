// Unit tests for scripts/lib/whats-new-core.mjs — the pure core behind the
// "what's new & worth my time since last scan" digest. whats-new.mjs only wraps
// these with file I/O + rendering, so this suite pins the logic: scan-history
// parsing, URL-join normalization, cutoff inference, the scan↔score join, the
// verdict bucketing, and the ranked digest assembly.
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
  bucketOf,
  priorityOf,
  verdictOf,
  blockedReasonOf,
  verdictStars,
  buildDigest,
  BUCKET_LABELS,
  BUCKET_ORDER,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
} from './whats-new-core.mjs'
import { parseScoreHistory } from './targeting-core.mjs'
import { historyTsv } from './testing/score-history-fixture.mjs'

const SCAN_HEADER = [
  'url', 'first_seen', 'portal', 'title', 'company', 'location', 'status',
  'scan_dates',
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

const scanTsv = (...rows) => [SCAN_HEADER, ...rows].join('\n')

// Score rows go through the real v2 fixture builder + the real parser, so
// Want / Ease / verdict / tier always agree with the engine.
// Dimension presets (fictional listings):
const GO = { skills_match: 8, experience_bar: 8, competition: 7, growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9 }
const STRETCH = { skills_match: 6, experience_bar: 6, competition: 5, growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9 }
const SOLID = { skills_match: 8, experience_bar: 8, competition: 7 }
const THIN = {}
const SKIP = { growth_mobility: 4, optionality_exit: 4, brand_value: 4, role_content: 4 }
const scores = (...rows) => parseScoreHistory(historyTsv(...rows))

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
    normalizeUrl('https://Job-Boards.Example.test/acme/jobs/123/'),
    normalizeUrl('http://job-boards.example.test/acme/jobs/123'),
  )
})

test('normalizeUrl preserves gh_jid query id but drops tracking params', () => {
  const a = normalizeUrl('https://jobs.example.test/positions/7806657?gh_jid=7806657')
  const b = normalizeUrl('https://jobs.example.test/positions/7806657?gh_jid=7806657&utm=x')
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

test('fixture presets land in the intended verdict cells', () => {
  const rows = scores(
    { ...GO, url: 'https://x.test/go' },
    { ...STRETCH, url: 'https://x.test/stretch' },
    { ...SOLID, url: 'https://x.test/solid' },
    { ...THIN, url: 'https://x.test/thin' },
    { ...SKIP, url: 'https://x.test/skip' },
  )
  assert.deepEqual(rows.map((r) => r.verdict), ['go', 'stretch', 'solid', 'thin', 'skip'])
})

test('indexScoresByUrl keeps the most recent eval per url', () => {
  const idx = indexScoresByUrl(scores(
    { ...SKIP, date: '2026-06-01' },
    { ...GO, date: '2026-06-20' },
  ))
  assert.equal(idx.size, 1)
  const [row] = [...idx.values()]
  assert.equal(row.verdict, 'go')
  assert.equal(row.date, '2026-06-20')
})

/* ───── verdictOf / blockedReasonOf / bucketOf ───────────────────── */

test('verdictOf reads the stored verdict, derives from Want/Ease, flags red as blocked', () => {
  assert.equal(verdictOf({ verdict: 'stretch' }), 'stretch')
  assert.equal(verdictOf({ want: 8.5, ease: 7.5, eligibility: 'green' }), 'go')
  assert.equal(verdictOf({ want: 9, ease: 9, eligibility: 'red' }), 'blocked')
  assert.equal(verdictOf({ blocked: true }), 'blocked')
  assert.equal(verdictOf({ want: NaN, ease: NaN }), '')
  assert.equal(verdictOf(null), '')
})

test('blockedReasonOf takes the first red flag reason, from parsed or raw flags', () => {
  const [row] = scores({ eligibility: 'red', eligibility_flags: 'duration:amber:6 months;language:red:German C1 required' })
  assert.equal(blockedReasonOf(row), 'German C1 required')
  assert.equal(blockedReasonOf({ eligibility_flags: 'work_auth:red:no sponsorship' }), 'no sponsorship')
  assert.equal(blockedReasonOf({ eligibility_flags: 'start_date:red' }), 'start_date')
  assert.equal(blockedReasonOf({ eligibility: 'red' }), 'eligibility red')
})

test('bucketOf buckets by scanner status and verdict', () => {
  const [go, stretch, solid, thin, skip] = scores(GO, STRETCH, SOLID, THIN, SKIP)
  const [growth] = scores({ ...GO, want: 8.5, ease: 4.0 })
  const [blocked] = scores({ eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' })
  const added = { status: 'added' }
  assert.equal(bucketOf({ status: 'skipped_expired' }, go), 'noise')
  assert.equal(bucketOf(added, null), 'needs-eval')
  assert.equal(bucketOf(added, go), 'go')
  assert.equal(bucketOf(added, stretch), 'apply')
  assert.equal(bucketOf(added, solid), 'apply')
  assert.equal(bucketOf(added, thin), 'consider')
  assert.equal(bucketOf(added, growth), 'consider')
  assert.equal(bucketOf(added, skip), 'skip')
  assert.equal(bucketOf(added, blocked), 'blocked')
  assert.equal(bucketOf(added, { want: NaN, ease: NaN, verdict: '' }), 'needs-eval')
  assert.equal(priorityOf, bucketOf) // v1 alias
})

test('verdictStars: go ★★, stretch/solid ★, everything else none (blocked never)', () => {
  assert.equal(verdictStars('go'), '★★')
  assert.equal(verdictStars('stretch'), '★')
  assert.equal(verdictStars('solid'), '★')
  for (const v of ['thin', 'growth', 'skip', 'blocked', '', null]) assert.equal(verdictStars(v), '')
})

/* ───── buildDigest (integration of the pure pieces) ─────────────── */

test('buildDigest surfaces only postings new since the cutoff, bucketed and ranked', () => {
  const scan = scanTsv(
    // old, before cutoff — excluded
    scanRow({ url: 'https://x.test/old', first_seen: '2026-06-10', scan_dates: '2026-06-10|2026-06-24', company: 'Old Co' }),
    // new + go → go bucket
    scanRow({ url: 'https://x.test/hi', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'Northwind Analytics' }),
    // new + stretch → apply bucket
    scanRow({ url: 'https://x.test/st', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'Contoso Retail' }),
    // new + unscored → needs-eval
    scanRow({ url: 'https://x.test/new', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'Fabrikam Labs' }),
    // new + blocked → blocked bucket
    scanRow({ url: 'https://x.test/red', first_seen: '2026-06-24', scan_dates: '2026-06-24', company: 'Tailspin Toys' }),
    // new but filtered by scanner → noise (excluded by default)
    scanRow({ url: 'https://x.test/skip', first_seen: '2026-06-24', scan_dates: '2026-06-24', status: 'skipped_title', company: 'Skip Co' }),
  )
  const score = scores(
    { ...GO, url: 'https://x.test/hi', company: 'Northwind Analytics' },
    { ...STRETCH, url: 'https://x.test/st', company: 'Contoso Retail' },
    { eligibility: 'red', eligibility_flags: 'language:red:German C1 required', url: 'https://x.test/red', company: 'Tailspin Toys' },
    { ...GO, url: 'https://x.test/old', company: 'Old Co' },
  )
  const d = buildDigest(parseScanHistory(scan), score)

  assert.equal(d.cutoff, '2026-06-24')
  assert.equal(d.latestRun, '2026-06-24')
  assert.equal(d.totalNew, 4) // old excluded, skip excluded
  assert.deepEqual(d.items.map((i) => i.bucket), ['go', 'apply', 'needs-eval', 'blocked'])

  const [hi, st, fresh, red] = d.items
  assert.equal(hi.company, 'Northwind Analytics')
  assert.equal(hi.verdict, 'go')
  assert.equal(hi.verdictLabel, 'Go')
  assert.ok(hi.want >= 8 && hi.ease >= 7)
  assert.ok(Number.isFinite(hi.priority))
  assert.equal(st.verdict, 'stretch')
  assert.equal(fresh.verdict, null)
  assert.equal(fresh.priority, null)
  assert.equal(red.verdict, 'blocked')
  assert.equal(red.want, null)
  assert.equal(red.ease, null)
  assert.equal(red.priority, null)
  assert.equal(red.blockedReason, 'German C1 required')
  assert.equal(red.verdictLabel, 'blocked: German C1 required')

  assert.equal(d.counts.go, 1)
  assert.equal(d.counts.apply, 1)
  assert.equal(d.counts['needs-eval'], 1)
  assert.equal(d.counts.blocked, 1)
  assert.deepEqual(d.prioritize.map((i) => i.company), ['Northwind Analytics', 'Contoso Retail'])
  assert.equal(d.needsEval.length, 1)
  assert.equal(d.blocked.length, 1)
  for (const it of d.items) {
    assert.ok(!('overall' in it) && !('band' in it) && !('priority' in it && typeof it.priority === 'string'))
  }
})

test('buildDigest ranks by Priority within a bucket', () => {
  const scan = scanTsv(
    scanRow({ url: 'https://x.test/a', first_seen: '2026-06-24', company: 'Low Stretch' }),
    scanRow({ url: 'https://x.test/b', first_seen: '2026-06-24', company: 'High Solid' }),
  )
  const score = scores(
    { want: 8.1, ease: 5.2, url: 'https://x.test/a' }, // stretch, priority ≈ 6.49
    { want: 7.9, ease: 9.0, url: 'https://x.test/b' }, // solid, priority ≈ 8.43
  )
  const d = buildDigest(parseScanHistory(scan), score, { since: '2026-06-24' })
  assert.deepEqual(d.items.map((i) => i.company), ['High Solid', 'Low Stretch'])
  assert.ok(d.items.every((i) => i.bucket === 'apply'))
})

test('buildDigest includeNoise keeps scanner-skipped rows last', () => {
  const scan = scanTsv(
    scanRow({ url: 'https://x.test/a', first_seen: '2026-06-24', company: 'A' }),
    scanRow({ url: 'https://x.test/b', first_seen: '2026-06-24', status: 'skipped_title', company: 'B' }),
  )
  const d = buildDigest(parseScanHistory(scan), [], { includeNoise: true, since: '2026-06-24' })
  assert.equal(d.totalNew, 2)
  assert.equal(d.items[d.items.length - 1].bucket, 'noise')
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
    scanRow({ url: 'https://jobs.example.test/positions/7806657?gh_jid=7806657', first_seen: '2026-06-24', company: 'Fabrikam Labs' }),
  )
  const score = scores(
    { ...SOLID, url: 'https://jobs.example.test/positions/7806657?gh_jid=7806657&utm=src', company: 'Fabrikam Labs' },
  )
  const d = buildDigest(parseScanHistory(scan), score, { since: '2026-06-24' })
  assert.equal(d.items[0].verdict, 'solid')
  assert.equal(d.items[0].bucket, 'apply')
})

/* ───── exported constants ───────────────────────────────────────── */

test('bucket labels cover every bucket; v1 aliases point at the same objects', () => {
  for (const b of BUCKET_ORDER) assert.ok(BUCKET_LABELS[b], `label for ${b}`)
  assert.equal(PRIORITY_LABELS, BUCKET_LABELS)
  assert.equal(PRIORITY_ORDER, BUCKET_ORDER)
})
