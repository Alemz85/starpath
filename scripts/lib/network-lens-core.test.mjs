// Unit tests for scripts/lib/network-lens-core.mjs — the whole-network overview
// the desktop app's Network tab renders. All fixtures are fictional
// (system-layer hygiene).
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNetworkOverview } from './network-lens-core.mjs'

const TODAY = '2026-07-01'

/* ───── fictional fixtures ───────────────────────────────────────────────────*/

// Roster: a strong 1st-degree peer + a recruiter at Helios, a 2nd-degree
// manager at Northwind (via the Helios peer), and an orphan contact at a
// company nowhere in the pipeline.
const NETWORK_MD = `# Network

| # | Name | Company | Title | Relationship | Degree | Via | Last Contact | Notes |
|---|------|---------|-------|--------------|--------|-----|--------------|-------|
| 1 | Ada Vega | Helios Analytics | Senior Strategy Analyst | strong | 1 | | 2026-05-20 | ex-colleague |
| 2 | Bo Lindt | Helios Analytics | Talent Partner | medium | 1 | | n/d | |
| 3 | Cy Moreau | Northwind Labs | Head of Strategy | medium | 2 | Ada Vega | 2026-04-02 | |
| 4 | Di Okafor | Quasar Systems | Product Manager | weak | 1 | | | met at meetup |
`

const APPS_MD = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Helios Analytics | Strategy Analyst | 8.4/10 | Applied | ✅ | [1](reports/tier-1/x.md) | |
`

const SCOUTING_MD = `| # | Date | Company | Role | Score | Tier | PDF | Deadline | Report | Src | Notes |
|---|------|---------|------|-------|------|-----|----------|--------|-----|-------|
| 1 | 2026-06-10 | Northwind Labs | Strategy Associate | 7.8/10 | T2 | ❌ | n/d | [1](reports/tier-2/y.md) | scan | |
| 2 | 2026-06-12 | Zephyr Group | Strategy Consultant | 9.1/10 | T1 | ❌ | n/d | [2](reports/tier-1/z.md) | scan | |
| 3 | 2026-06-14 | Umbra Partners | Junior Analyst | 5.2/10 | T3 | ❌ | n/d | [3](reports/tier-3/w.md) | scan | |
`

// One overdue message thread with the Helios recruiter (30 days > 5-day
// message_first window → nudge due).
const OUTREACH_MD = `# Outreach

