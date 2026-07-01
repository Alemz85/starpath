// Unit tests for scripts/lib/warm-outreach-core.mjs — the pipeline-wide sweep
// for untouched warm referral paths that feeds the daily brief's "Warm outreach
// paths" section. All fixtures are fictional (system-layer hygiene).
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNetwork, parsePipeline } from './network-core.mjs'
import { warmOutreachOpportunities } from './warm-outreach-core.mjs'

const TODAY = '2026-07-02'

/* ───── fictional fixtures ───────────────────────────────────────────────────*/

// Roster: 1st-degree ties at Vandelay + Initech, a 2nd-degree at Globex (via a
// bridge), a recruiter at Hooli, and an orphan contact at a non-pipeline company.
const NETWORK_MD = `# Network

| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
|---|------|---------|-------|--------------|--------|-----|--------------|-------|
| 1 | Dana Fox | Vandelay | Head of Strategy | strong | 1 | | 2026-06-01 | ex-colleague |
| 2 | Kim Osei | Globex | Ops Manager | medium | 2 | Dana Fox | | met at conf |
| 3 | Raj Patel | Initech | Data Analyst | medium | 1 | | 2026-05-10 | uni friend |
| 4 | Lee Wong | Hooli | Technical Recruiter | weak | 1 | | | |
| 5 | Ana Ruiz | Wayne Corp | Design Lead | strong | 1 | | | not in pipeline |
`

// Pipeline: applications + scouting rows (shared leading shape).
const APPS_MD = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-20 | Vandelay | Strategy Analyst | 8.7/10 | Applied | ✅ | [1](reports/tier-1/x.md) | |
| 2 | 2026-06-22 | Hooli | Platform Analyst | 7.9/10 | Applied | ✅ | [2](reports/tier-2/y.md) | |
`

const SCOUTING_MD = `| # | Date | Company | Role | Score | Tier | PDF | Deadline | Report | Src | Notes |
|---|------|---------|------|-------|------|-----|----------|--------|-----|-------|
| 1 | 2026-06-25 | Globex | Ops Associate | 7.4/10 | T2 | ❌ | n/d | [1](reports/tier-2/z.md) | scan | |
| 2 | 2026-06-26 | Initech | Data Analyst | 6.9/10 | T3 | ❌ | n/d | [2](reports/tier-3/w.md) | scan | |
`

function world() {
  return {
    contacts: parseNetwork(NETWORK_MD),
    pipeline: parsePipeline(APPS_MD, SCOUTING_MD),
  }
}

// Collapsed outreach-log entries (outreach-cadence collapse() output shape).
function thread(over = {}) {
  return {
    company: 'Vandelay',
    role: 'Strategy Analyst',
    contact: 'Sam Reyes',
    title: 'Recruiter',
    channel: 'Email',
    lastTouch: '2026-07-01',
    touches: 1,
    outcome: '',
    notes: '',
    ...over,
  }
}

/* ───── the sweep ─────────────────────────────────────────────────────────────*/

test('untouched 1st-degree ties become warm-direct; 2nd-degree become warm-intro via the bridge', () => {
  const opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [], today: TODAY })
  const byCompany = Object.fromEntries(opps.map((o) => [o.company, o]))

  const vandelay = byCompany.Vandelay
  assert.equal(vandelay.play, 'warm-direct')
  assert.equal(vandelay.target.name, 'Dana Fox')
  assert.equal(vandelay.topRole.role, 'Strategy Analyst')
  assert.equal(vandelay.topRole.score, 8.7)

  const globex = byCompany.Globex
  assert.equal(globex.play, 'warm-intro')
  assert.equal(globex.target.name, 'Kim Osei')
  assert.equal(globex.target.via, 'Dana Fox')
  assert.match(globex.channel, /Ask Dana Fox for the introduction/)
})

test('opportunities rank highest-value first: role score, then warmth', () => {
  const opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [], today: TODAY })
  const scores = opps.map((o) => o.topRole?.score ?? 0)
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a))
  assert.equal(opps[0].company, 'Vandelay') // 8.7 tops the board
})

test('orphan contacts (company not in the pipeline) are never surfaced', () => {
  const opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [], today: TODAY })
  assert.ok(!opps.some((o) => o.company === 'Wayne Corp'))
})

test('a live/pending thread at a company blocks any parallel first touch there', () => {
  // Sam Reyes was emailed yesterday → thread is `waiting` (on track). Dana Fox
  // is untouched, but the brief must not open a parallel first touch.
  const opps = warmOutreachOpportunities({
    ...world(),
    collapsedContacts: [thread({ lastTouch: '2026-07-01', touches: 1 })],
    today: TODAY,
  })
  assert.ok(!opps.some((o) => o.company === 'Vandelay'))
  assert.ok(opps.some((o) => o.company === 'Globex')) // other companies unaffected
})

test('a company with a due nudge is excluded (the nudge section owns it)', () => {
  // 20 days since the last email, 1 touch → outreach-core classifies `nudge`.
  const opps = warmOutreachOpportunities({
    ...world(),
    collapsedContacts: [thread({ lastTouch: '2026-06-12', touches: 1 })],
    today: TODAY,
  })
  assert.ok(!opps.some((o) => o.company === 'Vandelay'))
})

test('a replied thread is excluded (a conversation, not a brief to-do)', () => {
  const opps = warmOutreachOpportunities({
    ...world(),
    collapsedContacts: [thread({ outcome: 'replied' })],
    today: TODAY,
  })
  assert.ok(!opps.some((o) => o.company === 'Vandelay'))
})

test('exhausted (cold) contacts are never re-suggested; a different untouched person still is', () => {
  // Raj Patel at Initech burned 2 touches with no reply → cold. He is the ONLY
  // mapped contact there → no warm play at Initech at all.
  const initechCold = thread({
    company: 'Initech', contact: 'Raj Patel', title: 'Data Analyst',
    lastTouch: '2026-06-01', touches: 2,
  })
  let opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [initechCold], today: TODAY })
  assert.ok(!opps.some((o) => o.company === 'Initech'))

  // At Vandelay a DIFFERENT person went cold — Dana Fox stays a valid warm-direct
  // target, and the cold contact rides along as a do-not-re-touch caution.
  const vandelayCold = thread({ contact: 'Sam Reyes', lastTouch: '2026-06-01', touches: 2 })
  opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [vandelayCold], today: TODAY })
  const vandelay = opps.find((o) => o.company === 'Vandelay')
  assert.equal(vandelay.target.name, 'Dana Fox')
  assert.match(vandelay.cautions.join(' '), /do not re-touch: Sam Reyes/)
})

test('counts expose how many mapped paths are still untouched', () => {
  const opps = warmOutreachOpportunities({ ...world(), collapsedContacts: [], today: TODAY })
  const vandelay = opps.find((o) => o.company === 'Vandelay')
  assert.deepEqual(vandelay.counts, { paths: 1, untouched: 1 })
})

/* ───── empty world ──────────────────────────────────────────────────────────*/

test('empty roster or empty pipeline → no opportunities, no throw', () => {
  const { contacts, pipeline } = world()
  assert.deepEqual(warmOutreachOpportunities({ contacts: [], pipeline, collapsedContacts: [], today: TODAY }), [])
  assert.deepEqual(warmOutreachOpportunities({ contacts, pipeline: [], collapsedContacts: [], today: TODAY }), [])
  assert.deepEqual(warmOutreachOpportunities(), [])
  assert.deepEqual(warmOutreachOpportunities({}), [])
})
