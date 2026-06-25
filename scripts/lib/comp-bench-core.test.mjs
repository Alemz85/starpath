// Unit tests for scripts/lib/comp-bench-core.mjs — the compensation-benchmarking
// engine over the user's own evaluated landscape.
//
// The load-bearing, most-likely-to-regress logic is the free-text salary parser
// (parseSalary), so it gets the heaviest coverage — exercised against every real
// `salary_raw` form observed in score-history.tsv plus the forms it must REFUSE
// to guess at. Then: target-string parsing, per-archetype/per-city grouping on
// the savings-power proxy, target-vs-landscape drift in all three directions,
// the comp-floor scan, and the top-level bundle's empty/error path.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GBP_TO_EUR,
  parseSalary,
  parseCompTarget,
  cleanCity,
  enrichRows,
  benchmarkByArchetype,
  benchmarkByCity,
  employmentBucket,
  targetDrift,
  fmtK,
  compFloorRisks,
  compRecommendations,
  benchmarkComp,
} from './comp-bench-core.mjs'

/* ───── parseSalary: monthly EUR stipends ──────────────────────────────────── */

test('parseSalary annualizes a plain monthly EUR stipend (×12)', () => {
  const r = parseSalary('€750/mo')
  assert.equal(r.currency, 'EUR')
  assert.equal(r.period, 'month')
  assert.equal(r.annualEur, 9000) // 750 × 12
  assert.equal(r.isRange, false)
  assert.equal(r.fxApplied, false)
})

test('parseSalary handles comma thousands in a monthly figure', () => {
  const r = parseSalary('€1,600/mo')
  assert.equal(r.annualEur, 19200) // 1600 × 12
  assert.equal(r.period, 'month')
})

test('parseSalary handles €2,300/mo', () => {
  assert.equal(parseSalary('€2,300/mo').annualEur, 27600)
})

/* ───── parseSalary: K-scaled monthly range ────────────────────────────────── */

test('parseSalary expands "€2.2-3.3K/mo" — trailing K scales BOTH ends, ×12', () => {
  const r = parseSalary('€2.2-3.3K/mo')
  assert.equal(r.isRange, true)
  assert.equal(r.annualEurLow, 26400)  // 2200 × 12
  assert.equal(r.annualEurHigh, 39600) // 3300 × 12
  assert.equal(r.annualEur, 33000)     // midpoint
})

/* ───── parseSalary: annual GBP, with FX + bonus ───────────────────────────── */

test('parseSalary reads "£42K + 10% bonus" — GBP→EUR, bonus captured, base only in annualEur', () => {
  const r = parseSalary('£42K + 10% bonus')
  assert.equal(r.currency, 'GBP')
  assert.equal(r.period, 'year')
  assert.equal(r.fxApplied, true)
  assert.equal(r.bonusPct, 0.1)
  // 42000 × 1.17 = 49140 — the 10 from "10%" must NOT be read as a salary token.
  assert.equal(r.annualEur, Math.round(42000 * DEFAULT_GBP_TO_EUR))
  assert.equal(r.isRange, false)
})

test('parseSalary reads a GBP annual range "£40-65K London disclosed" and ignores trailing noise', () => {
  const r = parseSalary('£40-65K London disclosed')
  assert.equal(r.isRange, true)
  assert.equal(r.annualEurLow, Math.round(40000 * DEFAULT_GBP_TO_EUR))
  assert.equal(r.annualEurHigh, Math.round(65000 * DEFAULT_GBP_TO_EUR))
})

test('parseSalary honors an overridden gbpToEur rate', () => {
  const r = parseSalary('£40K', { gbpToEur: 1.0 })
  assert.equal(r.annualEur, 40000)
})

/* ───── parseSalary: refusals (never guess) ────────────────────────────────── */

for (const bad of [
  'undisclosed',
  'undisclosed (intern)',
  'undisclosed (Google EMEA)',
  'not disclosed',
  'competitive',
  'hourly (undisclosed)',
  'n/d',
  'n/a',
  '',
  '   ',
  null,
  undefined,
]) {
  test(`parseSalary refuses to invent a figure for ${JSON.stringify(bad)}`, () => {
    assert.equal(parseSalary(bad), null)
  })
}

test('parseSalary refuses USD (no silent USD→EUR)', () => {
  assert.equal(parseSalary('$90K'), null)
  assert.equal(parseSalary('90K USD'), null)
})

test('parseSalary refuses a bare unitless number (no currency symbol)', () => {
  // "40-65" with no €/£ could be anything — must not be read as euros.
  assert.equal(parseSalary('40-65'), null)
})

/* ───── parseCompTarget ─────────────────────────────────────────────────────── */

