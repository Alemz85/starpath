// Test-only fixtures. Not imported by any route, so it never reaches the
// app bundle — it only exists to keep the unit suites readable. A ScoreEntry
// has ~30 fields; tests care about three or four at a time, so this factory
// fills the rest with inert defaults and lets each test override what it
// asserts on. Company names are fictional (the repo is public).

import type { ScoreEntry, ApplicationEntry, ScoutingEntry } from '@/types'

/** An UNSCORED v2 row by default: every dimension / Want / Ease / Priority is
 *  null (spec §8.1 — empty cells are missing, never 0). Pass the fields a test
 *  asserts on; `scored()` below fills a plausible full dimension set. */
export function makeScoreEntry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return {
    date: '2026-04-27',
    archetype: 'Data Analyst',
    skills_match: null,
    experience_bar: null,
    competition: null,
    ease: null,
    growth_mobility: null,
    optionality_exit: null,
    brand_value: null,
    role_content: null,
    best_cities: null,
    salary_adj_city: null,
    work_life_balance: null,
    want: null,
    priority: null,
    eligibility: 'green',
    eligibility_flags: '',
    verdict: null,
    best_fit_roles: '',
    mode: 'scouting',
    company: 'Acme',
    role: 'Analyst',
    tier: 'T3',
    source: '',
    location: '',
    employment_type: '',
    duration: '',
    salary_raw: '',
    url: '',
    ...overrides,
  }
}

/** A fully scored row: every dimension at `dim` (default 6), plus the given
 *  Want / Ease. Verdict / tier / priority are left to the caller or derived
 *  by the code under test. */
export function makeScoredEntry(
  want: number,
  ease: number,
  overrides: Partial<ScoreEntry> = {},
  dim = 6,
): ScoreEntry {
  return makeScoreEntry({
    skills_match: dim, experience_bar: dim, competition: dim,
    growth_mobility: dim, optionality_exit: dim, brand_value: dim, role_content: dim,
    best_cities: dim, salary_adj_city: dim, work_life_balance: dim,
    want, ease,
    priority: Math.round(Math.sqrt(want * ease) * 100) / 100,
    ...overrides,
  })
}

/** A blocked (eligibility red) row — no scores, the reason in the flags. */
export function makeBlockedEntry(reason = 'German C1 required', overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return makeScoreEntry({
    eligibility: 'red',
    eligibility_flags: `language:red:${reason}`,
    verdict: 'blocked',
    tier: 'T4',
    ...overrides,
  })
}

export function makeApplication(overrides: Partial<ApplicationEntry> = {}): ApplicationEntry {
  return {
    num: 1,
    date: '2026-04-27',
    company: 'Acme',
    role: 'Analyst',
    score: 'W8.0 E7.0',
    status: 'Evaluated',
    pdf: false,
    deadline: 'n/d',
    report: '',
    notes: '',
    entityId: '',
    cities: [],
    ...overrides,
  }
}

export function makeScoutingEntry(overrides: Partial<ScoutingEntry> = {}): ScoutingEntry {
  return {
    num: 1,
    date: '2026-04-27',
    company: 'Acme',
    role: 'Analyst',
    want: 7.5,
    ease: 6.0,
    tier: 'T2',
    eligibility: 'green',
    eligibilityReason: '',
    report: '—',
    deadline: 'n/d',
    promotionHint: '',
    notes: '',
    entityId: '',
    cities: [],
    ...overrides,
  }
}
