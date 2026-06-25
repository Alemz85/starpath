// Unit tests for scripts/lib/positioning-core.mjs — the corpus-level positioning
// synthesis that bridges targeting-core (corpus aggregates) and explain-score
// (per-role levers) into per-archetype average-fingerprint levers and the
// systemic binding constraint.
//
// These pin: fingerprint averaging + bottleneck detection, the min-roles filter,
// the average-role lever replay (which must agree with the canonical engine),
// and the systemic-constraint tally. positioning-intel.mjs only wraps these with
// file I/O, so this is where the logic is pinned.
//
// Plain ESM, zero deps: `node --test scripts/lib/positioning-core.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from './targeting-core.mjs'
import {
  rollupCurrentFit,
  rollupAspirationalFit,
  assignTier,
} from './score-bands.mjs'
import {
  archetypeFingerprints,
  archetypeLever,
  systemicConstraint,
  positioningIntel,
} from './positioning-core.mjs'

const HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

// Build one TSV data row from overrides so tests stay readable.
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

const parse = (...rows) => parseScoreHistory(tsv(...rows))

// ─── archetypeFingerprints: averaging + bottleneck ────────────────────────────

test('archetypeFingerprints averages each dimension across an archetype', () => {
  const rows = parse(
    row({ skills_match: 6, ease_of_entry: 4, strategic_fit: 8, overall: 6.5 }),
    row({ skills_match: 8, ease_of_entry: 6, strategic_fit: 8, overall: 7.5 }),
    row({ skills_match: 7, ease_of_entry: 5, strategic_fit: 8, overall: 7.0 }),
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps.length, 1)
  const fp = fps[0]
  assert.equal(fp.archetype, 'Data Analyst')
  assert.equal(fp.count, 3)
  assert.equal(fp.dims.skills_match, 7)       // (6+8+7)/3
  assert.equal(fp.dims.ease_of_entry, 5)      // (4+6+5)/3
  assert.equal(fp.dims.strategic_fit, 8)
})

test('archetypeFingerprints flags the lowest-averaging dim as the bottleneck', () => {
  const rows = parse(
    row({ skills_match: 7, ease_of_entry: 3, strategic_fit: 8, growth_mobility: 7, optionality_exit: 7, brand_value: 7 }),
    row({ skills_match: 7, ease_of_entry: 3, strategic_fit: 8, growth_mobility: 7, optionality_exit: 7, brand_value: 7 }),
    row({ skills_match: 7, ease_of_entry: 4, strategic_fit: 8, growth_mobility: 7, optionality_exit: 7, brand_value: 7 }),
  )
  const fp = archetypeFingerprints(rows)[0]
  assert.equal(fp.bottleneck.key, 'ease_of_entry')
  assert.ok(fp.bottleneck.avg < 4)
})

test('archetypeFingerprints applies the minRoles filter', () => {
  const rows = parse(
    row({ archetype: 'Data Analyst' }),
    row({ archetype: 'Data Analyst' }),     // only 2 — below default 3
    row({ archetype: 'Strategy & Operations' }),
    row({ archetype: 'Strategy & Operations' }),
    row({ archetype: 'Strategy & Operations' }),
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps.length, 1)
  assert.equal(fps[0].archetype, 'Strategy & Operations')

  // Lowering the threshold surfaces both.
  const both = archetypeFingerprints(rows, { minRoles: 2 })
  assert.equal(both.length, 2)
})

test('archetypeFingerprints sorts strongest avg Overall first', () => {
  const rows = parse(
    row({ archetype: 'Weak', overall: 6.0, skills_match: 5, ease_of_entry: 5, strategic_fit: 5 }),
    row({ archetype: 'Weak', overall: 6.0, skills_match: 5, ease_of_entry: 5, strategic_fit: 5 }),
    row({ archetype: 'Weak', overall: 6.0, skills_match: 5, ease_of_entry: 5, strategic_fit: 5 }),
    row({ archetype: 'Strong', overall: 8.0, skills_match: 9, ease_of_entry: 8, strategic_fit: 9 }),
    row({ archetype: 'Strong', overall: 8.0, skills_match: 9, ease_of_entry: 8, strategic_fit: 9 }),
    row({ archetype: 'Strong', overall: 8.0, skills_match: 9, ease_of_entry: 8, strategic_fit: 9 }),
  )
  const fps = archetypeFingerprints(rows)
  assert.equal(fps[0].archetype, 'Strong')
  assert.equal(fps[1].archetype, 'Weak')
})

