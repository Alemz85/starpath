import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupeEntities,
  buildFacetOptions,
  buildActedKeys,
  filterAndGroupEntities,
  computeFacetCounts,
  flattenForExport,
  livenessOf,
  type DbFilters,
  type DbFilterContext,
} from '@/lib/databaseRows'
import { livenessKey, type Liveness } from '@/lib/scanHistory'
import { makeScoreEntry, makeApplication } from '@/test-utils/fixtures'

// ─── filter / context builders ───────────────────────────────────────────────

function filters(overrides: Partial<DbFilters> = {}): DbFilters {
  return {
    companies: new Set(),
    locations: new Set(),
    archetypes: new Set(),
    tiers: new Set(),
    employmentTypes: new Set(),
    liveness: new Set<Liveness>(['active']),
    scoreMin: 0,
    scoreMax: 10,
    ...overrides,
  }
}

function ctx(overrides: Partial<DbFilterContext> = {}): DbFilterContext {
  return {
    filters: overrides.filters ?? filters(),
    tokenFilters: {},
    freeText: '',
    showClosed: false,
    untappedOnly: false,
    actedKeys: new Set(),
    liveness: {},
    ...overrides,
  }
}

// ─── livenessOf ──────────────────────────────────────────────────────────────

test('livenessOf defaults unseen listings to active, else maps via livenessKey', () => {
  const e = makeScoreEntry({ company: 'Acme', role: 'Engineer' })
  assert.equal(livenessOf(e, {}), 'active')
  assert.equal(livenessOf(e, { [livenessKey('Acme', 'Engineer')]: 'closed' }), 'closed')
})

// ─── dedupeEntities ──────────────────────────────────────────────────────────

test('dedupeEntities keeps the latest evaluation per (company, role, city)', () => {
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-01-01', overall: 5 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-03-01', overall: 8 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].overall, 8)  // newer row wins
})

test('dedupeEntities treats different cities of the same role as distinct entities', () => {
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin' }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris' }),
  ])
  assert.equal(out.length, 2)
})

// ─── buildFacetOptions ───────────────────────────────────────────────────────

test('buildFacetOptions returns sorted-unique values and the fixed tier list', () => {
  const opts = buildFacetOptions([
    makeScoreEntry({ company: 'Zeta', location: 'Paris', employment_type: 'Full-time' }),
    makeScoreEntry({ company: 'Acme', location: 'Berlin', employment_type: 'Internship' }),
    makeScoreEntry({ company: 'Acme', location: 'Berlin', employment_type: 'Internship' }),
  ])
  assert.deepEqual(opts.companies, ['Acme', 'Zeta'])
  assert.deepEqual(opts.locations, ['Berlin', 'Paris'])
  assert.deepEqual(opts.employmentTypes, ['Full-time', 'Internship'])
  assert.deepEqual(opts.tiers, ['T1', 'T2-high', 'T2', 'T3', 'T4'])
})

test('buildFacetOptions expands a multi-city listing under each city', () => {
  const opts = buildFacetOptions([
    makeScoreEntry({ company: 'Acme', location: 'Berlin / Paris / London' }),
  ])
  assert.deepEqual(opts.locations, ['Berlin', 'London', 'Paris'])
})

// ─── buildActedKeys ──────────────────────────────────────────────────────────

test('buildActedKeys collects only engaged statuses, keyed + lowercased', () => {
  const keys = buildActedKeys([
    makeApplication({ company: 'Acme', role: 'Engineer', status: 'Applied' }),
    makeApplication({ company: 'Globex', role: 'Analyst', status: 'Interview' }),
    makeApplication({ company: 'Initech', role: 'PM', status: 'Evaluated' }),   // not engaged
    makeApplication({ company: 'Umbrella', role: 'Lead', status: 'Discarded' }), // not engaged
  ])
  assert.equal(keys.has(livenessKey('Acme', 'Engineer')), true)
  assert.equal(keys.has(livenessKey('Globex', 'Analyst')), true)
  assert.equal(keys.has(livenessKey('Initech', 'PM')), false)
  assert.equal(keys.has(livenessKey('Umbrella', 'Lead')), false)
  assert.equal(keys.size, 2)
})

// ─── filterAndGroupEntities ──────────────────────────────────────────────────

test('filterAndGroupEntities drops zero-score rows unless showClosed', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'A', overall: 7 }),
    makeScoreEntry({ company: 'Acme', role: 'B', overall: 0 }),
  ])
  assert.equal(filterAndGroupEntities(entities, ctx()).length, 1)
  assert.equal(filterAndGroupEntities(entities, ctx({ showClosed: true })).length, 2)
})

