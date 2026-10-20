import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHealthRow, serializeHealthRow, parseHealthRows, collapseRuns,
  reviewPortalHealth, renderReview, portalHeadsUp, reviewIsEmpty, THRESHOLDS, HEALTH_HEADER,
} from './portal-health-core.mjs'

const row = (date, company, outcome, jobs = 0, kept = 0, extra = {}) =>
  buildHealthRow({ date, company, source: 'greenhouse-api', outcome, jobs, kept, ...extra })

const tracked = [
  { name: 'Nimbus Robotics', enabled: true },
  { name: 'Harbor Light', enabled: true },
  { name: 'Lumen Freight', enabled: true },
  { name: 'Old Mill Co', enabled: false },
]

test('rows round-trip through the TSV and bad lines are dropped', () => {
  const r = row('2026-10-01', 'Nimbus Robotics', 'ok', 12, 1, { note: 'tab\there' })
  const text = `${HEALTH_HEADER}\n${serializeHealthRow(r)}\nnot a row\n2026-13-99\tX\tsrc\tok\t1\t0\t\n`
  const parsed = parseHealthRows(text)
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0], { ...r, note: 'tab here' })
  assert.throws(() => buildHealthRow({ date: '2026-10-01', company: 'X', outcome: 'meh' }), /outcome/)
  assert.throws(() => buildHealthRow({ date: 'yesterday', company: 'X', outcome: 'ok' }), /date/)
})

test('two records on the same day count as one run (last wins)', () => {
  const runs = collapseRuns([
    row('2026-10-01', 'Nimbus Robotics', 'error'),
    row('2026-10-01', 'Nimbus Robotics', 'ok', 5, 0),
    row('2026-10-08', 'nimbus robotics', 'ok', 5, 0),
  ])
  const nimbus = [...runs.values()][0]
  assert.equal(runs.size, 1, 'case-insensitive company key')
  assert.deepEqual(nimbus.runs.map((r) => [r.date, r.outcome]), [['2026-10-01', 'ok'], ['2026-10-08', 'ok']])
})

test('fix: the last N runs all failed', () => {
  const rows = [
    row('2026-08-01', 'Harbor Light', 'ok', 3, 1),
    row('2026-09-01', 'Harbor Light', 'error', 0, 0, { note: 'HTTP 429' }),
    row('2026-09-08', 'Harbor Light', 'unreachable'),
    row('2026-09-15', 'Harbor Light', 'error', 0, 0, { note: 'HTTP 404' }),
  ]
  const review = reviewPortalHealth({ rows, tracked })
  assert.equal(review.fix.length, 1)
  assert.equal(review.fix[0].company, 'Harbor Light')
  assert.match(review.fix[0].reason, /3 failed scans in a row/)
  assert.match(review.fix[0].reason, /HTTP 404/)
  assert.equal(review.pause.length, 0, 'a failing board is never also a pause')
})

test('pause: enough runs over enough days with nothing kept; a single find resets it', () => {
  const quiet = ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-20'].map((d) => row(d, 'Nimbus Robotics', 'ok', 40, 0))
  let review = reviewPortalHealth({ rows: quiet, tracked })
  assert.equal(review.pause.length, 1)
  assert.match(review.pause[0].reason, /no matching role in 4 scans over 50 days \(160 postings seen\)/)

  review = reviewPortalHealth({ rows: [...quiet, row('2026-09-01', 'Nimbus Robotics', 'ok', 40, 1)], tracked })
  assert.equal(review.pause.length, 0)

  const short = ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22'].map((d) => row(d, 'Nimbus Robotics', 'ok', 40, 0))
  assert.equal(reviewPortalHealth({ rows: short, tracked }).pause.length, 0, `${THRESHOLDS.pauseMinSpanDays} days not reached`)
})

test('disabled or untracked companies are never flagged for fix/pause', () => {
  const rows = ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-20'].flatMap((d) => [
    row(d, 'Old Mill Co', 'ok', 10, 0),
    row(d, 'Nobody Inc', 'error'),
  ])
  const review = reviewPortalHealth({ rows, tracked })
  assert.equal(review.fix.length, 0)
  assert.equal(review.pause.length, 0)
})

test('promote: untracked companies found repeatedly by discovery sources or scored well', () => {
  const scanHistory = [
    { company: 'Bright Harbor', source: 'websearch', status: 'added' },
    { company: 'Bright Harbor', source: 'indeed', status: 'added' },
    { company: 'Once Only', source: 'websearch', status: 'added' },
    { company: 'Nimbus Robotics', source: 'websearch', status: 'added' },
    { company: 'Nimbus Robotics', source: 'websearch', status: 'added' },
    { company: 'Api Finds', source: 'greenhouse-api', status: 'added' },
    { company: 'Api Finds', source: 'greenhouse-api', status: 'added' },
  ]
  const scores = [
    { company: 'Old Mill Co', verdict: 'go' },
    { company: 'Once Only', verdict: 'skip' },
    { company: 'Quiet Star', verdict: 'stretch' },
  ]
  const review = reviewPortalHealth({ rows: [], tracked, scanHistory, scores })
  const byCompany = Object.fromEntries(review.promote.map((p) => [p.company, p]))
  assert.deepEqual(Object.keys(byCompany).sort(), ['Bright Harbor', 'Old Mill Co', 'Quiet Star'])
  assert.match(byCompany['Bright Harbor'].reason, /found 2× by websearch, indeed: add it to tracked_companies/)
  assert.match(byCompany['Old Mill Co'].reason, /scored go: re-enable it in tracked_companies/)
  assert.equal(byCompany['Old Mill Co'].evidence.tracked, true)
  assert.ok(!byCompany['Nimbus Robotics'], 'an enabled tracked company is not promoted')
  assert.ok(!byCompany['Api Finds'], 'API finds come from a tracked board already')
  // ranking: a verdict outranks finds
  assert.equal(review.promote[0].company === 'Quiet Star' || review.promote[0].company === 'Old Mill Co', true)
})

test('render + heads-up items; nothing when the review is empty', () => {
  assert.equal(renderReview({ fix: [], pause: [], promote: [] }), '')
  assert.deepEqual(portalHeadsUp({ fix: [], pause: [], promote: [] }), [])
  assert.equal(reviewIsEmpty(null), true)

  const rows = ['2026-07-01', '2026-07-15', '2026-08-01', '2026-08-20'].map((d) => row(d, 'Nimbus Robotics', 'ok', 40, 0))
  const review = reviewPortalHealth({ rows, tracked, scores: [{ company: 'Quiet Star', verdict: 'go' }] })
  const text = renderReview(review)
  assert.match(text, /^Portal health — suggestions/)
  assert.match(text, /No fit for a while · Nimbus Robotics/)
  assert.match(text, /Worth tracking · Quiet Star/)
  const items = portalHeadsUp(review)
  assert.equal(items.length, 2)
  assert.equal(items[0].meta.kind, 'portal-health')
  assert.equal(items[0].meta.action, 'pause')
  assert.match(items[0].sub, /^No matching role/)
  assert.equal(portalHeadsUp(review, 1).length, 1)
})
