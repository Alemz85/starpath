// calibration-advisor.test.mjs — unit tests for the pure calibration advisor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  brandLists,
  brandBonusDrift,
  brandBonusCandidates,
  dimensionSignal,
  compReality,
  scoreOutcomeCalibration,
  buildSuggestions,
  partitionSuggestions,
  analyzeCalibration,
} from './calibration-advisor.mjs'
import { GATES } from './scoring-stats.mjs'

/* ───── helpers ──────────────────────────────────────────────────── */

// Build a score-history row with sane defaults; override what a test cares about.
function row(over = {}) {
  return {
    date: '2026-01-01',
    archetype: 'Business / Data Analyst',
    skills_match: 7,
    ease_of_entry: 7,
    strategic_fit: 7,
    growth_mobility: 7,
    optionality_exit: 7,
    brand_value: 7,
    overall: 7,
    salary_adj_city: 6,
    work_life_balance: 7,
    company: 'Acme',
    role: 'Analyst',
    location: 'Madrid',
    ...over,
  }
}

// Repeat a row spec n times (varying nothing — used for clustering tests).
const repeat = (n, spec) => Array.from({ length: n }, () => row(spec))

/* ───── brandLists / alias ───────────────────────────────────────── */

test('brandLists honors the cems_adjacent_companies backward-compat alias', () => {
  const a = brandLists({ cems_adjacent_companies: ['Sabadell'] })
  assert.deepEqual(a.affinity, ['Sabadell'])
  // explicit brand_affinity_companies wins over the alias
  const b = brandLists({
    brand_affinity_companies: ['BBVA'],
    cems_adjacent_companies: ['Sabadell'],
  })
  assert.deepEqual(b.affinity, ['BBVA'])
})

test('brandLists returns empty arrays for empty/absent calibration', () => {
  const a = brandLists({})
  assert.deepEqual(a, { affinity: [], dream: [], lowerDream: [], extra: [] })
  assert.deepEqual(brandLists(undefined).dream, [])
})

/* ───── brandBonusDrift ──────────────────────────────────────────── */

