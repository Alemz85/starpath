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
import {
  normalizeArchetype,
  parseScoreHistory,
  overallBand,
  archetypePerformance,
  dimensionDrag,
  landscapeSummary,
  cityExposure,
  targetingRecommendations,
  analyzeScouting,
} from './targeting-core.mjs'

const HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

// Build one TSV data row from an overrides object so tests stay readable.
function row(over = {}) {
  const base = {
    date: '2026-05-01', archetype: 'Data Analyst',
    skills_match: 7, ease_of_entry: 6, strategic_fit: 8, current_fit: 7,
    growth_mobility: 7, optionality_exit: 7, brand_value: 7, sales_trap_risk: 8,
    aspirational_fit: 7, overall: 7, best_cities: 'Madrid', salary_adj_city: 6,
    work_life_balance: 7, best_fit_roles: 'Analyst', mode: 'scouting',
    company: 'Acme', role: 'Analyst', tier: 'T2', source: 'pipeline',
    location: 'Madrid', employment_type: 'full-time', duration: 'permanent',
    salary_raw: 'n/d', url: 'https://x',
  }
  const merged = { ...base, ...over }
  return [
    'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
    'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
    'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
    'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
    'company', 'role', 'tier', 'source', 'location', 'employment_type',
    'duration', 'salary_raw', 'url',
  ].map(k => merged[k]).join('\t')
}

function tsv(...rows) {
  return [HEADER, ...rows].join('\n')
}

// ─── normalizeArchetype: spacing/separator drift collapses ────────────────────

test('normalizeArchetype collapses slash + spacing variants to one label', () => {
  assert.equal(normalizeArchetype('Business/Data Analyst'), 'Business / Data Analyst')
  assert.equal(normalizeArchetype('Business / Data Analyst'), 'Business / Data Analyst')
  assert.equal(normalizeArchetype('Business  /  Data Analyst'), 'Business / Data Analyst')
  assert.equal(normalizeArchetype('  Strategy & Operations  '), 'Strategy & Operations')
})

test('normalizeArchetype handles empty / missing as Unknown', () => {
  assert.equal(normalizeArchetype(''), 'Unknown')
  assert.equal(normalizeArchetype(null), 'Unknown')
  assert.equal(normalizeArchetype(undefined), 'Unknown')
  assert.equal(normalizeArchetype('   '), 'Unknown')
})

// ─── parseScoreHistory: defensive parsing ─────────────────────────────────────

test('parseScoreHistory reads header + numeric coercion', () => {
  const rows = parseScoreHistory(tsv(row({ overall: 8.1, skills_match: 9 })))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].overall, 8.1)
  assert.equal(rows[0].skills_match, 9)
  assert.equal(typeof rows[0].overall, 'number')
  assert.equal(rows[0].archetype, 'Data Analyst')
})

test('parseScoreHistory normalizes archetype on parse', () => {
  const rows = parseScoreHistory(tsv(row({ archetype: 'Business/Data Analyst' })))
  assert.equal(rows[0].archetype, 'Business / Data Analyst')
})

test('parseScoreHistory skips blank lines and too-short rows', () => {
  const text = tsv(row()) + '\n\n' + 'only\ttwo'
  const rows = parseScoreHistory(text)
  assert.equal(rows.length, 1)
})

test('parseScoreHistory coerces garbage numerics to NaN', () => {
  const rows = parseScoreHistory(tsv(row({ overall: 'oops' })))
  assert.ok(Number.isNaN(rows[0].overall))
})

test('parseScoreHistory returns [] on empty input', () => {
  assert.deepEqual(parseScoreHistory(''), [])
  assert.deepEqual(parseScoreHistory('   '), [])
})

// ─── overallBand: boundaries ──────────────────────────────────────────────────