test('parseCompTarget parses a €K range + floor from profile.yml strings', () => {
  const t = parseCompTarget({ target_range: '€30K-55K', minimum: '€15K' })
  assert.equal(t.targetLow, 30000)
  assert.equal(t.targetHigh, 55000)
  assert.equal(t.floor, 15000)
})

test('parseCompTarget swaps an inverted range', () => {
  const t = parseCompTarget({ target_range: '€55K-30K' })
  assert.equal(t.targetLow, 30000)
  assert.equal(t.targetHigh, 55000)
})

test('parseCompTarget tolerates an en-dash and explicit thousands', () => {
  const t = parseCompTarget({ target_range: '€25,000–40,000' })
  assert.equal(t.targetLow, 25000)
  assert.equal(t.targetHigh, 40000)
})

test('parseCompTarget yields nulls for an absent block', () => {
  const t = parseCompTarget({})
  assert.equal(t.targetLow, null)
  assert.equal(t.targetHigh, null)
  assert.equal(t.floor, null)
})

test('parseCompTarget converts a GBP-stated target to EUR', () => {
  const t = parseCompTarget({ target_range: '£30K-50K' }, { gbpToEur: 1.0 })
  assert.equal(t.targetLow, 30000)
  assert.equal(t.targetHigh, 50000)
})

/* ───── cleanCity ───────────────────────────────────────────────────────────── */

test('cleanCity strips country code, picks first of a list, drops n/d & remote', () => {
  assert.equal(cleanCity('Madrid ES'), 'Madrid')
  assert.equal(cleanCity('London, UK'), 'London')
  assert.equal(cleanCity('Dublin / Amsterdam'), 'Dublin')
  assert.equal(cleanCity('n/d'), '')
  assert.equal(cleanCity('Remote (EU)'), '')
})

test('cleanCity collapses a multi-hub blob to its first parenthesized city', () => {
  assert.equal(
    cleanCity('Multi-hub (London/Madrid/Kraków/Lisbon)'),
    'London',
  )
})

test('cleanCity rejects a leaked numeric score (column-shift guard)', () => {
  // best_cities can leak a bare savings-power score when TSV columns shift —
  // "6" / "10.0" must never be treated as a city.
  assert.equal(cleanCity('6'), '')
  assert.equal(cleanCity('10.0'), '')
})

/* ───── Fixture: a small synthetic landscape exercising the aggregators ─────── */

// Deliberately fictional companies/roles — system-layer hygiene: this fixture
// exercises the rubric, it does not encode any real user's targets.
function fixtureRows() {
  return [
    // Data Analyst: two FT, decent savings-power, one with a disclosed FT salary.
    { archetype: 'Data Analyst', salary_adj_city: 7, overall: 7.0, employment_type: 'full-time', location: 'Dublin', best_cities: 'Dublin', salary_raw: '€42K', date: '2026-01-01' },
    { archetype: 'Data Analyst', salary_adj_city: 8, overall: 7.5, employment_type: 'full-time', location: 'Dublin', best_cities: 'Dublin', salary_raw: '€48K', date: '2026-01-02' },
    { archetype: 'Data Analyst', salary_adj_city: 6, overall: 6.5, employment_type: 'internship', location: 'Dublin', best_cities: 'Dublin', salary_raw: '€1,600/mo', date: '2026-01-03' },
    // Strategy & Operations: weak savings-power, two comp-floor non-intern roles.
    { archetype: 'Strategy & Operations', salary_adj_city: 3, overall: 6.0, employment_type: 'full-time', location: 'Barcelona', best_cities: 'Barcelona', salary_raw: 'undisclosed', date: '2026-01-04' },
    { archetype: 'Strategy & Operations', salary_adj_city: 4, overall: 6.2, employment_type: 'full-time', location: 'Barcelona', best_cities: 'Barcelona', salary_raw: 'n/d', date: '2026-01-05' },
    { archetype: 'Strategy & Operations', salary_adj_city: 3, overall: 5.8, employment_type: 'internship', location: 'Barcelona', best_cities: 'Barcelona', salary_raw: '€750/mo', date: '2026-01-06' },
  ]
}

test('enrichRows attaches a parsed disclosed salary and a clean city', () => {
  const e = enrichRows(fixtureRows())
  assert.equal(e[0].city, 'Dublin')
  assert.equal(e[0].disclosed.annualEur, 42000)
  // "undisclosed" / "n/d" rows get a null anchor, not a fabricated one.
  assert.equal(e[3].disclosed, null)
  assert.equal(e[4].disclosed, null)
})

