import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCockpitFeed,
  parseScore10,
  SCOUTING_MIN_SCORE,
  FOLLOWUP_QUIET_DAYS,
  type CockpitInput,
  type OutreachCadenceEntry,
} from '@/lib/todayCockpit'
import { makeApplication, makeScoutingEntry } from '@/test-utils/fixtures'

// Pin "today" so every day-count assertion is deterministic.
const NOW = new Date(2026, 5, 25) // 2026-06-25 (local midnight)

function feed(input: Partial<CockpitInput>) {
  return buildCockpitFeed(
    { applications: [], scouting: [], outreach: [], liveness: {}, ...input },
    NOW,
  )
}

// ─── parseScore10 ─────────────────────────────────────────────────────────────

test('parseScore10 reads /10 scores and rejects everything else', () => {
  assert.equal(parseScore10('7.2/10'), 7.2)
  assert.equal(parseScore10('8.0/10'), 8.0)
  assert.equal(parseScore10(' 9/10 '), 9)
  assert.equal(parseScore10('3.40/5'), null)   // /5 legacy — skipped, not mis-ranked
  assert.equal(parseScore10('n/d'), null)
  assert.equal(parseScore10(''), null)
})

// ─── Deadlines ────────────────────────────────────────────────────────────────

test('a near deadline on an Evaluated app surfaces as an apply action', () => {
  const { items, counts } = feed({
    applications: [makeApplication({
      company: 'Northwind', role: 'Ops Analyst', status: 'Evaluated', deadline: '2026-06-27', // +2d
    })],
  })
  assert.equal(counts.deadline, 1)
  const it = items[0]
  assert.equal(it.kind, 'deadline')
  assert.equal(it.severity, 'critical')          // <=2 days
  assert.equal(it.action.type, 'apply')
  assert.equal(it.actionLabel, 'Apply now')
})

test('a sent app with a near deadline points to the report, not apply', () => {
  const { items } = feed({
    applications: [makeApplication({ status: 'Applied', deadline: '2026-06-30' })], // +5d
  })
  assert.equal(items[0].action.type, 'viewReport')
  assert.equal(items[0].severity, 'high')        // 3..7 days
})

test('missed, rolling, and far-off deadlines do not surface', () => {
  const { counts } = feed({
    applications: [
      makeApplication({ company: 'A', deadline: '2026-06-20' }),  // missed
      makeApplication({ company: 'B', deadline: 'Rolling' }),     // rolling
      makeApplication({ company: 'C', deadline: '2026-09-01' }),  // >31d
      makeApplication({ company: 'D', deadline: 'n/d' }),         // no date
    ],
  })
  assert.equal(counts.deadline, 0)
})

test('decided applications (Offer/Rejected/SKIP/Discarded) skip the deadline nudge', () => {
  const decided = ['Offer', 'Rejected', 'SKIP', 'Discarded'] as const
  for (const status of decided) {
    const { counts } = feed({
      applications: [makeApplication({ status, deadline: '2026-06-27' })],
    })
    assert.equal(counts.deadline, 0, `status ${status} should not surface a deadline`)
  }
})

// ─── Follow-ups ───────────────────────────────────────────────────────────────

test('a quiet sent application past the cadence surfaces a follow-up', () => {
  const { items, counts } = feed({
    applications: [makeApplication({
      status: 'Applied', date: '2026-06-10', deadline: 'n/d', // 15d quiet
    })],
  })
  assert.equal(counts.followup, 1)
  assert.equal(items[0].kind, 'followup')
  assert.equal(items[0].action.type, 'draftFollowup')
})

test('a freshly-sent application (under the quiet window) does not nag', () => {
  // Build the date from local Y/M/D so it can't drift across the UTC boundary
  // the way toISOString() would (NOW is a local-midnight Date).
  const justSent = new Date(NOW)
  justSent.setDate(justSent.getDate() - (FOLLOWUP_QUIET_DAYS - 1))
  const d = `${justSent.getFullYear()}-${String(justSent.getMonth() + 1).padStart(2, '0')}-${String(justSent.getDate()).padStart(2, '0')}`
  const { counts } = feed({
    applications: [makeApplication({ status: 'Applied', date: d, deadline: 'n/d' })],
  })
  assert.equal(counts.followup, 0)
})

test('a stalled interview outranks a fresh-ish applied follow-up', () => {
  const { items } = feed({
    applications: [
      makeApplication({ company: 'Quiet', role: 'IC', status: 'Applied',   date: '2026-06-13', deadline: 'n/d' }), // 12d
      makeApplication({ company: 'Live',  role: 'IC', status: 'Interview', date: '2026-06-01', deadline: 'n/d' }), // 24d stalled
    ],
  })
  // Both are follow-ups; the stalled interview must rank first.
  assert.equal(items[0].company, 'Live')
  assert.equal(items[0].severity, 'high')
})

