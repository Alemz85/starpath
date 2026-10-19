import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreColor,
  scoreColorLight,
  tierHex,
  TIER_HEX,
  NEUTRAL_SCORE_COLOR,
  tierVerdict,
  verdictTier,
} from '@/lib/tier'

test('scoreColor maps each band at its documented threshold', () => {
  assert.equal(scoreColor(9.5), TIER_HEX.T1)     // ≥8 deep indigo (one ladder, no teal)
  assert.equal(scoreColor(9.0), TIER_HEX.T1)
  assert.equal(scoreColor(8.0), TIER_HEX.T1)     // ≥8 deep indigo
  assert.equal(scoreColor(7.0), TIER_HEX.T2)     // ≥7 galaxy violet (apply threshold)
  assert.equal(scoreColor(6.9), '#5D6C7B')       // ≥5 slate
  assert.equal(scoreColor(5.0), '#5D6C7B')
  assert.equal(scoreColor(4.9), '#94A3B8')       // <5 faded slate
  assert.equal(scoreColor(0), '#94A3B8')
})

test('scoreColorLight stays in the cosmic family per band', () => {
  assert.equal(scoreColorLight(9), '#7C5CFF')    // indigo fades into violet
  assert.equal(scoreColorLight(8), '#7C5CFF')
  assert.equal(scoreColorLight(7), '#B5A3FF')
  assert.equal(scoreColorLight(5), '#94A3B8')
  assert.equal(scoreColorLight(4), '#CED0D4')
})

test('tierHex resolves known tiers and falls back to T4', () => {
  assert.equal(tierHex('T1'), TIER_HEX.T1)
  assert.equal(tierHex('T2'), TIER_HEX.T2)
  assert.equal(tierHex('T4'), TIER_HEX.T4)
  assert.equal(tierHex('not-a-tier'), TIER_HEX.T4)
  assert.equal(tierHex(undefined), TIER_HEX.T4)
  assert.equal(tierHex(null), TIER_HEX.T4)
})

test('NEUTRAL_SCORE_COLOR is the slate secondary token', () => {
  assert.equal(NEUTRAL_SCORE_COLOR, '#5D6C7B')
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
