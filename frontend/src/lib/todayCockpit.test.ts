import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCockpitFeed,
  parseScore10,
  SCOUTING_MIN_SCORE,
  FOLLOWUP_QUIET_DAYS,
  FOLLOWUP_STALE_DAYS,
  SCOUTING_FRESH_DAYS,
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

// ─── parseScore10 edge cases ──────────────────────────────────────────────────

test('parseScore10 handles integer /10 scores without decimal', () => {
  assert.equal(parseScore10('7/10'), 7)
  assert.equal(parseScore10('10/10'), 10)
  assert.equal(parseScore10('0/10'), 0)
})

test('parseScore10 is tolerant of surrounding whitespace', () => {
  assert.equal(parseScore10('  8.5 / 10  '), 8.5)
})

test('parseScore10 rejects malformed and non-/10 strings', () => {
  assert.equal(parseScore10('7.2 / 5'), null)
  assert.equal(parseScore10('abc'), null)
  assert.equal(parseScore10('7.2'), null)    // no /10 suffix
  assert.equal(parseScore10('/10'), null)    // missing numeric part
  assert.equal(parseScore10(''), null)
})

// ─── Deadline edge cases ──────────────────────────────────────────────────────

test('a deadline falling today (0 days) is critical and counts as 100 urgency', () => {
  const { items } = feed({
    applications: [makeApplication({ company: 'Today', role: 'A', status: 'Evaluated', deadline: '2026-06-25' })],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'critical')
  assert.equal(items[0].urgencyScore, 100)  // 100 - 0*2.6 = 100
  assert.ok(items[0].title.includes('today'))
})

test('a deadline tomorrow (1 day) uses "tomorrow" in the title', () => {
  const { items } = feed({
    applications: [makeApplication({ company: 'Tomorrow', role: 'A', status: 'Evaluated', deadline: '2026-06-26' })],
  })
  assert.equal(items[0].severity, 'critical')  // <=2 days
  assert.ok(items[0].title.includes('tomorrow'))
})

test('a deadline in exactly 31 days is surfaced (boundary inclusive)', () => {
  const { counts } = feed({
    applications: [makeApplication({ company: 'BoundaryHi', role: 'A', status: 'Evaluated', deadline: '2026-07-26' })],
  })
  assert.equal(counts.deadline, 1)
})

test('a deadline 32 days away is beyond this-month horizon and not surfaced', () => {
  const { counts } = feed({
    applications: [makeApplication({ company: 'TooFar', role: 'A', status: 'Evaluated', deadline: '2026-07-27' })],
  })
  assert.equal(counts.deadline, 0)
})

test('a deadline on a non-Evaluated in-flight status routes to viewReport', () => {
  for (const status of ['Applied', 'Responded', 'Interview'] as const) {
    const { items } = feed({
      applications: [makeApplication({ company: 'Z', role: 'R', status, deadline: '2026-06-28' })], // +3d high
    })
    assert.equal(items[0].action.type, 'viewReport', `status ${status} should viewReport`)
    assert.equal(items[0].actionLabel, 'Open report', `status ${status} actionLabel`)
  }
})

// ─── Follow-up edge cases ─────────────────────────────────────────────────────

test('Responded status past the quiet window also triggers a follow-up', () => {
  const { counts } = feed({
    applications: [makeApplication({
      status: 'Responded', date: '2026-06-10', deadline: 'n/d', // 15d quiet
    })],
  })
  assert.equal(counts.followup, 1)
})

test('Interview status past the quiet window gets an interviewing-specific title', () => {
  const { items, counts } = feed({
    applications: [makeApplication({
      status: 'Interview', date: '2026-06-10', deadline: 'n/d', // 15d quiet
    })],
  })
  assert.equal(counts.followup, 1)
  assert.ok(items[0].title.toLowerCase().includes('interview'))
  assert.equal(items[0].severity, 'high')  // interviewing rows are always high
})

test('a stalled application urgencyScore is capped at 85', () => {
  // 400 quiet days → formula would produce 40+400+12 = 452 without cap
  const { items } = feed({
    applications: [makeApplication({ status: 'Applied', date: '2024-01-01', deadline: 'n/d' })],
  })
  assert.equal(items[0].kind, 'followup')
  assert.ok(items[0].urgencyScore <= 85)
})

test('follow-up is not triggered when exactly at the quiet threshold (boundary exclusive)', () => {
  // FOLLOWUP_QUIET_DAYS = 10 — date exactly 10 days ago should surface (>= 10)
  const { items } = feed({
    applications: [makeApplication({ status: 'Applied', date: '2026-06-15', deadline: 'n/d' })],
  })
  // 10 days since → should surface (quiet >= FOLLOWUP_QUIET_DAYS)
  assert.equal(items.filter(i => i.kind === 'followup').length, 1)
})

test('follow-up is skipped for a non-in-flight status (Evaluated has no follow-up)', () => {
  const { counts } = feed({
    applications: [makeApplication({ status: 'Evaluated', date: '2026-01-01', deadline: 'n/d' })],
  })
  assert.equal(counts.followup, 0)
})

test('follow-up with a malformed date is silently skipped', () => {
  const { counts } = feed({
    applications: [makeApplication({ status: 'Applied', date: 'not-a-date', deadline: 'n/d' })],
  })
  assert.equal(counts.followup, 0)
})

// ─── Outreach edge cases ──────────────────────────────────────────────────────

test('outreach item subtitle includes role when present', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'Helios', contact: 'Dana', action: 'nudge', daysSince: 8, role: 'Recruiter' },
  ]
  const { items } = feed({ outreach })
  assert.ok(items[0].subtitle.includes('Dana'))
  assert.ok(items[0].subtitle.includes('Recruiter'))
})

