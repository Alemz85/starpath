// Unit tests for scripts/lib/training-roi.mjs — the deterministic ROI engine
// behind the `training` mode. It reuses targeting-core's dimensionDrag /
// archetypePerformance and replays the scoring engine (rollupEase /
// rollupMatch → assignVerdict) for the projected uplift, so these tests pin the
// training-specific logic: dimension-key normalization (trainable v2 dims
// only), gap relevance scoring, archetype matching, the projected Ease uplift
// + verdict changes, effort banding, and the WORTH_IT / TIMEBOX / SKIP tree.
//
// Fixtures are v2 score-history rows built by the shared fixture builder
// (companies fictional). Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from './targeting-core.mjs'
import { historyTsv } from './testing/score-history-fixture.mjs'
import {
  normalizeDimensionKey,
  gapRelevance,
  targetingRelevance,
  projectedUplift,
  effortProfile,
  trainingVerdict,
  TRAINABLE_DIMS,
} from './training-roi.mjs'

// Healthy base: every dimension 8 except hygiene salary/WLB at 7 (neutral), so
// Match = 8.25 (motivators 8 + City +0.25) and Ease is set by the Ease dims.
const HEALTHY = {
  archetype: 'Data Analyst', company: 'Contoso Retail',
  skills_match: 8, experience_bar: 8, competition: 8,
  growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8,
  best_cities: 8, salary_adj_city: 7, work_life_balance: 7,
}

function rows(...overrides) {
  return parseScoreHistory(historyTsv(...overrides.map((o) => ({ ...HEALTHY, ...o }))))
}
function many(n, over) {
  return Array.from({ length: n }, () => over)
}

// A corpus where Experience bar is a clear systemic drag (3 = the experience
// wall, low in every eval) while every other dimension is healthy (~8).
// Verdict: growth (Match 8.25, Ease capped at 4.5). Archetype is a dense
// "Strategy & Operations" landscape.
function experienceDragCorpus() {
  return rows(...many(10, { archetype: 'Strategy & Operations', experience_bar: 3 }))
}

// Moderate drag: experience_bar 5 (systemic by avg < 6, never ≤ 4), competition
// 6 so a +1 lift leaves Ease inside the stretch column (no verdict moves).
function moderateCorpus(n = 8) {
  return rows(...many(n, { archetype: 'Strategy & Operations', experience_bar: 5, competition: 6 }))
}

// ───── normalizeDimensionKey ─────────────────────────────────────────────
test('normalizeDimensionKey maps loose aliases to trainable v2 keys', () => {
  assert.equal(normalizeDimensionKey('experience'), 'experience_bar')
  assert.equal(normalizeDimensionKey('YoE'), 'experience_bar')
  assert.equal(normalizeDimensionKey('skills'), 'skills_match')
  assert.equal(normalizeDimensionKey('credential'), 'competition')
  assert.equal(normalizeDimensionKey('positioning'), 'role_content')
  assert.equal(normalizeDimensionKey('experience_bar'), 'experience_bar')
})

test('normalizeDimensionKey returns null for unknown or non-trainable tokens', () => {
  assert.equal(normalizeDimensionKey('blockchain'), null)
  assert.equal(normalizeDimensionKey(''), null)
  assert.equal(normalizeDimensionKey(null), null)
  // Role-side Match dims belong to the listing, not the candidate.
  for (const k of ['brand_value', 'growth_mobility', 'optionality_exit', 'best_cities', 'salary_adj_city', 'work_life_balance']) {
    assert.equal(normalizeDimensionKey(k), null, `${k} is not trainable`)
  }
  // Rollups are not dimensions.
  assert.equal(normalizeDimensionKey('ease'), null)
  assert.equal(normalizeDimensionKey('match'), null)
})

test('normalizeDimensionKey: every trainable key round-trips; case/whitespace tolerant', () => {
  assert.deepEqual([...TRAINABLE_DIMS], ['skills_match', 'experience_bar', 'competition', 'role_content'])
  for (const k of TRAINABLE_DIMS) assert.equal(normalizeDimensionKey(k), k)
  assert.equal(normalizeDimensionKey('Skills'), 'skills_match')
  assert.equal(normalizeDimensionKey('EXPERIENCE BAR'), 'experience_bar')
  assert.equal(normalizeDimensionKey('  role  content  '), 'role_content')
  assert.equal(normalizeDimensionKey('\tskills\t'), 'skills_match')
})

