import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rollupCurrentFit,
  rollupAspirationalFit,
  assignTier,
  tierLevers,
  rowLever,
  sixDimsOf,
  isInternRow,
  isNearUpgrade,
  filterNearUpgrades,
  leverContextOf,
  hasScoredDims,
  reportFixability,
  REPORT_NEAR_MISS_MAX_GAP,
  NEAR_MISS_MAX_LIFT,
  type SixDims,
  type LeverContext,
} from '@/lib/tierLevers'
import type { ScoreEntry } from '@/types'

// These fixtures are PINNED against the backend engine. The expected lever
// outputs below were produced by running scripts/lib/explain-score.mjs §
// explainScore on the exact same six-dim sets (see the session that added this
// file). If score-bands.mjs changes a band rule, these assertions (and the
// .mjs side's own fixtures) must move together — that's the drift guard.

const ctx = (over: Partial<LeverContext> = {}): LeverContext => ({
  salary_adj_for_city: 6,
  work_life_balance: 6,
  is_intern: false,
  ...over,
})

const dims = (over: Partial<SixDims> = {}): SixDims => ({
  skills_match: 6,
  ease_of_entry: 6,
  strategic_fit: 6,
  growth_mobility: 6,
  optionality_exit: 6,
  brand_value: 6,
  ...over,
})

// Build a ScoreEntry with the six dims + a sane non-zero overall so rowLever
// doesn't short-circuit. Stored tier defaults to the engine tier.
function entry(over: Partial<ScoreEntry> = {}): ScoreEntry {
  const base = {
    skills_match: 6, ease_of_entry: 6, strategic_fit: 6,
    growth_mobility: 6, optionality_exit: 6, brand_value: 6,
  }
  return {
    date: '2026-06-01', archetype: 'x',
    current_fit: 0, sales_trap_risk: 0, aspirational_fit: 0,
    overall: 6, best_cities: 0, salary_adj_city: 6, work_life_balance: 6,
    best_fit_roles: '', mode: 'scouting', company: 'Acme', role: 'Analyst',
    tier: 'T3', source: '', location: 'Milan', employment_type: 'full-time',
    duration: '', salary_raw: '', url: '',
    ...base, ...over,
  } as ScoreEntry
}

// ─── Canonical rollups match score-bands.mjs ────────────────────────────────

test('rollupCurrentFit averages the 3 CF dims and applies the bottom-range penalty', () => {
  assert.equal(rollupCurrentFit({ skills_match: 8, ease_of_entry: 4, strategic_fit: 8 }), 6.67)
  // one dim in [1,2] → -0.30
  assert.equal(rollupCurrentFit({ skills_match: 8, ease_of_entry: 2, strategic_fit: 8 }), 5.7)
})

test('rollupAspirationalFit mirrors the CF rollup on the AF dims', () => {
  assert.equal(rollupAspirationalFit({ growth_mobility: 8, optionality_exit: 8, brand_value: 8 }), 8)
  assert.equal(rollupAspirationalFit({ growth_mobility: 1, optionality_exit: 8, brand_value: 8 }), 5.37)
})

test('assignTier reproduces the engine band rules', () => {
  // CF ≥ 9 → T1
  assert.equal(assignTier(9.0, 5, dims()), 'T1')
  // uniform fingerprint: all 6 ≥ 8 AND CF/AF ≥ 8 → T1
  assert.equal(assignTier(8.33, 8, dims({ skills_match: 9, ease_of_entry: 8, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 })), 'T1')
  // EoE ≤ 4 gate with AF ≥ 7 → T3
  assert.equal(assignTier(6.67, 8, dims({ ease_of_entry: 4 })), 'T3')
  // EoE ≤ 4 gate with AF < 7 → T4
  assert.equal(assignTier(6.67, 5, dims({ ease_of_entry: 4 })), 'T4')
  // CF ≥ 7 AND EoE > 4 → T2
  assert.equal(assignTier(7.0, 6, dims({ ease_of_entry: 7 })), 'T2')
})

// ─── tierLevers: pinned against the backend engine ──────────────────────────

