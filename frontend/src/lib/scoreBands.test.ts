// scoreBands.test.ts — pins the renderer mirror of the v2 engine to the
// formulas and boundary cells in docs/scoring-v2.md (§2 Match, §3 Ease, §4
// verdict grid, §5 Priority, §8 cell formats). The backend pins the same
// cases in scripts/lib/score-bands.test.mjs; if a rule changes, both sides
// and the spec move in the same commit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assignVerdict,
  computePriority,
  computeMatch,
  computeEase,
  hygieneDelta,
  parseEligibilityFlags,
  parseEligibilityCell,
  parseScoreCell,
  formatScoreCell,
  eligibilityCheckLabel,
  normalizeTier,
  normalizeVerdict,
  verdictOf,
  priorityOf,
  blockedReason,
  amberCountOf,
  recommendsAgainst,
  VERDICT_LABELS,
  VERDICT_TIER,
  VERDICT_RANK,
  MATCH_HIGH, MATCH_MID, EASE_HIGH, EASE_MID,
  MOTIVATOR_BOTTOM_PENALTY, HYGIENE_VETO_CAP, ROLE_CONTENT_VETO_AT, ROLE_CONTENT_VETO_CAP,
  DREAM_MATCH_FLOOR, DEFAULT_MATCH_WEIGHTS, DEFAULT_EASE_WEIGHTS,
  EXPERIENCE_WALL_AT, EXPERIENCE_WALL_CAP, AMBER_EASE_PENALTY, AMBER_EASE_PENALTY_MAX, REFERRAL_BONUS,
} from '@/lib/scoreBands'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'

/* ───── constants, by spec name ─────────────────────────────────────────── */

test('constants carry the spec values', () => {
  assert.equal(MATCH_HIGH, 8.0)
  assert.equal(MATCH_MID, 6.5)
  assert.equal(EASE_HIGH, 7.0)
  assert.equal(EASE_MID, 5.0)
  assert.equal(MOTIVATOR_BOTTOM_PENALTY, 0.30)
  assert.equal(HYGIENE_VETO_CAP, 5.0)
  assert.equal(ROLE_CONTENT_VETO_AT, 3)
  assert.equal(ROLE_CONTENT_VETO_CAP, 6.0)
  assert.equal(DREAM_MATCH_FLOOR, 8.0)
  assert.deepEqual(DEFAULT_MATCH_WEIGHTS, { growth_mobility: 1, optionality_exit: 1, brand_value: 1, role_content: 1 })
  assert.deepEqual(DEFAULT_EASE_WEIGHTS, { skills_match: 0.35, experience_bar: 0.35, competition: 0.30 })
  assert.equal(EXPERIENCE_WALL_AT, 3)
  assert.equal(EXPERIENCE_WALL_CAP, 4.5)
  assert.equal(AMBER_EASE_PENALTY, 0.5)
  assert.equal(AMBER_EASE_PENALTY_MAX, 1.0)
  assert.deepEqual(REFERRAL_BONUS, { 'warm-direct': 1.0, 'warm-intro': 0.5 })
})

test('verdict labels and tiers match the spec grid', () => {
  assert.deepEqual(VERDICT_LABELS, {
    go: 'Go', stretch: 'Stretch', growth: 'Growth target', solid: 'Solid',
    thin: 'If pipeline thin', skip: 'Skip', blocked: 'Blocked',
  })
  assert.deepEqual(VERDICT_TIER, {
    go: 'T1', stretch: 'T2', solid: 'T2', thin: 'T2', growth: 'T3', skip: 'T4', blocked: 'T4',
  })
  const order = Object.entries(VERDICT_RANK).sort((a, b) => a[1] - b[1]).map(([v]) => v)
  assert.deepEqual(order, ['blocked', 'skip', 'thin', 'growth', 'solid', 'stretch', 'go'])
})

/* ───── §4 grid — every cell and every boundary ─────────────────────────── */

