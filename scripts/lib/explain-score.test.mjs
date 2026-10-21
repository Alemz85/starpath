// Unit tests for the scoring explainability layer (explain-score.mjs, v2).
//
// These pin the binding constraints, levers, sensitivity and the report text.
// The lever search replays the canonical engine (rollupMatch / rollupEase /
// assignVerdict), so these tests double as a tripwire: if score-bands.mjs
// moves a threshold, a lever assertion here flips and we notice.
//
// Plain ESM, zero deps: `node --test scripts/lib/explain-score.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindingConstraints,
  drivers,
  verdictLevers,
  sensitivity,
  explainScore,
  DIM_LABELS,
  LEVER_DIMS,
} from './explain-score.mjs'
import { rollupMatch, rollupEase, assignVerdict } from './score-bands.mjs'

// Full v2 dim set with sensible defaults; override what a test cares about.
const D = (o = {}) => ({
  growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7,
  best_cities: 8, salary_adj_city: 6, work_life_balance: 6,
  skills_match: 8, experience_bar: 6, competition: 6, ...o,
})
const GREEN = { status: 'green', amber_count: 0, checks: [] }
const AMBER1 = {
  status: 'amber', amber_count: 1,
  checks: [{ check: 'start_date', status: 'amber', reason: 'Start date not stated', question: 'When does the internship start?' }],
}
const RED = {
  status: 'red', amber_count: 0,
  checks: [{ check: 'language', status: 'red', reason: 'German C1 required; not in your profile' }],
}
const X = (dims, eligibility = GREEN, context = {}) => ({ dims, eligibility, context })

// ─── labels ───────────────────────────────────────────────────────────────────

test('DIM_LABELS covers the v2 dimensions with report-table labels', () => {
  assert.deepEqual(Object.keys(DIM_LABELS).sort(), [
    'best_cities', 'brand_value', 'competition', 'experience_bar', 'growth_mobility',
    'optionality_exit', 'role_content', 'salary_adj_city', 'skills_match', 'work_life_balance',
  ])
  assert.equal(DIM_LABELS.role_content, 'Role content')
  assert.equal(DIM_LABELS.experience_bar, 'Experience bar')
  // the nine judgment dims are the levers; computed salary is not
  assert.equal(LEVER_DIMS.length, 9)
  assert.ok(!LEVER_DIMS.includes('salary_adj_city'))
})

// ─── binding constraints ──────────────────────────────────────────────────────

test('bindingConstraints: blocked listing → one eligibility_red per red check', () => {
  const c = bindingConstraints(X(null, RED))
  assert.equal(c.length, 1)
  assert.equal(c[0].kind, 'eligibility_red')
  assert.equal(c[0].check, 'language')
  assert.match(c[0].message, /German C1/)
})

test('bindingConstraints: red `other` entries are listed individually', () => {
  const elig = {
    status: 'red', amber_count: 0,
    checks: [{ check: 'other', status: 'red', reason: 'a; b', entries: [{ status: 'red', reason: 'clearance required' }, { status: 'red', reason: 'STEM degree required' }] }],
  }
  const c = bindingConstraints(X(null, elig))
  assert.deepEqual(c.map(x => [x.kind, x.check]), [['eligibility_red', 'other'], ['eligibility_red', 'other']])
  assert.match(c[1].message, /STEM/)
})

