// Test-only fixtures. Not imported by any route, so it never reaches the
// app bundle — it only exists to keep the unit suites readable. A ScoreEntry
// has ~26 fields; tests care about three or four at a time, so this factory
// fills the rest with inert defaults and lets each test override what it
// asserts on.

import type { ScoreEntry } from '@/types'

export function makeScoreEntry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return {
    date: '2026-04-27',
    archetype: 'Data Analyst',
    skills_match: 0,
    ease_of_entry: 0,
    strategic_fit: 0,
    current_fit: 0,
    growth_mobility: 0,
    optionality_exit: 0,
    brand_value: 0,
    sales_trap_risk: 0,
    aspirational_fit: 0,
    overall: 0,
    best_cities: 0,
    salary_adj_city: 0,
    work_life_balance: 0,
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
