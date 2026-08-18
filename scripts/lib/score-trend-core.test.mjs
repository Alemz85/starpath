// Unit tests for scripts/lib/score-trend-core.mjs — the re-evaluation /
// score-trend math. score-trend.mjs only wraps these with file I/O, so this
// suite is where the logic is pinned: the canonical (company, role) key reuse,
// the delta dead-band, trajectory grouping (same-date collapse + spelling-drift
// merge + the top-dimension-mover driver), band-crossing detection, the
// landscape older-vs-recent split (median date, inclusive-recent, the
// insufficient-data + concentration guards), and the recommendation gates.
//
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listingKey,
  classifyDelta,
  listingTrajectories,
  trajectorySummary,
  landscapeTrend,
  trendRecommendations,
  analyzeTrend,
  parseScoreHistory,
  OVERALL_NOISE_FLOOR,
} from './score-trend-core.mjs'

const HEADER = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
].join('\t')

const COLS = [
  'date', 'archetype', 'skills_match', 'ease_of_entry', 'strategic_fit',
  'current_fit', 'growth_mobility', 'optionality_exit', 'brand_value',
  'sales_trap_risk', 'aspirational_fit', 'overall', 'best_cities',
  'salary_adj_city', 'work_life_balance', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
]

// Build one TSV data row from an overrides object so tests stay readable.
function row(over = {}) {
  const base = {
    date: '2026-05-01', archetype: 'Data Analyst',
    skills_match: 7, ease_of_entry: 6, strategic_fit: 8, current_fit: 7,
    growth_mobility: 7, optionality_exit: 7, brand_value: 7, sales_trap_risk: 8,
    aspirational_fit: 7, overall: 7, best_cities: 'Madrid', salary_adj_city: 6,
    work_life_balance: 7, best_fit_roles: 'Analyst', mode: 'scouting',
    company: 'Acme', role: 'Analyst', tier: 'T2', source: 'pipeline',
    location: 'Madrid', employment_type: 'full-time', duration: 'permanent',
    salary_raw: 'n/d', url: 'https://x',
  }
  const merged = { ...base, ...over }
  return COLS.map(k => merged[k]).join('\t')
}

function tsv(...rows) {
  return [HEADER, ...rows].join('\n')
}

// ─── listingKey: reuses the canonical dedup normalization ─────────────────────

test('listingKey collapses company-spelling + role-spacing drift to one key', () => {
  // dedup-index.normalizeCompany strips non-alphanumerics + lowercases;
  // normalizeRole lowercases + collapses whitespace.
  assert.equal(
    listingKey('Celonis', 'Strategy Analyst Internship'),
    listingKey('celonis ', 'Strategy  Analyst   Internship'),
  )
  assert.equal(
    listingKey('Trade Republic', 'Data Analyst'),
    listingKey('traderepublic', 'data analyst'),
  )
})

test('listingKey tolerates missing company/role without throwing', () => {
  assert.equal(typeof listingKey(undefined, undefined), 'string')
  assert.equal(listingKey('', ''), '\t')
})

// ─── classifyDelta: dead-band boundaries ──────────────────────────────────────

test('classifyDelta applies the ±0.25 dead-band by default', () => {
  assert.equal(classifyDelta(0.26), 'improving')
  assert.equal(classifyDelta(0.25), 'stable')   // exactly on the band → stable
  assert.equal(classifyDelta(0.1), 'stable')
  assert.equal(classifyDelta(0), 'stable')
  assert.equal(classifyDelta(-0.25), 'stable')
  assert.equal(classifyDelta(-0.26), 'declining')
  assert.equal(classifyDelta(NaN), 'unknown')
})

test('classifyDelta respects a custom stableBand', () => {
  assert.equal(classifyDelta(0.2, { stableBand: 0.15 }), 'improving')
  assert.equal(classifyDelta(0.2, { stableBand: 0.5 }), 'stable')
})

// ─── listingTrajectories: grouping, delta, drivers, band crossing ─────────────

test('listingTrajectories ignores single-eval listings (no movement)', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Solo', role: 'Once', overall: 7.0 }),
  ))
  assert.deepEqual(listingTrajectories(rows), [])
})

