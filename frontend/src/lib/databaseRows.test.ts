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
import { makeScoreEntry, makeApplication, makeBlockedEntry } from '@/test-utils/fixtures'

// ─── filter / context builders ───────────────────────────────────────────────

function filters(overrides: Partial<DbFilters> = {}): DbFilters {
  return {
    companies: new Set(),
    locations: new Set(),
    archetypes: new Set(),
    tiers: new Set(),
    verdicts: new Set(),
    eligibilities: new Set(),
    employmentTypes: new Set(),
    liveness: new Set<Liveness>(['active']),
    wantMin: 0,
    wantMax: 10,
    easeMin: 0,
    easeMax: 10,
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

test('dedupeEntities: a same-day re-score (later row) wins over the earlier run', () => {
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Analyst', location: 'Lyon', date: '2026-10-20', want: 7.4, ease: 6.62 }),
    makeScoreEntry({ company: 'Acme', role: 'Analyst', location: 'Lyon', date: '2026-10-20', want: 7.4, ease: 6.05 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].ease, 6.05)
})

test('dedupeEntities keeps the latest evaluation per (company, role, city)', () => {
  const out = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-01-01', want: 5, ease: 5 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-03-01', want: 8, ease: 8 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].want, 8)  // newer row wins
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
  assert.deepEqual(opts.tiers, ['T1', 'T2', 'T3', 'T4'])
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

test('filterAndGroupEntities drops unevaluated rows unless showClosed', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'A', want: 7, ease: 7 }),
    makeScoreEntry({ company: 'Acme', role: 'B', want: null }),
  ])
  assert.equal(filterAndGroupEntities(entities, ctx()).length, 1)
  assert.equal(filterAndGroupEntities(entities, ctx({ showClosed: true })).length, 2)
})

test('filterAndGroupEntities sorts groups by Priority desc', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Low', role: 'r', want: 4.5, ease: 4.5 }),
    makeScoreEntry({ company: 'High', role: 'r', want: 9.1, ease: 9.1 }),
    makeScoreEntry({ company: 'Mid', role: 'r', want: 7, ease: 7 }),
  ])
  assert.deepEqual(
    filterAndGroupEntities(entities, ctx({ showClosed: true })).map(r => r.company),
    ['High', 'Mid', 'Low'],
  )
})

test('filterAndGroupEntities applies the company + tier facets', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', want: 8, ease: 8, tier: 'T2' }),
    makeScoreEntry({ company: 'Acme', role: 'b', want: 8, ease: 8, tier: 'T3' }),
    makeScoreEntry({ company: 'Globex', role: 'c', want: 8, ease: 8, tier: 'T2' }),
  ])
  const byCompany = filterAndGroupEntities(entities, ctx({ filters: filters({ companies: new Set(['Acme']) }) }))
  assert.deepEqual(byCompany.map(r => r.role).sort(), ['a', 'b'])
  const byTier = filterAndGroupEntities(entities, ctx({ filters: filters({ tiers: new Set(['T2']) }) }))
  assert.deepEqual(byTier.map(r => r.role).sort(), ['a', 'c'])
})

test('filterAndGroupEntities honours the untapped-only lens', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'Analyst', want: 8, ease: 8 }),
  ])
  const acted = buildActedKeys([makeApplication({ company: 'Acme', role: 'Engineer', status: 'Applied' })])
  const out = filterAndGroupEntities(entities, ctx({ untappedOnly: true, actedKeys: acted }))
  assert.deepEqual(out.map(r => r.company), ['Globex'])  // Acme already engaged → hidden
})

