import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeScoreTrajectory,
  sparklinePath,
  buildEngagementTimeline,
  trajectoryLabel,
} from '@/lib/companyTimeline'
import { makeScoreEntry, makeApplication } from '@/test-utils/fixtures'

// ─── computeScoreTrajectory ─────────────────────────────────────────────────────

test('trajectory: rising scores read as improving', () => {
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-03-01', overall: 6.0 }),
    makeScoreEntry({ date: '2026-04-01', overall: 7.5 }),
    makeScoreEntry({ date: '2026-05-01', overall: 8.5 }),
  ])
  assert.equal(t.direction, 'improving')
  assert.equal(t.firstScore, 6.0)
  assert.equal(t.latestScore, 8.5)
  assert.equal(t.delta, 2.5)
  assert.ok(t.slope > 0)
  assert.equal(t.points.length, 3)
})

test('trajectory: falling scores read as declining', () => {
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-03-01', overall: 9.0 }),
    makeScoreEntry({ date: '2026-05-01', overall: 6.0 }),
  ])
  assert.equal(t.direction, 'declining')
  assert.equal(t.delta, -3.0)
  assert.ok(t.slope < 0)
})

test('trajectory: a noisy middle does not flip the verdict (slope, not endpoints)', () => {
  // First→last delta is +0.2 (would look "improving" on endpoints alone) but
  // the slope across the dip is still clearly positive — and a small endpoint
  // move with a near-zero slope should read as steady. Construct a genuinely
  // flat-ish series: equal endpoints, a spike in the middle → slope ≈ 0.
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-01-01', overall: 7.0 }),
    makeScoreEntry({ date: '2026-02-01', overall: 9.0 }),
    makeScoreEntry({ date: '2026-03-01', overall: 7.0 }),
  ])
  assert.equal(t.direction, 'steady')   // slope is 0 despite the spike
  assert.equal(t.delta, 0)
})

test('trajectory: a tiny drift stays steady (inside the noise band)', () => {
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-01-01', overall: 7.0 }),
    makeScoreEntry({ date: '2026-02-01', overall: 7.05 }),
  ])
  assert.equal(t.direction, 'steady')
})

test('trajectory: unscored / SKIP rows are excluded from the trend', () => {
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-03-01', overall: 6.0 }),
    makeScoreEntry({ date: '2026-04-01', overall: 0 }),    // unscored — ignored
    makeScoreEntry({ date: '2026-05-01', overall: 8.0 }),
  ])
  assert.equal(t.points.length, 2)
  assert.equal(t.direction, 'improving')
  assert.equal(t.firstScore, 6.0)
  assert.equal(t.latestScore, 8.0)
})

test('trajectory: a single scored point is flat with no delta', () => {
  const t = computeScoreTrajectory([makeScoreEntry({ overall: 7.5 })])
  assert.equal(t.direction, 'flat')
  assert.equal(t.delta, 0)
  assert.equal(t.slope, 0)
  assert.equal(t.firstScore, 7.5)
  assert.equal(t.latestScore, 7.5)
})

test('trajectory: empty history is flat and safe', () => {
  const t = computeScoreTrajectory([])
  assert.deepEqual(t, {
    points: [], direction: 'flat', delta: 0, slope: 0, firstScore: 0, latestScore: 0,
  })
})

test('trajectory: re-sorts to oldest→newest regardless of input order', () => {
  const t = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-05-01', overall: 8.0 }),   // newest first (store order)
    makeScoreEntry({ date: '2026-03-01', overall: 6.0 }),
  ])
  assert.equal(t.points[0].date, '2026-03-01')
  assert.equal(t.points[0].score, 6.0)
  assert.equal(t.points[1].date, '2026-05-01')
  assert.equal(t.direction, 'improving')
})

// ─── sparklinePath ──────────────────────────────────────────────────────────────

test('sparkline: maps points into the box, higher score sits higher (smaller y)', () => {
  const pts = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-03-01', overall: 4.0 }),
    makeScoreEntry({ date: '2026-04-01', overall: 8.0 }),
  ]).points
  const path = sparklinePath(pts, 100, 20, 2)
  const coords = path.split(' ').map(s => s.split(',').map(Number))
  assert.equal(coords.length, 2)
  // First x at left pad, last x at right edge.
  assert.equal(coords[0][0], 2)
  assert.equal(coords[1][0], 98)
  // Higher score → smaller y. Point 2 (8.0) above point 1 (4.0).
  assert.ok(coords[1][1] < coords[0][1])
})