test('archetypeFingerprints tolerates blank dimension cells (NaN-safe averaging)', () => {
  const rows = parse(
    row({ skills_match: 7 }),
    row({ skills_match: '' }),   // blank → NaN, excluded from the mean
    row({ skills_match: 9 }),
  )
  const fp = archetypeFingerprints(rows)[0]
  assert.equal(fp.dims.skills_match, 8) // mean of the two finite values (7,9)
})

// ─── archetypeLever: replay must agree with the canonical engine ──────────────

test('archetypeLever reproduces CF/AF/tier from the average fingerprint', () => {
  // A fingerprint gated by the EoE hard gate (EoE ≤ 4) — strong CF otherwise.
  const fp = {
    archetype: 'X', count: 3,
    dims: { skills_match: 9, ease_of_entry: 4, strategic_fit: 9, growth_mobility: 8, optionality_exit: 8, brand_value: 8 },
    ctx: { salary_adj_city: 6, work_life_balance: 7 },
  }
  const lever = archetypeLever(fp)

  // Independently derive what the engine should produce.
  const cf = rollupCurrentFit(fp.dims)
  const af = rollupAspirationalFit(fp.dims)
  const { tier } = assignTier({ cf, af, sixDims: fp.dims })
  assert.equal(lever.cf, Math.round(cf * 100) / 100)
  assert.equal(lever.af, Math.round(af * 100) / 100)
  assert.equal(lever.tier, tier)
})

test('archetypeLever surfaces the EoE gate as the binding constraint', () => {
  const fp = {
    archetype: 'Gated', count: 4,
    dims: { skills_match: 8, ease_of_entry: 3, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 },
    ctx: { salary_adj_city: 6, work_life_balance: 6 },
  }
  const lever = archetypeLever(fp)
  assert.equal(lever.tier, 'T3') // EoE ≤ 4 gate caps at growth target (AF high)
  assert.equal(lever.bindingConstraint.dimension, 'ease_of_entry')
})

test('archetypeLever returns a cheapest band-crossing lever when one exists', () => {
  const fp = {
    archetype: 'Liftable', count: 5,
    dims: { skills_match: 8, ease_of_entry: 4, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 },
    ctx: { salary_adj_city: 6, work_life_balance: 6 },
  }
  const lever = archetypeLever(fp)
  // EoE 4 trips the gate; lifting EoE past 4 should re-band upward.
  assert.ok(lever.cheapestLever, 'expected a band-crossing lever')
  assert.equal(lever.cheapestLever.dimension, 'ease_of_entry')
  assert.ok(lever.cheapestLever.to > lever.cheapestLever.from)
})

test('archetypeLever falls back to neutral context when ctx dims are blank', () => {
  const fp = {
    archetype: 'NoCtx', count: 3,
    dims: { skills_match: 7, ease_of_entry: 6, strategic_fit: 7, growth_mobility: 7, optionality_exit: 7, brand_value: 7 },
    ctx: { salary_adj_city: NaN, work_life_balance: NaN },
  }
  // Should not throw and should produce a finite CF/AF.
  const lever = archetypeLever(fp)
  assert.ok(Number.isFinite(lever.cf))
  assert.ok(Number.isFinite(lever.af))
})

// ─── systemicConstraint: cross-archetype tally ────────────────────────────────