test('filterAndGroupEntities sorts groups by overall desc', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Low', role: 'r', overall: 4.5 }),
    makeScoreEntry({ company: 'High', role: 'r', overall: 9.1 }),
    makeScoreEntry({ company: 'Mid', role: 'r', overall: 7 }),
  ])
  assert.deepEqual(
    filterAndGroupEntities(entities, ctx({ showClosed: true })).map(r => r.company),
    ['High', 'Mid', 'Low'],
  )
})

test('filterAndGroupEntities applies the company + tier facets (T2-high folds into T2)', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', overall: 8, tier: 'T2-high' }),
    makeScoreEntry({ company: 'Acme', role: 'b', overall: 8, tier: 'T3' }),
    makeScoreEntry({ company: 'Globex', role: 'c', overall: 8, tier: 'T2' }),
  ])
  const byCompany = filterAndGroupEntities(entities, ctx({ filters: filters({ companies: new Set(['Acme']) }) }))
  assert.deepEqual(byCompany.map(r => r.role).sort(), ['a', 'b'])
  // Selecting "T2" must also surface T2-high rows.
  const byTier = filterAndGroupEntities(entities, ctx({ filters: filters({ tiers: new Set(['T2']) }) }))
  assert.deepEqual(byTier.map(r => r.role).sort(), ['a', 'c'])
})

test('filterAndGroupEntities honours the untapped-only lens', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', overall: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'Analyst', overall: 8 }),
  ])
  const acted = buildActedKeys([makeApplication({ company: 'Acme', role: 'Engineer', status: 'Applied' })])
  const out = filterAndGroupEntities(entities, ctx({ untappedOnly: true, actedKeys: acted }))
  assert.deepEqual(out.map(r => r.company), ['Globex'])  // Acme already engaged → hidden
})

test('filterAndGroupEntities hides a group whose only liveness state is filtered out', () => {
  const entities = dedupeEntities([makeScoreEntry({ company: 'Acme', role: 'Engineer', overall: 8 })])
  const closedMap = { [livenessKey('Acme', 'Engineer')]: 'closed' as Liveness }
  // Default filter is {active} → the closed group is hidden…
  assert.equal(filterAndGroupEntities(entities, ctx({ liveness: closedMap })).length, 0)
  // …but visible once 'closed' is in the chip set.
  assert.equal(
    filterAndGroupEntities(entities, ctx({
      liveness: closedMap,
      filters: filters({ liveness: new Set<Liveness>(['active', 'closed']) }),
    })).length,
    1,
  )
})

test('filterAndGroupEntities groups same-role cities and picks the best ACTIVE sibling as primary', () => {
  // Two cities of one role: Paris scores higher but is closed; Berlin is active.
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', overall: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', overall: 9 }),
  ])
  const liveness = {
    [livenessKey('Acme', 'Engineer Berlin')]: 'active' as Liveness,
    [livenessKey('Acme', 'Engineer Paris')]: 'closed' as Liveness,
  }
  const out = filterAndGroupEntities(entities, ctx({
    liveness,
    filters: filters({ liveness: new Set<Liveness>(['active', 'closed']) }),
  }))
  assert.equal(out.length, 1)                       // one grouped parent row
  assert.equal(out[0].role, 'Engineer Berlin')      // active sibling is primary, not the higher-scoring closed one
  assert.equal(out[0].livenessState, 'active')
  assert.equal(out[0].siblings?.length, 1)
  assert.equal(out[0].siblings?.[0].role, 'Engineer Paris')
})

test('filterAndGroupEntities falls back to the most-recent sibling when none are active', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', overall: 9, date: '2026-01-01' }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', overall: 6, date: '2026-05-01' }),
  ])
  const liveness = {
    [livenessKey('Acme', 'Engineer Berlin')]: 'closed' as Liveness,
    [livenessKey('Acme', 'Engineer Paris')]: 'closed' as Liveness,
  }
  const out = filterAndGroupEntities(entities, ctx({
    liveness,
    filters: filters({ liveness: new Set<Liveness>(['closed']) }),
  }))
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'Engineer Paris')  // most recent date wins when no active sibling
})

// ─── computeFacetCounts ──────────────────────────────────────────────────────

test('computeFacetCounts ignores a dimension\'s own selection but applies the others', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', overall: 8, tier: 'T1' }),
    makeScoreEntry({ company: 'Globex', role: 'b', overall: 8, tier: 'T2' }),
  ])
  const counts = computeFacetCounts(entities, ctx({ filters: filters({ companies: new Set(['Acme']) }) }))
  // Company dimension ignores its own filter → both companies still counted.
  assert.deepEqual(counts.companies, { Acme: 1, Globex: 1 })
  // Tier dimension respects the active company filter → only Acme's T1 counts.
  assert.deepEqual(counts.tiers, { T1: 1 })
})