// ───── gapRelevance ──────────────────────────────────────────────────────
test('gapRelevance flags a targeted systemic drag with a high gapScore', () => {
  const g = gapRelevance(experienceDragCorpus(), ['experience_bar'])
  assert.ok(g.best, 'has a best gap')
  assert.equal(g.best.key, 'experience_bar')
  assert.equal(g.best.dragRank, 1, 'experience bar is the #1 drag')
  assert.equal(g.best.isSystemicDrag, true)
  assert.ok(g.best.gapScore > 0.5, `gapScore should be high, got ${g.best.gapScore}`)
})

test('gapRelevance: a healthy dimension is not a systemic drag', () => {
  const g = gapRelevance(experienceDragCorpus(), ['competition'])
  assert.equal(g.best.key, 'competition')
  assert.equal(g.best.isSystemicDrag, false)
  assert.ok(g.best.gapScore < 0.3, `healthy dim gapScore should be low, got ${g.best.gapScore}`)
})

test('gapRelevance drops dimensions with no data in the corpus', () => {
  const g = gapRelevance(experienceDragCorpus(), ['experience_bar', 'blockchain_unknown'])
  assert.equal(g.targeted.length, 1)
  assert.equal(g.targeted[0].key, 'experience_bar')
})

test('gapRelevance with empty rows → no targeted dims (corpus has no data)', () => {
  const g = gapRelevance([], ['experience_bar'])
  assert.equal(g.targeted.length, 0)
  assert.equal(g.best, null)
  assert.equal(g.dimsInCorpus, 0)
})

test('gapRelevance with empty targetDims → targeted is empty, dragTable still populated', () => {
  const g = gapRelevance(experienceDragCorpus(), [])
  assert.equal(g.targeted.length, 0)
  assert.equal(g.best, null)
  assert.equal(g.dragTable.length, 10, 'all ten v2 dimensions are in the drag table')
})

test('gapRelevance returns targeted dims sorted by gapScore descending', () => {
  const g = gapRelevance(experienceDragCorpus(), ['competition', 'experience_bar'])
  assert.equal(g.targeted[0].key, 'experience_bar', 'higher gapScore should come first')
  assert.ok(g.targeted[0].gapScore >= g.targeted[1].gapScore)
})

test('gapRelevance ignores Blocked rows (empty cells are missing, not 0)', () => {
  const corpus = parseScoreHistory(historyTsv(
    ...many(3, { ...HEALTHY }),
    ...many(5, { eligibility: 'red', eligibility_flags: 'language:red:German C1 required' }),
  ))
  const g = gapRelevance(corpus, ['experience_bar'])
  assert.equal(g.best.avg, 8)
  assert.equal(g.best.isSystemicDrag, false)
})

// ───── targetingRelevance ────────────────────────────────────────────────
test('targetingRelevance matches mapped archetypes against the corpus', () => {
  const t = targetingRelevance(experienceDragCorpus(), ['Strategy & Operations'])
  assert.ok(t.best, 'matched an archetype')
  assert.equal(t.best.archetype, 'Strategy & Operations')
  assert.equal(t.best.count, 10)
  assert.equal(t.best.avgMatch, 8.25)
  assert.equal(t.best.avgEase, 4.5)
  assert.equal(t.landscapeShare, 100)
})

test('targetingRelevance reports archetypes absent from the corpus', () => {
  const t = targetingRelevance(experienceDragCorpus(), ['Blockchain Engineering'])
  assert.equal(t.best, null)
  assert.deepEqual(t.unmatched, ['Blockchain Engineering'])
})

test('targetingRelevance does substring/primary-segment matching', () => {
  const t = targetingRelevance(rows(
    { archetype: 'Strategy & Operations / BizOps' },
    { archetype: 'Strategy & Operations / BizOps' },
  ), ['Strategy & Operations'])
  assert.ok(t.best, 'requested primary segment matched the compound archetype')
})

test('targetingRelevance ranks the matched archetype with the higher actionable rate first', () => {
  const corpus = rows(
    ...many(3, { archetype: 'Data Analyst', experience_bar: 3 }),   // growth: not actionable
    ...many(3, { archetype: 'Data Analyst / BI' }),                 // go: actionable
  )
  const t = targetingRelevance(corpus, ['Data Analyst / BI', 'Data Analyst'])
  assert.equal(t.best.archetype, 'Data Analyst / BI')
  assert.equal(t.best.actionableRate, 100)
})