test('brandBonusDrift flags a misdirected bonus (weak avg)', () => {
  const rows = [
    row({ company: 'WeakCo', overall: 5.5 }),
    row({ company: 'WeakCo', overall: 5.0 }),
  ]
  const out = brandBonusDrift(rows, { brand_affinity_companies: ['WeakCo'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'misdirected')
  assert.equal(out[0].band, 'weak')
  assert.equal(out[0].source, 'brand_affinity_companies')
})

test('brandBonusDrift flags an inert dream bonus (strong avg)', () => {
  const rows = [
    row({ company: 'StarCo', overall: 8.5 }),
    row({ company: 'StarCo', overall: 9.0 }),
  ]
  const out = brandBonusDrift(rows, { dream_companies: ['StarCo'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'inert')
  assert.equal(out[0].kind, 'dream')
})

test('brandBonusDrift stays silent for a mid-band bonus (working as intended)', () => {
  const rows = [
    row({ company: 'MidCo', overall: 6.8 }),
    row({ company: 'MidCo', overall: 7.1 }),
  ]
  const out = brandBonusDrift(rows, { lower_tier_dream_companies: ['MidCo'] })
  assert.equal(out.length, 0)
})

test('brandBonusDrift needs minRoles evidence before judging', () => {
  const rows = [row({ company: 'Solo', overall: 9.5 })]
  // default minRoles=2 → one row is not enough
  assert.equal(brandBonusDrift(rows, { dream_companies: ['Solo'] }).length, 0)
  // lowering the threshold surfaces it
  assert.equal(
    brandBonusDrift(rows, { dream_companies: ['Solo'] }, { minRoles: 1 }).length,
    1,
  )
})

test('brandBonusDrift is case/space-insensitive on company name', () => {
  const rows = [
    row({ company: '  weakco ', overall: 5.0 }),
    row({ company: 'WEAKCO', overall: 5.2 }),
  ]
  const out = brandBonusDrift(rows, { dream_companies: ['WeakCo'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'misdirected')
})

test('brandBonusDrift returns nothing when no calibration is configured', () => {
  const rows = repeat(3, { company: 'X', overall: 5 })
  assert.deepEqual(brandBonusDrift(rows, {}), [])
})

/* ───── brandBonusCandidates ─────────────────────────────────────── */

test('brandBonusCandidates surfaces an un-credited strong company', () => {
  const rows = [
    row({ company: 'RisingCo', overall: 8.0 }),
    row({ company: 'RisingCo', overall: 8.4 }),
    row({ company: 'RisingCo', overall: 7.9 }),
  ]
  const out = brandBonusCandidates(rows, {})
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'RisingCo')
  assert.ok(out[0].avgOverall >= 7.5)
})

test('brandBonusCandidates excludes companies already credited', () => {
  const rows = repeat(3, { company: 'RisingCo', overall: 8.2 })
  const out = brandBonusCandidates(rows, { brand_affinity_companies: ['RisingCo'] })
  assert.equal(out.length, 0)
})

test('brandBonusCandidates needs minRoles and minAvg', () => {
  // only 2 rows → below minRoles=3
  const few = repeat(2, { company: 'RisingCo', overall: 8.2 })
  assert.equal(brandBonusCandidates(few, {}).length, 0)
  // 3 rows but avg below 7.5
  const weak = repeat(3, { company: 'MehCo', overall: 7.0 })
  assert.equal(brandBonusCandidates(weak, {}).length, 0)
})

/* ───── dimensionSignal ──────────────────────────────────────────── */

test('dimensionSignal flags a ceiling-pinned dimension', () => {
  const rows = repeat(10, { brand_value: 10 })
  const sig = dimensionSignal(rows).find(d => d.key === 'brand_value')
  assert.equal(sig.status, 'pinned-ceiling')
  assert.equal(sig.pinned, 'ceiling')
  assert.ok(sig.ceilShare >= 70)
})

test('dimensionSignal flags a floor-pinned dimension', () => {
  const rows = repeat(10, { ease_of_entry: 1 })
  const sig = dimensionSignal(rows).find(d => d.key === 'ease_of_entry')
  assert.equal(sig.status, 'pinned-floor')
  assert.equal(sig.pinned, 'floor')
})

test('dimensionSignal marks a well-spread dimension healthy', () => {
  const vals = [2, 4, 5, 6, 7, 8, 9, 3, 6, 7]
  const rows = vals.map(v => row({ skills_match: v }))
  const sig = dimensionSignal(rows).find(d => d.key === 'skills_match')
  assert.equal(sig.status, 'healthy')
})

test('dimensionSignal reports sparse below minRows', () => {
  const rows = repeat(3, { brand_value: 10 })
  const sig = dimensionSignal(rows).find(d => d.key === 'brand_value')
  assert.equal(sig.status, 'sparse')
})

/* ───── compReality ──────────────────────────────────────────────── */

test('compReality detects targets above market (chronically low)', () => {
  const rows = repeat(8, { salary_adj_city: 3 })
  const c = compReality(rows)
  assert.equal(c.status, 'targets-above-market')
  assert.ok(c.lowShare >= 50)
})

test('compReality detects targets below market (chronically maxed)', () => {
  const rows = repeat(8, { salary_adj_city: 10 })
  const c = compReality(rows)
  assert.equal(c.status, 'targets-below-market')
})

test('compReality reports aligned for a balanced spread', () => {
  const vals = [5, 6, 7, 6, 5, 7, 6, 8]
  const rows = vals.map(v => row({ salary_adj_city: v }))
  assert.equal(compReality(rows).status, 'aligned')
})

test('compReality reports sparse below minRows', () => {
  assert.equal(compReality(repeat(3, { salary_adj_city: 3 })).status, 'sparse')
})

/* ───── scoreOutcomeCalibration ──────────────────────────────────── */

test('scoreOutcomeCalibration is unavailable with no outcomes', () => {
  const r = scoreOutcomeCalibration(repeat(3, {}), [])
  assert.equal(r.available, false)
})

test('scoreOutcomeCalibration flags high-score-no-convert', () => {
  // Three roles of one archetype scored high, all rejected when applied.
  const rows = [
    row({ archetype: 'Tech Sales', company: 'A', role: 'AE', overall: 8.0 }),
    row({ archetype: 'Tech Sales', company: 'B', role: 'AE', overall: 8.2 }),
    row({ archetype: 'Tech Sales', company: 'C', role: 'AE', overall: 7.8 }),
  ]
  const outcomes = [
    { company: 'A', role: 'AE', status: 'rejected' },
    { company: 'B', role: 'AE', status: 'rejected' },
    { company: 'C', role: 'AE', status: 'discarded' },
  ]
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.available, true)
  const ts = r.archetypes.find(a => a.archetype === 'Tech Sales')
  assert.equal(ts.flag, 'high-score-no-convert')
  assert.equal(ts.positive, 0)
})

test('scoreOutcomeCalibration flags low-score-converts', () => {
  const rows = [
    row({ archetype: 'Ops', company: 'A', role: 'Ops', overall: 6.0 }),
    row({ archetype: 'Ops', company: 'B', role: 'Ops', overall: 6.2 }),
    row({ archetype: 'Ops', company: 'C', role: 'Ops', overall: 5.9 }),
  ]
  const outcomes = [
    { company: 'A', role: 'Ops', status: 'interview' },
    { company: 'B', role: 'Ops', status: 'offer' },
    { company: 'C', role: 'Ops', status: 'rejected' },
  ]
  const r = scoreOutcomeCalibration(rows, outcomes)
  const ops = r.archetypes.find(a => a.archetype === 'Ops')
  assert.equal(ops.flag, 'low-score-converts')
  assert.ok(ops.convertRate >= 50)
})

test('scoreOutcomeCalibration ignores pre-application statuses (evaluated)', () => {
  const rows = repeat(3, { archetype: 'Ops', company: 'A', role: 'Ops', overall: 8 })
  const outcomes = [{ company: 'A', role: 'Ops', status: 'evaluated' }]
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.available, false) // nothing reached the market
})

test('scoreOutcomeCalibration respects minApplied threshold', () => {
  const rows = repeat(2, { archetype: 'Ops', company: 'A', role: 'Ops', overall: 8 })
  const outcomes = [
    { company: 'A', role: 'Ops', status: 'rejected' },
    { company: 'A', role: 'Ops', status: 'rejected' },
  ]
  // default minApplied=3 → archetype dropped from the table
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.archetypes.length, 0)
})

test('scoreOutcomeCalibration joins on an explicit archetype field when present', () => {
  const rows = [] // no score rows to join against
  const outcomes = [
    { archetype: 'Design', status: 'rejected' },
    { archetype: 'Design', status: 'rejected' },
    { archetype: 'Design', status: 'rejected' },
  ]
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.available, true)
  // no score → avgScore null → no flag, but the row is still counted
  const d = r.archetypes.find(a => a.archetype === 'Design')
  assert.equal(d.applied, 3)
  assert.equal(d.avgScore, null)
  assert.equal(d.flag, null)
})

/* ───── buildSuggestions ─────────────────────────────────────────── */

test('buildSuggestions emits a misdirected-bonus suggestion', () => {
  const diag = {
    brandBonusDrift: [
      { company: 'WeakCo', source: 'dream_companies', kind: 'dream', roles: 5, avgOverall: 5.2, band: 'weak', verdict: 'misdirected' },
    ],
  }
  const s = buildSuggestions(diag)
  assert.equal(s.length, 1)
  assert.equal(s[0].target, 'user/profile.yml')
  assert.match(s[0].action, /Reconsider the brand bonus on "WeakCo"/)
})

test('buildSuggestions sorts high severity first', () => {
  const diag = {
    brandBonusDrift: [
      { company: 'WeakCo', source: 'dream_companies', kind: 'dream', roles: 5, avgOverall: 5.2, verdict: 'misdirected' }, // medium
    ],
    compReality: { status: 'targets-above-market', mean: 3.5, lowShare: 60, count: 40 }, // high
    brandBonusCandidates: [{ company: 'RisingCo', roles: 5, avgOverall: 8.1 }], // low
  }
  const s = buildSuggestions(diag)
  assert.equal(s[0].severity, 'high')
  assert.equal(s[s.length - 1].severity, 'low')
})

test('buildSuggestions never returns an apply/write instruction — only an edit hint', () => {
  const diag = {
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', status: 'pinned-ceiling', mean: 9.8, ceilShare: 95, count: 40 }],
  }
  const s = buildSuggestions(diag)
  assert.equal(s.length, 1)
  assert.ok(s[0].edit) // there is a suggested edit
  // The suggestion targets a user/* file (never a system file).
  assert.match(s[0].target, /^user\//)
})

/* ───── analyzeCalibration (top-level) ───────────────────────────── */

test('analyzeCalibration errors on empty input', () => {
  assert.ok(analyzeCalibration([]).error)
  assert.ok(analyzeCalibration([row({ overall: NaN })]).error)
})

test('analyzeCalibration produces a full report with metadata + suggestions', () => {
  const rows = [
    ...repeat(6, { company: 'StarCo', overall: 9.0, brand_value: 10 }),
    ...repeat(6, { company: 'WeakCo', overall: 5.0, salary_adj_city: 3 }),
  ]
  const out = analyzeCalibration(rows, {
    calibration: { dream_companies: ['StarCo'], brand_affinity_companies: ['WeakCo'] },
  })
  assert.ok(out.metadata)
  assert.equal(out.metadata.evaluated, 12)
  assert.equal(out.metadata.calibrationConfigured, true)
  assert.equal(out.metadata.outcomesAvailable, false)
  assert.ok(Array.isArray(out.suggestions))
  // StarCo inert (dream, strong) + WeakCo misdirected + comp-above-market + brand_value pinned
  const actions = out.suggestions.map(s => s.action).join(' | ')
  assert.match(actions, /WeakCo/)
  assert.match(actions, /StarCo/)
})

test('analyzeCalibration integrates outcomes when provided', () => {
  // 8 applications = the § 3.4 gate for a conversion claim: below it, "0 of n
  // converted" is an ordinary run of bad luck, not a rubric defect.
  const companies = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  const rows = companies.map(c => row({ archetype: 'Tech Sales', company: c, role: 'AE', overall: 8.0 }))
  const outcomes = companies.map(c => ({ company: c, role: 'AE', status: 'rejected' }))
  const out = analyzeCalibration(rows, { outcomes })
  assert.equal(out.metadata.outcomesAvailable, true)
  const has = out.suggestions.some(s => /high \(avg/.test(s.action) && /Tech Sales/.test(s.action))
  assert.ok(has, 'expected a high-score-no-convert suggestion for Tech Sales')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Statistical contract (docs/scoring-statistical-design.md § 3.4)
 *
 * Diagnostics describe and are ungated; advisories prescribe and are gated.
 * An advisory below its gate is not softened — it leaves the recommendation
 * list entirely and lands in `insufficientData`.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ───── advisory gates: exactly at, and one under ────────────────────────── */

const driftDiag = (roles) => ({
  brandBonusDrift: [
    { company: 'WeakCo', source: 'dream_companies', kind: 'dream', roles, avgOverall: 5.2, band: 'weak', verdict: 'misdirected' },
  ],
})

test('brand advisory is suppressed one role under the gate', () => {
  const p = partitionSuggestions(driftDiag(GATES.calibrationMinCompanyRoles - 1))
  assert.equal(p.suggestions.length, 0)
  assert.equal(p.insufficientData.length, 1)
  assert.equal(p.insufficientData[0].confidence, 'insufficient')
  assert.equal(p.insufficientData[0].sampleSize, 3)
  assert.equal(p.insufficientData[0].gate, 4)
  assert.match(p.insufficientData[0].reason, /not a recommendation/i)
  // The text is preserved so the user can see what unlocks with more evidence.
  assert.match(p.insufficientData[0].action, /WeakCo/)
})

test('brand advisory unlocks at EXACTLY the gate, tiered low', () => {
  const p = partitionSuggestions(driftDiag(GATES.calibrationMinCompanyRoles))
  assert.equal(p.suggestions.length, 1)
  assert.equal(p.insufficientData.length, 0)
  assert.equal(p.suggestions[0].confidence, 'low')
  assert.equal(p.suggestions[0].sampleSize, 4)
})

test('brand advisory confidence climbs at 2× and 4× the gate', () => {
  assert.equal(partitionSuggestions(driftDiag(8)).suggestions[0].confidence, 'moderate')
  assert.equal(partitionSuggestions(driftDiag(16)).suggestions[0].confidence, 'high')
})

test('dimension-pinning advisory needs 20 scored evaluations of that dimension', () => {
  const dim = (count) => ({
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', status: 'pinned-ceiling', mean: 9.8, ceilShare: 95, count }],
  })
  assert.equal(partitionSuggestions(dim(19)).suggestions.length, 0)
  assert.equal(partitionSuggestions(dim(19)).insufficientData.length, 1)
  assert.equal(partitionSuggestions(dim(20)).suggestions.length, 1)
  assert.equal(partitionSuggestions(dim(20)).suggestions[0].confidence, 'low')
})

test('comp-target advisory needs 20 scored salary observations', () => {
  const comp = (count) => ({ compReality: { status: 'targets-above-market', mean: 3.5, lowShare: 60, count } })
  assert.equal(partitionSuggestions(comp(19)).suggestions.length, 0)
  assert.equal(partitionSuggestions(comp(20)).suggestions.length, 1)
})

test('conversion advisory needs 8 applications in the archetype', () => {
  const so = (applied) => ({
    scoreOutcome: {
      available: true,
      archetypes: [{ archetype: 'Growth Analytics', applied, positive: 0, negative: applied, convertRate: 0, avgScore: 8.2, flag: 'high-score-no-convert' }],
    },
  })
  assert.equal(partitionSuggestions(so(7)).suggestions.length, 0)
  assert.equal(partitionSuggestions(so(7)).insufficientData.length, 1)
  assert.equal(partitionSuggestions(so(8)).suggestions.length, 1)
  assert.equal(partitionSuggestions(so(8)).suggestions[0].sampleSize, 8)
})

/* ───── buildSuggestions stays the same shape as before ──────────────────── */

test('buildSuggestions still returns a plain sorted array (old contract)', () => {
  const diag = driftDiag(6)
  const arr = buildSuggestions(diag)
  assert.ok(Array.isArray(arr))
  assert.deepEqual(arr, partitionSuggestions(diag).suggestions)
  for (const k of ['target', 'action', 'reasoning', 'severity', 'edit']) {
    assert.ok(k in arr[0], `suggestion lost pre-contract field: ${k}`)
  }
})

/* ───── diagnostics stay ungated but now state their n ───────────────────── */

test('diagnostics keep firing below the advisory gate — they only describe', () => {
  // 2 roles is under the 4-role advisory gate, but the drift DIAGNOSTIC still
  // reports what the log says, with its own confidence tier attached.
  const rows = repeat(2, { company: 'WeakCo', overall: 5.0 })
  const drift = brandBonusDrift(rows, { dream_companies: ['WeakCo'] })
  assert.equal(drift.length, 1)
  assert.equal(drift[0].roles, 2)
  assert.equal(drift[0].confidence, 'insufficient')
})

test('dimensionSignal and compReality carry a confidence tier at every size', () => {
  const sparse = dimensionSignal(repeat(3, { brand_value: 10 })).find(d => d.key === 'brand_value')
  assert.equal(sparse.status, 'sparse')
  assert.equal(sparse.confidence, 'insufficient')

  const moderate = dimensionSignal(repeat(40, { brand_value: 10 })).find(d => d.key === 'brand_value')
  assert.equal(moderate.status, 'pinned-ceiling')
  assert.equal(moderate.confidence, 'moderate')   // 2× the 20-row gate

  const many = dimensionSignal(repeat(80, { brand_value: 10 })).find(d => d.key === 'brand_value')
  assert.equal(many.confidence, 'high')           // 4× the gate

  assert.equal(compReality(repeat(3, { salary_adj_city: 3 })).confidence, 'insufficient')
  assert.equal(compReality(repeat(20, { salary_adj_city: 3 })).confidence, 'low')
})

test('scoreOutcomeCalibration tiers each archetype by its applied count', () => {
  const companies = ['A', 'B', 'C', 'D']
  const rows = companies.map(c => row({ archetype: 'Field Ops', company: c, role: 'Coord', overall: 8.0 }))
  const outcomes = companies.map(c => ({ company: c, role: 'Coord', status: 'rejected' }))
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.archetypes[0].applied, 4)
  assert.equal(r.archetypes[0].confidence, 'insufficient') // gate is 8
})

/* ───── analyzeCalibration: additive shape ──────────────────────────────── */

test('analyzeCalibration publishes its gates and an insufficientData list', () => {
  const rows = [
    ...repeat(3, { company: 'ThinCo', overall: 5.0 }),
    ...repeat(3, { company: 'OtherCo', overall: 7.0 }),
  ]
  const out = analyzeCalibration(rows, { calibration: { dream_companies: ['ThinCo'] } })
  assert.equal(out.metadata.contract.gates.companyRoles, 4)
  assert.equal(out.metadata.contract.gates.dimRows, 20)
  assert.equal(out.metadata.contract.gates.applied, 8)
  assert.ok(Array.isArray(out.insufficientData))
  // ThinCo has 3 roles — described in diagnostics, withheld from advisories.
  assert.equal(out.diagnostics.brandBonusDrift.length, 1)
  assert.equal(out.suggestions.some(s => /ThinCo/.test(s.action)), false)
  assert.equal(out.insufficientData.some(s => /ThinCo/.test(s.action)), true)
})

test('analyzeCalibration keeps every pre-contract top-level field', () => {
  const rows = repeat(6, { company: 'StarCo', overall: 9.0 })
  const out = analyzeCalibration(rows, { calibration: { dream_companies: ['StarCo'] } })
  for (const k of ['metadata', 'diagnostics', 'suggestions']) {
    assert.ok(k in out, `analyzeCalibration lost pre-contract field: ${k}`)
  }
  for (const k of ['evaluated', 'calibrationConfigured', 'outcomesAvailable', 'dateRange', 'analysisDate']) {
    assert.ok(k in out.metadata, `metadata lost pre-contract field: ${k}`)
  }
  for (const k of ['brandBonusDrift', 'brandBonusCandidates', 'dimensionSignal', 'compReality', 'scoreOutcome']) {
    assert.ok(k in out.diagnostics, `diagnostics lost pre-contract field: ${k}`)
  }
})

test('no advisory ever carries an insufficient confidence tier', () => {
  // The invariant behind the whole gate: a rendered recommendation is never
  // labelled insufficient — it is withheld instead.
  const diag = {
    brandBonusDrift: [{ company: 'X', source: 'dream_companies', kind: 'dream', roles: 1, avgOverall: 5, verdict: 'misdirected' }],
    brandBonusCandidates: [{ company: 'Y', roles: 2, avgOverall: 8.4 }],
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', status: 'pinned-ceiling', mean: 9.9, ceilShare: 99, count: 6 }],
    compReality: { status: 'targets-above-market', mean: 3, lowShare: 70, count: 6 },
  }
  const p = partitionSuggestions(diag)
  assert.equal(p.suggestions.length, 0)
  assert.equal(p.insufficientData.length, 4)
  for (const s of p.suggestions) assert.notEqual(s.confidence, 'insufficient')
})
