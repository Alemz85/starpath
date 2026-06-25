// Unit tests for the scoring explainability layer (explain-score.mjs).
//
// These pin the three deterministic outputs — binding constraints, drivers,
// and band-crossing levers — plus the headline. The lever search re-runs the
// canonical engine, so these tests also act as a tripwire: if score-bands.mjs
// changes a band boundary, a lever assertion here flips and we notice.
//
// Plain ESM, zero deps: `node --test scripts/lib/explain-score.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bindingConstraints,
  drivers,
  tierLevers,
  explainScore,
} from './explain-score.mjs'
import {
  rollupCurrentFit,
  rollupAspirationalFit,
  assignTier,
} from './score-bands.mjs'

// Helper: full six-dim set with sensible defaults, override what a test cares about.
const SIX = (o = {}) => ({
  skills_match: 7, ease_of_entry: 6, strategic_fit: 7,
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, ...o,
})
const CTX = (o = {}) => ({ salary_adj_for_city: 6, work_life_balance: 6, is_intern: false, ...o })

// Derive cf/af/tier the same way the engine does, so test inputs are consistent.
function derive(sixDims) {
  const cf = rollupCurrentFit(sixDims)
  const af = rollupAspirationalFit(sixDims)
  const { tier } = assignTier({ cf, af, sixDims })
  return { cf, af, tier }
}

// ─── bindingConstraints ───────────────────────────────────────────────────────

test('bindingConstraints flags the EoE hard gate first and explains the cap', () => {
  const sixDims = SIX({ ease_of_entry: 4, skills_match: 8, strategic_fit: 8, growth_mobility: 8, optionality_exit: 7, brand_value: 7 })
  const { cf, af, tier } = derive(sixDims)
  assert.equal(tier, 'T3')  // EoE gate, AF ≥ 7
  const constraints = bindingConstraints({ sixDims, cf, af, tier })
  assert.equal(constraints[0].kind, 'eoe_gate')
  assert.equal(constraints[0].dimension, 'ease_of_entry')
  assert.match(constraints[0].message, /experience-wall gate/)
  assert.match(constraints[0].message, /Growth Target/)  // af ≥ 7 branch
})

test('bindingConstraints surfaces every bottom-range (1-2) dim with its penalty note', () => {
  const sixDims = SIX({ skills_match: 2, brand_value: 1, ease_of_entry: 6 })
  const { cf, af, tier } = derive(sixDims)
  const constraints = bindingConstraints({ sixDims, cf, af, tier })
  const kinds = constraints.map(c => c.kind)
  assert.ok(kinds.includes('bottom_range'))
  const dims = constraints.filter(c => c.kind === 'bottom_range').map(c => c.dimension)
  assert.deepEqual(new Set(dims), new Set(['skills_match', 'brand_value']))
  assert.match(constraints.find(c => c.dimension === 'skills_match').message, /−0\.30 penalty/)
})

test('bindingConstraints falls back to the weaker rollup + its lowest dim when no gate/bottom fires', () => {
  // Solid-but-uneven role: CF weaker than AF, lowest CF dim is strategic_fit.
  const sixDims = SIX({ skills_match: 7, ease_of_entry: 6, strategic_fit: 5, growth_mobility: 9, optionality_exit: 8, brand_value: 9 })
  const { cf, af, tier } = derive(sixDims)
  const constraints = bindingConstraints({ sixDims, cf, af, tier })
  assert.equal(constraints.length, 1)
  assert.equal(constraints[0].kind, 'low_rollup')
  assert.equal(constraints[0].dimension, 'strategic_fit')
  assert.match(constraints[0].message, /Current Fit/)
})

test('bindingConstraints does NOT flag the EoE gate when the role is already T1', () => {
  // CF ≥ 9 forces T1 ahead of the gate (see score-bands assignTier ordering).
  // CF ≥ 9 with EoE ≤ 4 is unreachable by averaging, so this asserts the
  // guard directly: a T1 tier suppresses the eoe_gate blame even if EoE is low.
  const sixDims = SIX({ skills_match: 9, ease_of_entry: 4, strategic_fit: 9, growth_mobility: 9, optionality_exit: 9, brand_value: 9 })
  const constraints = bindingConstraints({ sixDims, cf: 9.2, af: 9.0, tier: 'T1' })
  assert.ok(!constraints.some(c => c.kind === 'eoe_gate'))
})

// ─── drivers ──────────────────────────────────────────────────────────────────