const grid: Array<[number, number, string]> = [
  // Match ≥ 8.0 row
  [8.0, 7.0, 'go'], [9.5, 9.5, 'go'],
  [8.0, 6.99, 'stretch'], [8.0, 5.0, 'stretch'],
  [8.0, 4.99, 'growth'], [10, 1, 'growth'],
  // 6.5 ≤ Match < 8.0 row
  [7.99, 7.0, 'solid'], [6.5, 10, 'solid'],
  [6.5, 5.0, 'thin'], [7.99, 6.99, 'thin'],
  [6.5, 4.99, 'skip'],
  // Match < 6.5 row — skip in every column
  [6.49, 10, 'skip'], [6.49, 6, 'skip'], [1, 1, 'skip'],
]
for (const [match, ease, verdict] of grid) {
  test(`assignVerdict: Match ${match} × Ease ${ease} → ${verdict}`, () => {
    const r = assignVerdict({ match, ease, eligibility: 'green' })!
    assert.equal(r.verdict, verdict)
    assert.equal(r.tier, VERDICT_TIER[r.verdict])
  })
}

test('assignVerdict: red eligibility is blocked regardless of scores', () => {
  assert.deepEqual(
    { ...assignVerdict({ match: 9, ease: 9, eligibility: 'red' }) },
    { verdict: 'blocked', tier: 'T4', reason: 'Eligibility red' },
  )
  assert.equal(assignVerdict({ match: null, ease: null, eligibility: 'red' })!.verdict, 'blocked')
})

test('assignVerdict: amber is scored normally; missing scores → null', () => {
  assert.equal(assignVerdict({ match: 8.25, ease: 5.6, eligibility: 'amber' })!.verdict, 'stretch')
  assert.equal(assignVerdict({ match: null, ease: 7, eligibility: 'green' }), null)
  assert.equal(assignVerdict({ match: 7, ease: undefined }), null)
})

test('assignVerdict reason names both axes', () => {
  assert.equal(assignVerdict({ match: 8.25, ease: 5.6 })!.reason, 'Match 8.25 ≥ 8.0, Ease 5.6 in 5.0–7.0')
})

test('recommendsAgainst: skip and blocked only (ethical-use rule)', () => {
  assert.equal(recommendsAgainst('skip'), true)
  assert.equal(recommendsAgainst('blocked'), true)
  assert.equal(recommendsAgainst('thin'), false)
  assert.equal(recommendsAgainst('go'), false)
  assert.equal(recommendsAgainst(null), false)
})

/* ───── §5 Priority ─────────────────────────────────────────────────────── */

test('priority = round(sqrt(match × ease), 2); null when either is missing', () => {
  assert.equal(computePriority(8.25, 5.6), 6.8)
  assert.equal(computePriority(9, 4), 6)
  assert.equal(computePriority(null, 5), null)
  assert.equal(priorityOf(makeBlockedEntry()), null)
  assert.equal(priorityOf(makeScoreEntry({ match: 8, ease: 2, priority: null })), 4)
  assert.equal(priorityOf(makeScoreEntry({ match: 8, ease: 2, priority: 4.01 })), 4.01)
})

/* ───── §2 Match ─────────────────────────────────────────────────────────── */

test('hygiene steps h(x)', () => {
  assert.equal(hygieneDelta(10), 0.25)
  assert.equal(hygieneDelta(8), 0.25)
  assert.equal(hygieneDelta(7), 0)
  assert.equal(hygieneDelta(5), 0)
  assert.equal(hygieneDelta(4), -0.40)
  assert.equal(hygieneDelta(3), -0.80)
  assert.equal(hygieneDelta(2), -1.20)
  assert.equal(hygieneDelta(1), -1.20)
})

const motiv = (g: number, o: number, b: number, r: number) =>
  ({ growth_mobility: g, optionality_exit: o, brand_value: b, role_content: r })

