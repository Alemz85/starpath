import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCompanyStats } from '@/lib/companyStats'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'

test('computeCompanyStats aggregates roles, Match/Ease, verdict, tier and cities', () => {
  const stats = computeCompanyStats([
    makeScoreEntry({ role: 'Analyst', match: 8.0, ease: 6.0, tier: 'T2', location: 'Berlin' }),   // stretch, p 6.93
    makeScoreEntry({ role: 'analyst', match: 6.0, ease: 9.0, tier: 'T4', location: 'Paris' }),    // skip, p 7.35
    makeBlockedEntry('x', { role: 'PM', location: 'Berlin / Madrid' }),
  ])
  assert.equal(stats.evalCount, 3)
  assert.equal(stats.roleCount, 2)            // analyst (case-insensitive) + pm
  assert.equal(stats.scoredCount, 2)          // blocked excluded
  assert.equal(stats.blockedCount, 1)
  assert.deepEqual(stats.best, { match: 6, ease: 9, verdict: 'skip' })  // highest Priority row
  assert.equal(stats.avgMatch, 7)
  assert.equal(stats.avgEase, 7.5)
  assert.equal(stats.bestVerdict, 'stretch')  // best cell, not best Priority
  assert.equal(stats.bestTier, 'T2')
  assert.deepEqual(stats.cities, ['Berlin', 'Madrid', 'Paris'])
})

test('computeCompanyStats: a blocked-only company has no scores but a verdict', () => {
  const stats = computeCompanyStats([makeBlockedEntry()])
  assert.equal(stats.best, null)
  assert.equal(stats.avgMatch, null)
  assert.equal(stats.bestVerdict, 'blocked')
  assert.equal(stats.bestTier, 'T4')
})

test('computeCompanyStats is safe over an empty history', () => {
  assert.deepEqual(computeCompanyStats([]), {
    evalCount: 0, roleCount: 0, scoredCount: 0, blockedCount: 0,
    best: null, avgMatch: null, avgEase: null, bestVerdict: null, bestTier: null, cities: [],
  })
})