test('listingTrajectories surfaces a re-evaluated listing with signed delta + driver', () => {
  // Mirrors the real Contentsquare re-eval: 6.07 → 6.53, skills 6 → 7.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Contentsquare', role: 'CS Ops & Strategy', date: '2026-05-08', overall: 6.07, skills_match: 6, ease_of_entry: 5 }),
    row({ company: 'Contentsquare', role: 'CS Ops & Strategy', date: '2026-05-09', overall: 6.53, skills_match: 7, ease_of_entry: 5 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 2)
  assert.equal(t.firstOverall, 6.07)
  assert.equal(t.latestOverall, 6.53)
  assert.equal(t.delta, 0.46)
  assert.equal(t.verdict, 'improving')
  // skills_match is the only dim that moved (+1) → it's the top driver.
  assert.equal(t.topMover.key, 'skills_match')
  assert.equal(t.topMover.delta, 1)
  // ease_of_entry didn't move → not the driver.
  assert.notEqual(t.topMover.key, 'ease_of_entry')
})

test('listingTrajectories detects a declining listing and a band crossing', () => {
  // 7.2 (solid) → 6.4 (pass): crosses the solid→pass boundary downward.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Slide', role: 'X', date: '2026-05-01', overall: 7.2 }),
    row({ company: 'Slide', role: 'X', date: '2026-05-20', overall: 6.4 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.verdict, 'declining')
  assert.equal(t.delta, -0.8)
  assert.equal(t.bandFrom, 'solid')
  assert.equal(t.bandTo, 'pass')
  assert.equal(t.bandChanged, true)
})

test('listingTrajectories collapses same-date duplicate writes (last wins)', () => {
  // Two rows on the SAME date are a duplicate write, not a re-eval over time.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Dup', role: 'Y', date: '2026-05-14', overall: 7.0 }),
    row({ company: 'Dup', role: 'Y', date: '2026-05-14', overall: 7.5 }),
  ))
  // Single distinct date → not a trajectory.
  assert.deepEqual(listingTrajectories(rows), [])

  // Add a genuinely later date → now it's a 2-point trajectory, and the
  // same-date pair collapsed to the LAST row (7.5), so first=7.5, latest=8.0.
  const rows2 = parseScoreHistory(tsv(
    row({ company: 'Dup', role: 'Y', date: '2026-05-14', overall: 7.0 }),
    row({ company: 'Dup', role: 'Y', date: '2026-05-14', overall: 7.5 }),
    row({ company: 'Dup', role: 'Y', date: '2026-05-20', overall: 8.0 }),
  ))
  const [t] = listingTrajectories(rows2)
  assert.equal(t.evals, 2)
  assert.equal(t.firstOverall, 7.5)
  assert.equal(t.latestOverall, 8.0)
})

// Malformed-date graceful behavior (audit finding 12b): dates are opaque
// strings compared lexically (ISO sorts right), never Date-parsed. A malformed
// value like '2026-5-1' (missing zero-padding) must NOT throw or NaN-poison the
// trajectory — it is retained verbatim and ordered by string comparison. This
// PINS the actual current behavior: here '2026-5-1' lexically sorts after the
// zero-padded January date, landing as latestDate (chronologically correct by
// luck of the padding). Zero-padding is what keeps this honest — the pin
// documents that malformed input degrades gracefully, not that it's re-parsed.
test('listingTrajectories keeps a malformed date gracefully (no throw, string-ordered)', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Acme', role: 'Analyst', date: '2026-01-01', overall: 6.0 }),
    row({ company: 'Acme', role: 'Analyst', date: '2026-5-1', overall: 8.0 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 2)
  assert.equal(t.firstDate, '2026-01-01')
  assert.equal(t.latestDate, '2026-5-1') // retained verbatim, not normalized
  assert.equal(t.firstOverall, 6.0)
  assert.equal(t.latestOverall, 8.0)
})

test('listingTrajectories merges spelling/spacing drift onto one trajectory', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Celonis', role: 'Strategy Analyst Internship', date: '2026-05-14', overall: 7.0 }),
    row({ company: 'celonis', role: 'Strategy  Analyst  Internship', date: '2026-05-27', overall: 7.4 }),
  ))
  const traj = listingTrajectories(rows)
  assert.equal(traj.length, 1)
  assert.equal(traj[0].evals, 2)
})

test('listingTrajectories reports peak/trough across a non-monotonic path', () => {
  // Climb then give it back: 6.0 → 8.0 → 6.5. first→latest delta is +0.5 but
  // peak should capture the 8.0.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Wobble', role: 'Z', date: '2026-05-01', overall: 6.0 }),
    row({ company: 'Wobble', role: 'Z', date: '2026-05-10', overall: 8.0 }),
    row({ company: 'Wobble', role: 'Z', date: '2026-05-20', overall: 6.5 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 3)
  assert.equal(t.firstOverall, 6.0)
  assert.equal(t.latestOverall, 6.5)
  assert.equal(t.delta, 0.5)
  assert.equal(t.peakOverall, 8.0)
  assert.equal(t.troughOverall, 6.0)
  assert.equal(t.sequence.length, 3)
})

test('listingTrajectories sorts biggest absolute mover first', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Small', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Small', role: 'A', date: '2026-05-10', overall: 7.3 }),  // +0.3
    row({ company: 'Big', role: 'B', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Big', role: 'B', date: '2026-05-10', overall: 5.5 }),    // -1.5
  ))
  const traj = listingTrajectories(rows)
  assert.equal(traj[0].company, 'Big')   // |−1.5| > |+0.3|
  assert.equal(traj[1].company, 'Small')
})