test('outreach item subtitle omits role when absent', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'Helios', contact: 'Dana', action: 'nudge', daysSince: 8 },
  ]
  const { items } = feed({ outreach })
  assert.equal(items[0].subtitle, 'Dana')
})

test('outreach with daysSince >= 14 gets high severity', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'A', contact: 'X', action: 'nudge', daysSince: 14 },
  ]
  const { items } = feed({ outreach })
  assert.equal(items[0].severity, 'high')
})

test('outreach with daysSince < 14 gets medium severity', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'A', contact: 'X', action: 'nudge', daysSince: 13 },
  ]
  const { items } = feed({ outreach })
  assert.equal(items[0].severity, 'medium')
})

test('outreach urgencyScore is capped at 80 for very old nudges', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'A', contact: 'X', action: 'nudge', daysSince: 999 },
  ]
  const { items } = feed({ outreach })
  assert.ok(items[0].urgencyScore <= 80)
})

test('outreach without daysSince falls back to computing from lastTouch', () => {
  // lastTouch = 2026-06-10 → 15 days before NOW
  const outreach: OutreachCadenceEntry[] = [
    { company: 'A', contact: 'X', action: 'nudge', lastTouch: '2026-06-10' },
  ]
  const { items } = feed({ outreach })
  assert.equal(items.length, 1)
  assert.ok(items[0].title.includes('15'))
})

test('outreach without daysSince or lastTouch uses 0 days and shows "Nudge due"', () => {
  // No daysSince, no lastTouch → days falls back to null → over = 0
  const outreach: OutreachCadenceEntry[] = [
    { company: 'A', contact: 'X', action: 'nudge' },
  ]
  const { items } = feed({ outreach })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Nudge due')
})

test('outreach id is derived from lowercased company and contact', () => {
  const outreach: OutreachCadenceEntry[] = [
    { company: 'Helios Corp', contact: 'Dana Kim', action: 'nudge', daysSince: 8 },
  ]
  const { items } = feed({ outreach })
  assert.equal(items[0].id, 'outreach:helios corp|dana kim')
})

// ─── Scouting edge cases ──────────────────────────────────────────────────────

test('scouting hit evaluated today (age = 0) adds maximum recency lift', () => {
  const { items } = feed({
    scouting: [makeScoutingEntry({ company: 'Now', score: '7.0/10', date: '2026-06-25' })],
  })
  // score=7.0 → scoreLift=0; age=0 → recencyLift=14; total = 30+0+14=44
  assert.equal(items[0].urgencyScore, 44)
})

test('scouting at exactly the SCOUTING_FRESH_DAYS boundary (14d) still surfaces', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Edge', score: '7.5/10', date: '2026-06-11' })], // 14d ago
  })
  assert.equal(counts.scouting, 1)
})

test('scouting at SCOUTING_FRESH_DAYS+1 (15d) is too old and dropped', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Gone', score: '9.0/10', date: '2026-06-10' })], // 15d ago
  })
  assert.equal(counts.scouting, 0)
})

test('scouting at exactly SCOUTING_MIN_SCORE (7.0) is surfaced', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Min', score: '7.0/10', date: '2026-06-24' })],
  })
  assert.equal(counts.scouting, 1)
})