test('drivers ranks top lift and biggest drag per rollup with deltas vs the rollup mean', () => {
  const sixDims = SIX({ skills_match: 9, ease_of_entry: 6, strategic_fit: 6, growth_mobility: 5, optionality_exit: 7, brand_value: 9 })
  const { currentFit, aspirationalFit } = drivers({ sixDims })

  // CF: mean = (9+6+6)/3 = 7.0 → skills is top lift (+2), strategic/ease tie at -1.
  assert.equal(currentFit.mean, 7)
  assert.equal(currentFit.topLift.dimension, 'skills_match')
  assert.equal(currentFit.topLift.delta, 2)
  assert.equal(currentFit.biggestDrag.delta, -1)

  // AF: mean = (5+7+9)/3 = 7.0 → brand top (+2), growth biggest drag (-2).
  assert.equal(aspirationalFit.mean, 7)
  assert.equal(aspirationalFit.topLift.dimension, 'brand_value')
  assert.equal(aspirationalFit.biggestDrag.dimension, 'growth_mobility')
  assert.equal(aspirationalFit.biggestDrag.delta, -2)
})

test('drivers.weak lists only dims at or below the weak threshold (≤5)', () => {
  const sixDims = SIX({ skills_match: 4, ease_of_entry: 5, strategic_fit: 8, growth_mobility: 6, optionality_exit: 7, brand_value: 8 })
  const { currentFit, aspirationalFit } = drivers({ sixDims })
  assert.deepEqual(currentFit.weak.map(w => w.dimension).sort(), ['ease_of_entry', 'skills_match'])
  assert.equal(aspirationalFit.weak.length, 0)
})

// ─── tierLevers ───────────────────────────────────────────────────────────────

test('tierLevers finds the smallest single-dim raise that crosses a band, replaying real math', () => {
  // EoE-gated T3: skills/strategic strong, but EoE 4 caps it. Raising EoE 4→5
  // clears the gate; CF stays ≥7 so it becomes T2. That should be a lever.
  const sixDims = SIX({ skills_match: 8, ease_of_entry: 4, strategic_fit: 8, growth_mobility: 7, optionality_exit: 7, brand_value: 7 })
  const levers = tierLevers({ sixDims, context: CTX() })
  const eoeLever = levers.find(l => l.dimension === 'ease_of_entry')
  assert.ok(eoeLever, 'expected an Ease of Entry lever')
  assert.equal(eoeLever.from, 4)
  assert.equal(eoeLever.to, 5)         // smallest raise that clears the ≤4 gate
  assert.equal(eoeLever.fromTier, 'T3')
  assert.equal(eoeLever.toTier, 'T2')
  // Levers are sorted smallest-lift-first.
  assert.ok(levers[0].lift <= eoeLever.lift)
})

test('tierLevers returns no levers for a maxed-out T1 role', () => {
  const sixDims = SIX({ skills_match: 10, ease_of_entry: 10, strategic_fit: 10, growth_mobility: 10, optionality_exit: 10, brand_value: 10 })
  const levers = tierLevers({ sixDims, context: CTX() })
  assert.equal(levers.length, 0)
})

test('tierLevers respects the EoE gate — no AF dim can lift an EoE≤4, AF<7 role out of T4', () => {
  // EoE 3 gate + AF below 7 → T4. Bumping a single AF dim by a notch can't
  // both clear the gate AND push AF over 7, so it stays T4 on that lever.
  const sixDims = SIX({ skills_match: 6, ease_of_entry: 3, strategic_fit: 6, growth_mobility: 5, optionality_exit: 5, brand_value: 5 })
  const { tier } = derive(sixDims)
  assert.equal(tier, 'T4')
  const levers = tierLevers({ sixDims, context: CTX() })
  // The only way out is raising EoE above the gate; AF-only bumps shouldn't appear.
  assert.ok(!levers.some(l => ['growth_mobility', 'optionality_exit', 'brand_value'].includes(l.dimension)))
})

// ─── explainScore (integration) ───────────────────────────────────────────────

test('explainScore bundles constraints + drivers + levers and writes a lever-led headline', () => {
  const sixDims = SIX({ skills_match: 8, ease_of_entry: 4, strategic_fit: 8, growth_mobility: 7, optionality_exit: 7, brand_value: 7 })
  const { cf, af, tier } = derive(sixDims)
  const out = explainScore({ sixDims, cf, af, tier, context: CTX() })
  assert.ok(out.bindingConstraints.length >= 1)
  assert.ok(out.drivers.currentFit && out.drivers.aspirationalFit)
  assert.ok(out.levers.length >= 1)
  assert.match(out.headline, /Closest lever/)
  assert.match(out.headline, /binding constraint/i)
})

test('explainScore headline for a T1 role is a no-constraints lede, not a lever', () => {
  const sixDims = SIX({ skills_match: 10, ease_of_entry: 9, strategic_fit: 9, growth_mobility: 9, optionality_exit: 9, brand_value: 9 })
  const { cf, af, tier } = derive(sixDims)
  assert.equal(tier, 'T1')
  const out = explainScore({ sixDims, cf, af, tier, context: CTX() })
  assert.equal(out.levers.length, 0)
  assert.match(out.headline, /Top-band match/)
})