test('overallBand hits each boundary exactly', () => {
  assert.equal(overallBand(7.5), 'strong')
  assert.equal(overallBand(7.49), 'solid')
  assert.equal(overallBand(7.0), 'solid')
  assert.equal(overallBand(6.99), 'pass')
  assert.equal(overallBand(6.0), 'pass')
  assert.equal(overallBand(5.99), 'weak')
  assert.equal(overallBand(4.2), 'weak')
  assert.equal(overallBand(NaN), 'unknown')
})

// ─── archetypePerformance: aggregation + sort + share ─────────────────────────

test('archetypePerformance aggregates by archetype, sorts by avg desc', () => {
  const rows = parseScoreHistory(tsv(
    row({ archetype: 'Strong One', overall: 8.0 }),
    row({ archetype: 'Strong One', overall: 8.4 }),
    row({ archetype: 'Weak One', overall: 5.0 }),
  ))
  const perf = archetypePerformance(rows)
  assert.equal(perf[0].archetype, 'Strong One')
  assert.equal(perf[0].count, 2)
  assert.equal(perf[0].avgOverall, 8.2)
  assert.equal(perf[0].maxOverall, 8.4)
  assert.equal(perf[0].strongRate, 100) // both ≥ 7.5
  assert.equal(perf[1].archetype, 'Weak One')
  assert.equal(perf[1].strongRate, 0)
  // shares sum to 100 across the 3 evaluated roles (2 + 1)
  assert.equal(perf[0].share, 67)
  assert.equal(perf[1].share, 33)
})

test('archetypePerformance merges spacing variants into one bucket', () => {
  const rows = parseScoreHistory(tsv(
    row({ archetype: 'Business/Data Analyst', overall: 7.0 }),
    row({ archetype: 'Business / Data Analyst', overall: 7.2 }),
  ))
  const perf = archetypePerformance(rows)
  assert.equal(perf.length, 1)
  assert.equal(perf[0].count, 2)
})

// ─── dimensionDrag: weakest-first ordering + lowShare ─────────────────────────

test('dimensionDrag surfaces the weakest dimension first', () => {
  const rows = parseScoreHistory(tsv(
    row({ ease_of_entry: 3, skills_match: 9 }),
    row({ ease_of_entry: 4, skills_match: 9 }),
  ))
  const drag = dimensionDrag(rows)
  assert.equal(drag[0].key, 'ease_of_entry')
  assert.equal(drag[0].avg, 3.5)
  assert.equal(drag[0].lowShare, 100) // both ≤ 4
  // skills_match should not be the drag — it's high
  assert.ok(drag[drag.length - 1].avg >= drag[0].avg)
})

// ─── landscapeSummary: band mix + wasted-effort share ─────────────────────────

test('landscapeSummary computes band mix and wastedShare', () => {
  const rows = parseScoreHistory(tsv(
    row({ overall: 8.0 }), // strong
    row({ overall: 7.2 }), // solid
    row({ overall: 6.5 }), // pass
    row({ overall: 5.0 }), // weak
  ))
  const land = landscapeSummary(rows)
  assert.equal(land.evaluated, 4)
  assert.equal(land.bands.strong, 1)
  assert.equal(land.bands.solid, 1)
  assert.equal(land.bands.pass, 1)
  assert.equal(land.bands.weak, 1)
  assert.equal(land.wastedShare, 25) // 1 of 4 weak
})

// ─── cityExposure: prefers location, filters noise, strips country code ───────

test('cityExposure tallies clean cities from solid+ roles only', () => {
  const rows = parseScoreHistory(tsv(
    row({ overall: 8.0, location: 'Barcelona' }),
    row({ overall: 7.1, location: 'Barcelona' }),
    row({ overall: 5.0, location: 'Lisbon' }),      // weak → excluded
    row({ overall: 7.5, location: 'Madrid ES' }),   // country code stripped
  ))
  const cities = cityExposure(rows)
  assert.deepEqual(cities[0], { city: 'Barcelona', count: 2 })
  assert.ok(cities.some(c => c.city === 'Madrid'))
  assert.ok(!cities.some(c => c.city === 'Lisbon'))   // weak role excluded
  assert.ok(!cities.some(c => /ES/.test(c.city)))     // no country code leak
})