test('EoE gate: the cheapest lever is the +1 on Ease of Entry that lifts the gate (T3 → T2)', () => {
  // Backend ground truth: ease_of_entry 4 → 5 (+1) T3 → T2
  const d = dims({ skills_match: 8, ease_of_entry: 4, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 })
  const levers = tierLevers(d, ctx())
  assert.ok(levers.length > 0)
  const best = levers[0]
  assert.equal(best.dimension, 'ease_of_entry')
  assert.equal(best.from, 4)
  assert.equal(best.to, 5)
  assert.equal(best.lift, 1)
  assert.equal(best.fromTier, 'T3')
  assert.equal(best.toTier, 'T2')
})

test('already-T1 uniform-fingerprint role has no lever', () => {
  // Backend ground truth: none
  const d = dims({ skills_match: 9, ease_of_entry: 8, strategic_fit: 8, growth_mobility: 8, optionality_exit: 8, brand_value: 8 })
  assert.equal(assignTier(rollupCurrentFit(d), rollupAspirationalFit(d), d), 'T1')
  assert.deepEqual(tierLevers(d, ctx()), [])
})

test('a deep-T4 role with no single-dim path to T3 returns no lever', () => {
  // Backend ground truth: none (AF can\'t reach 7 with one +bump from a 5)
  const d = dims({ skills_match: 4, ease_of_entry: 5, strategic_fit: 4, growth_mobility: 5, optionality_exit: 5, brand_value: 5 })
  assert.equal(assignTier(rollupCurrentFit(d), rollupAspirationalFit(d), d), 'T4')
  assert.deepEqual(tierLevers(d, ctx()), [])
})

test('a T2 role at the CF-7 edge has no single-dim jump to T1', () => {
  // Backend ground truth: none
  const d = dims({ skills_match: 7, ease_of_entry: 7, strategic_fit: 7, growth_mobility: 6, optionality_exit: 6, brand_value: 6 })
  assert.equal(assignTier(rollupCurrentFit(d), rollupAspirationalFit(d), d), 'T2')
  assert.deepEqual(tierLevers(d, ctx()), [])
})

test('levers are sorted smallest-lift first, then by current value descending', () => {
  // T4 role where two different dims can each cross to T3, at different lifts.
  // skills_match low drags CF; raising AF dims to reach AF≥7 crosses to T3.
  const d = dims({ skills_match: 3, ease_of_entry: 6, strategic_fit: 6, growth_mobility: 6, optionality_exit: 6, brand_value: 6 })
  const levers = tierLevers(d, ctx())
  for (let i = 1; i < levers.length; i++) {
    const prev = levers[i - 1]
    const cur = levers[i]
    assert.ok(
      prev.lift < cur.lift || (prev.lift === cur.lift && prev.from >= cur.from),
      `levers not ordered at index ${i}: ${JSON.stringify(prev)} before ${JSON.stringify(cur)}`,
    )
  }
})

// ─── rowLever (the Database row entry point) ────────────────────────────────

test('rowLever surfaces the cheapest lever and flags a near-miss when lift ≤ threshold', () => {
  const e = entry({
    skills_match: 8, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: 'T3', overall: 6.6,
  })
  const r = rowLever(e)
  assert.ok(r.best)
  assert.equal(r.best!.dimension, 'ease_of_entry')
  assert.equal(r.best!.lift, 1)
  assert.equal(r.tier, 'T3')
  assert.equal(r.nearMiss, true) // lift 1 ≤ NEAR_MISS_MAX_LIFT (1.0)
})

test('rowLever returns no lever for a zero-score (unevaluated) placeholder row', () => {
  const e = entry({ overall: 0, tier: 'T4' })
  const r = rowLever(e)
  assert.equal(r.best, null)
  assert.equal(r.nearMiss, false)
  assert.equal(r.tier, 'T4')
})

test('rowLever normalizes a stored T2-high tier to T2 for display', () => {
  const e = entry({
    skills_match: 8, ease_of_entry: 7, strategic_fit: 8,
    growth_mobility: 6, optionality_exit: 6, brand_value: 6,
    tier: 'T2-high', overall: 7.6,
  })
  const r = rowLever(e)
  assert.equal(r.tier, 'T2')
})

test('rowLever falls back to the engine tier when the stored tier cell is empty', () => {
  const e = entry({
    skills_match: 8, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: '', overall: 6.6,
  })
  const r = rowLever(e)
  assert.equal(r.tier, 'T3') // recomputed from dims
})