| # | Date | Company | Role | Contact | Title | Channel | Touch | Outcome | Notes |
|---|------|---------|------|---------|-------|---------|-------|---------|-------|
| 1 | 2026-06-01 | Helios Analytics | Strategy Analyst | Bo Lindt | Recruiter | Message | 1 | Pending | first touch |
`

function overview(over = {}) {
  return buildNetworkOverview({
    networkRaw: NETWORK_MD,
    applicationsRaw: APPS_MD,
    scoutingRaw: SCOUTING_MD,
    outreachRaw: OUTREACH_MD,
    today: TODAY,
    ...over,
  })
}

/* ───── empty world ──────────────────────────────────────────────────────────*/

test('all-null inputs produce an empty, well-shaped overview (no throw)', () => {
  const o = buildNetworkOverview({ today: TODAY })
  assert.deepEqual(o.roster, [])
  assert.deepEqual(o.companies, [])
  assert.deepEqual(o.gaps, [])
  assert.deepEqual(o.latentLeads, [])
  assert.deepEqual(o.threads, [])
  assert.deepEqual(o.counts, {
    contacts: 0, pipelineTargets: 0, companiesWithPath: 0,
    gaps: 0, latentLeads: 0, threads: 0, dueNudges: 0,
  })
})

test('malformed / non-table content degrades to empty layers, never throws', () => {
  const o = buildNetworkOverview({
    networkRaw: 'not a table\n| broken | row\n||||',
    applicationsRaw: '## heading only',
    scoutingRaw: '| # | half a header',
    outreachRaw: '|||||\ngarbage',
    today: TODAY,
  })
  assert.equal(o.roster.length, 0)
  assert.equal(o.companies.length, 0)
  assert.equal(o.threads.length, 0)
})

test('empty roster still classifies outreach threads', () => {
  const o = overview({ networkRaw: null })
  assert.equal(o.roster.length, 0)
  assert.equal(o.companies.length, 0)
  assert.equal(o.threads.length, 1)
  assert.equal(o.threads[0].action, 'nudge')
  assert.equal(o.counts.dueNudges, 1)
})

/* ───── populated world ──────────────────────────────────────────────────────*/

test('roster parses every valid contact', () => {
  const o = overview()
  assert.equal(o.roster.length, 4)
  assert.deepEqual(o.roster.map(c => c.name), ['Ada Vega', 'Bo Lindt', 'Cy Moreau', 'Di Okafor'])
  assert.equal(o.counts.contacts, 4)
})

test('companies carry the decision-ladder play — due nudge outranks warm paths', () => {
  const o = overview()
  assert.equal(o.companies.length, 2)

  // Helios: Bo's thread is 30 days stale → nudge is the play (ladder step 2
  // beats the untouched Ada path, which surfaces as a caution instead).
  const helios = o.companies[0]
  assert.equal(helios.company, 'Helios Analytics')
  assert.equal(helios.play, 'nudge')
  assert.equal(helios.target.name, 'Bo Lindt')
  assert.equal(helios.topRole.role, 'Strategy Analyst')
  assert.equal(helios.topRole.score, 8.4)
  assert.equal(helios.counts.paths, 2)
  assert.equal(helios.counts.untouched, 1) // Ada untouched; Bo has the thread
  assert.ok(helios.cautions.some(c => c.includes('Ada Vega')))

  // Northwind: untouched 2nd-degree Cy → warm-intro via the bridge.
  const northwind = o.companies[1]
  assert.equal(northwind.company, 'Northwind Labs')
  assert.equal(northwind.play, 'warm-intro')
  assert.equal(northwind.target.name, 'Cy Moreau')
  assert.equal(northwind.target.via, 'Ada Vega')
})

test('paths are annotated with their thread state', () => {
  const helios = overview().companies[0]
  const bo = helios.paths.find(p => p.name === 'Bo Lindt')
  const ada = helios.paths.find(p => p.name === 'Ada Vega')
  assert.equal(bo.thread.action, 'nudge')
  assert.equal(ada.thread, null)
  assert.ok(ada.warmth > bo.warmth) // strong direct peer beats medium recruiter
})

test('a fresh (on-track) thread flips the play to the untouched warm path', () => {
  const fresh = OUTREACH_MD.replace('2026-06-01 | Helios', '2026-06-29 | Helios')
  const o = overview({ outreachRaw: fresh })
  const helios = o.companies.find(c => c.company === 'Helios Analytics')
  assert.equal(helios.play, 'warm-direct') // Ada, 1st-degree untouched
  assert.equal(helios.target.name, 'Ada Vega')
  // The in-flight Bo thread must be flagged so the asks get coordinated.
  assert.ok(helios.cautions.some(c => c.includes('Bo Lindt')))
  assert.equal(o.counts.dueNudges, 0)
})

test('gaps are the pipeline companies with no contact, best score first', () => {
  const o = overview()
  assert.deepEqual(o.gaps.map(g => g.company), ['Zephyr Group', 'Umbra Partners'])
  assert.equal(o.gaps[0].topScore, 9.1)
  assert.equal(o.counts.gaps, 2)
})

test('latent leads are contacts at companies outside the pipeline', () => {
  const o = overview()
  assert.equal(o.latentLeads.length, 1)
  assert.equal(o.latentLeads[0].name, 'Di Okafor')
  assert.equal(o.latentLeads[0].company, 'Quasar Systems')
})

test('threads strip is cadence-classified and JSON-slim', () => {
  const t = overview().threads[0]
  assert.equal(t.company, 'Helios Analytics')
  assert.equal(t.contact, 'Bo Lindt')
  assert.equal(t.action, 'nudge')
  assert.equal(t.daysSince, 30)
  assert.equal(t.touches, 1)
  assert.ok(t.reason.length > 0)
})

test('overview is JSON-serializable (safe across the IPC boundary)', () => {
  const o = overview()
  const roundTripped = JSON.parse(JSON.stringify(o))
  assert.deepEqual(roundTripped, o)
})
