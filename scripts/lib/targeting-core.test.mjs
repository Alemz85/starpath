// Unit tests for scripts/lib/targeting-core.mjs — the targeting-intelligence
// math that turns data/score-history.tsv into "where is the landscape giving me
// strong matches, and what's dragging the rest down". analyze-patterns.mjs only
// wraps these with file I/O, so this suite is where the logic is pinned:
// archetype label collapsing, defensive TSV parsing (the column-shift bug),
// band boundaries, dimension drag ordering, city extraction, and the
// recommendation gates.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCORE_HISTORY_HEADER } from './profile-core.mjs'
import {
  normalizeArchetype,
  parseScoreHistory,
  parseEligibilityFlags,
  isBlocked,
  isScored,
  scoredRows,
  DIMENSIONS,
  archetypePerformance,
  dimensionDrag,
  landscapeSummary,
  eligibilityBreakdown,
  cityExposure,
  targetingRecommendations,
  analyzeScouting,
} from './targeting-core.mjs'
import { historyTsv, historyRow } from './testing/score-history-fixture.mjs'

const tsv = (...rows) => historyTsv(...rows)

// Fixture archetypes for verdict cells (default weights, green):
//   GO      Match 8.5,  Ease 8.0   → go
//   SOLID   Match 7.0,  Ease 7.0   → solid
//   SKIP    Match 4.75…            → skip
const GO = { growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 8, best_cities: 8, skills_match: 8, experience_bar: 8, competition: 8 }
const SOLID = { growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7, best_cities: 7, skills_match: 7, experience_bar: 7, competition: 7 }
const SKIP = { growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 4, skills_match: 7, experience_bar: 7, competition: 7 }
const RED = { eligibility: 'red', eligibility_flags: 'language:red:German C1 required' }

// ─── parseScoreHistory ────────────────────────────────────────────────────────

test('parseScoreHistory reads the v2 header + numeric coercion', () => {
  const rows = parseScoreHistory(tsv({ ...GO, company: 'Northwind Analytics' }))
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.skills_match, 8)
  assert.equal(r.match, 8.5) // M 8.25 + City hygiene +0.25
  assert.equal(typeof r.ease, 'number')
  assert.equal(r.verdict, 'go')
  assert.equal(r.tier, 'T1')
  assert.equal(r.eligibility, 'green')
  assert.deepEqual(r.eligibilityFlags, [])
  assert.equal(r.blocked, false)
  assert.equal(r.company, 'Northwind Analytics')
})

test('parseScoreHistory: Blocked rows have NaN scores, never 0', () => {
  const [r] = parseScoreHistory(tsv(RED))
  assert.equal(r.blocked, true)
  assert.equal(r.verdict, 'blocked')
  assert.ok(Number.isNaN(r.match))
  assert.ok(Number.isNaN(r.ease))
  assert.ok(Number.isNaN(r.priority))
  assert.ok(Number.isNaN(r.skills_match))
  assert.deepEqual(r.eligibilityFlags, [{ check: 'language', status: 'red', reason: 'German C1 required' }])
  assert.equal(isBlocked(r), true)
  assert.equal(isScored(r), false)
})

test('parseScoreHistory derives a missing verdict/priority from match + ease', () => {
  const line = historyRow({ ...SOLID }).split('\t')
  const cols = tsv().split('\n')[0].split('\t')
  line[cols.indexOf('verdict')] = ''
  line[cols.indexOf('priority')] = ''
  line[cols.indexOf('tier')] = ''
  const [r] = parseScoreHistory(tsv(line.join('\t')))
  assert.equal(r.verdict, 'solid')
  assert.equal(r.tier, 'T2')
  assert.equal(r.priority, 7)
})

test('parseScoreHistory normalizes archetype on parse', () => {
  const rows = parseScoreHistory(tsv({ archetype: 'Business/Data Analyst' }))
  assert.equal(rows[0].archetype, 'Business / Data Analyst')
})

test('parseScoreHistory skips blank lines', () => {
  const text = tsv({}) + '\n\n   \n'
  assert.equal(parseScoreHistory(text).length, 1)
})

test('parseScoreHistory coerces garbage numerics to NaN', () => {
  const line = historyRow({}).split('\t')
  line[tsv().split('\n')[0].split('\t').indexOf('match')] = 'abc'
  const rows = parseScoreHistory(tsv(line.join('\t')))
  assert.ok(Number.isNaN(rows[0].match))
  assert.equal(isScored(rows[0]), false)
})

test('parseScoreHistory returns [] on empty input', () => {
  assert.deepEqual(parseScoreHistory(''), [])
  assert.deepEqual(parseScoreHistory(null), [])
})

