// calibration-advisor.test.mjs — unit tests for the pure calibration advisor
// (scoring v2: Want / Ease / verdict). Rows are built with the shared v2
// fixture builder and parsed by targeting-core, so Want / Ease / verdict are
// the real engine's. Companies are fictional.
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
  wantRow,
  resolvedWeights,
  rowIsIntern,
} from './calibration-advisor.mjs'
import { GATES } from './scoring-stats.mjs'
import { parseScoreHistory } from './targeting-core.mjs'
import { historyTsv } from './testing/score-history-fixture.mjs'
import { WANT_HIGH, WANT_MID } from './score-bands.mjs'

/* ───── helpers ──────────────────────────────────────────────────── */

// Parse fixture rows through the real score-history parser.
const parse = (...overs) => parseScoreHistory(historyTsv(...overs))
// n identical rows.
const repeat = (n, over = {}) => parse(...Array.from({ length: n }, () => over))

// Motivator presets (hygiene stays at the fixture's neutral 7 / 6 / 7).
const WANT_LOW = { growth_mobility: 5, optionality_exit: 5, brand_value: 6, role_content: 5 }   // Want 5.25
const WANT_TOP = { growth_mobility: 9, optionality_exit: 9, brand_value: 9, role_content: 9 }   // Want 9.0
const WANT_MIDROW = { growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7 } // Want 7.0

/* ───── helpers exported by the lib ─────────────────────────────── */

test('wantRow uses the verdict grid row boundaries', () => {
  assert.equal(wantRow(WANT_HIGH), 'high')
  assert.equal(wantRow(WANT_HIGH - 0.01), 'mid')
  assert.equal(wantRow(WANT_MID), 'mid')
  assert.equal(wantRow(WANT_MID - 0.01), 'low')
  assert.equal(wantRow(NaN), null)
})

test('resolvedWeights merges user weights over the engine defaults', () => {
  const d = resolvedWeights()
  assert.equal(d.want.brand_value, 1)
  assert.equal(d.ease.experience_bar, 0.35)
  const w = resolvedWeights({ want_weights: { brand_value: 0.5 }, ease_weights: { competition: 0.5 } })
  assert.equal(w.want.brand_value, 0.5)
  assert.equal(w.want.growth_mobility, 1)
  assert.equal(w.ease.competition, 0.5)
})

test('rowIsIntern reads employment_type', () => {
  assert.equal(rowIsIntern({ employment_type: 'internship' }), true)
  assert.equal(rowIsIntern({ employment_type: 'working-student' }), true)
  assert.equal(rowIsIntern({ employment_type: 'full-time' }), false)
})

/* ───── brandLists / alias ───────────────────────────────────────── */

test('brandLists honors the cems_adjacent_companies backward-compat alias', () => {
  const a = brandLists({ cems_adjacent_companies: ['Contoso Retail'] })
  assert.deepEqual(a.affinity, ['Contoso Retail'])
  // explicit brand_affinity_companies wins over the alias
  const b = brandLists({
    brand_affinity_companies: ['Fabrikam Labs'],
    cems_adjacent_companies: ['Contoso Retail'],
  })
  assert.deepEqual(b.affinity, ['Fabrikam Labs'])
})

test('brandLists returns empty arrays for empty/absent calibration', () => {
  const a = brandLists({})
  assert.deepEqual(a, { affinity: [], dream: [], lowerDream: [], extra: [] })
  assert.deepEqual(brandLists(undefined).dream, [])
})

/* ───── brandBonusDrift (on Want) ───────────────────────────────── */