// ─── Outreach ─────────────────────────────────────────────────────────────────

test('only nudge-action outreach entries surface', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'Foo', contact: 'Dana', action: 'nudge', daysSince: 9, reason: 'No reply yet' },
    { company: 'Bar', contact: 'Lee',  action: 'waiting', daysSince: 2 },
    { company: 'Baz', contact: 'Sam',  action: 'cold', daysSince: 30 },
    { company: 'Qux', contact: 'Ana',  action: 'done', daysSince: 1 },
  ]
  const { items, counts } = feed({ outreach })
  assert.equal(counts.outreach, 1)
  assert.equal(items[0].company, 'Foo')
  assert.equal(items[0].action.type, 'draftOutreach')
})

// ─── Scouting ─────────────────────────────────────────────────────────────────

test('a fresh high-fit scouting hit surfaces as review & apply', () => {
  const { items, counts } = feed({
    scouting: [makeScoutingEntry({
      company: 'Helios', role: 'Strategy Analyst', score: '8.2/10', tier: 'T2', date: '2026-06-23', // 2d old
    })],
  })
  assert.equal(counts.scouting, 1)
  assert.equal(items[0].kind, 'scouting')
  assert.equal(items[0].severity, 'high')        // >=8.0
  assert.equal(items[0].action.type, 'apply')
})

test('scouting hits below the apply threshold or too old are dropped', () => {
  const { counts } = feed({
    scouting: [
      makeScoutingEntry({ company: 'Low', score: '6.5/10', date: '2026-06-24' }),   // below threshold
      makeScoutingEntry({ company: 'Old', score: '9.0/10', date: '2026-05-01' }),   // stale (>14d)
      makeScoutingEntry({ company: 'Bad', score: '3.4/5',  date: '2026-06-24' }),   // /5 — unparseable as /10
    ],
  })
  assert.equal(counts.scouting, 0)
})

test('a scouting hit already engaged in applications is suppressed', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Dup', role: 'Analyst', score: '8.0/10', date: '2026-06-24' })],
    applications: [makeApplication({ company: 'Dup', role: 'Analyst', status: 'Applied', deadline: 'n/d' })],
  })
  assert.equal(counts.scouting, 0)
})

test('a scouting hit whose listing is closed (liveness) is suppressed', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Gone', role: 'Analyst', score: '8.0/10', date: '2026-06-24' })],
    liveness: { 'gone|analyst': 'closed' },
  })
  assert.equal(counts.scouting, 0)
})

test('re-evaluations collapse to the freshest row per entity', () => {
  const { counts } = feed({
    scouting: [
      makeScoutingEntry({ company: 'Repeat', role: 'PM', score: '7.5/10', date: '2026-06-18' }),
      makeScoutingEntry({ company: 'Repeat', role: 'PM', score: '8.1/10', date: '2026-06-24' }),
    ],
  })
  assert.equal(counts.scouting, 1)
})

// ─── Ranking + rollup ─────────────────────────────────────────────────────────

test('a closing deadline outranks a fresh scouting hit', () => {
  const { items } = feed({
    applications: [makeApplication({ company: 'Closing', role: 'X', status: 'Evaluated', deadline: '2026-06-26' })], // +1d
    scouting:     [makeScoutingEntry({ company: 'Fresh', role: 'Y', score: '9.0/10', date: '2026-06-25' })],
  })
  assert.equal(items[0].kind, 'deadline')
  assert.equal(items[0].company, 'Closing')
})

test('feed aggregates counts and an actionable (critical+high) total', () => {
  const { items, counts, actionable } = feed({
    applications: [
      makeApplication({ company: 'DL', role: 'A', status: 'Evaluated', deadline: '2026-06-26' }), // deadline critical
      makeApplication({ company: 'FU', role: 'B', status: 'Applied', date: '2026-06-01', deadline: 'n/d' }), // followup stalled (high)
    ],
    scouting: [makeScoutingEntry({ company: 'SC', role: 'C', score: '7.2/10', date: '2026-06-24' })], // scouting medium
    outreach: [{ company: 'OR', contact: 'Z', action: 'nudge', daysSince: 8 }], // outreach medium
  })
  assert.equal(items.length, 4)
  assert.deepEqual(counts, { deadline: 1, followup: 1, outreach: 1, scouting: 1 })
  assert.equal(actionable, 2) // the critical deadline + the high follow-up
})

test('an empty pipeline yields an empty, zeroed feed', () => {
  const { items, counts, actionable } = feed({})
  assert.equal(items.length, 0)
  assert.equal(actionable, 0)
  assert.deepEqual(counts, { deadline: 0, followup: 0, outreach: 0, scouting: 0 })
})