test('benchmarkByArchetype ranks by median savings-power and surfaces anchors', () => {
  const e = enrichRows(fixtureRows())
  const out = benchmarkByArchetype(e, { minRoles: 3 })
  assert.equal(out.length, 2)
  // Data Analyst (adj 6,7,8 → median 7) beats S&O (adj 3,3,4 → median 3).
  assert.equal(out[0].label, 'Data Analyst')
  assert.equal(out[0].adjMedian, 7)
  assert.equal(out[1].label, 'Strategy & Operations')
  assert.equal(out[1].adjMedian, 3)
  // S&O: all 3 rows at adj ≤ 4 (3, 4, 3) → 100% comp-weak.
  assert.equal(out[1].compWeakShare, 100)
  // Data Analyst has 2 disclosed FT anchors (€42K, €48K) + 1 intern anchor.
  assert.equal(out[0].anchorCount, 3)
})

test('benchmarkByArchetype drops sub-minRoles groups', () => {
  const rows = [
    { archetype: 'X', salary_adj_city: 5, overall: 6, employment_type: 'full-time', location: 'Milan', salary_raw: 'n/d' },
    { archetype: 'X', salary_adj_city: 6, overall: 6, employment_type: 'full-time', location: 'Milan', salary_raw: 'n/d' },
  ]
  assert.equal(benchmarkByArchetype(enrichRows(rows), { minRoles: 3 }).length, 0)
})

test('benchmarkByCity groups by clean city and skips cityless rows', () => {
  const rows = [
    ...fixtureRows(),
    { archetype: 'Data Analyst', salary_adj_city: 9, overall: 8, employment_type: 'full-time', location: 'Remote', best_cities: 'n/d', salary_raw: 'n/d' },
  ]
  const out = benchmarkByCity(enrichRows(rows), { minRoles: 3 })
  const cities = out.map((c) => c.label)
  assert.ok(cities.includes('Dublin'))
  assert.ok(cities.includes('Barcelona'))
  assert.ok(!cities.includes('Remote')) // the remote/n-d row contributes no city
})

/* ───── employmentBucket ────────────────────────────────────────────────────── */

test('employmentBucket classifies the real employment_type values', () => {
  assert.equal(employmentBucket('internship'), 'intern')
  assert.equal(employmentBucket('working-student'), 'intern')
  assert.equal(employmentBucket('trainee'), 'intern')
  assert.equal(employmentBucket('full-time'), 'fulltime')
  assert.equal(employmentBucket('graduate-program'), 'fulltime')
  assert.equal(employmentBucket('contract'), 'fulltime')
  assert.equal(employmentBucket(''), 'other')
})

/* ───── targetDrift: all three verdicts ────────────────────────────────────── */

test('targetDrift flags target-above-landscape when the floor exceeds disclosed FT median', () => {
  // FT anchors €42K & €48K → median €45K; target floor €60K is above it.
  const e = enrichRows(fixtureRows())
  const target = parseCompTarget({ target_range: '€60K-80K' })
  const { drift, byType } = targetDrift(e, target)
  assert.equal(byType.fulltime.count, 2)
  assert.equal(byType.fulltime.medianEur, 45000)
  assert.equal(drift.verdict, 'target-above-landscape')
  assert.equal(drift.deltaEur, 15000) // 60K − 45K
})

test('targetDrift flags target-below-landscape when disclosed FT median exceeds the ceiling', () => {
  const e = enrichRows(fixtureRows())
  const target = parseCompTarget({ target_range: '€20K-30K' })
  const { drift } = targetDrift(e, target)
  assert.equal(drift.verdict, 'target-below-landscape')
  assert.equal(drift.deltaEur, 15000) // 45K − 30K
})

test('targetDrift reports aligned when the band brackets the disclosed FT median', () => {
  const e = enrichRows(fixtureRows())
  const target = parseCompTarget({ target_range: '€40K-50K' })
  const { drift } = targetDrift(e, target)
  assert.equal(drift.verdict, 'aligned')
  assert.equal(drift.deltaEur, 0)
})

test('targetDrift returns null drift with too few FT anchors', () => {
  const rows = [
    { archetype: 'X', salary_adj_city: 7, overall: 7, employment_type: 'full-time', location: 'Dublin', salary_raw: '€42K' },
    { archetype: 'X', salary_adj_city: 6, overall: 6, employment_type: 'internship', location: 'Dublin', salary_raw: '€1,600/mo' },
  ]
  const { drift, anchorsTotal } = targetDrift(enrichRows(rows), parseCompTarget({ target_range: '€30K-55K' }))
  assert.equal(anchorsTotal, 2)   // both anchors counted
  assert.equal(drift, null)        // but only 1 is FT → no honest verdict
})