test('nearMiss is false when the cheapest lever needs a multi-point lift', () => {
  // A role where the only band-crossing lever is a ≥2 lift.
  const e = entry({
    skills_match: 5, ease_of_entry: 7, strategic_fit: 5,
    growth_mobility: 6, optionality_exit: 6, brand_value: 6,
    tier: 'T4', overall: 5.5,
  })
  const r = rowLever(e)
  if (r.best) {
    assert.equal(r.nearMiss, r.best.lift <= NEAR_MISS_MAX_LIFT)
  }
})

// ─── Near-upgrade quick-filter ──────────────────────────────────────────────

test('isNearUpgrade is true for a +1 EoE-gate row and false for an already-T1 row', () => {
  const nearMiss = entry({
    skills_match: 8, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: 'T3', overall: 6.6,
  })
  const maxed = entry({
    skills_match: 9, ease_of_entry: 8, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: 'T1', overall: 8.3,
  })
  assert.equal(isNearUpgrade(nearMiss), true)
  assert.equal(isNearUpgrade(maxed), false)
})

test('isNearUpgrade is false for a zero-score placeholder row', () => {
  assert.equal(isNearUpgrade(entry({ overall: 0 })), false)
})

test('filterNearUpgrades is a no-op when disabled and keeps only near-misses when enabled', () => {
  const near = entry({
    company: 'A', skills_match: 8, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8, tier: 'T3', overall: 6.6,
  })
  const maxed = entry({
    company: 'B', skills_match: 9, ease_of_entry: 8, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8, tier: 'T1', overall: 8.3,
  })
  const rows = [near, maxed]
  assert.deepEqual(filterNearUpgrades(rows, false), rows)
  const kept = filterNearUpgrades(rows, true)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].company, 'A')
})

// ─── ScoreEntry adapters ────────────────────────────────────────────────────

test('sixDimsOf pulls exactly the six rollup dims off a ScoreEntry', () => {
  const e = entry({ skills_match: 1, ease_of_entry: 2, strategic_fit: 3, growth_mobility: 4, optionality_exit: 5, brand_value: 6 })
  assert.deepEqual(sixDimsOf(e), {
    skills_match: 1, ease_of_entry: 2, strategic_fit: 3,
    growth_mobility: 4, optionality_exit: 5, brand_value: 6,
  })
})

test('isInternRow matches internship/intern in employment_type, any case', () => {
  assert.equal(isInternRow(entry({ employment_type: 'internship' })), true)
  assert.equal(isInternRow(entry({ employment_type: 'Internship' })), true)
  assert.equal(isInternRow(entry({ employment_type: 'intern' })), true)
  assert.equal(isInternRow(entry({ employment_type: 'full-time' })), false)
  assert.equal(isInternRow(entry({ employment_type: '' })), false)
})

test('leverContextOf wires salary/WLB/intern from the ScoreEntry', () => {
  const e = entry({ salary_adj_city: 3, work_life_balance: 4, employment_type: 'internship' })
  assert.deepEqual(leverContextOf(e), {
    salary_adj_for_city: 3,
    work_life_balance: 4,
    is_intern: true,
  })
})

// ─── hasScoredDims ──────────────────────────────────────────────────────────

test('hasScoredDims is true for an evaluated row and false for placeholders', () => {
  assert.equal(hasScoredDims(entry({ overall: 6, skills_match: 8 })), true)
  // zero overall → unevaluated, even if a dim is non-zero
  assert.equal(hasScoredDims(entry({ overall: 0, skills_match: 8 })), false)
  // all six dims zero → orphan placeholder (the shape ReportsView builds when
  // a report has no score-history match)
  assert.equal(hasScoredDims(entry({
    overall: 0, skills_match: 0, ease_of_entry: 0, strategic_fit: 0,
    growth_mobility: 0, optionality_exit: 0, brand_value: 0,
  })), false)
  assert.equal(hasScoredDims(null), false)
  assert.equal(hasScoredDims(undefined), false)
})

// ─── reportFixability: engine-first, parse-fallback (the unified authority) ──