// ───── projectedUplift (engine replay) ───────────────────────────────────
test('projectedUplift: lifting experience_bar off the wall moves Ease and verdicts', () => {
  const u = projectedUplift(experienceDragCorpus(), ['experience_bar'], { lift: 1 })
  assert.equal(u.scope, 'landscape')
  assert.equal(u.rows, 10)
  assert.equal(u.avgEaseBefore, 4.5, 'experience wall caps Ease at 4.5')
  assert.ok(u.avgEaseAfter > 6, `wall removed → Ease > 6, got ${u.avgEaseAfter}`)
  assert.equal(u.easeMovement, 'improving')
  assert.equal(u.avgMatchDelta, 0, 'Match untouched by an Ease-side lift')
  assert.equal(u.upgrades, 10)
  assert.equal(u.downgrades, 0)
  assert.equal(u.upgradeShare, 100)
  assert.equal(u.actionableUpgrades, 10, 'stretch is actionable')
  assert.deepEqual(u.transitions, { 'growth→stretch': 10 })
  assert.ok(u.avgPriorityDelta > 0)
})

test('projectedUplift: a small lift that changes no verdict is within the Ease noise floor', () => {
  const u = projectedUplift(moderateCorpus(), ['competition'], { lift: 1 })
  assert.equal(u.upgrades, 0)
  assert.deepEqual(u.transitions, {})
  assert.ok(u.easeDelta > 0 && u.easeDelta < 0.35, `easeDelta ${u.easeDelta}`)
  assert.equal(u.easeMovement, 'within-noise')
})

test('projectedUplift: role_content replays Match (the Ease side keeps the stored value)', () => {
  // role_content 3 trips the role-content veto (Match ≤ 6.0 → skip); lifting
  // it to 5 clears the veto.
  const corpus = rows(...many(4, { role_content: 3 }))
  assert.equal(corpus[0].verdict, 'skip')
  const u = projectedUplift(corpus, ['role_content'], { lift: 2 })
  assert.ok(u.avgMatchDelta > 1, `Match lifts once the veto clears, got ${u.avgMatchDelta}`)
  assert.equal(u.easeDelta, 0)
  assert.equal(u.upgrades, 4)
  assert.ok(Object.keys(u.transitions).every((k) => k.startsWith('skip→')))
})