test('parseEligibilityFlags keeps colons inside reasons', () => {
  assert.deepEqual(parseEligibilityFlags('start_date:amber:start not stated;other:amber:STEM: required'), [
    { check: 'start_date', status: 'amber', reason: 'start not stated' },
    { check: 'other', status: 'amber', reason: 'STEM: required' },
  ])
  assert.deepEqual(parseEligibilityFlags(''), [])
})

test('DIMENSIONS lists the ten v2 dimensions with their rollup group', () => {
  assert.equal(DIMENSIONS.length, 10)
  const keys = DIMENSIONS.map(d => d.key)
  assert.ok(keys.includes('role_content'))
  assert.ok(keys.includes('experience_bar'))
  assert.ok(!keys.includes('ease_of_entry'))
  assert.equal(DIMENSIONS.find(d => d.key === 'competition').rollup, 'ease')
  assert.equal(DIMENSIONS.find(d => d.key === 'best_cities').group, 'hygiene')
})

// ─── archetypePerformance ─────────────────────────────────────────────────────

test('archetypePerformance aggregates Match/Ease/verdicts, sorts by actionable rate', () => {
  const rows = parseScoreHistory(tsv(
    { ...GO, archetype: 'Strategy' },
    { ...SOLID, archetype: 'Strategy' },
    { ...SKIP, archetype: 'Sales' },
    { ...SOLID, archetype: 'Sales' },
    { ...RED, archetype: 'Sales' },
  ))
  const perf = archetypePerformance(rows)
  assert.equal(perf[0].archetype, 'Strategy')
  assert.equal(perf[0].count, 2)
  assert.equal(perf[0].actionableRate, 100)
  assert.equal(perf[0].verdicts.go, 1)
  assert.equal(perf[0].verdicts.solid, 1)
  assert.equal(perf[0].avgMatch, 7.75)
  const sales = perf.find(p => p.archetype === 'Sales')
  assert.equal(sales.count, 2, 'blocked row is not a scored role')
  assert.equal(sales.blocked, 1)
  assert.equal(sales.actionableRate, 50)
  assert.equal(sales.share, 50)
})

test('archetypePerformance merges spacing variants into one bucket', () => {
  const rows = parseScoreHistory(tsv(
    { archetype: 'Business/Data Analyst' },
    { archetype: 'Business / Data Analyst' },
  ))
  const perf = archetypePerformance(rows)
  assert.equal(perf.length, 1)
  assert.equal(perf[0].count, 2)
})

// ─── dimensionDrag ────────────────────────────────────────────────────────────

test('dimensionDrag surfaces the weakest dimension first and ignores blocked rows', () => {
  const rows = parseScoreHistory(tsv(
    { experience_bar: 3 }, { experience_bar: 4 }, { experience_bar: 5 }, RED,
  ))
  const drag = dimensionDrag(rows)
  assert.equal(drag[0].key, 'experience_bar')
  assert.equal(drag[0].count, 3)
  assert.equal(drag[0].avg, 4)
  assert.equal(drag[0].rollup, 'ease')
  assert.equal(drag[0].lowShare, 67)
})

// ─── landscapeSummary ─────────────────────────────────────────────────────────

test('landscapeSummary computes verdict mix, actionable and wasted shares', () => {
  const rows = parseScoreHistory(tsv(GO, SOLID, SKIP, SKIP, RED))
  const land = landscapeSummary(rows)
  assert.equal(land.evaluated, 4)
  assert.equal(land.blocked, 1)
  assert.equal(land.verdicts.go, 1)
  assert.equal(land.verdicts.solid, 1)
  assert.equal(land.verdicts.skip, 2)
  assert.equal(land.actionableShare, 50)
  assert.equal(land.wastedShare, 50)
  assert.equal(land.blockedShare, 20)
  assert.ok(!('bands' in land))
  assert.ok(!('avgOverall' in land))
})

// ─── eligibilityBreakdown ─────────────────────────────────────────────────────

test('eligibilityBreakdown counts blocked rows and shares per check', () => {
  const rows = parseScoreHistory(tsv(
    GO,
    { ...SOLID, eligibility: 'amber', eligibility_flags: 'start_date:amber:start not stated' },
    { ...SOLID, eligibility: 'amber', eligibility_flags: 'start_date:amber:start not stated;duration:amber:not stated' },
    RED,
    { ...RED, eligibility_flags: 'work_auth:red:no sponsorship' },
  ))
  const e = eligibilityBreakdown(rows)
  assert.equal(e.total, 5)
  assert.deepEqual(e.status, { green: 1, amber: 2, red: 2, unknown: 0 })
  assert.equal(e.redShare, 40)
  assert.equal(e.amberShare, 40)
  const start = e.byCheck.find(c => c.check === 'start_date')
  assert.equal(start.amber, 2)
  assert.equal(start.amberShare, 40)
  assert.equal(start.topReasons[0].reason, 'start not stated')
  assert.equal(e.byCheck.find(c => c.check === 'language').red, 1)
  assert.equal(e.byCheck.find(c => c.check === 'work_auth').redShare, 20)
})