test('cityExposure rejects numeric / n/d / remote noise (column-shift guard)', () => {
  const rows = parseScoreHistory(tsv(
    row({ overall: 8.0, location: '10.0', best_cities: '8' }), // both numeric
    row({ overall: 8.0, location: 'n/d', best_cities: 'n/d' }),
    row({ overall: 8.0, location: 'Remote-EU' }),
  ))
  const cities = cityExposure(rows)
  assert.deepEqual(cities, [])
})

test('cityExposure falls back to best_cities when location is unusable', () => {
  const rows = parseScoreHistory(tsv(
    row({ overall: 8.0, location: 'n/d', best_cities: 'Dublin' }),
  ))
  const cities = cityExposure(rows)
  assert.deepEqual(cities, [{ city: 'Dublin', count: 1 }])
})

// ─── targetingRecommendations: gates ──────────────────────────────────────────

test('targetingRecommendations only fires "lean into" when archetype has enough roles', () => {
  // 3 strong roles < minRoles(4) → no lean-in rec
  const few = parseScoreHistory(tsv(
    row({ archetype: 'Niche', overall: 8.0 }),
    row({ archetype: 'Niche', overall: 8.1 }),
    row({ archetype: 'Niche', overall: 8.2 }),
  ))
  const recsFew = targetingRecommendations(few)
  assert.ok(!recsFew.some(r => /Lean into/.test(r.action)))

  // 4 strong roles ≥ minRoles → lean-in rec fires
  const enough = parseScoreHistory(tsv(
    row({ archetype: 'Niche', overall: 8.0 }),
    row({ archetype: 'Niche', overall: 8.1 }),
    row({ archetype: 'Niche', overall: 8.2 }),
    row({ archetype: 'Niche', overall: 8.3 }),
  ))
  const recsEnough = targetingRecommendations(enough)
  assert.ok(recsEnough.some(r => /Lean into "Niche"/.test(r.action)))
})

test('targetingRecommendations flags a systemic dimension drag', () => {
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 5 }, () => row({ ease_of_entry: 3, overall: 6.0 })),
  ))
  const recs = targetingRecommendations(rows)
  assert.ok(recs.some(r => /Ease of Entry/.test(r.action)))
})

test('targetingRecommendations warns when too much effort is wasted', () => {
  const rows = parseScoreHistory(tsv(
    row({ overall: 5.0 }), row({ overall: 5.5 }),
    row({ overall: 7.5 }), row({ overall: 7.6 }),
  ))
  const recs = targetingRecommendations(rows)
  assert.ok(recs.some(r => /weak/.test(r.action)))
})

// ─── analyzeScouting: end-to-end shape + error guards ─────────────────────────

test('analyzeScouting returns a structured analysis object', () => {
  const rows = parseScoreHistory(tsv(
    row({ archetype: 'A', overall: 8.0, location: 'Madrid' }),
    row({ archetype: 'A', overall: 7.5, location: 'Madrid' }),
    row({ archetype: 'B', overall: 5.0, location: 'Rome' }),
  ))
  const out = analyzeScouting(rows)
  assert.equal(out.metadata.evaluated, 3)
  assert.equal(out.metadata.dateRange.from, '2026-05-01')
  assert.ok(Array.isArray(out.archetypePerformance))
  assert.ok(Array.isArray(out.dimensionDrag))
  assert.ok(Array.isArray(out.cityExposure))
  assert.ok(Array.isArray(out.recommendations))
  assert.ok(out.landscape.evaluated === 3)
})

test('analyzeScouting errors on empty or score-less input', () => {
  assert.ok(analyzeScouting([]).error)
  const noScores = parseScoreHistory(tsv(row({ overall: 'x' })))
  assert.ok(analyzeScouting(noScores).error)
})