// ─── trajectorySummary: verdict split + band up/downgrades ────────────────────

test('trajectorySummary tallies verdicts and band moves', () => {
  const rows = parseScoreHistory(tsv(
    // improving + band upgrade: pass(6.5) → solid(7.2)
    row({ company: 'Up', role: 'A', date: '2026-05-01', overall: 6.5 }),
    row({ company: 'Up', role: 'A', date: '2026-05-10', overall: 7.2 }),
    // declining + band downgrade: solid(7.1) → pass(6.3)
    row({ company: 'Down', role: 'B', date: '2026-05-01', overall: 7.1 }),
    row({ company: 'Down', role: 'B', date: '2026-05-10', overall: 6.3 }),
    // stable: 7.0 → 7.1 (within dead-band)
    row({ company: 'Flat', role: 'C', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Flat', role: 'C', date: '2026-05-10', overall: 7.1 }),
  ))
  const sum = trajectorySummary(listingTrajectories(rows))
  assert.equal(sum.reevaluated, 3)
  assert.equal(sum.verdicts.improving, 1)
  assert.equal(sum.verdicts.declining, 1)
  assert.equal(sum.verdicts.stable, 1)
  assert.equal(sum.bandUpgrades, 1)
  assert.equal(sum.bandDowngrades, 1)
})

// ─── landscapeTrend: split, guards, share delta ───────────────────────────────

test('landscapeTrend reports insufficientData below the row floor', () => {
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 7 }),
    row({ date: '2026-05-02', overall: 7 }),
  ))
  const t = landscapeTrend(rows) // 2 rows < minPerWindow*2 (6)
  assert.equal(t.insufficientData, true)
})

test('landscapeTrend reports insufficientData when all evals share one date', () => {
  const rows = parseScoreHistory(tsv(
    ...Array.from({ length: 8 }, () => row({ date: '2026-05-01', overall: 7 })),
  ))
  const t = landscapeTrend(rows) // plenty of rows, but 1 distinct date → no time axis
  assert.equal(t.insufficientData, true)
  assert.equal(t.distinctDates, 1)
})

test('landscapeTrend splits at the median date and computes an upward trend', () => {
  // 3 older roles avg 6.0, 3 recent roles avg 8.0 → recent sharper.
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    row({ date: '2026-05-03', overall: 6.0 }),
    row({ date: '2026-05-20', overall: 8.0 }),
    row({ date: '2026-05-21', overall: 8.0 }),
    row({ date: '2026-05-22', overall: 8.0 }),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, false)
  assert.equal(t.older.count, 3)
  assert.equal(t.recent.count, 3)
  assert.equal(t.older.avgOverall, 6.0)
  assert.equal(t.recent.avgOverall, 8.0)
  assert.equal(t.delta, 2.0)
  assert.equal(t.verdict, 'improving')
  // strong/solid share: older 0% (all 6.0 = pass), recent 100% (all 8.0 = strong)
  assert.equal(t.older.strongSolidShare, 0)
  assert.equal(t.recent.strongSolidShare, 100)
  assert.equal(t.strongSolidShareDelta, 100)
})

test('landscapeTrend detects a downward trend', () => {
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 8.0 }),
    row({ date: '2026-05-02', overall: 8.0 }),
    row({ date: '2026-05-03', overall: 8.0 }),
    row({ date: '2026-05-20', overall: 6.0 }),
    row({ date: '2026-05-21', overall: 6.0 }),
    row({ date: '2026-05-22', overall: 6.0 }),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.verdict, 'declining')
  assert.equal(t.delta, -2.0)
})

test('landscapeTrend stays stable inside the ±0.15 landscape dead-band', () => {
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 7.0 }),
    row({ date: '2026-05-02', overall: 7.1 }),
    row({ date: '2026-05-03', overall: 7.0 }),
    row({ date: '2026-05-20', overall: 7.05 }),
    row({ date: '2026-05-21', overall: 7.1 }),
    row({ date: '2026-05-22', overall: 7.0 }),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, false)
  assert.equal(t.verdict, 'stable')
})

test('landscapeTrend picks a balanced split, not the lopsided median-date cut', () => {
  // Dates: 05-01(×1), 05-02(×4), 05-03(×4). Distinct dates = 3, so the naive
  // "median date" cut is at 05-02 → older = 1 row (starved). The balanced-split
  // search instead cuts at 05-03: older = 5 (05-01 + 05-02), recent = 4. Both
  // clear the floor and the split is as close to 50/50 as the calendar allows.
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    row({ date: '2026-05-03', overall: 8.0 }),
    row({ date: '2026-05-03', overall: 8.0 }),
    row({ date: '2026-05-03', overall: 8.0 }),
    row({ date: '2026-05-03', overall: 8.0 }),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, false)
  assert.equal(t.splitDate, '2026-05-03')
  assert.equal(t.older.count, 5)
  assert.equal(t.recent.count, 4)
})