test('filterAndGroupEntities hides a group whose only liveness state is filtered out', () => {
  const entities = dedupeEntities([makeScoreEntry({ company: 'Acme', role: 'Engineer', want: 8, ease: 8 })])
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
    makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', want: 9, ease: 9 }),
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
    makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', want: 9, ease: 9, date: '2026-01-01' }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', want: 6, ease: 6, date: '2026-05-01' }),
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
    makeScoreEntry({ company: 'Acme', role: 'a', want: 8, ease: 8, tier: 'T1' }),
    makeScoreEntry({ company: 'Globex', role: 'b', want: 8, ease: 8, tier: 'T2' }),
  ])
  const counts = computeFacetCounts(entities, ctx({ filters: filters({ companies: new Set(['Acme']) }) }))
  // Company dimension ignores its own filter → both companies still counted.
  assert.deepEqual(counts.companies, { Acme: 1, Globex: 1 })
  // Tier dimension respects the active company filter → only Acme's T1 counts.
  assert.deepEqual(counts.tiers, { T1: 1 })
})

test('computeFacetCounts bumps each city of a multi-listing', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', want: 8, ease: 8, tier: 'T2', location: 'Berlin / Paris' }),
  ])
  const counts = computeFacetCounts(entities, ctx())
  assert.deepEqual(counts.tiers, { T2: 1 })
  assert.deepEqual(counts.locations, { Berlin: 1, Paris: 1 })
})

test('computeFacetCounts respects the global Want-range and unevaluated-row gates', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'A', role: 'a', want: 9, ease: 9 }),
    makeScoreEntry({ company: 'B', role: 'b', want: 6, ease: 6 }),
    makeScoreEntry({ company: 'C', role: 'c', want: null }),  // zero-score
  ])
  const counts = computeFacetCounts(entities, ctx({ filters: filters({ wantMin: 7 }) }))
  assert.deepEqual(counts.companies, { A: 1 })  // B below range, C zero-score → excluded
})

test('computeFacetCounts excludes engaged listings under the untapped-only lens', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'Analyst', want: 8, ease: 8 }),
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
      makeScoreEntry({ company: 'Acme', role: 'Engineer Berlin', location: 'Berlin', want: 8, ease: 8 }),
      makeScoreEntry({ company: 'Acme', role: 'Engineer Paris', location: 'Paris', want: 9, ease: 9 }),
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
  const e = makeScoreEntry({ company: 'Acme', role: 'Engineer', want: 8, ease: 8 })
  const out = dedupeEntities([e])
  assert.equal(out.length, 1)
  assert.equal(out[0].want, 8)
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
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-01-01', want: 5, ease: 5 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-02-01', want: 6, ease: 6 }),
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', date: '2026-05-01', want: 9, ease: 9 }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].want, 9)
})

// ─── buildFacetOptions edge cases ────────────────────────────────────────────

test('buildFacetOptions with empty input returns empty sorted arrays and fixed tiers', () => {
  const opts = buildFacetOptions([])
  assert.deepEqual(opts.companies, [])
  assert.deepEqual(opts.locations, [])
  assert.deepEqual(opts.archetypes, [])
  assert.deepEqual(opts.employmentTypes, [])
  assert.deepEqual(opts.tiers, ['T1', 'T2', 'T3', 'T4'])
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
    makeScoreEntry({ company: 'Acme', role: 'Eng Berlin', location: 'Berlin', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Eng Paris',  location: 'Paris',  want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Acme', role: 'Eng London', location: 'London', want: 8, ease: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ locations: new Set(['Berlin']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'Eng Berlin')
})

test('filterAndGroupEntities filters a multi-city listing: row visible if ANY city matches', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin / Paris', want: 8, ease: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ locations: new Set(['Paris']) }) }))
  assert.equal(out.length, 1)
})

// ─── filterAndGroupEntities: archetype filter ─────────────────────────────────

test('filterAndGroupEntities filters by archetype via canonicalization', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', archetype: 'Data Analyst', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', archetype: 'Product Manager', want: 8, ease: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ archetypes: new Set(['Data Analyst']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Acme')
})

// ─── filterAndGroupEntities: employment type filter ───────────────────────────

test('filterAndGroupEntities filters by employment type', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme',   role: 'a', employment_type: 'Full-time', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', employment_type: 'Internship', want: 8, ease: 8 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({ filters: filters({ employmentTypes: new Set(['Internship']) }) }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Globex')
})

// ─── filterAndGroupEntities: score range filter ───────────────────────────────

test('filterAndGroupEntities applies the Want range gate', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'High', role: 'a', want: 9.5, ease: 9.5 }),
    makeScoreEntry({ company: 'Mid',  role: 'b', want: 7.0, ease: 7.0 }),
    makeScoreEntry({ company: 'Low',  role: 'c', want: 5.0, ease: 5.0 }),
  ])
  const out = filterAndGroupEntities(entities, ctx({
    showClosed: true,
    filters: filters({ wantMin: 6, wantMax: 8 }),
  }))
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Mid')
})

