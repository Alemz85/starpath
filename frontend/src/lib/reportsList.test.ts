import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getScoreBand, ALL_BANDS, BAND_DETAILS, nextBandUp,
  filterReportRows, sortReportRows, corpusBands, bandCounts,
  buildScoreIndex, matchScore,
  fixabilityScore, isNearMiss,
  reportRowFixability, reportEngineLever,
  type ScoreBand, type ReportRowLike, type FixabilityRow,
} from '@/lib/reportsList'
import { rowLever, replay, leverContextOf, type V2Dims } from '@/lib/tierLevers'
import { makeScoreEntry, makeBlockedEntry } from '@/test-utils/fixtures'
import { TIER_COLORS } from '@/types'
import type { ScoreEntry } from '@/types'

// A report row carries only the handful of fields the grid reads.
function row(over: Partial<ReportRowLike> = {}): ReportRowLike {
  return { company: 'Acme', role: 'Analyst', tier: 'T2', want: 7.5, ease: 7.5, mtime: 0, ...over }
}

// ─── getScoreBand: verdict, never a number cut-off ───────────────────────────

test('getScoreBand prefers the stored verdict', () => {
  assert.equal(getScoreBand(row({ verdict: 'thin', want: 9, ease: 9 })), 'thin')
  assert.equal(getScoreBand(row({ verdict: 'Stretch' })), 'stretch')
})

test('getScoreBand replays the grid from Want / Ease when the verdict is missing', () => {
  assert.equal(getScoreBand(row({ want: 8, ease: 7 })), 'go')
  assert.equal(getScoreBand(row({ want: 8, ease: 6.99 })), 'stretch')
  assert.equal(getScoreBand(row({ want: 8, ease: 4.99 })), 'growth')
  assert.equal(getScoreBand(row({ want: 7.99, ease: 7 })), 'solid')
  assert.equal(getScoreBand(row({ want: 6.5, ease: 5 })), 'thin')
  assert.equal(getScoreBand(row({ want: 6.49, ease: 10 })), 'skip')
})

test('getScoreBand: red eligibility is blocked', () => {
  assert.equal(getScoreBand(row({ want: null, ease: null, eligibility: 'red' })), 'blocked')
})

test('getScoreBand falls back to the folder tier for an orphan report', () => {
  const orphan = (tier: string) => row({ tier, want: null, ease: null })
  assert.equal(getScoreBand(orphan('T1')), 'go')
  assert.equal(getScoreBand(orphan('t2')), 'solid')
  assert.equal(getScoreBand(orphan('T3')), 'growth')
  assert.equal(getScoreBand(orphan('T4')), 'skip')
  assert.equal(getScoreBand(orphan('')), 'skip')
})

test('every band has display details from its tier tokens; ALL_BANDS is best → worst', () => {
  assert.deepEqual([...ALL_BANDS], ['go', 'stretch', 'solid', 'growth', 'thin', 'skip', 'blocked'])
  assert.equal(BAND_DETAILS.go.label, 'Go')
  assert.equal(BAND_DETAILS.go.text, TIER_COLORS.T1.text)
  assert.equal(BAND_DETAILS.stretch.bg, TIER_COLORS.T2.bg)
  assert.equal(BAND_DETAILS.growth.border, TIER_COLORS.T3.border)
  assert.equal(BAND_DETAILS.blocked.text, TIER_COLORS.T4.text)
  for (const b of ALL_BANDS) assert.ok(BAND_DETAILS[b]?.label, `${b} has a label`)
})

test('nextBandUp walks the better-cell order; go and blocked have none', () => {
  assert.equal(nextBandUp('skip'), 'thin')
  assert.equal(nextBandUp('thin'), 'growth')
  assert.equal(nextBandUp('stretch'), 'go')
  assert.equal(nextBandUp('go'), null)
  assert.equal(nextBandUp('blocked'), null)
})

// ─── filterReportRows ────────────────────────────────────────────────────────

test('filterReportRows with no query and no bands returns the input untouched', () => {
  const rows = [row(), row({ company: 'Beta' })]
  assert.equal(filterReportRows(rows, {}), rows)
})

test('filterReportRows matches the query against company OR role, case-insensitively, trimmed', () => {
  const rows = [
    row({ company: 'Initech', role: 'Risk Analyst' }),
    row({ company: 'Acme', role: 'ML Engineer' }),
    row({ company: 'Globex', role: 'Data Analyst' }),
  ]
  assert.deepEqual(filterReportRows(rows, { query: '  ANALYST ' }).map(r => r.company), ['Initech', 'Globex'])
  assert.deepEqual(filterReportRows(rows, { query: 'acme' }).map(r => r.company), ['Acme'])
})