test('Match: spec example — M 8.0 + city +0.25 = 8.25', () => {
  const w = computeMatch({ ...motiv(8, 8, 9, 7), best_cities: 8, salary_adj_city: 6, work_life_balance: 6 })
  assert.equal(w.motivators_mean, 8)
  assert.equal(w.score, 8.25)
  assert.deepEqual(w.hygiene, { best_cities: 0.25, salary_adj_city: 0, work_life_balance: 0 })
  assert.deepEqual(w.vetoes, [])
})

test('Match: −0.30 per motivator ≤ 2', () => {
  const w = computeMatch({ ...motiv(2, 2, 8, 8), best_cities: 6, salary_adj_city: 6, work_life_balance: 6 })
  assert.equal(w.motivator_penalty, 0.6)
  assert.equal(w.score, 4.4) // 5.0 − 0.6
})

test('Match: interns ignore the salary hygiene term and its veto', () => {
  const dims = { ...motiv(8, 8, 8, 8), best_cities: 6, salary_adj_city: 1, work_life_balance: 6 }
  assert.equal(computeMatch(dims, { is_intern: true }).score, 8)
  // Non-intern: salary h = −1.20 and the hygiene veto caps at 5.0.
  const w = computeMatch(dims)
  assert.equal(w.score, 5)
  assert.deepEqual(w.vetoes, ['hygiene'])
})

test('Match: dream floor lifts to 8.0, vetoes still win over it', () => {
  const low = { ...motiv(6, 6, 6, 6), best_cities: 6, salary_adj_city: 6, work_life_balance: 6 }
  assert.equal(computeMatch(low, { dream: true }).score, 8)
  assert.equal(computeMatch(low, { dream: true }).floor, 8)
  const vetoed = { ...motiv(6, 6, 6, 3), best_cities: 6, salary_adj_city: 6, work_life_balance: 6 }
  assert.equal(computeMatch(vetoed, { dream: true }).score, ROLE_CONTENT_VETO_CAP)
  const hygieneVeto = { ...motiv(6, 6, 6, 6), best_cities: 2, salary_adj_city: 6, work_life_balance: 6 }
  assert.equal(computeMatch(hygieneVeto, { dream: true }).score, HYGIENE_VETO_CAP)
})

test('Match: role_content ≤ 3 caps at 6.0; 4 does not', () => {
  const at3 = computeMatch({ ...motiv(10, 10, 10, 3), best_cities: 8, salary_adj_city: 8, work_life_balance: 8 })
  assert.equal(at3.score, 6)
  assert.ok(at3.vetoes.includes('role_content'))
  const at4 = computeMatch({ ...motiv(10, 10, 10, 4), best_cities: 8, salary_adj_city: 8, work_life_balance: 8 })
  assert.equal(at4.score, 9.25)
})

test('Match: custom weights', () => {
  const w = computeMatch({ ...motiv(10, 4, 4, 4), best_cities: 6, salary_adj_city: 6, work_life_balance: 6 },
    { weights: { growth_mobility: 2 } })
  assert.equal(w.score, 6.4) // (20 + 12) / 5
})

/* ───── §3 Ease ─────────────────────────────────────────────────────────── */

test('Ease: weighted geometric mean', () => {
  const e = computeEase({ skills_match: 8, experience_bar: 6, competition: 5 })
  const expected = Math.exp((0.35 * Math.log(8) + 0.35 * Math.log(6) + 0.30 * Math.log(5)) / 1.0)
  assert.equal(e.score, Math.round(expected * 100) / 100)
  assert.equal(e.wall, false)
})

test('Ease: experience wall at ≤ 3 caps at 4.5; 4 is not a wall', () => {
  const wall = computeEase({ skills_match: 10, experience_bar: 3, competition: 10 })
  assert.equal(wall.wall, true)
  assert.equal(wall.score, 4.5)
  const noWall = computeEase({ skills_match: 10, experience_bar: 4, competition: 10 })
  assert.equal(noWall.wall, false)
  assert.ok(noWall.score > 4.5)
})