test('reportFixability ENGINE path mirrors rowLever exactly when dims are present', () => {
  // The canonical EoE-gate near-miss: ease_of_entry 4 → 5 (+1) T3 → T2. The
  // Reports verdict for this listing must equal the Database verdict bit-for-bit.
  const e = entry({
    skills_match: 8, ease_of_entry: 4, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: 'T3', overall: 6.6,
  })
  const lev = rowLever(e)
  const fix = reportFixability({
    scoreEntry: e, overall: 6.6, tier: 'T3',
    // Deliberately give the parse path a CONTRADICTORY signal — no lever, and a
    // band distance that would say "not a near-miss" on the fallback — to prove
    // the engine path wins when dims exist.
    parsedHasLever: false, parsedLever: null, bandDistance: 0.9,
  })
  assert.equal(fix.source, 'engine')
  assert.equal(fix.nearMiss, lev.nearMiss)          // both true
  assert.equal(fix.nearMiss, true)
  assert.equal(fix.engineLever?.dimension, 'ease_of_entry')
  assert.equal(fix.engineLever?.lift, 1)
  assert.equal(fix.engineLever?.toTier, 'T2')
})

test('reportFixability ENGINE path: an already-T1 row is never a near-miss', () => {
  const e = entry({
    skills_match: 9, ease_of_entry: 8, strategic_fit: 8,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8,
    tier: 'T1', overall: 8.3,
  })
  const fix = reportFixability({
    scoreEntry: e, overall: 8.3, tier: 'T1',
    // Even if the report body somehow named a lever, the engine says top-band.
    parsedHasLever: true, parsedLever: 'Brand value 8 → 10', bandDistance: 0.4,
  })
  assert.equal(fix.source, 'engine')
  assert.equal(fix.nearMiss, false)
  assert.equal(fix.engineLever, null)
  assert.equal(fix.fixabilityScore, 0)
})

test('reportFixability PARSE fallback fires only when no real dims are available', () => {
  // No scoreEntry → must use the Overall-gap + parsed-lever heuristic.
  const near = reportFixability({
    scoreEntry: null, overall: 6.9, tier: 'T3',
    parsedHasLever: false, parsedLever: null, bandDistance: 0.1,
  })
  assert.equal(near.source, 'parse')
  assert.equal(near.nearMiss, true)        // 0.1 ≤ 0.5
  assert.equal(near.engineLever, null)

  const lever = reportFixability({
    scoreEntry: null, overall: 5.4, tier: 'T3',
    parsedHasLever: true, parsedLever: 'Skills 6 → 8', bandDistance: 1.6,
  })
  assert.equal(lever.source, 'parse')
  assert.equal(lever.nearMiss, true)       // lever overrides the wide gap

  const far = reportFixability({
    scoreEntry: null, overall: 5.4, tier: 'T3',
    parsedHasLever: false, parsedLever: null, bandDistance: 1.6,
  })
  assert.equal(far.nearMiss, false)        // wide gap, no lever
})

test('reportFixability PARSE fallback: top-band / unscored → never near-miss, score 0', () => {
  const top = reportFixability({
    scoreEntry: null, overall: 9.3, tier: 'T1',
    parsedHasLever: true, parsedLever: 'x', bandDistance: null,
  })
  assert.equal(top.nearMiss, false)
  assert.equal(top.fixabilityScore, 0)
})

test('reportFixability falls back to dim-less placeholder entries via the parse path', () => {
  // The orphan-report shape ReportsView builds: a ScoreEntry with overall 0 and
  // all dims 0. hasScoredDims rejects it, so the parse path drives the verdict.
  const placeholder = entry({
    overall: 0, skills_match: 0, ease_of_entry: 0, strategic_fit: 0,
    growth_mobility: 0, optionality_exit: 0, brand_value: 0,
  })
  const fix = reportFixability({
    scoreEntry: placeholder, overall: 6.9, tier: 'T3',
    parsedHasLever: false, parsedLever: null, bandDistance: 0.1,
  })
  assert.equal(fix.source, 'parse')
  assert.equal(fix.nearMiss, true)
})

test('reportFixability parse path defaults hasLever to the display string presence', () => {
  // parsedHasLever omitted → derive from parsedLever. A wide gap with a lever
  // string still reads as a near-miss.
  const fix = reportFixability({
    scoreEntry: null, overall: 5.4, tier: 'T3',
    parsedLever: 'Skills 6 → 8', bandDistance: 1.6,
  })
  assert.equal(fix.nearMiss, true)
  // sanity: the threshold constant is the historical 0.5
  assert.equal(REPORT_NEAR_MISS_MAX_GAP, 0.5)
})