test('sparkline: a flat series rides the midline', () => {
  const pts = computeScoreTrajectory([
    makeScoreEntry({ date: '2026-03-01', overall: 7.0 }),
    makeScoreEntry({ date: '2026-04-01', overall: 7.0 }),
  ]).points
  const path = sparklinePath(pts, 100, 20, 2)
  const ys = path.split(' ').map(s => Number(s.split(',')[1]))
  // height 20, pad 2 → usable 16, midline = 2 + 8 = 10.
  ys.forEach(y => assert.equal(y, 10))
})

test('sparkline: single point centers, empty draws nothing', () => {
  const single = sparklinePath([{ date: '2026-03-01', score: 7, role: 'X' }], 100, 20, 2)
  assert.equal(single, '50,10')
  assert.equal(sparklinePath([], 100, 20), '')
})

// ─── buildEngagementTimeline ────────────────────────────────────────────────────

test('timeline: merges evaluations + applications newest-first', () => {
  const events = buildEngagementTimeline(
    [
      makeScoreEntry({ date: '2026-03-01', role: 'Analyst', overall: 7.0 }),
      makeScoreEntry({ date: '2026-05-01', role: 'PM', overall: 8.0 }),
    ],
    [
      makeApplication({ date: '2026-04-15', role: 'Analyst', status: 'Applied', score: '7.0/10' }),
    ],
  )
  assert.deepEqual(events.map(e => e.date), ['2026-05-01', '2026-04-15', '2026-03-01'])
  assert.deepEqual(events.map(e => e.kind), ['evaluation', 'application', 'evaluation'])
  assert.equal(events[1].status, 'Applied')
  assert.equal(events[1].score, 7.0)
})

test('timeline: an "Evaluated" application mirroring its evaluation is suppressed', () => {
  const events = buildEngagementTimeline(
    [makeScoreEntry({ date: '2026-03-01', role: 'Analyst', overall: 7.0 })],
    [makeApplication({ date: '2026-03-01', role: 'analyst', status: 'Evaluated', score: '7.0/10' })],
  )
  // Only the evaluation survives — the case-insensitive duplicate is dropped.
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'evaluation')
})

test('timeline: an application past "Evaluated" is kept even on a matching date/role', () => {
  const events = buildEngagementTimeline(
    [makeScoreEntry({ date: '2026-03-01', role: 'Analyst', overall: 7.0 })],
    [makeApplication({ date: '2026-03-01', role: 'Analyst', status: 'Interview' })],
  )
  assert.equal(events.length, 2)
  assert.ok(events.some(e => e.kind === 'application' && e.status === 'Interview'))
})

test('timeline: non-numeric application score becomes null, never 0', () => {
  const events = buildEngagementTimeline(
    [],
    [makeApplication({ date: '2026-03-01', role: 'Analyst', status: 'Applied', score: '—' })],
  )
  assert.equal(events[0].score, null)
})

test('timeline: same-day evaluation sorts above its application (causal order)', () => {
  const events = buildEngagementTimeline(
    [makeScoreEntry({ date: '2026-03-01', role: 'Analyst', overall: 7.0 })],
    [makeApplication({ date: '2026-03-01', role: 'PM', status: 'Applied' })],
  )
  // Same date → evaluation keeps its input precedence before the application.
  assert.equal(events[0].kind, 'evaluation')
  assert.equal(events[1].kind, 'application')
})

test('timeline: empty inputs yield no events', () => {
  assert.deepEqual(buildEngagementTimeline([], []), [])
})

// ─── trajectoryLabel ────────────────────────────────────────────────────────────

test('trajectoryLabel maps every direction to copy', () => {
  assert.equal(trajectoryLabel('improving'), 'Trending up')
  assert.equal(trajectoryLabel('declining'), 'Trending down')
  assert.equal(trajectoryLabel('steady'), 'Holding steady')
  assert.equal(trajectoryLabel('flat'), 'Single evaluation')
})