test('filterReportRows treats the band set as an OR multi-select and ANDs the query', () => {
  const rows = [
    row({ company: 'A', want: 9, ease: 9 }),       // go
    row({ company: 'B', want: 8, ease: 6 }),       // stretch
    row({ company: 'C', want: 5, ease: 5 }),       // skip
  ]
  const both = filterReportRows(rows, { bands: new Set<ScoreBand>(['go', 'skip']) })
  assert.deepEqual(both.map(r => r.company), ['A', 'C'])
  assert.deepEqual(filterReportRows(rows, { bands: new Set<ScoreBand>(['go', 'skip']), query: 'c' }).map(r => r.company), ['C'])
  assert.equal(filterReportRows(rows, { bands: new Set() }).length, 3)
  assert.deepEqual(filterReportRows([], { query: 'x' }), [])
})

// ─── sortReportRows ──────────────────────────────────────────────────────────

test('sortReportRows by score sorts on Priority; blocked/unscored rows last', () => {
  const rows = [
    row({ company: 'Low', want: 6, ease: 6 }),            // 6.0
    row({ company: 'Blocked', want: null, ease: null, eligibility: 'red' }),
    row({ company: 'High', want: 9, ease: 8 }),           // 8.49
    row({ company: 'Mid', want: 8, ease: 6, priority: 6.93 }),
  ]
  assert.deepEqual(sortReportRows(rows, 'score', 'desc').map(r => r.company), ['High', 'Mid', 'Low', 'Blocked'])
  assert.deepEqual(sortReportRows(rows, 'score', 'asc').map(r => r.company), ['Blocked', 'Low', 'Mid', 'High'])
})

test('sortReportRows by date keys off mtime', () => {
  const rows = [row({ company: 'Old', mtime: 1 }), row({ company: 'New', mtime: 9 })]
  assert.deepEqual(sortReportRows(rows, 'date', 'desc').map(r => r.company), ['New', 'Old'])
  assert.deepEqual(sortReportRows(rows, 'date', 'asc').map(r => r.company), ['Old', 'New'])
})

test('sortReportRows by tier: T1→T4, unknown last, better verdict first within a tier', () => {
  const rows = [
    row({ company: 'T4', tier: 'T4', want: 5, ease: 5 }),
    row({ company: 'X', tier: 'weird' }),
    row({ company: 'T2thin', tier: 'T2', want: 7, ease: 6 }),
    row({ company: 'T2stretch', tier: 'T2', want: 8.5, ease: 6 }),
    row({ company: 'T1', tier: 'T1', want: 9, ease: 9 }),
  ]
  assert.deepEqual(sortReportRows(rows, 'tier', 'desc').map(r => r.company), ['T1', 'T2stretch', 'T2thin', 'T4', 'X'])
})

test('sortReportRows does not mutate its input', () => {
  const rows = [row({ company: 'B', want: 6, ease: 6 }), row({ company: 'A', want: 9, ease: 9 })]
  const copy = [...rows]
  sortReportRows(rows, 'score', 'desc')
  assert.deepEqual(rows, copy)
})

// ─── corpusBands / bandCounts ────────────────────────────────────────────────

test('corpusBands lists only the bands actually present, in canonical order, deduped', () => {
  const rows = [row({ want: 5, ease: 5 }), row({ want: 9, ease: 9 }), row({ want: 9, ease: 9 }), row({ eligibility: 'red', want: null, ease: null })]
  assert.deepEqual(corpusBands(rows), ['go', 'skip', 'blocked'])
})

test('bandCounts tallies per band and respects the query', () => {
  const rows = [
    row({ company: 'Acme', want: 9, ease: 9 }),
    row({ company: 'Acme', want: 8, ease: 6 }),
    row({ company: 'Globex', want: 9, ease: 9 }),
  ]
  const all = bandCounts(rows)
  assert.equal(all.go, 2)
  assert.equal(all.stretch, 1)
  assert.equal(all.blocked, 0)
  assert.equal(bandCounts(rows, 'globex').go, 1)
  assert.equal(bandCounts(rows, 'globex').stretch, 0)
  assert.ok(Object.values(bandCounts([])).every(n => n === 0))
})

// ─── buildScoreIndex / matchScore ────────────────────────────────────────────

test('matchScore: exact → file-name rule → unique prefix (both directions) → null', () => {
  const entries = [
    makeScoreEntry({ company: 'Acme', role: 'Analyst', want: 6, ease: 6 }),
    makeScoreEntry({ company: 'Acme', role: 'Senior Strategy Associate', want: 7, ease: 7 }),
    makeScoreEntry({ company: 'Globex', role: 'PM', want: 6, ease: 6 }),
    makeScoreEntry({ company: 'Globex', role: 'Data Lead', want: 9, ease: 8 }),
    makeBlockedEntry('x', { company: 'Globex', role: 'Intern' }),
  ]
  const idx = buildScoreIndex(entries)
  assert.equal(matchScore(idx, { company: ' acme ', role: 'ANALYST' })?.role, 'Analyst')
  assert.equal(matchScore(idx, { company: 'Acme', role: 'Senior Strategy' })?.role, 'Senior Strategy Associate')
  assert.equal(matchScore(idx, { company: 'Acme', role: 'Senior Strategy Associate II' })?.role, 'Senior Strategy Associate')
  // No company-wide fallback: an unknown role at a known company stays unscored.
  assert.equal(matchScore(idx, { company: 'Globex', role: 'Something else' }), null)
  assert.equal(matchScore(idx, { company: 'Nope', role: 'x' }), null)
  assert.equal(buildScoreIndex([]).byExact.size, 0)
})