test('bindingConstraints: experience wall is binding when lifting it reaches a better cell', () => {
  const c = bindingConstraints(X(D({ experience_bar: 3, competition: 8 })))
  assert.equal(c[0].kind, 'experience_wall')
  assert.equal(c[0].binding, true)
  assert.match(c[0].message, /capped at 4.5 \(it would be 5.68/)
})

test('bindingConstraints: hygiene veto names the factor', () => {
  const dims = D({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9, best_cities: 6, work_life_balance: 2, experience_bar: 8, competition: 8 })
  const c = bindingConstraints(X(dims))
  assert.equal(c[0].kind, 'hygiene_veto')
  assert.equal(c[0].dimension, 'work_life_balance')
  assert.equal(c[0].binding, true)
  assert.match(c[0].message, /caps Match at 5\.0/)
})

test('bindingConstraints: role-content veto', () => {
  const dims = D({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 3, best_cities: 6, experience_bar: 8, competition: 8 })
  const c = bindingConstraints(X(dims))
  assert.equal(c[0].kind, 'role_content_veto')
  assert.match(c[0].message, /caps Match at 6\.0/)
})

test('bindingConstraints: low_ease binds a stretch; each amber reports its question and gain', () => {
  const c = bindingConstraints(X(D(), AMBER1))
  assert.deepEqual(c.map(x => x.kind), ['low_ease', 'amber'])
  assert.equal(c[0].binding, true)
  assert.equal(c[0].threshold, 7)
  assert.equal(c[1].binding, false)    // +0.5 Ease (6.14 → 6.64) still a stretch
  assert.equal(c[1].value, 0.5)
  assert.match(c[1].message, /Resolve: When does the internship start\?/)
})

test('bindingConstraints: amber `other` entries each become an amber constraint', () => {
  const elig = {
    status: 'amber', amber_count: 2,
    checks: [{ check: 'other', status: 'amber', reason: 'x', question: 'q', entries: [
      { status: 'amber', reason: 'STEM degree preferred', question: 'Is a non-STEM MSc accepted?' },
      { status: 'amber', reason: 'enrolment required', question: 'Are recent graduates eligible?' },
    ] }],
  }
  const ambers = bindingConstraints(X(D(), elig)).filter(c => c.kind === 'amber')
  assert.equal(ambers.length, 2)
  assert.deepEqual(ambers.map(a => a.question), ['Is a non-STEM MSc accepted?', 'Are recent graduates eligible?'])
})

test('bindingConstraints: low_match / low_ease listed but non-binding when no single threshold helps', () => {
  const dims = D({ growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 5, best_cities: 6, skills_match: 4, experience_bar: 4, competition: 4 })
  const c = bindingConstraints(X(dims))
  assert.deepEqual(c.map(x => [x.kind, x.binding]), [['low_match', false], ['low_ease', false]])
})

test('bindingConstraints: a clean go has none', () => {
  assert.deepEqual(bindingConstraints(X(D({ experience_bar: 7, competition: 7 }))), [])
})

// ─── levers ───────────────────────────────────────────────────────────────────

test('verdictLevers: smallest single-dim raise, replayed through the engine', () => {
  const l = verdictLevers(X(D(), AMBER1))
  assert.equal(l[0].dimension, 'experience_bar')
  assert.deepEqual([l[0].from, l[0].to, l[0].lift, l[0].fromVerdict, l[0].newVerdict], [6, 9, 3, 'stretch', 'go'])
  assert.match(l[0].message, /Experience bar 6 → 9 \(\+3\) would move this from Stretch to Go\./)
  // proof by replay: the lever's target really is a go
  const dims = { ...D(), experience_bar: 9 }
  const v = assignVerdict({ match: rollupMatch(dims).score, ease: rollupEase(dims, { amber_count: 1 }).score, eligibility: 'amber' })
  assert.equal(v.verdict, 'go')
})

test('verdictLevers: the wall lever (+1 over the wall)', () => {
  const l = verdictLevers(X(D({ experience_bar: 3, competition: 8 })))
  assert.deepEqual([l[0].dimension, l[0].from, l[0].to, l[0].newVerdict], ['experience_bar', 3, 4, 'stretch'])
})

test('verdictLevers: lifting a vetoed hygiene factor', () => {
  const dims = D({ growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9, best_cities: 6, work_life_balance: 2, experience_bar: 8, competition: 8 })
  const l = verdictLevers(X(dims))
  assert.deepEqual([l[0].dimension, l[0].to, l[0].newVerdict], ['work_life_balance', 3, 'go'])
})

test('verdictLevers: a resolvable amber wins a tie with a +1 dimension', () => {
  const dims = D({ growth_mobility: 9, optionality_exit: 8, brand_value: 9, role_content: 8, skills_match: 8, experience_bar: 7, competition: 7 })
  const l = verdictLevers(X(dims, AMBER1))
  assert.equal(l[0].kind, 'amber')
  assert.equal(l[0].check, 'start_date')
  assert.equal(l[0].newVerdict, 'go')
  assert.match(l[0].message, /When does the internship start\?/)
  assert.ok(l.slice(1).every(x => x.kind === 'dimension' && x.lift === 1))
})

test('verdictLevers: none for go, blocked, or when +4 on any single dim is not enough', () => {
  assert.deepEqual(verdictLevers(X(D({ experience_bar: 7, competition: 7 }))), [])
  assert.deepEqual(verdictLevers(X(null, RED)), [])
  const stuck = D({ growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 5, best_cities: 6, skills_match: 4, experience_bar: 4, competition: 4 })
  assert.deepEqual(verdictLevers(X(stuck)), [])
  // a bigger search budget finds nothing either (match < 6.5 is skip in every column)
  assert.deepEqual(verdictLevers({ ...X(stuck), maxSteps: 4 }), [])
})

test('verdictLevers: respects context (intern carve-out, dream floor) in the replay', () => {
  // dream floor puts Match at 8 → ease decides; without dream the same dims are a thin
  const dims = D({ growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7, best_cities: 6, skills_match: 6, experience_bar: 6, competition: 6 })
  assert.equal(explainScore(X(dims)).verdict, 'thin')
  assert.equal(explainScore(X(dims, GREEN, { dream: true })).verdict, 'stretch')
  // intern: a poverty stipend neither vetoes nor drags
  const low = D({ salary_adj_city: 2, experience_bar: 7, competition: 7 })
  assert.equal(explainScore(X(low)).verdict, 'skip')
  assert.equal(explainScore(X(low, GREEN, { is_intern: true })).verdict, 'go')
})

// ─── sensitivity / drivers ────────────────────────────────────────────────────

test('sensitivity: a go sitting exactly on the thresholds is fragile', () => {
  const dims = D({ growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8, best_cities: 6, skills_match: 7, experience_bar: 7, competition: 7 })
  const s = sensitivity(X(dims))
  assert.equal(s.verdict, 'go')
  assert.equal(s.fragile, true)
  assert.equal(s.weakestLinks[0].toVerdict, 'stretch')
  assert.equal(sensitivity(X(null, RED)).fragile, false)
})

test('drivers: motivator lift/drag, hygiene terms, Ease stages', () => {
  const d = drivers(X(D({ work_life_balance: 4 })))
  assert.equal(d.match.topLift.dimension, 'brand_value')
  assert.equal(d.match.biggestDrag.dimension, 'role_content')
  assert.deepEqual(d.match.hygiene[0], { dimension: 'work_life_balance', label: 'Work-Life Balance', value: 4, term: -0.4 })
  assert.equal(d.ease.topLift.dimension, 'skills_match')
  assert.equal(drivers(X(null, RED)), null)
})

// ─── explainScore bundle ──────────────────────────────────────────────────────

test('explainScore: verdict matches the engine, and whyThisScore carries both labels', () => {
  const out = explainScore(X(D(), AMBER1))
  const dims = D()
  const engine = assignVerdict({ match: rollupMatch(dims).score, ease: rollupEase(dims, { amber_count: 1 }).score, eligibility: 'amber' })
  assert.equal(out.verdict, engine.verdict)
  assert.equal(out.verdict, 'stretch')
  assert.equal(
    out.whyThisScore,
    '- **Holding it back:** Ease 6.14 is below 7.0; its weakest stage is Experience bar 6/10.\n' +
    '- **Closest lever:** Experience bar 6 → 9 (+3) would move this from Stretch to Go.',
  )
  assert.equal(out.holdingItBack, out.bindingConstraints[0].message)
  assert.equal(out.closestLever, out.levers[0].message)
  assert.match(out.headline, /^Stretch: .* Closest lever: /)
})

test('explainScore: go headline, nothing holding it back', () => {
  const out = explainScore(X(D({ experience_bar: 7, competition: 7 })))
  assert.equal(out.verdict, 'go')
  assert.match(out.headline, /^Go: Match 8\.25, Ease 7\.33/)
  assert.match(out.whyThisScore, /Holding it back:\*\* Nothing/)
  assert.match(out.whyThisScore, /Closest lever:\*\* None needed/)
})

test('explainScore: blocked listing explains the gate, no lever, no scores needed', () => {
  const out = explainScore(X(null, RED))
  assert.equal(out.verdict, 'blocked')
  assert.deepEqual(out.levers, [])
  assert.match(out.headline, /^Blocked by eligibility \(Language: German C1/)
  assert.match(out.whyThisScore, /Holding it back:\*\* Language is red/)
  assert.match(out.whyThisScore, /Closest lever:\*\* No single lever/)
})

test('explainScore: "no single lever" wording when nothing crosses', () => {
  const stuck = D({ growth_mobility: 5, optionality_exit: 5, brand_value: 5, role_content: 5, best_cities: 6, skills_match: 4, experience_bar: 4, competition: 4 })
  const out = explainScore(X(stuck))
  assert.equal(out.verdict, 'skip')
  assert.match(out.closestLever, /^No single lever/)
  assert.match(out.headline, /No single change moves the verdict/)
})