test('projectedUplift: Blocked rows are excluded; scope narrows to mapped archetypes', () => {
  const corpus = parseScoreHistory(historyTsv(
    ...many(2, { ...HEALTHY, archetype: 'Strategy & Operations', experience_bar: 3 }),
    ...many(3, { ...HEALTHY, archetype: 'Data Analyst', experience_bar: 3 }),
    { archetype: 'Strategy & Operations', eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' },
  ))
  const all = projectedUplift(corpus, ['experience_bar'])
  assert.equal(all.rows, 5, 'blocked row never replayed')
  const scoped = projectedUplift(corpus, ['experience_bar'], { archetypes: ['Strategy & Operations'] })
  assert.equal(scoped.scope, 'mapped-archetypes')
  assert.equal(scoped.rows, 2)
})

test('projectedUplift: amber flags keep their Ease penalty in both replays', () => {
  const corpus = rows({ experience_bar: 5, competition: 6, eligibility: 'amber', eligibility_flags: 'start_date:amber:start not stated' })
  const u = projectedUplift(corpus, ['skills_match'], { lift: 1 })
  assert.equal(u.rows, 1)
  // before = stored Ease (same engine, same amber count) — the replay is faithful.
  assert.equal(u.avgEaseBefore, corpus[0].ease)
})

test('projectedUplift: no trainable dims or no rows → zero rows, unknown movement', () => {
  const u = projectedUplift(experienceDragCorpus(), [])
  assert.equal(u.upgrades, 0)
  const empty = projectedUplift([], ['skills_match'])
  assert.equal(empty.rows, 0)
  assert.equal(empty.easeMovement, 'unknown')
})

// ───── effortProfile ─────────────────────────────────────────────────────
test('effortProfile bands total hours correctly', () => {
  assert.equal(effortProfile({ weeks: 1, hoursPerWeek: 10 }).band, 'micro') // 10h
  assert.equal(effortProfile({ weeks: 4, hoursPerWeek: 10 }).band, 'light') // 40h
  assert.equal(effortProfile({ weeks: 10, hoursPerWeek: 10 }).band, 'heavy') // 100h
  assert.equal(effortProfile({ weeks: 12, hoursPerWeek: 20 }).band, 'major') // 240h
})

test('effortProfile clamps negatives and computes total + cost', () => {
  const e = effortProfile({ weeks: -3, hoursPerWeek: 8, costEur: -50 })
  assert.equal(e.totalHours, 0)
  assert.equal(e.costEur, 0)
  assert.equal(e.weeks, 0)
})

test('effortProfile band boundaries (20/21/60/61/150/151h)', () => {
  assert.equal(effortProfile({ weeks: 4, hoursPerWeek: 5 }).band, 'micro')
  assert.equal(effortProfile({ weeks: 3, hoursPerWeek: 7 }).band, 'light')
  assert.equal(effortProfile({ weeks: 6, hoursPerWeek: 10 }).band, 'light')
  assert.equal(effortProfile({ weeks: 61, hoursPerWeek: 1 }).band, 'heavy')
  assert.equal(effortProfile({ weeks: 15, hoursPerWeek: 10 }).band, 'heavy')
  assert.equal(effortProfile({ weeks: 151, hoursPerWeek: 1 }).band, 'major')
})

test('effortProfile: non-numeric or omitted inputs default to 0', () => {
  const e = effortProfile({ weeks: 'ten', hoursPerWeek: 'five', costEur: 'free' })
  assert.equal(e.totalHours, 0)
  assert.equal(e.costEur, 0)
  assert.equal(e.band, 'micro')
  const d = effortProfile()
  assert.equal(d.totalHours, 0)
  assert.equal(d.band, 'micro')
})

// ───── trainingVerdict ───────────────────────────────────────────────────
const ON_TARGET = {
  targetDimensions: ['experience'],
  mappedArchetypes: ['Strategy & Operations'],
  weeks: 6, hoursPerWeek: 8, // 48h → light
  producesArtifact: true,
}

test('WORTH_IT: closes the systemic drag, matches a real archetype, proportionate effort, has artifact', () => {
  const v = trainingVerdict(experienceDragCorpus(), ON_TARGET)
  assert.equal(v.verdict, 'WORTH_IT')
  assert.equal(v.signals.attacksDrag, true)
  assert.equal(v.signals.archMatches, true)
  assert.equal(v.signals.movesVerdicts, true)
  assert.equal(v.uplift.scope, 'mapped-archetypes')
  assert.equal(v.uplift.upgrades, 10)
  assert.ok(v.trace.length >= 4)
  assert.ok(v.trace.some((t) => /Projected: \+1 step on Experience bar/.test(t) && /growth→stretch ×10/.test(t) && /10 into an actionable verdict/.test(t)))
  assert.ok(v.trace.some((t) => /avg Match 8\.25 · Ease 4\.5/.test(t)))
  assert.match(v.headline, /Experience bar/)
})

test('SKIP: targets a dimension that is not dragging anything', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, targetDimensions: ['competition'], weeks: 8, hoursPerWeek: 10 })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  // Context should still point at the dimension the user SHOULD target.
  assert.equal(v.context.topDrag.key, 'experience_bar')
  assert.equal(v.context.topTrainableDrag.key, 'experience_bar')
})

test('SKIP: maps to an archetype absent from the corpus', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, mappedArchetypes: ['Blockchain Engineering'], weeks: 4 })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.archMatches, false)
})

test('TIMEBOX: right gap + archetype but the offer is over-scoped (major effort, modest gap breadth)', () => {
  const v = trainingVerdict(moderateCorpus(), { ...ON_TARGET, weeks: 16, hoursPerWeek: 15 }) // 240h → major
  assert.equal(v.signals.attacksDrag, true)
  assert.equal(v.signals.archMatches, true)
  assert.equal(v.signals.proportionate, false)
  assert.equal(v.verdict, 'TIMEBOX')
})

test('TIMEBOX: proportionate but thin signal (no artifact, weak credential, modest gapScore, no verdict moves)', () => {
  const v = trainingVerdict(moderateCorpus(), {
    ...ON_TARGET, weeks: 2, hoursPerWeek: 5, // 10h → micro
    producesArtifact: false, brandStrength: 3,
  })
  assert.equal(v.signals.proportionate, true)
  assert.equal(v.signals.gapScore < 0.5, true)
  assert.equal(v.signals.movesVerdicts, false)
  assert.equal(v.verdict, 'TIMEBOX')
})