test('matchScore: a report saved without parentheses finds its own listing, never a sibling', () => {
  const entries = [
    makeScoreEntry({ company: 'Nimbus Robotics', role: 'Program Analyst Intern, Lyon 2027', want: 8, ease: 8.25 }),
    makeScoreEntry({ company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 (Lyon)', want: 8, ease: 7.4 }),
  ]
  const idx = buildScoreIndex(entries)
  // File name "Nimbus Robotics - Process Analyst Intern 2027 Lyon.md"
  const hit = matchScore(idx, { company: 'Nimbus Robotics', role: 'Process Analyst Intern 2027 Lyon' })
  assert.equal(hit?.role, 'Process Analyst Intern 2027 (Lyon)')
  assert.equal(hit?.ease, 7.4)
  // A report for a third listing at the same company borrows nobody's scores.
  assert.equal(matchScore(idx, { company: 'Nimbus Robotics', role: 'Data Analyst Intern (Lisbon)' }), null)
  // A prefix that fits both listings is ambiguous: unscored, not the higher-priority one.
  assert.equal(matchScore(idx, { company: 'Nimbus Robotics', role: 'P' }), null)
})

// ─── fixability / near-miss ──────────────────────────────────────────────────

test('without a scored entry a report is never a near-miss', () => {
  assert.equal(isNearMiss({ ...row() }), false)
  assert.equal(fixabilityScore({ ...row() }), 0)
  const blocked: FixabilityRow = { ...row({ want: null, ease: null, eligibility: 'red' }), scoreEntry: makeBlockedEntry() }
  assert.equal(isNearMiss(blocked), false)
  assert.equal(fixabilityScore(blocked), 0)
})

// ─── Unified engine path (reportsList ↔ tierLevers) ──────────────────────────

const near: V2Dims = {
  growth_mobility: 8, optionality_exit: 8, brand_value: 9, role_content: 7,
  best_cities: 8, salary_adj_city: 6, work_life_balance: 6,
  skills_match: 7, experience_bar: 7, competition: 6,
}
function scored(d: V2Dims, over: Partial<ScoreEntry> = {}): ScoreEntry {
  const base = makeScoreEntry({ ...d, employment_type: 'full-time', ...over })
  const r = replay(d, leverContextOf(base, d))
  return { ...base, want: r.want, ease: r.ease, verdict: r.verdict, ...over }
}

test('DRIFT GUARD: a report row carrying real dims reads identically to the Database', () => {
  const entry = scored(near) // stretch, one step from go
  const fr: FixabilityRow = { ...row({ want: entry.want, ease: entry.ease, verdict: entry.verdict }), scoreEntry: entry }
  const db = rowLever(entry)
  const rep = reportRowFixability(fr)
  assert.equal(rep.nearMiss, db.nearMiss)
  assert.deepEqual(rep.engineLever, db.best)
  assert.deepEqual(reportEngineLever(fr), db.best)
  assert.equal(isNearMiss(fr), true)
})

test('a far row (needs +2) is not a near-miss, and a go row never is', () => {
  const far = scored({ ...near, growth_mobility: 6, optionality_exit: 6, brand_value: 6, role_content: 6, best_cities: 6, skills_match: 6, experience_bar: 6 })
  assert.equal(isNearMiss({ ...row(), scoreEntry: far }), false)
  assert.equal(isNearMiss({ ...row({ want: 9, ease: 9 }), scoreEntry: far }), false)
})

test('sortReportRows by fixable puts the cheapest upgrade first under desc', () => {
  const far = scored({ ...near, growth_mobility: 6, optionality_exit: 6, brand_value: 6, role_content: 6, best_cities: 6, skills_match: 6, experience_bar: 6 })
  const rows: FixabilityRow[] = [
    { ...row({ company: 'None', want: 6, ease: 6 }) },
    { ...row({ company: 'Near' }), scoreEntry: scored(near) },
    { ...row({ company: 'Far' }), scoreEntry: far },
  ]
  assert.deepEqual(sortReportRows(rows, 'fixable', 'desc').map(r => r.company), ['Near', 'Far', 'None'])
  assert.deepEqual(sortReportRows(rows, 'fixable', 'asc').map(r => r.company), ['None', 'Far', 'Near'])
})
