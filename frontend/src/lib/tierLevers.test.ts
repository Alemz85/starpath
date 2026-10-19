import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rowLever,
  verdictLevers,
  replay,
  v2DimsOf,
  isInternRow,
  isNearUpgrade,
  filterNearUpgrades,
  leverContextOf,
  hasScoredDims,
  reportFixability,
  bindingConstraints,
  leverSentence,
  NEAR_MISS_MAX_LIFT,
  LEVER_MAX_STEPS,
  type V2Dims,
  type LeverContext,
} from '@/lib/tierLevers'
import type { ScoreEntry } from '@/types'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'

// These cases pin the spec's boundary behaviour (docs/scoring-v2.md §2–§4,
// §7): the verdict grid edges, the experience wall, both Want vetoes, the
// dream floor, the intern salary carve-out, the amber resolve (+0.5 Ease),
// and the +4-step search horizon. Each expected value is derived by hand from
// the spec formulas in the comment beside it.

const ctx = (over: Partial<LeverContext> = {}): LeverContext => ({
  is_intern: false, dream: false, amber_count: 0, ...over,
})

const dims = (over: Partial<V2Dims> = {}): V2Dims => ({
  growth_mobility: 6, optionality_exit: 6, brand_value: 6, role_content: 6,
  best_cities: 6, salary_adj_city: 6, work_life_balance: 6,
  skills_match: 6, experience_bar: 6, competition: 6,
  ...over,
})

// A ScoreEntry whose stored Want/Ease/verdict are the replay of its dims
// (what a fresh evaluation at default weights writes).
function entry(d: Partial<V2Dims> = {}, over: Partial<ScoreEntry> = {}): ScoreEntry {
  const full = dims(d)
  const base = makeScoreEntry({ ...full, employment_type: 'full-time', ...over })
  const r = replay(full, leverContextOf(base, full))
  return { ...base, want: r.want, ease: r.ease, verdict: r.verdict, tier: '', ...over }
}

test('constants: +4-step horizon, one-step near-miss', () => {
  assert.equal(LEVER_MAX_STEPS, 4)
  assert.equal(NEAR_MISS_MAX_LIFT, 1)
})

test('replay: all-6 dims → Want 6.0 (M 6, no hygiene), Ease 6.0 → skip (Want < 6.5)', () => {
  assert.deepEqual(replay(dims(), ctx()), { want: 6, ease: 6, verdict: 'skip' })
})

test('all-6 row: one motivator +2 reaches Want 6.5 exactly → thin (grid edge is inclusive)', () => {
  // M = (8 + 6 + 6 + 6) / 4 = 6.5 → 6.5 ≤ Want < 8, 5 ≤ Ease < 7 → thin.
  const [best] = verdictLevers(dims(), ctx())
  assert.equal(best.kind, 'dimension')
  assert.equal(best.dimension, 'growth_mobility') // first motivator wins the tie
  assert.equal(best.from, 6)
  assert.equal(best.to, 8)
  assert.equal(best.lift, 2)
  assert.equal(best.fromVerdict, 'skip')
  assert.equal(best.toVerdict, 'thin')
  assert.equal(best.toTier, 'T2')
})

test('stretch → go: Ease 6.69 needs one step on skills or experience (≥ 7.0 edge)', () => {
  // Want: M (8+8+9+7)/4 = 8.0, City 8 → +0.25 → 8.25.
  // Ease: 7^0.35 · 7^0.35 · 6^0.30 = 6.69 → stretch. skills 7→8: 8^.35·7^.35·6^.3 = 7.00 → go.
  const e = entry({
    growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7, best_cities: 8,
    skills_match: 7, experience_bar: 7, competition: 6,
  })
  assert.equal(e.want, 8.25)
  assert.equal(e.verdict, 'stretch')
  const r = rowLever(e)
  assert.equal(r.best?.dimension, 'skills_match') // ties with experience_bar & competition; higher `from`, then spec order
  assert.equal(r.best?.toVerdict, 'go')
  assert.equal(r.best?.lift, 1)
  assert.equal(r.nearMiss, true)
  assert.equal(r.verdict, 'stretch')
})

