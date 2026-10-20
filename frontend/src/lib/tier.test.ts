import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreColor,
  scoreColorLight,
  tierColor,
  TIER_COLOR,
  NEUTRAL_SCORE_COLOR,
  tierVerdict,
  verdictTier,
} from '@/lib/tier'

test('scoreColor maps each band at its documented threshold', () => {
  assert.equal(scoreColor(9.5), TIER_COLOR.T1)     // ≥8 tier-1 (one ladder)
  assert.equal(scoreColor(9.0), TIER_COLOR.T1)
  assert.equal(scoreColor(8.0), TIER_COLOR.T1)     // ≥8 tier-1
  assert.equal(scoreColor(7.0), TIER_COLOR.T2)     // ≥7 tier-2 (apply threshold)
  assert.equal(scoreColor(6.9), 'rgb(var(--c-score-mid))')  // ≥5 the theme's secondary text
  assert.equal(scoreColor(5.0), 'rgb(var(--c-score-mid))')
  assert.equal(scoreColor(4.9), TIER_COLOR.T4)     // <5 faded
  assert.equal(scoreColor(0), TIER_COLOR.T4)
  assert.equal(TIER_COLOR.T1, 'rgb(var(--c-tier-1))')  // a theme token, never a hex
})

test('scoreColorLight uses the light companion token of each band', () => {
  assert.equal(scoreColorLight(9), 'rgb(var(--c-tier-1-light))')
  assert.equal(scoreColorLight(8), 'rgb(var(--c-tier-1-light))')
  assert.equal(scoreColorLight(7), 'rgb(var(--c-tier-2-light))')
  assert.equal(scoreColorLight(5), 'rgb(var(--c-tier-4))')
  assert.equal(scoreColorLight(4), 'rgb(var(--c-track))')
})

test('tierColor resolves known tiers, falls back to T4, and takes an alpha', () => {
  assert.equal(tierColor('T1', 0.2), 'rgb(var(--c-tier-1) / 0.2)')
  assert.equal(tierColor('nope', 0.2), 'rgb(var(--c-tier-4) / 0.2)')
  assert.equal(tierColor('T1'), TIER_COLOR.T1)
  assert.equal(tierColor('T2'), TIER_COLOR.T2)
  assert.equal(tierColor('T4'), TIER_COLOR.T4)
  assert.equal(tierColor('not-a-tier'), TIER_COLOR.T4)
  assert.equal(tierColor(undefined), TIER_COLOR.T4)
  assert.equal(tierColor(null), TIER_COLOR.T4)
})

test('NEUTRAL_SCORE_COLOR is the score-mid token', () => {
  assert.equal(NEUTRAL_SCORE_COLOR, 'rgb(var(--c-score-mid))')
})

test('tierVerdict / verdictTier: v2 verdict copy and its tier', () => {
  assert.equal(tierVerdict('stretch'), 'Stretch — apply with prep')
  assert.equal(tierVerdict('growth', { short: true }), 'Growth target')
  assert.equal(tierVerdict('thin'), 'If pipeline thin — only if your pipeline is thin')
  assert.equal(tierVerdict(null), '—')
  assert.equal(verdictTier('go'), 'T1')
  assert.equal(verdictTier('solid'), 'T2')
  assert.equal(verdictTier('blocked'), 'T4')
  assert.equal(verdictTier('nope'), null)
})