test('landscapeTrend reports insufficientData when no boundary yields two viable windows', () => {
  // One lone early row then a big same-day batch — no cut gives older ≥ 3.
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 6.0 }),
    row({ date: '2026-05-02', overall: 6.0 }),
    ...Array.from({ length: 6 }, () => row({ date: '2026-05-03', overall: 8.0 })),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, true)
})

// ─── trendRecommendations: gates ──────────────────────────────────────────────

test('trendRecommendations flags the sharpest decliner and strongest improver', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Faller', role: 'D', date: '2026-05-01', overall: 7.2 }),
    row({ company: 'Faller', role: 'D', date: '2026-05-20', overall: 6.2 }),   // -1.0
    row({ company: 'Riser', role: 'R', date: '2026-05-01', overall: 6.5 }),
    row({ company: 'Riser', role: 'R', date: '2026-05-20', overall: 7.6 }),    // +1.1, band cross
  ))
  const traj = listingTrajectories(rows)
  const recs = trendRecommendations(traj, { insufficientData: true })
  assert.ok(recs.some(r => /Re-check "Faller/.test(r.action)))
  assert.ok(recs.some(r => /Prioritize "Riser/.test(r.action)))
  // Riser crossed pass→solid → high impact.
  const riserRec = recs.find(r => /Riser/.test(r.action))
  assert.equal(riserRec.impact, 'high')
})

test('trendRecommendations stays silent on movements below minDelta', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Tiny', role: 'T', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Tiny', role: 'T', date: '2026-05-20', overall: 7.3 }),   // +0.3 < 0.5
  ))
  const recs = trendRecommendations(listingTrajectories(rows), { insufficientData: true })
  assert.equal(recs.length, 0)
})

test('trendRecommendations emits a landscape verdict line when trending up', () => {
  const trend = {
    insufficientData: false, verdict: 'improving',
    recent: { avgOverall: 7.8 }, older: { avgOverall: 6.9 },
    delta: 0.9, strongSolidShareDelta: 20,
  }
  const recs = trendRecommendations([], trend)
  assert.ok(recs.some(r => /Targeting is sharpening/.test(r.action)))
})

// ─── analyzeTrend: end-to-end shape + error guards ────────────────────────────

test('analyzeTrend returns a structured analysis object', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'A', role: 'r', date: '2026-05-01', overall: 6.0 }),
    row({ company: 'A', role: 'r', date: '2026-05-20', overall: 7.0 }),
    row({ company: 'B', role: 's', date: '2026-05-02', overall: 6.0 }),
    row({ company: 'C', role: 't', date: '2026-05-03', overall: 8.0 }),
    row({ company: 'D', role: 'u', date: '2026-05-21', overall: 8.0 }),
    row({ company: 'E', role: 'v', date: '2026-05-22', overall: 8.0 }),
  ))
  const out = analyzeTrend(rows)
  assert.equal(out.metadata.evaluated, 6)
  assert.equal(out.metadata.reevaluatedListings, 1)   // only (A, r) repeats
  assert.equal(out.metadata.dateRange.from, '2026-05-01')
  assert.ok(Array.isArray(out.listingTrajectories))
  assert.ok(out.trajectorySummary)
  assert.ok(out.landscapeTrend)
  assert.ok(Array.isArray(out.recommendations))
})

test('analyzeTrend errors on empty or score-less input', () => {
  assert.ok(analyzeTrend([]).error)
  const noScores = parseScoreHistory(tsv(row({ overall: 'x' })))
  assert.ok(analyzeTrend(noScores).error)
})

/* ═══════════════════════════════════════════════════════════════════════════
 * Additional edge-case coverage (extension round)
 * ═══════════════════════════════════════════════════════════════════════════ */

// ─── listingTrajectories: rows missing date or non-finite overall ──────────

test('listingTrajectories skips rows that have no date', () => {
  // A row without a date field is not eligible for trajectories.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Nodater', role: 'X', overall: 7.0, date: '' }),
    row({ company: 'Nodater', role: 'X', overall: 7.5, date: '' }),
  ))
  // Both rows parsed with empty date → filtered out → no trajectory.
  assert.deepEqual(listingTrajectories(rows), [])
})

test('listingTrajectories skips rows with non-finite overall (NaN / string)', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'BadScore', role: 'Y', overall: 'TBD', date: '2026-05-01' }),
    row({ company: 'BadScore', role: 'Y', overall: 7.0,   date: '2026-05-10' }),
  ))
  // Only 1 row is scoreable → no trajectory (need ≥2 distinct-date scored rows).
  assert.deepEqual(listingTrajectories(rows), [])
})

// ─── trajectorySummary: empty input + all-stable ──────────────────────────

