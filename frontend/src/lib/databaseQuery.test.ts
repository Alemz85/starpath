import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenQuery, matchesTokenQuery } from '@/lib/databaseQuery'
import { makeScoreEntry } from '@/test-utils/fixtures'

// ─── parseTokenQuery ──────────────────────────────────────────────────────────

test('parseTokenQuery reads bare tokens and leaves nothing as free text', () => {
  const { tokenFilters, freeText } = parseTokenQuery('company:Stripe tier:T1')
  assert.equal(tokenFilters.company, 'Stripe')
  assert.equal(tokenFilters.tier, 'T1')
  assert.equal(freeText, '')
})

test('parseTokenQuery reads quoted multi-word values', () => {
  const { tokenFilters } = parseTokenQuery('company:"JP Morgan" role:"Senior Engineer"')
  assert.equal(tokenFilters.company, 'JP Morgan')
  assert.equal(tokenFilters.role, 'Senior Engineer')
})

test('parseTokenQuery keeps the non-token remainder as free text', () => {
  const { tokenFilters, freeText } = parseTokenQuery('backend company:Acme')
  assert.equal(tokenFilters.company, 'Acme')
  assert.equal(freeText, 'backend')
})

test('parseTokenQuery accepts both min-score and minscore spellings', () => {
  assert.equal(parseTokenQuery('min-score:7').tokenFilters.minScore, 7)
  assert.equal(parseTokenQuery('minscore:7.5').tokenFilters.minScore, 7.5)
})

test('parseTokenQuery treats a bare phrase as pure free text', () => {
  const { tokenFilters, freeText } = parseTokenQuery('data scientist')
  assert.deepEqual(tokenFilters, {})
  assert.equal(freeText, 'data scientist')
})

// ─── matchesTokenQuery ────────────────────────────────────────────────────────

const entry = makeScoreEntry({
  company: 'Stripe',
  role: 'ML Engineer',
  archetype: 'Strategy & Operations Analyst',
  tier: 'T1',
  location: 'Berlin / Paris',
  employment_type: 'Full-time',
  overall: 8.0,
})

test('matchesTokenQuery: substring company/role, exact tier', () => {
  assert.equal(matchesTokenQuery(entry, { company: 'strip' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { role: 'engineer' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { tier: 't1' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { tier: 'T2' }, ''), false)
})

test('matchesTokenQuery: archetype matches raw OR canonical bucket', () => {
  assert.equal(matchesTokenQuery(entry, { archetype: 'operations' }, ''), true)        // raw
  assert.equal(matchesTokenQuery(entry, { archetype: 'strategy & ops' }, ''), true)     // canonical
  assert.equal(matchesTokenQuery(entry, { archetype: 'marketing' }, ''), false)
})

test('matchesTokenQuery: location matches a parsed city', () => {
  assert.equal(matchesTokenQuery(entry, { location: 'paris' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { location: 'madrid' }, ''), false)
})

test('matchesTokenQuery: min-score is a floor', () => {
  assert.equal(matchesTokenQuery(entry, { minScore: 7 }, ''), true)   // 8.0 ≥ 7
  assert.equal(matchesTokenQuery(entry, { minScore: 9 }, ''), false)  // 8.0 < 9
})

test('matchesTokenQuery: a non-numeric min-score is ignored, not catastrophic', () => {
  // Regression: `min-score:x` → parseFloat → NaN. The two old copies disagreed
  // (the facet copy applied it, so `overall >= NaN` was always false and
  // silently emptied every count). The shared matcher ignores a non-finite
  // floor.
  assert.equal(matchesTokenQuery(entry, { minScore: NaN }, ''), true)
})

test('matchesTokenQuery: free text matches company OR role', () => {
  assert.equal(matchesTokenQuery(entry, {}, 'ml'), true)        // role
  assert.equal(matchesTokenQuery(entry, {}, 'stripe'), true)    // company
  assert.equal(matchesTokenQuery(entry, {}, 'zzz'), false)
})

test('matchesTokenQuery: tokens AND together, empty query matches all', () => {
  assert.equal(matchesTokenQuery(entry, { company: 'Stripe', tier: 'T1' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { company: 'Stripe', tier: 'T3' }, ''), false)
  assert.equal(matchesTokenQuery(entry, {}, ''), true)
})