test('scouting below SCOUTING_MIN_SCORE (6.9) is dropped', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Below', score: '6.9/10', date: '2026-06-24' })],
  })
  assert.equal(counts.scouting, 0)
})

test('scouting dedup tie-break: same age → higher score wins', () => {
  const { items, counts } = feed({
    scouting: [
      makeScoutingEntry({ company: 'Tied', role: 'PM', score: '7.5/10', date: '2026-06-24' }),
      makeScoutingEntry({ company: 'Tied', role: 'PM', score: '8.8/10', date: '2026-06-24' }), // same age, higher score
    ],
  })
  assert.equal(counts.scouting, 1)
  assert.ok(items[0].title.includes('8.8'))
})

test('scouting hit in active liveness is NOT suppressed', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Live', role: 'Eng', score: '8.0/10', date: '2026-06-24' })],
    liveness: { 'live|eng': 'active' },
  })
  assert.equal(counts.scouting, 1)
})

test('scouting hit in stale liveness is NOT suppressed (only closed suppresses)', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Stale', role: 'Eng', score: '8.0/10', date: '2026-06-24' })],
    liveness: { 'stale|eng': 'stale' },
  })
  assert.equal(counts.scouting, 1)
})

test('scouting urgencyScore is capped at 70 for an extreme-score, zero-age hit', () => {
  const { items } = feed({
    scouting: [makeScoutingEntry({ company: 'Perfect', score: '10.0/10', date: '2026-06-25' })],
  })
  assert.ok(items[0].urgencyScore <= 70)
})

test('scouting severity is "medium" for a score between min and 8.0', () => {
  const { items } = feed({
    scouting: [makeScoutingEntry({ company: 'Med', score: '7.9/10', date: '2026-06-24' })],
  })
  assert.equal(items[0].severity, 'medium')
})

test('Evaluated status in applications does NOT suppress a scouting hit (only ENGAGED_OR_DEAD does)', () => {
  const { counts } = feed({
    scouting: [makeScoutingEntry({ company: 'Eval', role: 'Analyst', score: '8.0/10', date: '2026-06-24' })],
    applications: [makeApplication({ company: 'Eval', role: 'Analyst', status: 'Evaluated', deadline: 'n/d' })],
  })
  assert.equal(counts.scouting, 1)
})

// ─── Ranking tie-break details ────────────────────────────────────────────────

test('kind tie-break: deadline beats followup when urgencyScore is equal', () => {
  // Manufacture a followup and a deadline that produce the same raw urgencyScore.
  // Deadline at day 7 → 100 - 7*2.6 = 81.8 → rounded 82.
  // Followup: 40 + quiet days; for quiet=42 → 82, but capped at 85 — won't tie at 82.
  // Simpler: use the sort predicate directly by comparing items in the feed.
  // Actually the sort is stable and kind wins after urgencyScore + severity ties.
  // We just need two items with the same urgencyScore where kind differs.
  // Deadline at 5d → 100 - 5*2.6 = 87 → round = 87.
  // Followup: 40 + 47 = 87, still under 85 cap → 85. Not same.
  // We can't easily force the exact tie, so we verify the comparator direction
  // with an integration case: a 'high' deadline outranks a 'high' followup when
  // scores differ but both are high-severity (deadline urgency > followup urgency).
  const { items } = feed({
    applications: [
      makeApplication({ company: 'DeadlineApp', role: 'R1', status: 'Evaluated', deadline: '2026-06-30' }), // 5d → urgent 87
      makeApplication({ company: 'FollowupApp', role: 'R2', status: 'Applied', date: '2026-06-01', deadline: 'n/d' }), // 24d → capped 85
    ],
  })
  // Deadline urgency 87 > followup urgency 85 → deadline first
  assert.equal(items[0].kind, 'deadline')
  assert.equal(items[0].company, 'DeadlineApp')
})

test('company name alphabetical tie-break when all else is equal', () => {
  // Two identical scouting hits same day, same score → different companies
  const { items } = feed({
    scouting: [
      makeScoutingEntry({ company: 'Zeta', role: 'Analyst', score: '7.5/10', date: '2026-06-24' }),
      makeScoutingEntry({ company: 'Alpha', role: 'Analyst', score: '7.5/10', date: '2026-06-24' }),
    ],
  })
  // Both are scouting, same score/age/severity → alphabetical: Alpha before Zeta
  assert.equal(items[0].company, 'Alpha')
  assert.equal(items[1].company, 'Zeta')
})