test('computeFacetCounts folds T2-high into the T2 bucket and bumps each city of a multi-listing', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', overall: 8, tier: 'T2-high', location: 'Berlin / Paris' }),
  ])
  const counts = computeFacetCounts(entities, ctx())
  assert.deepEqual(counts.tiers, { T2: 1 })
  assert.deepEqual(counts.locations, { Berlin: 1, Paris: 1 })
})

test('computeFacetCounts respects the global score-range and zero-score gates', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'A', role: 'a', overall: 9 }),
    makeScoreEntry({ company: 'B', role: 'b', overall: 6 }),
    makeScoreEntry({ company: 'C', role: 'c', overall: 0 }),  // zero-score
  ])
  const counts = computeFacetCounts(entities, ctx({ filters: filters({ scoreMin: 7 }) }))
  assert.deepEqual(counts.companies, { A: 1 })  // B below range, C zero-score → excluded
})

test('computeFacetCounts excludes engaged listings under the untapped-only lens', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', overall: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'Analyst', overall: 8 }),
  ])
  const acted = buildActedKeys([makeApplication({ company: 'Acme', role: 'Engineer', status: 'Applied' })])
  // Without the lens, both count; with it, the already-applied Acme row drops —
  // so the counts agree with the rows filterAndGroupEntities would render.
  assert.deepEqual(computeFacetCounts(entities, ctx()).companies, { Acme: 1, Globex: 1 })
  assert.deepEqual(
    computeFacetCounts(entities, ctx({ untappedOnly: true, actedKeys: acted })).companies,
    { Globex: 1 },
  )
})

// ─── flattenForExport ────────────────────────────────────────────────────────

test('flattenForExport emits the parent then each sibling with a resolved livenessState', () => {
  const grouped = filterAndGroupEntities(
    dedupeEntities([
      makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', overall: 8 }),
      makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', overall: 9 }),
    ]),
    ctx(),  // both default-active, filter {active}
  )
  const liveness = {}  // unseen → active
  const flat = flattenForExport(grouped, liveness)
  assert.equal(flat.length, 2)                                   // parent + 1 sibling
  assert.ok(flat.every(r => r.livenessState === 'active'))       // every row carries a state
})

// ─── dedupeEntities edge cases ───────────────────────────────────────────────

test('dedupeEntities with an empty array returns an empty array', () => {
  assert.deepEqual(dedupeEntities([]), [])
})

test('dedupeEntities keeps a single entry unchanged', () => {
  const e = makeScoreEntry({ company: 'Acme', role: 'Engineer', overall: 8 })
  const out = dedupeEntities([e])
  assert.equal(out.length, 1)
  assert.equal(out[0].overall, 8)
})

test('dedupeEntities: same (company, role) across different cities are distinct entities', () => {
  // 'Engineer' with no location vs 'Engineer' with Berlin — different entityIds
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: '' }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin' }),
  ])
  assert.equal(out.length, 2)
})

test('dedupeEntities: three evaluations of the same role/city — only the most recent survives', () => {
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-01-01', overall: 5 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-02-01', overall: 6 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-05-01', overall: 9 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].overall, 9)
})

// ─── buildFacetOptions edge cases ────────────────────────────────────────────

test('buildFacetOptions with empty input returns empty sorted arrays and fixed tiers', () => {
  const opts = buildFacetOptions([])
  assert.deepEqual(opts.companies, [])
  assert.deepEqual(opts.locations, [])
  assert.deepEqual(opts.archetypes, [])
  assert.deepEqual(opts.employmentTypes, [])
  assert.deepEqual(opts.tiers, ['T1', 'T2-high', 'T2', 'T3', 'T4'])
})

test('buildFacetOptions filters out falsy archetypes', () => {
  const opts = buildFacetOptions([
    makeScoreEntry({ archetype: '' }),
    makeScoreEntry({ archetype: 'Data Analyst' }),
  ])
  // Empty archetype is filtered via .filter(Boolean)
  assert.ok(!opts.archetypes.includes(''))
  assert.ok(opts.archetypes.includes('Data Analyst') || opts.archetypes.some(a => a.length > 0))
})

// ─── buildActedKeys edge cases ────────────────────────────────────────────────

test('buildActedKeys with an empty input returns an empty set', () => {
  const keys = buildActedKeys([])
  assert.equal(keys.size, 0)
})