test('experience wall: experience_bar 3 caps Ease at 4.5 → growth; 3→4 lifts the wall', () => {
  // Motivators 9 → Want 9.0. Ease geo 9^.65·3^.35 ≈ 5.88, capped at 4.5 → growth.
  // experience 4: 9^.65·4^.35 ≈ 6.53, no wall → stretch.
  const e = entry({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9, skills_match: 9, experience_bar: 3, competition: 9 })
  assert.equal(e.ease, 4.5)
  assert.equal(e.verdict, 'growth')
  const r = rowLever(e)
  assert.equal(r.best?.dimension, 'experience_bar')
  assert.equal(r.best?.to, 4)
  assert.equal(r.best?.toVerdict, 'stretch')
  assert.ok(bindingConstraints(e).some(c => c.kind === 'experience_wall'))
})

test('amber resolve is a lever (+0.5 Ease) and wins a one-step tie', () => {
  // Want 8.0. Ease 7^.7·8^.3 ≈ 7.29 − 0.5 amber = 6.79 → stretch; resolving it → 7.29 → go.
  const e = entry(
    { growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, skills_match: 7, experience_bar: 7, competition: 8 },
    { eligibility: 'amber', eligibility_flags: 'start_date:amber:start date not stated' },
  )
  assert.equal(e.verdict, 'stretch')
  const r = rowLever(e)
  assert.equal(r.best?.kind, 'amber')
  assert.equal(r.best?.check, 'start_date')
  assert.equal(r.best?.dimension, null)
  assert.equal(r.best?.toVerdict, 'go')
  assert.equal(r.best?.lift, 1)
  assert.match(leverSentence(r.best!), /^Resolve start date → Go$/)
})

test('amber resolve also works for the `other` check', () => {
  const e = entry(
    { growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, skills_match: 7, experience_bar: 7, competition: 8 },
    { eligibility: 'amber', eligibility_flags: 'other:amber:STEM degree required' },
  )
  assert.equal(rowLever(e).best?.check, 'other')
  assert.equal(rowLever(e).best?.label, 'Resolve other requirement')
})

test('role-content veto: role_content 3 caps Want at 6.0; 3→4 lifts it to solid', () => {
  // M (9+9+9+3)/4 = 7.5 → capped 6.0 → skip. role 4: M 7.75 → solid (Ease 8).
  const e = entry({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 3, skills_match: 8, experience_bar: 8, competition: 8 })
  assert.equal(e.want, 6)
  assert.equal(e.verdict, 'skip')
  const r = rowLever(e)
  assert.equal(r.best?.dimension, 'role_content')
  assert.equal(r.best?.to, 4)
  assert.equal(r.best?.toVerdict, 'solid')
  assert.ok(bindingConstraints(e).some(c => c.kind === 'role_content_veto'))
})

test('hygiene veto: WLB 2 caps Want at 5.0; 2→3 removes the veto (h −0.80) → go', () => {
  // M 9; WLB 2 → veto cap 5.0 → skip. WLB 3 → 9 − 0.8 = 8.2 ≥ 8 with Ease 8 → go.
  const e = entry({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9, work_life_balance: 2, skills_match: 8, experience_bar: 8, competition: 8 })
  assert.equal(e.want, 5)
  const r = rowLever(e)
  assert.equal(r.best?.dimension, 'work_life_balance')
  assert.equal(r.best?.to, 3)
  assert.equal(r.best?.toVerdict, 'go')
  assert.ok(bindingConstraints(e).some(c => c.kind === 'hygiene_veto'))
})

test('interns: salary 1 neither costs Want nor vetoes it', () => {
  const e = entry({ growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, salary_adj_city: 1 }, { employment_type: 'Internship' })
  assert.equal(isInternRow(e), true)
  assert.equal(e.want, 8)
  assert.ok(!bindingConstraints(e).some(c => c.kind === 'hygiene_veto'))
  const nonIntern = entry({ growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, salary_adj_city: 1 })
  assert.equal(nonIntern.want, 5)
})