test('Ease: −0.5 per amber check, max −1.0, clamped at 1', () => {
  const d = { skills_match: 6, experience_bar: 6, competition: 6 }
  assert.equal(computeEase(d).score, 6)
  assert.equal(computeEase(d, { amber_count: 1 }).score, 5.5)
  assert.equal(computeEase(d, { amber_count: 2 }).score, 5)
  assert.equal(computeEase(d, { amber_count: 5 }).score, 5)
  assert.equal(computeEase({ skills_match: 1, experience_bar: 1, competition: 1 }, { amber_count: 2 }).score, 1)
})

/* ───── §8 cell formats ─────────────────────────────────────────────────── */

test('parseEligibilityFlags reads check:status:reason;… (reason may contain colons)', () => {
  assert.deepEqual(parseEligibilityFlags(''), [])
  assert.deepEqual(parseEligibilityFlags('start_date:amber:start not stated;language:red:German C1: required'), [
    { check: 'start_date', status: 'amber', reason: 'start not stated' },
    { check: 'language', status: 'red', reason: 'German C1: required' },
  ])
  assert.deepEqual(parseEligibilityFlags('other:amber:STEM degree required'), [
    { check: 'other', status: 'amber', reason: 'STEM degree required' },
  ])
  assert.deepEqual(parseEligibilityFlags('garbage;;x:purple:nope'), [])
})

test('amberCountOf / blockedReason', () => {
  assert.equal(amberCountOf(makeScoreEntry({ eligibility_flags: 'a:amber:x;b:amber:y;c:red:z' })), 2)
  assert.equal(blockedReason(makeBlockedEntry('Needs existing right to work')), 'Needs existing right to work')
  assert.equal(blockedReason(makeScoreEntry({ eligibility_flags: 'work_auth:red:' })), 'Work authorisation')
  assert.equal(blockedReason(makeScoreEntry()), 'Not eligible')
})

test('parseEligibilityCell reads the scouting Eligibility cell', () => {
  assert.deepEqual(parseEligibilityCell('green'), { status: 'green', reason: '' })
  assert.deepEqual(parseEligibilityCell('amber: start date not stated; 14 months'), { status: 'amber', reason: 'start date not stated; 14 months' })
  assert.deepEqual(parseEligibilityCell('red: German C1 required'), { status: 'red', reason: 'German C1 required' })
  assert.deepEqual(parseEligibilityCell(''), { status: null, reason: '' })
})

test('eligibilityCheckLabel: known labels plus a humanised fallback', () => {
  assert.equal(eligibilityCheckLabel('work_auth'), 'Work authorisation')
  assert.equal(eligibilityCheckLabel('other'), 'Other requirement')
  assert.equal(eligibilityCheckLabel('security_clearance'), 'Security clearance')
})

test('parseScoreCell / formatScoreCell round-trip', () => {
  assert.equal(formatScoreCell(8.25, 5.6), 'M8.3 E5.6')
  assert.deepEqual(parseScoreCell(formatScoreCell(8.25, 5.6)), { match: 8.3, ease: 5.6 })
  assert.deepEqual(parseScoreCell('7.4/10'), { legacy: 7.4 })
  assert.equal(parseScoreCell('—'), null)
})

test('normalizeTier / normalizeVerdict / verdictOf', () => {
  assert.equal(normalizeTier('t2'), 'T2')
  assert.equal(normalizeTier('tier-3'), 'T3')
  assert.equal(normalizeTier('T2-high'), null) // retired in v2
  assert.equal(normalizeTier('full'), null)    // v1 vocabulary retired
  assert.equal(normalizeVerdict('Stretch'), 'stretch')
  assert.equal(normalizeVerdict('stellar'), null)
  assert.equal(verdictOf(makeScoreEntry({ match: 8.5, ease: 7.5 })), 'go')
  assert.equal(verdictOf(makeScoreEntry({ match: 8.5, ease: 7.5, verdict: 'thin' })), 'thin') // stored wins
  assert.equal(verdictOf(makeBlockedEntry()), 'blocked')
})