test('trajectorySummary on empty trajectories returns zero-state', () => {
  const sum = trajectorySummary([])
  assert.equal(sum.reevaluated, 0)
  assert.equal(sum.avgDelta, 0)
  assert.equal(sum.medianDelta, 0)
  assert.equal(sum.bandUpgrades, 0)
  assert.equal(sum.bandDowngrades, 0)
  assert.deepEqual(sum.verdicts, { improving: 0, declining: 0, stable: 0 })
})

test('trajectorySummary with all-stable trajectories has zero band moves', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'P', role: 'q', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'P', role: 'q', date: '2026-05-10', overall: 7.1 }),
    row({ company: 'Q', role: 'r', date: '2026-05-01', overall: 8.0 }),
    row({ company: 'Q', role: 'r', date: '2026-05-10', overall: 8.1 }),
  ))
  const sum = trajectorySummary(listingTrajectories(rows))
  assert.equal(sum.verdicts.stable, 2)
  assert.equal(sum.bandUpgrades, 0)
  assert.equal(sum.bandDowngrades, 0)
})

// ─── classifyDelta: Infinity / -Infinity ──────────────────────────────────

test('classifyDelta handles Infinity as improving (finite check is already in guard)', () => {
  // Infinity IS finite? No — Number.isFinite(Infinity) is false → 'unknown'.
  assert.equal(classifyDelta(Infinity), 'unknown')
  assert.equal(classifyDelta(-Infinity), 'unknown')
})

// ─── landscapeTrend: custom minPerWindow ──────────────────────────────────

test('landscapeTrend respects a custom minPerWindow=1', () => {
  // With minPerWindow=1, even a 2-row dataset with 2 distinct dates qualifies.
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 6.0 }),
    row({ date: '2026-05-20', overall: 8.0 }),
  ))
  const t = landscapeTrend(rows, { minPerWindow: 1 })
  assert.equal(t.insufficientData, false)
  assert.equal(t.older.count, 1)
  assert.equal(t.recent.count, 1)
  assert.equal(t.delta, 2.0)
})

// ─── landscapeTrend: the "stable" verdict uses a ±0.15 dead-band ─────────

test('landscapeTrend stable verdict at exactly ±0.15 boundary', () => {
  // Use values that produce delta = exactly 0.15 (or -0.15) — should be 'stable'.
  const rows = parseScoreHistory(tsv(
    row({ date: '2026-05-01', overall: 7.0 }),
    row({ date: '2026-05-02', overall: 7.0 }),
    row({ date: '2026-05-03', overall: 7.0 }),
    row({ date: '2026-05-20', overall: 7.15 }),
    row({ date: '2026-05-21', overall: 7.15 }),
    row({ date: '2026-05-22', overall: 7.15 }),
  ))
  const t = landscapeTrend(rows)
  // delta = 0.15 which is NOT strictly > 0.15 → should be 'stable' per classifyDelta(_, {stableBand:0.15}).
  assert.equal(t.verdict, 'stable')
})

// ─── trendRecommendations: declining landscape verdict ───────────────────

test('trendRecommendations emits a declining-landscape verdict', () => {
  const trend = {
    insufficientData: false, verdict: 'declining',
    recent: { avgOverall: 6.2 }, older: { avgOverall: 7.5 },
    delta: -1.3, strongSolidShareDelta: -20,
  }
  const recs = trendRecommendations([], trend)
  assert.ok(recs.some(r => /quality is sliding/.test(r.action)))
  const rec = recs.find(r => /quality is sliding/.test(r.action))
  assert.equal(rec.impact, 'high')
})

test('trendRecommendations is silent when trend is insufficient data', () => {
  const trend = { insufficientData: true }
  const recs = trendRecommendations([], trend)
  // No landscape-level rec when there is no usable trend.
  assert.ok(!recs.some(r => /sharpening|sliding/.test(r.action)))
})

// ─── listingTrajectories: topMover is null when no dimension changed ───────

test('listingTrajectories topMover is null when all dimensions are identical across evals', () => {
  // Both evaluations have every dimension the same — only overall differs (forced).
  const rows = parseScoreHistory(tsv(
    row({ company: 'Flat', role: 'Z', date: '2026-05-01', overall: 6.5 }),
    row({ company: 'Flat', role: 'Z', date: '2026-05-10', overall: 7.5 }),
  ))
  const [t] = listingTrajectories(rows)
  // Every base dimension in the row() helper is the same across both evals,
  // so no dim delta is non-zero → topMover is null.
  assert.equal(t.topMover, null)
})

// ─── listingTrajectories: sequence has all eval dates in order ────────────