test('buildActedKeys: all engaged statuses are captured', () => {
  // ENGAGED_STATUSES covers Applied, Responded, Interview, Offer, Rejected
  const keys = buildActedKeys([
    makeApplication({ company: 'A', role: 'r1', status: 'Applied' }),
    makeApplication({ company: 'A', role: 'r2', status: 'Responded' }),
    makeApplication({ company: 'A', role: 'r3', status: 'Interview' }),
    makeApplication({ company: 'A', role: 'r4', status: 'Offer' }),
    makeApplication({ company: 'A', role: 'r5', status: 'Rejected' }),
    makeApplication({ company: 'A', role: 'r6', status: 'Evaluated' }),  // NOT engaged
    makeApplication({ company: 'A', role: 'r7', status: 'Discarded' }),  // NOT engaged
    makeApplication({ company: 'A', role: 'r8', status: 'SKIP' }),       // NOT engaged
  ])
  assert.equal(keys.has(livenessKey('A', 'r1')), true)
  assert.equal(keys.has(livenessKey('A', 'r2')), true)
  assert.equal(keys.has(livenessKey('A', 'r3')), true)
  assert.equal(keys.has(livenessKey('A', 'r4')), true)
  assert.equal(keys.has(livenessKey('A', 'r5')), true)
  assert.equal(keys.has(livenessKey('A', 'r6')), false)
  assert.equal(keys.has(livenessKey('A', 'r7')), false)
  assert.equal(keys.has(livenessKey('A', 'r8')), false)
})

// ─── filterAndGroupEntities: location filter ─────────────────────────────────

test('filterAndGroupEntities filters by location (cities)', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Eng Berlin', location: 'Berlin', overall: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Eng Paris',  location: 'Paris',  overall: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Eng London', location: 'London', overall: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ locations: new Set(['Berlin']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'Eng Berlin')
})

test('filterAndGroupEntities filters a multi-city listing: row visible if ANY city matches', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin / Paris', overall: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ locations: new Set(['Paris']) }) }))
  assert.equal(out.length, 1)
})

// ─── filterAndGroupEntities: archetype filter ─────────────────────────────────

test('filterAndGroupEntities filters by archetype via canonicalization', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', archetype: 'Data Analyst', overall: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', archetype: 'Product Manager', overall: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ archetypes: new Set(['Data Analyst']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Acme')
})

// ─── filterAndGroupEntities: employment type filter ───────────────────────────

test('filterAndGroupEntities filters by employment type', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme',   role: 'a', employment_type: 'Full-time', overall: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', employment_type: 'Internship', overall: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ employmentTypes: new Set(['Internship']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Globex')
})

// ─── filterAndGroupEntities: score range filter ───────────────────────────────

test('filterAndGroupEntities applies scoreMin/scoreMax range gates', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'High', role: 'a', overall: 9.5 }),
    makeScoreEntry({ company: 'Mid',  role: 'b', overall: 7.0 }),
    makeScoreEntry({ company: 'Low',  role: 'c', overall: 5.0 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({
    showClosed: true,
    filters: filters({ scoreMin: 6, scoreMax: 8 }),
  }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Mid')
})

// ─── computeFacetCounts: liveness dimension ───────────────────────────────────

test('computeFacetCounts counts liveness bucket per entity', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', overall: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', overall: 8 }),
  ])
  const liveness = {
    [livenessKey('Acme', 'a')]: 'active' as Liveness,
    [livenessKey('Globex', 'b')]: 'stale' as Liveness,
  }
  const counts = computeFacetCounts(entities, ctx({
    liveness,
    filters: filters({ liveness: new Set<Liveness>(['active', 'stale']) }),
  }))
  assert.equal(counts.liveness['active'], 1)
  assert.equal(counts.liveness['stale'], 1)
})

// ─── flattenForExport edge cases ──────────────────────────────────────────────

test('flattenForExport with no siblings emits a single row', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', overall: 8 }),
  ])
  const grouped = filterAndGroupEntities(entities, ctx())
  const flat = flattenForExport(grouped, {})
  assert.equal(flat.length, 1)
  assert.equal(flat[0].company, 'Acme')
  assert.equal(flat[0].livenessState, 'active')
})

test('flattenForExport with an empty input returns an empty array', () => {
  assert.deepEqual(flattenForExport([], {}), [])
})

test('flattenForExport preserves a pre-resolved livenessState on a sibling', () => {
  // Build a grouped row where the sibling already carries a livenessState
  const parent = makeScoreEntry({ company: 'Acme', role: 'Eng Berlin', location: 'Berlin', overall: 8 })
  const sibling = { ...makeScoreEntry({ company: 'Acme', role: 'Eng Paris', location: 'Paris', overall: 7 }), livenessState: 'stale' as Liveness }
  const grouped = [{ ...parent, livenessState: 'active' as Liveness, siblings: [sibling] }]
  const flat = flattenForExport(grouped, {})
  assert.equal(flat.length, 2)
  assert.equal(flat[0].livenessState, 'active')
  // Sibling already has livenessState='stale'; flattenForExport should not overwrite it
  assert.equal(flat[1].livenessState, 'stale')
})
