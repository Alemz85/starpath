// Unit tests for src/lib/offerDrafts.ts — the pure layer that turns the
// evaluation corpus into prefilled offer drafts for the Offer-comparison view.
// Covers the prefill mapping (which evaluation dims map to which factor),
// factor clamping, picker dedup/ranking, label building, and the
// readiness gate that mirrors compareOffers' preconditions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NEUTRAL_FACTOR,
  neutralScores,
  clampFactor,
  offerLabel,
  draftFromScoreEntry,
  blankDraft,
  scoreEntryKey,
  pickableRoles,
  draftsReadiness,
  type OfferDraft,
} from '@/lib/offerDrafts'
import { compareOffers } from '@/lib/offerCompare'
import type { ScoreEntry } from '@/types'
import { makeScoreEntry } from '@/test-utils/fixtures'

// Minimal ScoreEntry factory — only the fields offerDrafts reads matter.
function entry(over: Partial<ScoreEntry>): ScoreEntry {
  return makeScoreEntry({ date: '2026-06-01', archetype: '', tier: 'T2', ...over })
}

// ─── clampFactor ─────────────────────────────────────────────────────────────

test('clampFactor rounds and clamps into [1,10], neutral on non-finite', () => {
  assert.equal(clampFactor(7.6), 8)
  assert.equal(clampFactor(0), 1)
  assert.equal(clampFactor(12), 10)
  assert.equal(clampFactor(undefined), NEUTRAL_FACTOR)
  assert.equal(clampFactor(NaN), NEUTRAL_FACTOR)
  assert.equal(clampFactor(null), NEUTRAL_FACTOR)
})

test('neutralScores is all-5', () => {
  const s = neutralScores()
  assert.deepEqual(s, { comp: 5, fit: 5, growth: 5, brand: 5, location: 5, risk: 5 })
})

// ─── offerLabel ──────────────────────────────────────────────────────────────

test('offerLabel joins company and role, falls back gracefully', () => {
  assert.equal(offerLabel('Stripe', 'Analyst'), 'Stripe — Analyst')
  assert.equal(offerLabel('Stripe', ''), 'Stripe')
  assert.equal(offerLabel('', 'Analyst'), 'Analyst')
  assert.equal(offerLabel('', ''), 'Offer')
})

// ─── draftFromScoreEntry: the prefill mapping ────────────────────────────────

test('draftFromScoreEntry maps evaluation dims to the right factors', () => {
  const d = draftFromScoreEntry(
    entry({
      company: 'Stripe',
      role: 'BizOps',
      want: 8.4,
      ease: 6,
      growth_mobility: 9,
      brand_value: 10,
      salary_adj_city: 6,
    }),
  )
  assert.equal(d.label, 'Stripe — BizOps')
  assert.equal(d.scores.fit, 8) // Want 8.4 → rounded 8
  assert.equal(d.scores.growth, 9)
  assert.equal(d.scores.brand, 10)
  assert.equal(d.scores.comp, 6)
  // location + risk are NOT prefilled — they start neutral for the user to set.
  assert.equal(d.scores.location, NEUTRAL_FACTOR)
  assert.equal(d.scores.risk, NEUTRAL_FACTOR)
  assert.ok(d.sourceKey)
  assert.ok(d.id)
})

test('draftFromScoreEntry survives blocked/unscored rows with missing dims (no out-of-range)', () => {
  // A legacy score-history row with zeros must not produce a 0 factor that
  // would make compareOffers throw — clampFactor floors it to neutral/1.
  const d = draftFromScoreEntry(entry({ want: null, growth_mobility: null, brand_value: null, salary_adj_city: null }))
  for (const f of ['comp', 'fit', 'growth', 'brand', 'location', 'risk'] as const) {
    assert.ok(d.scores[f] >= 1 && d.scores[f] <= 10)
  }
})

test('blankDraft is all-neutral with the given label and no source', () => {
  const d = blankDraft('Hand-entered')
  assert.equal(d.label, 'Hand-entered')
  assert.equal(d.sourceKey, undefined)
  assert.deepEqual(d.scores, neutralScores())
})

// ─── scoreEntryKey + pickableRoles ───────────────────────────────────────────

test('scoreEntryKey prefers url, falls back to company|role (case-insensitive)', () => {
  assert.equal(scoreEntryKey(entry({ url: 'https://x.co/JOB' })), 'url:https://x.co/job')
  assert.equal(scoreEntryKey(entry({ company: 'Acme', role: 'Analyst', url: '' })), 'cr:acme|analyst')
})

test('pickableRoles dedups by entity, keeps latest, ranks by Priority desc', () => {
  const rows = [
    entry({ company: 'Acme', role: 'Analyst', want: 7, ease: 7, date: '2026-01-01' }),
    entry({ company: 'Acme', role: 'Analyst', want: 8.5, ease: 8.5, date: '2026-05-01' }), // newer, same entity
    entry({ company: 'Beta', role: 'PM', want: 9.1, ease: 9.1, date: '2026-03-01' }),
    entry({ company: '', role: 'orphan', want: 9.9, ease: 9.9 }), // dropped: no company
  ]
  const picks = pickableRoles(rows)
  assert.equal(picks.length, 2)
  // Beta (9.1) ranks above Acme; Acme uses the NEWER evaluation (8.5, not 7).
  assert.deepEqual(picks.map((p) => p.company), ['Beta', 'Acme'])
  assert.equal(picks[1].want, 8.5)
  assert.equal(picks[1].priority, 8.5)
})

// ─── draftsReadiness: mirrors compareOffers preconditions ────────────────────

test('draftsReadiness requires ≥2 drafts', () => {
  assert.deepEqual(draftsReadiness([blankDraft('Solo')]), { ready: false, reason: 'need-two' })
})

test('draftsReadiness rejects blank and duplicate labels', () => {
  const a = blankDraft('A')
  const blank = blankDraft('')
  assert.equal(draftsReadiness([a, blank]).reason, 'blank-label')

  const dupA: OfferDraft = blankDraft('Same')
  const dupB: OfferDraft = blankDraft('same') // case-insensitive collision
  assert.equal(draftsReadiness([dupA, dupB]).reason, 'duplicate-label')
})

test('draftsReadiness passes for 2 unique-labelled drafts, and they compare cleanly', () => {
  const drafts = [blankDraft('Alpha'), blankDraft('Bravo')]
  assert.deepEqual(draftsReadiness(drafts), { ready: true })
  // The contract: a "ready" draft set never throws in the engine.
  const res = compareOffers(drafts.map((d) => ({ label: d.label, scores: d.scores })))
  assert.equal(res.ranking.length, 2)
})