test('brandBonusDrift flags a misdirected bonus (mean Want in the bottom row)', () => {
  const rows = repeat(2, { company: 'Tailspin Toys', ...WANT_LOW })
  const out = brandBonusDrift(rows, { brand_affinity_companies: ['Tailspin Toys'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'misdirected')
  assert.equal(out[0].wantRow, 'low')
  assert.equal(out[0].source, 'brand_affinity_companies')
  assert.ok(out[0].avgWant < WANT_MID)
  assert.ok(Number.isFinite(out[0].avgEase))
  // The affinity bonus (+0.6 Brand) is worth 0.15 Want at equal weights.
  assert.equal(out[0].avgWantUnaided, Math.round((out[0].avgWant - 0.15) * 100) / 100)
})

test('brandBonusDrift flags an inert dream floor (top row without the floor)', () => {
  const rows = repeat(2, { company: 'Northwind Analytics', ...WANT_TOP, brand_value: 10 })
  const out = brandBonusDrift(rows, { dream_companies: ['Northwind Analytics'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'inert')
  assert.equal(out[0].kind, 'dream')
  assert.equal(out[0].wantRowUnaided, 'high')
})

test('brandBonusDrift: a dream floor that actually lifts Want into the top row is working', () => {
  // Motivators 7 / 7 / 10 / 7 → raw Want 7.75; the dream floor lifts it to 8.0.
  // A naive "stored Want ≥ 8" check would call this inert; the engine replay
  // shows the floor is what puts it in the top row.
  const rows = repeat(3, { company: 'Northwind Analytics', ...WANT_MIDROW, brand_value: 10, want: 8.0 })
  const out = brandBonusDrift(rows, { dream_companies: ['Northwind Analytics'] })
  assert.equal(out.length, 0)
})

test('brandBonusDrift: a company added to dream_companies after it was scored is replayed exactly', () => {
  // Stored Want 7.0 has no floor (the company wasn't a dream company yet); the
  // unaided replay must not subtract a floor that never applied.
  const rows = repeat(3, { company: 'Northwind Analytics', ...WANT_MIDROW })
  const out = brandBonusDrift(rows, { dream_companies: ['Northwind Analytics'] }, { minRoles: 1 })
  assert.equal(out.length, 0)
})

test('brandBonusDrift: an additive bonus that carries a company over 8.0 is not inert', () => {
  // lower-tier dream (+1.0 Brand): stored Brand 8 → Want 8.0; unaided Brand 7 → 7.75.
  const rows = repeat(3, { company: 'Fabrikam Labs', growth_mobility: 8, optionality_exit: 8, brand_value: 8, role_content: 8 })
  const out = brandBonusDrift(rows, { lower_tier_dream_companies: ['Fabrikam Labs'] })
  assert.equal(out.length, 0)
})

test('brandBonusDrift stays silent for a mid-row bonus (working as intended)', () => {
  const rows = repeat(2, { company: 'Contoso Retail', ...WANT_MIDROW })
  assert.equal(brandBonusDrift(rows, { lower_tier_dream_companies: ['Contoso Retail'] }).length, 0)
})

test('brandBonusDrift needs minRoles scored roles before judging', () => {
  const rows = repeat(1, { company: 'Northwind Analytics', ...WANT_TOP })
  assert.equal(brandBonusDrift(rows, { dream_companies: ['Northwind Analytics'] }).length, 0)
  assert.equal(brandBonusDrift(rows, { dream_companies: ['Northwind Analytics'] }, { minRoles: 1 }).length, 1)
})

test('brandBonusDrift ignores blocked rows (no Want to judge)', () => {
  const rows = parse(
    { company: 'Tailspin Toys', eligibility: 'red', eligibility_flags: 'language:red:German C1 required' },
    { company: 'Tailspin Toys', eligibility: 'red', eligibility_flags: 'language:red:German C1 required' },
    { company: 'Tailspin Toys', ...WANT_LOW },
  )
  assert.equal(brandBonusDrift(rows, { dream_companies: ['Tailspin Toys'] }).length, 0)
})

test('brandBonusDrift is case/space-insensitive on company name', () => {
  const rows = parse(
    { company: '  tailspin toys ', ...WANT_LOW },
    { company: 'TAILSPIN TOYS', ...WANT_LOW },
  )
  const out = brandBonusDrift(rows, { brand_affinity_companies: ['Tailspin Toys'] })
  assert.equal(out.length, 1)
  assert.equal(out[0].verdict, 'misdirected')
})

test('brandBonusDrift folds a company on several lists into one entry', () => {
  const rows = repeat(2, { company: 'Tailspin Toys', ...WANT_LOW })
  const out = brandBonusDrift(rows, {
    brand_affinity_companies: ['Tailspin Toys'],
    lower_tier_dream_companies: ['Tailspin Toys'],
  })
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].sources, ['lower_tier_dream_companies', 'brand_affinity_companies'])
})

test('brandBonusDrift returns nothing when no calibration is configured', () => {
  assert.deepEqual(brandBonusDrift(repeat(3, { company: 'Tailspin Toys', ...WANT_LOW }), {}), [])
})

/* ───── brandBonusCandidates ─────────────────────────────────────── */

test('brandBonusCandidates surfaces an un-credited company in the top Want row', () => {
  const out = brandBonusCandidates(repeat(3, { company: 'Litware Systems', ...WANT_TOP }), {})
  assert.equal(out.length, 1)
  assert.equal(out[0].company, 'Litware Systems')
  assert.ok(out[0].avgWant >= WANT_HIGH)
  assert.ok(Number.isFinite(out[0].avgEase))
})

test('brandBonusCandidates excludes companies already credited', () => {
  const rows = repeat(3, { company: 'Litware Systems', ...WANT_TOP })
  assert.equal(brandBonusCandidates(rows, { brand_affinity_companies: ['Litware Systems'] }).length, 0)
})

test('brandBonusCandidates needs minRoles and a top-row mean Want', () => {
  assert.equal(brandBonusCandidates(repeat(2, { company: 'Litware Systems', ...WANT_TOP }), {}).length, 0)
  assert.equal(brandBonusCandidates(repeat(3, { company: 'Contoso Retail', ...WANT_MIDROW }), {}).length, 0)
})

/* ───── dimensionSignal ──────────────────────────────────────────── */

test('dimensionSignal covers the ten v2 dimensions', () => {
  const keys = dimensionSignal(repeat(5)).map(d => d.key).sort()
  assert.deepEqual(keys, [
    'best_cities', 'brand_value', 'competition', 'experience_bar', 'growth_mobility',
    'optionality_exit', 'role_content', 'salary_adj_city', 'skills_match', 'work_life_balance',
  ])
})

test('dimensionSignal flags a ceiling-pinned dimension and reports its Want weight', () => {
  const sig = dimensionSignal(repeat(10, { brand_value: 10 })).find(d => d.key === 'brand_value')
  assert.equal(sig.status, 'pinned-ceiling')
  assert.equal(sig.pinned, 'ceiling')
  assert.equal(sig.group, 'motivator')
  assert.equal(sig.rollup, 'want')
  assert.equal(sig.weight, 1)
  assert.ok(sig.ceilShare >= 70)
})

test('dimensionSignal flags a floor-pinned Ease stage with its Ease weight', () => {
  const sig = dimensionSignal(repeat(10, { experience_bar: 1 })).find(d => d.key === 'experience_bar')
  assert.equal(sig.status, 'pinned-floor')
  assert.equal(sig.rollup, 'ease')
  assert.equal(sig.weight, 0.35)
})

test('dimensionSignal honors user weights; hygiene factors carry no weight', () => {
  const sig = dimensionSignal(repeat(5), { weights: { want: { brand_value: 0.5 } } })
  assert.equal(sig.find(d => d.key === 'brand_value').weight, 0.5)
  assert.equal(sig.find(d => d.key === 'best_cities').weight, null)
})

test('dimensionSignal marks a well-spread dimension healthy', () => {
  const rows = parse(...[2, 4, 5, 6, 7, 8, 9, 3, 6, 7].map(v => ({ skills_match: v })))
  assert.equal(dimensionSignal(rows).find(d => d.key === 'skills_match').status, 'healthy')
})

test('dimensionSignal reports sparse below minRows and skips blocked rows', () => {
  const rows = parse(
    { brand_value: 10 }, { brand_value: 10 }, { brand_value: 10 },
    ...Array.from({ length: 5 }, () => ({ eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' })),
  )
  const sig = dimensionSignal(rows).find(d => d.key === 'brand_value')
  assert.equal(sig.status, 'sparse')
  assert.equal(sig.count, 3)
})

/* ───── compReality ──────────────────────────────────────────────── */

test('compReality detects targets above market (chronically low)', () => {
  const c = compReality(repeat(8, { salary_adj_city: 3 }))
  assert.equal(c.status, 'targets-above-market')
  assert.ok(c.lowShare >= 50)
})

test('compReality detects targets below market (chronically maxed)', () => {
  assert.equal(compReality(repeat(8, { salary_adj_city: 10 })).status, 'targets-below-market')
})

test('compReality reports aligned for a balanced spread', () => {
  const rows = parse(...[5, 6, 7, 6, 5, 7, 6, 8].map(v => ({ salary_adj_city: v })))
  assert.equal(compReality(rows).status, 'aligned')
})

test('compReality reports sparse below minRows', () => {
  assert.equal(compReality(repeat(3, { salary_adj_city: 3 })).status, 'sparse')
})

test('compReality excludes internship rows (their salary term is 0 in Want)', () => {
  const rows = [
    ...repeat(8, { salary_adj_city: 2, employment_type: 'internship' }),
    ...repeat(6, { salary_adj_city: 7 }),
  ]
  const c = compReality(rows)
  assert.equal(c.count, 6)
  assert.equal(c.internsExcluded, 8)
  assert.equal(c.status, 'aligned')
})

/* ───── scoreOutcomeCalibration ──────────────────────────────────── */

const apps = (n, { archetype = 'Growth Analytics', score, status, role = 'Analyst' } = {}) => {
  const companies = Array.from({ length: n }, (_, i) => `Wingtip ${String.fromCharCode(65 + i)}`)
  const rows = parse(...companies.map(c => ({ archetype, company: c, role })))
  const outcomes = companies.map((c, i) => ({
    company: c, role,
    status: typeof status === 'function' ? status(i) : status,
    score: typeof score === 'function' ? score(i) : score,
  }))
  return { rows, outcomes }
}

test('scoreOutcomeCalibration is unavailable with no outcomes', () => {
  const r = scoreOutcomeCalibration(repeat(3), [])
  assert.equal(r.available, false)
  assert.deepEqual(r.excluded, { legacy: 0, unscored: 0 })
})

test('scoreOutcomeCalibration flags high-score-no-convert from the Score cells', () => {
  const { rows, outcomes } = apps(3, { score: 'W8.4 E7.2', status: 'rejected' })
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.available, true)
  const a = r.archetypes.find(x => x.archetype === 'Growth Analytics')
  assert.equal(a.typicalVerdict, 'go')
  assert.equal(a.flag, 'high-score-no-convert')
  assert.equal(a.avgWant, 8.4)
  assert.equal(a.avgEase, 7.2)
  assert.equal(a.avgPriority, Math.round(Math.sqrt(8.4 * 7.2) * 100) / 100)
  assert.equal(a.verdicts.go, 3)
  assert.equal(a.actionableShare, 100)
  assert.equal(a.positive, 0)
})

test('scoreOutcomeCalibration flags low-score-converts (typical verdict not actionable)', () => {
  const { rows, outcomes } = apps(3, {
    score: 'W6.0 E6.0',
    status: (i) => (i < 2 ? 'interview' : 'rejected'),
  })
  const a = scoreOutcomeCalibration(rows, outcomes).archetypes[0]
  assert.equal(a.typicalVerdict, 'skip')
  assert.equal(a.flag, 'low-score-converts')
  assert.ok(a.convertRate >= 50)
})

test('scoreOutcomeCalibration accepts the display form of the cell (W8.3 · E5.6)', () => {
  const { rows, outcomes } = apps(3, { score: 'W8.3 · E5.6', status: 'rejected' })
  const a = scoreOutcomeCalibration(rows, outcomes).archetypes[0]
  assert.equal(a.typicalVerdict, 'stretch')
  assert.equal(a.flag, 'high-score-no-convert')
})

test('scoreOutcomeCalibration excludes legacy X.X/10 cells and says so', () => {
  const { rows, outcomes } = apps(5, {
    score: (i) => (i < 3 ? 'W8.4 E7.2' : '7.9/10'),
    status: 'rejected',
  })
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.excluded.legacy, 2)
  const a = r.archetypes[0]
  assert.equal(a.applied, 3) // only the v2-scored applications
  assert.equal(a.excluded.legacy, 2)
})

test('scoreOutcomeCalibration: an all-legacy archetype drops out of the table', () => {
  const { rows, outcomes } = apps(4, { score: '8.0/10', status: 'rejected' })
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.available, true)
  assert.equal(r.archetypes.length, 0)
  assert.equal(r.excluded.legacy, 4)
})

test('scoreOutcomeCalibration falls back to the score-history Want/Ease for an empty cell', () => {
  const companies = ['Wingtip A', 'Wingtip B', 'Wingtip C']
  const rows = parse(...companies.map(c => ({ archetype: 'Ops', company: c, role: 'Coord', ...WANT_TOP })))
  const outcomes = companies.map(c => ({ company: c, role: 'Coord', status: 'rejected', score: '' }))
  const a = scoreOutcomeCalibration(rows, outcomes).archetypes[0]
  assert.equal(a.applied, 3)
  assert.equal(a.avgWant, rows[0].want)
  assert.equal(a.avgEase, rows[0].ease)
})

test('scoreOutcomeCalibration counts unscored applications as excluded', () => {
  const outcomes = [{ company: 'Unknown Co', role: 'Analyst', status: 'rejected', score: 'N/A' }]
  const r = scoreOutcomeCalibration([], outcomes)
  assert.equal(r.available, true)
  assert.equal(r.excluded.unscored, 1)
})

test('scoreOutcomeCalibration ignores pre-application statuses (evaluated)', () => {
  const { rows, outcomes } = apps(3, { score: 'W8.4 E7.2', status: 'evaluated' })
  assert.equal(scoreOutcomeCalibration(rows, outcomes).available, false)
})

test('scoreOutcomeCalibration respects minApplied threshold', () => {
  const { rows, outcomes } = apps(2, { score: 'W8.4 E7.2', status: 'rejected' })
  assert.equal(scoreOutcomeCalibration(rows, outcomes).archetypes.length, 0)
})

test('scoreOutcomeCalibration joins on an explicit archetype field when present', () => {
  const outcomes = Array.from({ length: 3 }, () => ({ archetype: 'Design', status: 'rejected', score: 'W7.0 E7.5' }))
  const r = scoreOutcomeCalibration([], outcomes)
  const d = r.archetypes.find(a => a.archetype === 'Design')
  assert.equal(d.applied, 3)
  assert.equal(d.typicalVerdict, 'solid')
})

/* ───── buildSuggestions ─────────────────────────────────────────── */

const driftEntry = (over = {}) => ({
  company: 'Tailspin Toys', source: 'dream_companies', sources: ['dream_companies'], kind: 'dream',
  roles: 5, avgWant: 5.2, avgWantUnaided: 5.2, avgEase: 6.1, wantRow: 'low', wantRowUnaided: 'low',
  verdict: 'misdirected', ...over,
})

test('buildSuggestions emits a misdirected-bonus suggestion stated on Want', () => {
  const s = buildSuggestions({ brandBonusDrift: [driftEntry()] })
  assert.equal(s.length, 1)
  assert.equal(s[0].target, 'user/profile.yml')
  assert.match(s[0].action, /Reconsider the brand bonus on "Tailspin Toys"/)
  assert.match(s[0].action, /Want 5\.2/)
})

test('buildSuggestions emits the inert dream-floor note with the unaided Want', () => {
  const s = buildSuggestions({
    brandBonusDrift: [driftEntry({ avgWant: 9.0, avgWantUnaided: 9.0, wantRow: 'high', wantRowUnaided: 'high', verdict: 'inert' })],
  })
  assert.equal(s.length, 1)
  assert.match(s[0].action, /Want floor \(8\.0\) never bites/)
})

test('buildSuggestions sorts high severity first', () => {
  const diag = {
    brandBonusDrift: [driftEntry()], // medium
    compReality: { status: 'targets-above-market', mean: 3.5, lowShare: 60, count: 40 }, // high
    brandBonusCandidates: [{ company: 'Litware Systems', roles: 5, avgWant: 8.6, avgEase: 7.1 }], // low
  }
  const s = buildSuggestions(diag)
  assert.equal(s[0].severity, 'high')
  assert.equal(s[s.length - 1].severity, 'low')
})

test('buildSuggestions points a pinned weighted dimension at its scoring weight', () => {
  const s = buildSuggestions({
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', group: 'motivator', rollup: 'want', weight: 1, status: 'pinned-ceiling', mean: 9.8, ceilShare: 95, count: 40 }],
  })
  assert.equal(s.length, 1)
  assert.equal(s[0].target, 'user/profile.yml')
  assert.match(s[0].edit, /scoring\.want_weights\.brand_value/)
  const e = buildSuggestions({
    dimensionSignal: [{ key: 'competition', label: 'Competition', group: 'ease', rollup: 'ease', weight: 0.3, status: 'pinned-ceiling', mean: 9.5, ceilShare: 90, count: 40 }],
  })
  assert.match(e[0].edit, /scoring\.ease_weights\.competition/)
})

test('buildSuggestions sends a pinned hygiene factor to the anchor, not a weight', () => {
  const s = buildSuggestions({
    dimensionSignal: [{ key: 'best_cities', label: 'City', group: 'hygiene', rollup: 'want', weight: null, status: 'pinned-ceiling', mean: 9.6, ceilShare: 92, count: 40 }],
  })
  assert.equal(s[0].target, 'user/_profile.md')
  assert.doesNotMatch(s[0].edit, /weights/)
})

test('buildSuggestions never returns an apply/write instruction — only an edit hint', () => {
  const s = buildSuggestions({
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', group: 'motivator', rollup: 'want', weight: 1, status: 'pinned-ceiling', mean: 9.8, ceilShare: 95, count: 40 }],
  })
  assert.ok(s[0].edit)
  assert.match(s[0].target, /^user\//)
})

test('no suggestion text renders a v1 Overall or an X/10 score', () => {
  const diag = {
    brandBonusDrift: [driftEntry({ roles: 6 }), driftEntry({ company: 'Northwind Analytics', avgWant: 9, avgWantUnaided: 9, verdict: 'inert', roles: 6 })],
    brandBonusCandidates: [{ company: 'Litware Systems', roles: 5, avgWant: 8.6, avgEase: 7.1 }],
    compReality: { status: 'targets-below-market', mean: 9.5, lowShare: 0, count: 40 },
    scoreOutcome: { available: true, archetypes: [{ archetype: 'Ops', applied: 9, positive: 0, negative: 9, convertRate: 0, avgWant: 8.4, avgEase: 7.2, typicalVerdict: 'go', flag: 'high-score-no-convert' }] },
  }
  for (const x of buildSuggestions(diag)) {
    for (const field of [x.action, x.reasoning, x.edit]) {
      assert.doesNotMatch(field, /\/10\b/)
      assert.doesNotMatch(field, /overall|\bCF\b|\bAF\b/i)
    }
  }
})

/* ───── analyzeCalibration (top-level) ───────────────────────────── */

test('analyzeCalibration errors on empty input and on an all-blocked history', () => {
  assert.ok(analyzeCalibration([]).error)
  const blocked = parse({ eligibility: 'red', eligibility_flags: 'language:red:German C1 required' })
  const out = analyzeCalibration(blocked)
  assert.ok(out.error)
  assert.match(out.error, /1 blocked/)
})

test('analyzeCalibration produces a full report with metadata + suggestions', () => {
  const rows = [
    ...repeat(6, { company: 'Northwind Analytics', ...WANT_TOP, brand_value: 10 }),
    ...repeat(6, { company: 'Tailspin Toys', ...WANT_LOW, salary_adj_city: 3 }),
    ...parse({ company: 'Tailspin Toys', eligibility: 'red', eligibility_flags: 'work_auth:red:no sponsorship' }),
  ]
  const out = analyzeCalibration(rows, {
    calibration: { dream_companies: ['Northwind Analytics'], brand_affinity_companies: ['Tailspin Toys'] },
  })
  assert.equal(out.metadata.evaluated, 12)
  assert.equal(out.metadata.blocked, 1)
  assert.equal(out.metadata.calibrationConfigured, true)
  assert.equal(out.metadata.outcomesAvailable, false)
  assert.deepEqual(out.metadata.contract.wantRows, { mid: WANT_MID, high: WANT_HIGH })
  assert.equal(out.metadata.weights.want.brand_value, 1)
  const drift = out.diagnostics.brandBonusDrift
  assert.equal(drift.find(d => d.company === 'Tailspin Toys').roles, 6) // blocked row not counted
  const actions = out.suggestions.map(s => s.action).join(' | ')
  assert.match(actions, /Tailspin Toys/)
  assert.match(actions, /Northwind Analytics/)
})

test('analyzeCalibration threads the user weights into the dimension diagnostics', () => {
  const out = analyzeCalibration(repeat(6), { weights: { want: { role_content: 2 } } })
  assert.equal(out.diagnostics.dimensionSignal.find(d => d.key === 'role_content').weight, 2)
  assert.equal(out.metadata.weights.want.role_content, 2)
})

test('analyzeCalibration integrates outcomes when provided', () => {
  // 8 applications = the § 3.4 gate for a conversion claim.
  const { rows, outcomes } = apps(8, { archetype: 'Tech Sales', score: 'W8.4 E7.2', status: 'rejected' })
  const out = analyzeCalibration(rows, { outcomes })
  assert.equal(out.metadata.outcomesAvailable, true)
  const has = out.suggestions.some(s => /Tech Sales/.test(s.action) && /0\/8 applications converted/.test(s.action))
  assert.ok(has, 'expected a high-score-no-convert suggestion for Tech Sales')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Statistical contract (docs/scoring-statistical-design.md § 3.4)
 *
 * Diagnostics describe and are ungated; advisories prescribe and are gated.
 * An advisory below its gate is not softened — it leaves the recommendation
 * list entirely and lands in `insufficientData`.
 * ═══════════════════════════════════════════════════════════════════════════ */

const driftDiag = (roles) => ({ brandBonusDrift: [driftEntry({ roles })] })

test('brand advisory is suppressed one role under the gate', () => {
  const p = partitionSuggestions(driftDiag(GATES.calibrationMinCompanyRoles - 1))
  assert.equal(p.suggestions.length, 0)
  assert.equal(p.insufficientData.length, 1)
  assert.equal(p.insufficientData[0].confidence, 'insufficient')
  assert.equal(p.insufficientData[0].sampleSize, 3)
  assert.equal(p.insufficientData[0].gate, 4)
  assert.match(p.insufficientData[0].reason, /not a recommendation/i)
  assert.match(p.insufficientData[0].action, /Tailspin Toys/)
  assert.equal('n' in p.insufficientData[0], false)
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
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', group: 'motivator', rollup: 'want', weight: 1, status: 'pinned-ceiling', mean: 9.8, ceilShare: 95, count }],
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
      archetypes: [{ archetype: 'Growth Analytics', applied, positive: 0, negative: applied, convertRate: 0, avgWant: 8.2, avgEase: 7.1, typicalVerdict: 'go', flag: 'high-score-no-convert' }],
    },
  })
  assert.equal(partitionSuggestions(so(7)).suggestions.length, 0)
  assert.equal(partitionSuggestions(so(7)).insufficientData.length, 1)
  assert.equal(partitionSuggestions(so(8)).suggestions.length, 1)
  assert.equal(partitionSuggestions(so(8)).suggestions[0].sampleSize, 8)
})

test('buildSuggestions returns a plain sorted array with the stable fields', () => {
  const diag = driftDiag(6)
  const arr = buildSuggestions(diag)
  assert.ok(Array.isArray(arr))
  assert.deepEqual(arr, partitionSuggestions(diag).suggestions)
  for (const k of ['target', 'action', 'reasoning', 'severity', 'edit', 'sampleSize', 'gate', 'confidence']) {
    assert.ok(k in arr[0], `suggestion lost field: ${k}`)
  }
})

test('diagnostics keep firing below the advisory gate — they only describe', () => {
  const drift = brandBonusDrift(repeat(2, { company: 'Tailspin Toys', ...WANT_LOW }), { dream_companies: ['Tailspin Toys'] })
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

  assert.equal(dimensionSignal(repeat(80, { brand_value: 10 })).find(d => d.key === 'brand_value').confidence, 'high')

  assert.equal(compReality(repeat(3, { salary_adj_city: 3 })).confidence, 'insufficient')
  assert.equal(compReality(repeat(20, { salary_adj_city: 3 })).confidence, 'low')
})

test('scoreOutcomeCalibration tiers each archetype by its v2-scored applied count', () => {
  const { rows, outcomes } = apps(4, { archetype: 'Field Ops', score: 'W8.4 E7.2', status: 'rejected' })
  const r = scoreOutcomeCalibration(rows, outcomes)
  assert.equal(r.archetypes[0].applied, 4)
  assert.equal(r.archetypes[0].confidence, 'insufficient') // gate is 8
})

test('analyzeCalibration publishes its gates and an insufficientData list', () => {
  const rows = [
    ...repeat(3, { company: 'Tailspin Toys', ...WANT_LOW }),
    ...repeat(3, { company: 'Contoso Retail' }),
  ]
  const out = analyzeCalibration(rows, { calibration: { dream_companies: ['Tailspin Toys'] } })
  assert.equal(out.metadata.contract.gates.companyRoles, 4)
  assert.equal(out.metadata.contract.gates.dimRows, 20)
  assert.equal(out.metadata.contract.gates.applied, 8)
  assert.ok(Array.isArray(out.insufficientData))
  // Tailspin Toys has 3 roles — described in diagnostics, withheld from advisories.
  assert.equal(out.diagnostics.brandBonusDrift.length, 1)
  assert.equal(out.suggestions.some(s => /Tailspin Toys/.test(s.action)), false)
  assert.equal(out.insufficientData.some(s => /Tailspin Toys/.test(s.action)), true)
})

test('analyzeCalibration keeps every top-level field', () => {
  const out = analyzeCalibration(repeat(6, { company: 'Northwind Analytics', ...WANT_TOP }), { calibration: { dream_companies: ['Northwind Analytics'] } })
  for (const k of ['metadata', 'diagnostics', 'suggestions', 'insufficientData']) assert.ok(k in out, k)
  for (const k of ['evaluated', 'blocked', 'calibrationConfigured', 'outcomesAvailable', 'dateRange', 'analysisDate', 'weights']) {
    assert.ok(k in out.metadata, `metadata lost field: ${k}`)
  }
  for (const k of ['brandBonusDrift', 'brandBonusCandidates', 'dimensionSignal', 'compReality', 'scoreOutcome']) {
    assert.ok(k in out.diagnostics, `diagnostics lost field: ${k}`)
  }
})

test('no advisory ever carries an insufficient confidence tier', () => {
  const diag = {
    brandBonusDrift: [driftEntry({ roles: 1 })],
    brandBonusCandidates: [{ company: 'Litware Systems', roles: 2, avgWant: 8.4, avgEase: 7.0 }],
    dimensionSignal: [{ key: 'brand_value', label: 'Brand Value', group: 'motivator', rollup: 'want', weight: 1, status: 'pinned-ceiling', mean: 9.9, ceilShare: 99, count: 6 }],
    compReality: { status: 'targets-above-market', mean: 3, lowShare: 70, count: 6 },
  }
  const p = partitionSuggestions(diag)
  assert.equal(p.suggestions.length, 0)
  assert.equal(p.insufficientData.length, 4)
  for (const s of p.suggestions) assert.notEqual(s.confidence, 'insufficient')
})