test('listingTrajectories sequence is chronological even if rows arrived out of order', () => {
  // Feed rows in reverse-chronological order; the output sequence must be sorted.
  const rows = parseScoreHistory(tsv(
    row({ company: 'OutOfOrder', role: 'A', date: '2026-05-20', overall: 8.0 }),
    row({ company: 'OutOfOrder', role: 'A', date: '2026-05-01', overall: 6.0 }),
    row({ company: 'OutOfOrder', role: 'A', date: '2026-05-10', overall: 7.0 }),
  ))
  const [t] = listingTrajectories(rows)
  const dates = t.sequence.map(s => s.date)
  assert.deepEqual(dates, ['2026-05-01', '2026-05-10', '2026-05-20'])
  // first and latest should reflect the true chronological endpoints.
  assert.equal(t.firstOverall, 6.0)
  assert.equal(t.latestOverall, 8.0)
})

// ─── analyzeTrend: passes custom stableBand through ──────────────────────

test('analyzeTrend passes a custom stableBand to listingTrajectories', () => {
  // A delta of 0.3 is improving under the default 0.25 band but stable under 0.5.
  const rows = parseScoreHistory(tsv(
    row({ company: 'Tight', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Tight', role: 'A', date: '2026-05-10', overall: 7.3 }),
  ))
  const defaultOut = analyzeTrend(rows, {})
  const wideOut    = analyzeTrend(rows, { stableBand: 0.5 })
  const defaultT = defaultOut.listingTrajectories[0]
  const wideT    = wideOut.listingTrajectories[0]
  assert.equal(defaultT.verdict, 'improving') // 0.3 > 0.25 default → improving
  assert.equal(wideT.verdict, 'stable')       // 0.3 ≤ 0.5 wide band → stable
})

// ═══════════════════════════════════════════════════════════════════════════
// Statistical contract (docs/scoring-statistical-design.md)
//
// Everything below pins the ADDED surface: the noise-floor classification on
// per-listing moves and the ≥10-per-window gate on the corpus verdict. The
// pre-contract fields (`verdict`, `insufficientData`, the window blocks) must
// keep their old names, types, and dead-bands throughout.
// ═══════════════════════════════════════════════════════════════════════════

// n scored rows on n distinct dates, one listing each — a calendar window.
function windowRows(prefix, count, overall, startDay) {
  return Array.from({ length: count }, (_, i) =>
    row({
      company: `${prefix}${i}`,
      role: 'A',
      date: `2026-05-${String(startDay + i).padStart(2, '0')}`,
      overall,
    }))
}

// ─── per-listing: the noise floor ────────────────────────────────────────────

test('trajectory: a delta EXACTLY at the noise floor is detectable', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Floor', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Floor', role: 'A', date: '2026-05-10', overall: 7.3 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.delta, 0.3)
  assert.equal(t.detectable, true)
  assert.equal(t.movementClass, 'improving')
  assert.equal(t.noiseFloor, OVERALL_NOISE_FLOOR)
})

test('trajectory: a delta just under the floor is within-noise, not a direction', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Wobble', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Wobble', role: 'A', date: '2026-05-10', overall: 7.29 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.detectable, false)
  assert.equal(t.movementClass, 'within-noise')
  // ...while the legacy field still reads 'improving' under its own ±0.25 band.
  assert.equal(t.verdict, 'improving')
})

test('trajectory: one CF-dimension step alone never classifies as movement', () => {
  // 7.00 → 7.23 is what a single Current Fit dim re-judging by one integer does.
  const rows = parseScoreHistory(tsv(
    row({ company: 'OneDim', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'OneDim', role: 'A', date: '2026-05-10', overall: 7.23 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.movementClass, 'within-noise')
})

test('trajectory: a declining move past the floor classifies as declining', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Slide', role: 'A', date: '2026-05-01', overall: 8.0 }),
    row({ company: 'Slide', role: 'A', date: '2026-05-10', overall: 7.2 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.movementClass, 'declining')
  assert.equal(t.detectable, true)
})

test('trajectory: a two-eval trajectory can never read above low confidence', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Two', role: 'A', date: '2026-05-01', overall: 5.0 }),
    row({ company: 'Two', role: 'A', date: '2026-05-10', overall: 9.0 }),
  ))
  const [t] = listingTrajectories(rows)
  assert.equal(t.evals, 2)
  assert.equal(t.delta, 4)          // an enormous move...
  assert.equal(t.confidence, 'low') // ...still with only one difference behind it
})

test('trajectory confidence climbs with the evaluation count', () => {
  const mk = (days) => parseScoreHistory(tsv(
    ...days.map((d, i) => row({
      company: 'Many', role: 'A', date: `2026-05-${d}`, overall: 7 + i * 0.1,
    })),
  ))
  const four = listingTrajectories(mk(['01', '02', '03', '04']))[0]
  assert.equal(four.evals, 4)
  assert.equal(four.confidence, 'moderate')
  const eight = listingTrajectories(mk(['01', '02', '03', '04', '05', '06', '07', '08']))[0]
  assert.equal(eight.confidence, 'high')
})