test('WORTH_IT via the replay alone: a modest gap whose lift flips verdicts', () => {
  // experience_bar 5, competition 8: Ease 6.79 (stretch). +1 → Ease ≥ 7 → go.
  const corpus = rows(...many(6, { archetype: 'Strategy & Operations', experience_bar: 5 }))
  const v = trainingVerdict(corpus, {
    ...ON_TARGET, weeks: 2, hoursPerWeek: 5, producesArtifact: false, brandStrength: 3,
  })
  assert.equal(v.signals.gapScore < 0.5, true)
  assert.equal(v.signals.movesVerdicts, true)
  assert.deepEqual(v.uplift.transitions, { 'stretch→go': 6 })
  assert.equal(v.verdict, 'WORTH_IT')
})

test('verdict is deterministic — same offer + corpus yields identical result', () => {
  const corpus = experienceDragCorpus()
  assert.deepEqual(trainingVerdict(corpus, ON_TARGET), trainingVerdict(corpus, ON_TARGET))
})

test('unknown / non-trainable dimension tokens are surfaced, not silently dropped', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, targetDimensions: ['experience', 'quantum computing', 'brand'] })
  assert.deepEqual(v.unknownDimensions, ['quantum computing', 'brand'])
})

test('an upgrade that stays non-actionable (skip → thin) does not count as ROI', () => {
  // Match 6.87 (mid row) with the experience wall: skip. +1 step clears the
  // wall → Ease ~5.5 → thin: a better cell, but not one worth paying for.
  const corpus = rows(...many(6, { archetype: 'Strategy & Operations', experience_bar: 3, competition: 6, skills_match: 7,
    growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7, best_cities: 7 }))
  assert.equal(corpus[0].verdict, 'skip')
  const v = trainingVerdict(corpus, { ...ON_TARGET, weeks: 2, hoursPerWeek: 5, producesArtifact: false, brandStrength: 3 })
  assert.equal(v.uplift.upgrades, 6)
  assert.equal(v.uplift.actionableUpgrades, 0)
  assert.deepEqual(v.uplift.transitions, { 'skip→thin': 6 })
  assert.equal(v.signals.movesVerdicts, false)
})

test('expectedLift scales the replay', () => {
  const v1 = trainingVerdict(moderateCorpus(), { ...ON_TARGET, expectedLift: 1 })
  const v3 = trainingVerdict(moderateCorpus(), { ...ON_TARGET, expectedLift: 3 })
  assert.equal(v3.uplift.lift, 3)
  assert.ok(v3.uplift.easeDelta > v1.uplift.easeDelta)
})

test('trainingVerdict with empty rows → SKIP (cannot measure gap or archetype)', () => {
  const v = trainingVerdict([], { ...ON_TARGET, weeks: 4 })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  assert.equal(v.signals.archMatches, false)
  assert.equal(v.uplift.rows, 0)
})

test('trainingVerdict with no targetDimensions → SKIP, trace mentions missing dim', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, targetDimensions: [] })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.attacksDrag, false)
  assert.ok(v.trace.some((t) => /No target dimension/.test(t)))
})

test('trainingVerdict with no mappedArchetypes → SKIP, replay falls back to the whole landscape', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, mappedArchetypes: [] })
  assert.equal(v.verdict, 'SKIP')
  assert.equal(v.signals.archMatches, false)
  assert.equal(v.uplift.scope, 'landscape')
  assert.ok(v.trace.some((t) => /No mapped archetypes/.test(t)))
})

test('trainingVerdict: strong credential alone (no artifact) can push to WORTH_IT when gapScore >= 0.5', () => {
  const v = trainingVerdict(experienceDragCorpus(), { ...ON_TARGET, producesArtifact: false, brandStrength: 8 })
  assert.equal(v.verdict, 'WORTH_IT')
  assert.equal(v.signals.strongBrand, true)
  assert.equal(v.signals.hasArtifact, false)
})

test('trainingVerdict: brandStrength undefined → no brand trace line', () => {
  const v = trainingVerdict(experienceDragCorpus(), ON_TARGET)
  assert.equal(v.trace.some((t) => /brand/i.test(t)), false)
})

test('trainingVerdict: context.topArchetypes has at most 5 entries', () => {
  assert.ok(trainingVerdict(experienceDragCorpus(), ON_TARGET).context.topArchetypes.length <= 5)
})

test('trainingVerdict: all signals are present in return value', () => {
  const v = trainingVerdict(experienceDragCorpus(), ON_TARGET)
  for (const k of ['attacksDrag', 'archMatches', 'proportionate', 'movesVerdicts', 'hasArtifact', 'strongBrand', 'gapScore', 'effortBand']) {
    assert.ok(k in v.signals, `signals.${k} should be present`)
  }
})
