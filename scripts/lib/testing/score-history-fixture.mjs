// score-history-fixture.mjs — shared v2 test fixtures for the analytics
// suites (targeting, peer-rank, score-trend, calibration, positioning, …).
//
// Builds data/score-history.tsv rows in the v2 29-column layout
// (docs/scoring-v2.md §8.1). Match / Ease / Priority / verdict / tier are
// derived through the real engine unless a test overrides them, so fixtures
// can never disagree with the scoring rules. Companies are fictional.
//
// Not a test file itself (no `.test.mjs` suffix), so `npm test` doesn't run it.

import { SCORE_HISTORY_HEADER } from '../profile-core.mjs'
import {
  rollupMatch, rollupEase, assignVerdict, computePriority,
  MATCH_DIMS, EASE_DIMS,
} from '../score-bands.mjs'

export const HISTORY_COLUMNS = SCORE_HISTORY_HEADER.split('\t')
export const HISTORY_HEADER = SCORE_HISTORY_HEADER

export const BASE_DIMS = Object.freeze({
  skills_match: 7, experience_bar: 7, competition: 6,
  growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7,
  best_cities: 7, salary_adj_city: 6, work_life_balance: 7,
})

/**
 * One score-history row object (all 29 keys). Pass dimension overrides and/or
 * any column. `eligibility: 'red'` makes a Blocked row: every dimension,
 * match, ease and priority cell is empty, verdict `blocked`, tier T4.
 * `amber_count` (not a column) feeds the Ease amber penalty; it defaults to
 * the number of amber flags in `eligibility_flags`.
 */
export function historyRowObject(over = {}) {
  const eligibility = over.eligibility ?? 'green'
  const flags = over.eligibility_flags ?? ''
  const base = {
    date: '2026-09-01', archetype: 'Data Analyst',
    best_fit_roles: 'Analyst', mode: 'scouting',
    company: 'Northwind Analytics', role: 'Analyst', source: 'pipeline',
    location: 'Lisbon', employment_type: 'full-time', duration: 'permanent',
    salary_raw: 'n/d', url: 'https://jobs.example.test/1',
    eligibility, eligibility_flags: flags,
  }
  if (eligibility === 'red') {
    const out = { ...base, ...over }
    for (const k of [...MATCH_DIMS, ...EASE_DIMS, 'match', 'ease', 'priority']) out[k] = over[k] ?? ''
    out.verdict = over.verdict ?? 'blocked'
    out.tier = over.tier ?? 'T4'
    delete out.amber_count
    return out
  }
  const dims = { ...BASE_DIMS }
  for (const k of Object.keys(BASE_DIMS)) if (over[k] !== undefined) dims[k] = over[k]
  const amberCount = over.amber_count ??
    flags.split(';').filter(f => /^[^:]+:amber:/.test(f)).length
  const match = over.match ?? rollupMatch(dims).score
  const ease = over.ease ?? rollupEase(dims, { amber_count: amberCount }).score
  const v = assignVerdict({ match, ease, eligibility })
  const out = {
    ...base, ...dims,
    match, ease,
    priority: over.priority ?? computePriority(match, ease),
    verdict: over.verdict ?? v.verdict,
    tier: over.tier ?? v.tier,
  }
  for (const [k, val] of Object.entries(over)) if (!(k in out) && k !== 'amber_count') out[k] = val
  for (const k of ['date', 'archetype', 'best_fit_roles', 'mode', 'company', 'role', 'source', 'location', 'employment_type', 'duration', 'salary_raw', 'url']) {
    if (over[k] !== undefined) out[k] = over[k]
  }
  return out
}

/** One TSV data line in header order. */
export function historyRow(over = {}) {
  const o = historyRowObject(over)
  return HISTORY_COLUMNS.map(k => (o[k] ?? '')).join('\t')
}

/** Header + rows. Each arg is an overrides object or a pre-built line. */
export function historyTsv(...rows) {
  return [HISTORY_HEADER, ...rows.map(r => (typeof r === 'string' ? r : historyRow(r)))].join('\n') + '\n'
}
