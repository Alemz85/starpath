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

test('parseTokenQuery reads the v2 min-want / min-ease floors (both spellings)', () => {
  assert.equal(parseTokenQuery('min-want:7').tokenFilters.minWant, 7)
  assert.equal(parseTokenQuery('minwant:7.5').tokenFilters.minWant, 7.5)
  assert.equal(parseTokenQuery('min-ease:5').tokenFilters.minEase, 5)
  assert.equal(parseTokenQuery('minease:6.5').tokenFilters.minEase, 6.5)
})

test('parseTokenQuery reads verdict and eligibility tokens', () => {
  const { tokenFilters } = parseTokenQuery('verdict:"growth target" eligibility:amber')
  assert.equal(tokenFilters.verdict, 'growth target')
  assert.equal(tokenFilters.eligibility, 'amber')
  assert.equal(parseTokenQuery('elig:red').tokenFilters.eligibility, 'red')
})

test('the retired min-score token is no longer a filter', () => {
  assert.deepEqual(parseTokenQuery('min-score:7').tokenFilters, {})
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
  want: 8.0,
  ease: 6.0,
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

test('matchesTokenQuery: min-want / min-ease are per-axis floors', () => {
  assert.equal(matchesTokenQuery(entry, { minWant: 7 }, ''), true)    // 8.0 ≥ 7
  assert.equal(matchesTokenQuery(entry, { minWant: 9 }, ''), false)
  assert.equal(matchesTokenQuery(entry, { minEase: 6 }, ''), true)    // 6.0 ≥ 6
  assert.equal(matchesTokenQuery(entry, { minEase: 6.5 }, ''), false)
})

test('matchesTokenQuery: a non-numeric floor is ignored, not catastrophic', () => {
  // Regression guard: `min-want:x` → parseFloat → NaN must not empty the
  // results (or the facet counts) — the shared matcher ignores it.
  assert.equal(matchesTokenQuery(entry, { minWant: NaN, minEase: NaN }, ''), true)
})

test('matchesTokenQuery: a floor excludes a blocked row (it has no scores)', () => {
  const blocked = makeScoreEntry({ eligibility: 'red', verdict: 'blocked' })
  assert.equal(matchesTokenQuery(blocked, { minWant: 1 }, ''), false)
  assert.equal(matchesTokenQuery(blocked, {}, ''), true)
})

test('matchesTokenQuery: verdict matches the key or the label; eligibility exact', () => {
  assert.equal(matchesTokenQuery(entry, { verdict: 'stretch' }, ''), true)     // 8.0 × 6.0
  assert.equal(matchesTokenQuery(entry, { verdict: 'Stretch' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { verdict: 'go' }, ''), false)
  const growth = makeScoreEntry({ want: 9, ease: 4 })
  assert.equal(matchesTokenQuery(growth, { verdict: 'growth target' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { eligibility: 'GREEN' }, ''), true)
  assert.equal(matchesTokenQuery(entry, { eligibility: 'red' }, ''), false)
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