test('dream floor is inferred from the stored Want and holds Want at 8.0', () => {
  // Motivators 6 replay to 6.0, but the stored Want is 8.0 → floor in force.
  const base = makeScoreEntry({ ...dims(), want: 8, ease: 6, verdict: 'stretch', employment_type: 'full-time' })
  assert.equal(leverContextOf(base).dream, true)
  const r = rowLever(base)
  // Want stays 8 (floored); the lever must come from Ease: one Ease dim 6→8.
  assert.equal(r.verdict, 'stretch')
  assert.ok(r.best && ['skills_match', 'experience_bar', 'competition'].includes(r.best.dimension!))
  assert.equal(r.best?.toVerdict, 'go')
})

test('a lever must beat the STORED verdict, not only the replay', () => {
  // Stored 'solid' (e.g. custom weights), dims replay to 'skip': a probe that
  // only reaches thin is not an improvement over solid.
  const e = makeScoreEntry({ ...dims(), want: 7.5, ease: 7.2, verdict: 'solid' })
  const r = rowLever(e)
  if (r.best) assert.ok(['stretch', 'go'].includes(r.best.toVerdict))
})

test('no single change within +4 steps → best null', () => {
  // Motivators 2 → M 2 − 1.2 penalty → clamp 1. One motivator +4 (6) still < 6.5.
  const e = entry({ growth_mobility: 2, optionality_exit: 2, brand_value: 2, role_content: 2 })
  assert.equal(e.want, 1)
  assert.equal(rowLever(e).best, null)
  assert.equal(rowLever(e).nearMiss, false)
})

test('go rows have no lever; blocked rows have no lever and keep their verdict', () => {
  const go = entry({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9, skills_match: 9, experience_bar: 9, competition: 9 })
  assert.equal(go.verdict, 'go')
  assert.equal(rowLever(go).best, null)
  const blocked = makeBlockedEntry()
  const r = rowLever(blocked)
  assert.equal(r.best, null)
  assert.equal(r.verdict, 'blocked')
  assert.equal(r.tier, 'T4')
  assert.deepEqual(bindingConstraints(blocked), [{ kind: 'eligibility_red', detail: 'German C1 required' }])
})

test('hasScoredDims / v2DimsOf need every dim and a non-red row', () => {
  assert.equal(hasScoredDims(entry()), true)
  assert.equal(hasScoredDims(makeScoreEntry()), false)          // all null
  assert.equal(hasScoredDims({ ...entry(), competition: null }), false)
  assert.equal(hasScoredDims(makeBlockedEntry()), false)
  assert.equal(hasScoredDims(null), false)
  assert.equal(v2DimsOf(makeScoreEntry()), null)
})

test('isNearUpgrade / filterNearUpgrades use the one-step rule', () => {
  const near = entry({
    growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7, best_cities: 8,
    skills_match: 7, experience_bar: 7, competition: 6,
  })
  const far = entry() // needs +2
  assert.equal(isNearUpgrade(near), true)
  assert.equal(isNearUpgrade(far), false)
  assert.deepEqual(filterNearUpgrades([near, far], true), [near])
  assert.deepEqual(filterNearUpgrades([near, far], false), [near, far])
})

test('bindingConstraints names the low axis against the next grid threshold', () => {
  const c = bindingConstraints(entry())
  assert.ok(c.some(x => x.kind === 'low_want' && /< 6\.5/.test(x.detail)))
  assert.ok(c.some(x => x.kind === 'low_ease' && /< 7\.0/.test(x.detail)))
})

test('reportFixability: engine verdict when dims exist; no dims → not a near-miss', () => {
  const near = entry({
    growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7, best_cities: 8,
    skills_match: 7, experience_bar: 7, competition: 6,
  })
  const eng = reportFixability({ scoreEntry: near })
  assert.equal(eng.nearMiss, true)
  assert.equal(eng.fixabilityScore, 1)
  assert.equal(eng.engineLever?.toVerdict, 'go')
  assert.deepEqual(reportFixability({ scoreEntry: null }), { nearMiss: false, engineLever: null, fixabilityScore: 0 })
  assert.deepEqual(reportFixability({ scoreEntry: makeBlockedEntry() }), { nearMiss: false, engineLever: null, fixabilityScore: 0 })
})