test('trajectorySummary splits detectable moves from flat-within-noise ones', () => {
  const rows = parseScoreHistory(tsv(
    // a real climb
    row({ company: 'Real', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Real', role: 'A', date: '2026-05-10', overall: 8.0 }),
    // a wobble under the floor
    row({ company: 'Noise', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Noise', role: 'A', date: '2026-05-10', overall: 7.1 }),
  ))
  const sum = trajectorySummary(listingTrajectories(rows))
  assert.equal(sum.detectable, 1)
  assert.equal(sum.withinNoise, 1)
  assert.equal(sum.movement.improving, 1)
  assert.equal(sum.movement['within-noise'], 1)
  assert.equal(sum.noiseFloor, OVERALL_NOISE_FLOOR)
  // Legacy fields untouched: the 0.1 wobble is still 'stable' under ±0.25.
  assert.equal(sum.reevaluated, 2)
  assert.equal(sum.verdicts.improving, 1)
  assert.equal(sum.verdicts.stable, 1)
})

test('trajectorySummary tolerates pre-contract trajectory objects', () => {
  // A caller holding a trajectory built before this contract (no movementClass)
  // still gets a correct movement split, derived from its delta.
  const sum = trajectorySummary([
    { verdict: 'improving', delta: 0.8, bandChanged: false },
    { verdict: 'stable', delta: 0.05, bandChanged: false },
  ])
  assert.equal(sum.detectable, 1)
  assert.equal(sum.withinNoise, 1)
})

// ─── corpus verdict: the ≥10-per-window gate ────────────────────────────────

test('landscapeTrend attaches a withheld verdictGate on both early-out paths', () => {
  // (a) no usable time axis at all
  const tooFew = landscapeTrend(parseScoreHistory(tsv(
    row({ company: 'A', role: 'A', date: '2026-05-01', overall: 7 }),
    row({ company: 'B', role: 'B', date: '2026-05-02', overall: 7 }),
  )))
  assert.equal(tooFew.insufficientData, true)
  assert.equal(tooFew.verdictGate.met, false)
  assert.equal(tooFew.reportableVerdict, 'insufficient-data')

  // (b) dates too concentrated for any balanced boundary (8 on one date, 1 on another)
  const concentrated = landscapeTrend(parseScoreHistory(tsv(
    ...Array.from({ length: 8 }, (_, i) =>
      row({ company: `C${i}`, role: 'A', date: '2026-05-01', overall: 7 })),
    row({ company: 'Late', role: 'A', date: '2026-05-20', overall: 8 }),
  )))
  assert.equal(concentrated.insufficientData, true)
  assert.equal(concentrated.reportableVerdict, 'insufficient-data')
  assert.equal(concentrated.verdictGate.met, false)
})

test('corpus verdict is WITHHELD with 9 evals per window (one under the gate)', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 9, 6.0, 1),
    ...windowRows('New', 9, 8.0, 11),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.insufficientData, false)  // legacy field: a split does exist
  assert.equal(t.verdict, 'improving')     // legacy field: unchanged
  assert.equal(t.verdictGate.met, false)
  assert.equal(t.verdictGate.olderCount, 9)
  assert.equal(t.reportableVerdict, 'insufficient-data')
  assert.equal(t.verdictConfidence, 'insufficient')
  assert.match(t.verdictGate.reason, /10 required/)
})

test('corpus verdict UNLOCKS at exactly 10 evals per window', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 10, 6.0, 1),
    ...windowRows('New', 10, 8.0, 11),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.verdictGate.olderCount, 10)
  assert.equal(t.verdictGate.recentCount, 10)
  assert.equal(t.reportableVerdict, 'improving')
  assert.equal(t.verdictConfidence, 'low')  // exactly at the gate
})

test('corpus verdict confidence rises with window size', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 20, 6.0, 1),
    ...windowRows('New', 20, 8.0, 21),
  ))
  assert.equal(landscapeTrend(rows).verdictConfidence, 'moderate')
})

test('a gate-passing corpus move under the noise floor is flat-within-noise', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 10, 7.0, 1),
    ...windowRows('New', 10, 7.2, 11),
  ))
  const t = landscapeTrend(rows)
  assert.equal(t.verdictGate.met, true)
  assert.equal(t.delta, 0.2)
  assert.equal(t.reportableVerdict, 'flat-within-noise')
  // The legacy field disagrees (±0.15 dead-band) and is preserved as-is.
  assert.equal(t.verdict, 'improving')
})

test('landscapeTrend accepts a caller-supplied verdict gate', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 4, 6.0, 1),
    ...windowRows('New', 4, 8.0, 11),
  ))
  assert.equal(landscapeTrend(rows).reportableVerdict, 'insufficient-data')
  assert.equal(landscapeTrend(rows, { minPerWindowForVerdict: 4 }).reportableVerdict, 'improving')
})