// ─── computeFacetCounts: liveness dimension ───────────────────────────────────

test('computeFacetCounts counts liveness bucket per entity', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Acme', role: 'a', want: 8, ease: 8 }),
    makeScoreEntry({ company: 'Globex', role: 'b', want: 8, ease: 8 }),
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
    makeScoreEntry({ company: 'Acme', role: 'Engineer', location: 'Berlin', want: 8, ease: 8 }),
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
  const parent = makeScoreEntry({ company: 'Acme', role: 'Eng Berlin', location: 'Berlin', want: 8, ease: 8 })
  const sibling = { ...makeScoreEntry({ company: 'Acme', role: 'Eng Paris', location: 'Paris', want: 7, ease: 7 }), livenessState: 'stale' as Liveness }
  const grouped = [{ ...parent, livenessState: 'active' as Liveness, siblings: [sibling] }]
  const flat = flattenForExport(grouped, {})
  assert.equal(flat.length, 2)
  assert.equal(flat[0].livenessState, 'active')
  // Sibling already has livenessState='stale'; flattenForExport should not overwrite it
  assert.equal(flat[1].livenessState, 'stale')
})

// ─── scoring v2: verdict / eligibility facets, blocked rows ──────────────────

test('blocked rows are evaluations: shown by default, sorted last, excluded by a range', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'A', role: 'a', want: 7, ease: 7 }),
    makeBlockedEntry('German C1 required', { company: 'B', role: 'b' }),
    makeScoreEntry({ company: 'C', role: 'c' }),   // unscored placeholder
  ])
  const out = filterAndGroupEntities(entities, ctx())
  assert.deepEqual(out.map(r => r.company), ['A', 'B'])
  const ranged = filterAndGroupEntities(entities, ctx({ filters: filters({ easeMin: 1 }) }))
  assert.deepEqual(ranged.map(r => r.company), ['A'])
})

test('verdict and eligibility facets filter rows and count the other dimensions', () => {
  const entities = dedupeEntities([
    makeScoreEntry({ company: 'Go', role: 'a', want: 9, ease: 8 }),
    makeScoreEntry({ company: 'Thin', role: 'b', want: 7, ease: 6, eligibility: 'amber', eligibility_flags: 'start_date:amber:x' }),
    makeBlockedEntry('x', { company: 'Red', role: 'c' }),
  ])
  const byVerdict = filterAndGroupEntities(entities, ctx({ filters: filters({ verdicts: new Set(['thin', 'blocked']) }) }))
  assert.deepEqual(byVerdict.map(r => r.company).sort(), ['Red', 'Thin'])
  const byElig = filterAndGroupEntities(entities, ctx({ filters: filters({ eligibilities: new Set(['amber']) }) }))
  assert.deepEqual(byElig.map(r => r.company), ['Thin'])
  const counts = computeFacetCounts(entities, ctx({ filters: filters({ eligibilities: new Set(['green']) }) }))
  assert.deepEqual(counts.verdicts, { go: 1 })                        // eligibility filter applied
  assert.deepEqual(counts.eligibilities, { green: 1, amber: 1, red: 1 }) // own selection ignored
})

test('buildFacetOptions lists the verdict and eligibility facets in fixed order', () => {
  const opts = buildFacetOptions([])
  assert.deepEqual(opts.verdicts, ['go', 'stretch', 'solid', 'growth', 'thin', 'skip', 'blocked'])
  assert.deepEqual(opts.eligibilities, ['green', 'amber', 'red'])
})
