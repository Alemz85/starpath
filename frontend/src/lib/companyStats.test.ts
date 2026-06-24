import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCompanyStats } from '@/lib/companyStats'
import { makeScoreEntry } from '@/test-utils/fixtures'

test('computeCompanyStats aggregates roles, scores, tier and cities', () => {
  const stats = computeCompanyStats([
    makeScoreEntry({ role: 'Analyst', overall: 8.0, tier: 'T2', location: 'Berlin' }),
    makeScoreEntry({ role: 'analyst', overall: 6.0, tier: 'T1', location: 'Paris' }),  // dup role, different case
    makeScoreEntry({ role: 'PM',      overall: 0,   tier: 'T3', location: 'Berlin / Madrid' }),
  ])
  assert.equal(stats.evalCount, 3)
  assert.equal(stats.roleCount, 2)            // analyst (case-insensitive) + pm
  assert.equal(stats.scoredCount, 2)          // overall > 0
  assert.equal(stats.bestScore, 8.0)
  assert.equal(stats.avgScore, 7.0)           // (8 + 6) / 2
  assert.equal(stats.bestTier, 'T1')          // strongest rank present
  assert.deepEqual(stats.cities, ['Berlin', 'Madrid', 'Paris'])  // distinct, sorted
})

test('computeCompanyStats collapses T2-high to T2 for display', () => {
  const stats = computeCompanyStats([makeScoreEntry({ overall: 9, tier: 'T2-high' })])
  assert.equal(stats.bestTier, 'T2')
})

test('computeCompanyStats is safe over an empty history', () => {
  const stats = computeCompanyStats([])
  assert.deepEqual(stats, {
    evalCount: 0, roleCount: 0, scoredCount: 0,
    bestScore: 0, avgScore: 0, bestTier: null, cities: [],
  })
})