// ─── recommendations: the corpus claim is replaced, never softened ──────────

test('trendRecommendations emits an insufficient-data marker under the gate', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 5, 6.0, 1),
    ...windowRows('New', 5, 8.0, 11),
  ))
  const recs = trendRecommendations([], landscapeTrend(rows))
  assert.equal(recs.length, 1)
  assert.equal(recs[0].insufficientData, true)
  assert.equal(recs[0].confidence, 'insufficient')
  assert.match(recs[0].action, /insufficient data/i)
  // No sharpening/sliding language may leak through (docs § 4 rule 5).
  assert.ok(!/sharpening|sliding/i.test(recs.map(r => r.action).join(' ')))
})

test('trendRecommendations states n on a gate-passing corpus verdict', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 10, 6.0, 1),
    ...windowRows('New', 10, 8.0, 11),
  ))
  const recs = trendRecommendations([], landscapeTrend(rows))
  const corpus = recs.find(r => /sharpening/i.test(r.action))
  assert.ok(corpus, 'expected the sharpening verdict once the gate is met')
  assert.equal(corpus.sampleSize, 10)
  assert.equal(corpus.confidence, 'low')
  assert.match(corpus.reasoning, /10 earlier vs 10 recent evals/)
})

test('trendRecommendations reports a gate-passing flat corpus as flat', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 10, 7.0, 1),
    ...windowRows('New', 10, 7.2, 11),
  ))
  const recs = trendRecommendations([], landscapeTrend(rows))
  assert.equal(recs.length, 1)
  assert.match(recs[0].action, /flat within noise/i)
  assert.equal(recs[0].sampleSize, 10)
})

test('trendRecommendations keeps pre-contract behavior for hand-built trends', () => {
  // An external caller passing the old shape (no verdictGate) is unaffected.
  const trend = {
    insufficientData: false, verdict: 'improving',
    older: { avgOverall: 6.5 }, recent: { avgOverall: 7.4 },
    delta: 0.9, strongSolidShareDelta: 12,
  }
  const recs = trendRecommendations([], trend)
  assert.equal(recs.length, 1)
  assert.match(recs[0].action, /Targeting is sharpening/)
})

// ─── analyzeTrend: additive shape ───────────────────────────────────────────

test('analyzeTrend publishes the contract it ran under', () => {
  const rows = parseScoreHistory(tsv(
    ...windowRows('Old', 10, 6.0, 1),
    ...windowRows('New', 10, 8.0, 11),
  ))
  const out = analyzeTrend(rows)
  assert.equal(out.metadata.contract.noiseFloor, OVERALL_NOISE_FLOOR)
  assert.equal(out.metadata.contract.minPerWindowForVerdict, 10)
  assert.equal(out.metadata.contract.minEvalsPerTrajectory, 2)
  assert.match(out.metadata.contract.doc, /scoring-statistical-design/)
})

test('analyzeTrend keeps every pre-contract field with its old meaning', () => {
  const rows = parseScoreHistory(tsv(
    row({ company: 'Re', role: 'A', date: '2026-05-01', overall: 7.0 }),
    row({ company: 'Re', role: 'A', date: '2026-05-10', overall: 8.0 }),
    ...windowRows('Old', 4, 6.0, 2),
    ...windowRows('New', 4, 7.0, 12),
  ))
  const out = analyzeTrend(rows)
  assert.equal(typeof out.metadata.evaluated, 'number')
  assert.equal(typeof out.metadata.reevaluatedListings, 'number')
  assert.ok(out.metadata.dateRange.from && out.metadata.dateRange.to)

  const t = out.listingTrajectories[0]
  for (const k of ['key', 'company', 'role', 'evals', 'firstDate', 'latestDate',
    'firstOverall', 'latestOverall', 'delta', 'bandFrom', 'bandTo', 'bandChanged',
    'peakOverall', 'troughOverall', 'verdict', 'dimDeltas', 'sequence']) {
    assert.ok(k in t, `trajectory lost pre-contract field: ${k}`)
  }
  assert.ok(['improving', 'declining', 'stable', 'unknown'].includes(t.verdict))

  for (const k of ['reevaluated', 'verdicts', 'avgDelta', 'medianDelta',
    'bandUpgrades', 'bandDowngrades']) {
    assert.ok(k in out.trajectorySummary, `summary lost pre-contract field: ${k}`)
  }

  for (const k of ['insufficientData', 'splitDate', 'older', 'recent', 'delta',
    'strongSolidShareDelta', 'verdict']) {
    assert.ok(k in out.landscapeTrend, `landscapeTrend lost pre-contract field: ${k}`)
  }
  assert.equal(typeof out.landscapeTrend.older.count, 'number')
  assert.equal(typeof out.landscapeTrend.recent.avgOverall, 'number')
})