test('systemicConstraint picks the dimension binding the most archetypes', () => {
  const levers = [
    { archetype: 'A', bindingConstraint: { dimension: 'ease_of_entry', label: 'Ease of Entry' }, cheapestLever: { dimension: 'ease_of_entry', lift: 1 } },
    { archetype: 'B', bindingConstraint: { dimension: 'ease_of_entry', label: 'Ease of Entry' }, cheapestLever: { dimension: 'ease_of_entry', lift: 2 } },
    { archetype: 'C', bindingConstraint: { dimension: 'brand_value', label: 'Brand Value' }, cheapestLever: { dimension: 'brand_value', lift: 3 } },
  ]
  const sc = systemicConstraint(levers)
  assert.equal(sc.dominant.dimension, 'ease_of_entry')
  assert.equal(sc.dominant.count, 2)
  assert.deepEqual(sc.dominant.archetypes, ['A', 'B'])
  // Lever tally agrees and reports the average lift across the two EoE archetypes.
  assert.equal(sc.lever.dimension, 'ease_of_entry')
  assert.equal(sc.lever.count, 2)
  assert.equal(sc.lever.avgLift, 1.5)
})

test('systemicConstraint handles archetypes with no lever (T1) gracefully', () => {
  const levers = [
    { archetype: 'Top', bindingConstraint: null, cheapestLever: null },
    { archetype: 'Gated', bindingConstraint: { dimension: 'skills_match', label: 'Skills Match' }, cheapestLever: { dimension: 'skills_match', lift: 2 } },
  ]
  const sc = systemicConstraint(levers)
  assert.equal(sc.dominant.dimension, 'skills_match')
  assert.equal(sc.dominant.count, 1)
  assert.equal(sc.lever.dimension, 'skills_match')
})

test('systemicConstraint returns nulls when nothing binds', () => {
  const sc = systemicConstraint([
    { archetype: 'Top', bindingConstraint: null, cheapestLever: null },
  ])
  assert.equal(sc.dominant, null)
  assert.equal(sc.lever, null)
  assert.deepEqual(sc.tally, [])
})

// ─── positioningIntel: top-level bundle ───────────────────────────────────────

test('positioningIntel returns an error object on empty input', () => {
  assert.ok(positioningIntel([]).error)
  assert.ok(positioningIntel(null).error)
})

test('positioningIntel returns an error when no row has a valid Overall', () => {
  const rows = parse(row({ overall: 'oops' }), row({ overall: '' }))
  assert.ok(positioningIntel(rows).error)
})

test('positioningIntel assembles the full bundle and ties levers to fingerprints', () => {
  const rows = parse(
    row({ archetype: 'Data Analyst', ease_of_entry: 4, overall: 6.8 }),
    row({ archetype: 'Data Analyst', ease_of_entry: 4, overall: 6.8 }),
    row({ archetype: 'Data Analyst', ease_of_entry: 4, overall: 6.8 }),
    row({ archetype: 'Strategy & Operations', skills_match: 9, ease_of_entry: 8, strategic_fit: 9, growth_mobility: 9, optionality_exit: 9, brand_value: 9, overall: 8.8 }),
    row({ archetype: 'Strategy & Operations', skills_match: 9, ease_of_entry: 8, strategic_fit: 9, growth_mobility: 9, optionality_exit: 9, brand_value: 9, overall: 8.8 }),
    row({ archetype: 'Strategy & Operations', skills_match: 9, ease_of_entry: 8, strategic_fit: 9, growth_mobility: 9, optionality_exit: 9, brand_value: 9, overall: 8.8 }),
  )
  const intel = positioningIntel(rows)
  assert.equal(intel.metadata.evaluated, 6)
  assert.equal(intel.metadata.archetypesAnalyzed, 2)
  assert.equal(intel.fingerprints.length, 2)
  assert.equal(intel.levers.length, 2)
  // Every lever maps to a fingerprint of the same archetype.
  const fpNames = new Set(intel.fingerprints.map(f => f.archetype))
  for (const l of intel.levers) assert.ok(fpNames.has(l.archetype))
  // The EoE-gated Data Analyst archetype should surface EoE somewhere in the tally.
  const eoeBound = intel.systemicConstraint.tally.find(t => t.dimension === 'ease_of_entry')
  assert.ok(eoeBound, 'expected EoE among binding constraints')
  // Bundle carries the corpus aggregates from targeting-core.
  assert.ok(Array.isArray(intel.dimensionDrag))
  assert.ok(Array.isArray(intel.cityExposure))
  assert.ok(intel.landscape.evaluated === 6)
})