test('targetDrift keeps intern stipends OUT of the FT verdict basis', () => {
  // The €750/mo (=€9K) intern stipend must not drag the FT median down.
  const e = enrichRows(fixtureRows())
  const { byType } = targetDrift(e, parseCompTarget({ target_range: '€40K-50K' }))
  assert.equal(byType.fulltime.medianEur, 45000) // €42K/€48K only
  // Two intern stipends in the fixture: €1,600/mo (=€19.2K) and €750/mo (=€9K).
  assert.equal(byType.intern.count, 2)
  assert.equal(byType.intern.medianEur, 14100) // median(9000, 19200)
})

/* ───── fmtK ────────────────────────────────────────────────────────────────── */

test('fmtK formats annual EUR compactly and handles nullish', () => {
  assert.equal(fmtK(42000), '42K')
  assert.equal(fmtK(9500), '9.5K')
  assert.equal(fmtK(null), '—')
  assert.equal(fmtK(NaN), '—')
})

/* ───── compFloorRisks ──────────────────────────────────────────────────────── */

test('compFloorRisks surfaces only NON-intern roles at savings-power ≤ 4', () => {
  const risks = compFloorRisks(enrichRows(fixtureRows()))
  // The two S&O FT roles (adj 3 & 4) qualify; the adj-3 INTERN does not.
  assert.equal(risks.length, 2)
  assert.ok(risks.every((r) => r.archetype === 'Strategy & Operations'))
  assert.ok(risks.every((r) => r.salaryAdj <= 4))
  // Sorted weakest comp first.
  assert.equal(risks[0].salaryAdj, 3)
})

/* ───── compRecommendations ─────────────────────────────────────────────────── */

test('compRecommendations emits the headline drift rec + thin-sample caveat', () => {
  const e = enrichRows(fixtureRows())
  const target = parseCompTarget({ target_range: '€60K-80K' })
  const drift = targetDrift(e, target)
  const archetypes = benchmarkByArchetype(e, { minRoles: 3 })
  const cities = benchmarkByCity(e, { minRoles: 3 })
  const floorRisks = compFloorRisks(e)
  const recs = compRecommendations({ archetypes, cities, drift, floorRisks })
  assert.ok(recs.some((r) => /Reconcile your comp floor/.test(r.action)))
  assert.ok(recs.some((r) => r.impact === 'high'))
  // Only 3 disclosed anchors in the fixture → thin-sample caveat fires.
  assert.ok(recs.some((r) => /sample is thin/.test(r.action)))
})

/* ───── benchmarkComp: top-level bundle ─────────────────────────────────────── */

test('benchmarkComp returns an error object for an empty landscape', () => {
  const out = benchmarkComp([], { target_range: '€30K-55K' })
  assert.ok(out.error)
  assert.match(out.error, /No scored evaluations/)
})

test('benchmarkComp assembles a full bundle from a real-shaped landscape', () => {
  const out = benchmarkComp(fixtureRows(), { target_range: '€60K-80K', minimum: '€15K' }, { minRoles: 3 })
  assert.equal(out.metadata.evaluated, 6)
  assert.equal(out.metadata.withSalaryAdj, 6)
  assert.equal(out.metadata.disclosedAnchors, 4) // €42K, €48K, €1,600/mo, €750/mo
  assert.equal(out.metadata.gbpToEur, DEFAULT_GBP_TO_EUR)
  // Landscape median savings-power across [7,8,6,3,4,3] = 5.
  assert.equal(out.landscape.adjMedian, 5)
  assert.equal(out.byArchetype.length, 2)
  assert.equal(out.drift.drift.verdict, 'target-above-landscape')
  assert.ok(out.recommendations.length >= 1)
  assert.equal(out.target.floor, 15000)
})

test('benchmarkComp threads a custom gbpToEur through to anchors', () => {
  const rows = [
    { archetype: 'Data Analyst', salary_adj_city: 7, overall: 7, employment_type: 'full-time', location: 'London', salary_raw: '£50K' },
    { archetype: 'Data Analyst', salary_adj_city: 7, overall: 7, employment_type: 'full-time', location: 'London', salary_raw: '£50K' },
    { archetype: 'Data Analyst', salary_adj_city: 7, overall: 7, employment_type: 'full-time', location: 'London', salary_raw: '£50K' },
  ]
  const out = benchmarkComp(rows, { target_range: '€30K-42K' }, { minRoles: 3, gbpToEur: 1.0 })
  // £50K at rate 1.0 → €50K FT median → above the €42K ceiling.
  assert.equal(out.drift.byType.fulltime.medianEur, 50000)
  assert.equal(out.drift.drift.verdict, 'target-below-landscape')
})