// ─── cityExposure ─────────────────────────────────────────────────────────────

test('cityExposure tallies cities from actionable roles only', () => {
  const rows = parseScoreHistory(tsv(
    { ...GO, location: 'Lisbon' },
    { ...SOLID, location: 'Lisbon PT' },
    { ...SOLID, location: 'Porto' },
    { ...SKIP, location: 'Faro' },
    { ...RED, location: 'Faro' },
  ))
  const cities = cityExposure(rows)
  assert.deepEqual(cities, [{ city: 'Lisbon', count: 2 }, { city: 'Porto', count: 1 }])
})

test('cityExposure rejects numeric / n/d / remote noise', () => {
  const rows = parseScoreHistory(tsv(
    { ...GO, location: 'n/d' },
    { ...GO, location: '10.0' },
    { ...GO, location: 'Remote' },
  ))
  assert.deepEqual(cityExposure(rows), [])
})

// ─── targetingRecommendations ─────────────────────────────────────────────────

test('targetingRecommendations only fires "lean into" when archetype has enough roles', () => {
  const few = parseScoreHistory(tsv({ ...GO, archetype: 'Strategy' }, { ...GO, archetype: 'Strategy' }))
  assert.ok(!targetingRecommendations(few).some(r => /Lean into/.test(r.action)))
  const many = parseScoreHistory(tsv(...Array.from({ length: 4 }, () => ({ ...GO, archetype: 'Strategy' }))))
  const recs = targetingRecommendations(many)
  assert.ok(recs.some(r => /Lean into "Strategy"/.test(r.action) && /100% go\/stretch\/solid/.test(r.action)))
})

test('targetingRecommendations pulls back on a skip-heavy archetype', () => {
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 4 }, () => ({ ...GO, archetype: 'Strategy' })),
    ...Array.from({ length: 4 }, () => ({ ...SKIP, archetype: 'Sales' })),
  ))
  assert.ok(targetingRecommendations(rows).some(r => /Pull back on "Sales"/.test(r.action)))
})

test('targetingRecommendations flags a systemic dimension drag', () => {
  const rows = parseScoreHistory(tsv(...Array.from({ length: 5 }, () => ({ experience_bar: 3 }))))
  const rec = targetingRecommendations(rows).find(r => /Experience bar/.test(r.action))
  assert.ok(rec)
  assert.match(rec.reasoning, /Ease/)
})

test('targetingRecommendations warns when too much effort lands in Skip', () => {
  const rows = parseScoreHistory(tsv(SKIP, SKIP, GO, SOLID))
  assert.ok(targetingRecommendations(rows).some(r => /50% of scored evaluations land in Skip/.test(r.action)))
})

test('targetingRecommendations flags an eligibility check that blocks many listings', () => {
  const rows = parseScoreHistory(tsv(GO, SOLID, RED, RED, RED, RED))
  const rec = targetingRecommendations(rows).find(r => /"language" blocks/.test(r.action))
  assert.ok(rec)
  assert.match(rec.action, /67% of listings \(4 of 6\)/)
})

// ─── analyzeScouting ──────────────────────────────────────────────────────────

test('analyzeScouting returns a structured analysis object', () => {
  const rows = parseScoreHistory(tsv(GO, SOLID, RED))
  const out = analyzeScouting(rows)
  assert.equal(out.metadata.evaluated, 2)
  assert.equal(out.metadata.blocked, 1)
  assert.equal(out.metadata.total, 3)
  for (const k of ['landscape', 'archetypePerformance', 'dimensionDrag', 'eligibility', 'cityExposure', 'recommendations']) {
    assert.ok(k in out, k)
  }
})

test('analyzeScouting errors on empty or score-less input, keeping eligibility', () => {
  assert.ok(analyzeScouting([]).error)
  const onlyBlocked = analyzeScouting(parseScoreHistory(tsv(RED)))
  assert.ok(onlyBlocked.error)
  assert.equal(onlyBlocked.eligibility.status.red, 1)
  assert.equal(scoredRows(parseScoreHistory(tsv(RED))).length, 0)
})

test('parseScoreHistory reads a pre-rename `want` column as match', () => {
  const header = SCORE_HISTORY_HEADER.replace('\tmatch\t', '\twant\t')
  const cols = header.split('\t')
  const row = cols.map((c) => ({ date: '2026-10-01', archetype: 'Analyst', want: '8.5', ease: '7', company: 'Nimbus Robotics', role: 'Analyst', eligibility: 'green' }[c] ?? '')).join('\t')
  const [r] = parseScoreHistory(`${header}\n${row}\n`)
  assert.equal(r.match, 8.5)
})
