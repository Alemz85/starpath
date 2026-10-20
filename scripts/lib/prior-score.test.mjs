// Re-score anchoring: find the listing's previous evaluation and list the
// judged dimensions that moved by 1 or more.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findPrior, compareToPrior, PRIOR_DIMS } from './prior-score.mjs'
import { parseScoreHistory } from './targeting-core.mjs'
import { scoreListing } from '../score-listing.mjs'

const HEADER = 'date\tarchetype\tskills_match\texperience_bar\tcompetition\tease\tgrowth_mobility\toptionality_exit\tbrand_value\trole_content\tbest_cities\tsalary_adj_city\twork_life_balance\twant\tpriority\teligibility\teligibility_flags\tverdict\tbest_fit_roles\tmode\tcompany\trole\ttier\tsource\tlocation\temployment_type\tduration\tsalary_raw\turl'
const row = (date, dims, extra = {}) => {
  const r = {
    date, archetype: 'Strategy', skills_match: 7, experience_bar: 9, competition: 6, ease: 7.3,
    growth_mobility: 8, optionality_exit: 8, brand_value: 8.6, role_content: 7, best_cities: 8,
    salary_adj_city: 7, work_life_balance: 6, want: 8.15, priority: 7.7, eligibility: 'green',
    eligibility_flags: '', verdict: 'go', best_fit_roles: '—', mode: 'scouting',
    company: 'Lumen Freight', role: 'Supply Chain Analyst (Lyon, March 2028 start)', tier: 'T1',
    source: 'batch', location: 'Lyon, France', employment_type: 'Full-time', duration: '',
    salary_raw: 'n/d', url: 'https://example.com/jobs/42/', ...dims, ...extra,
  }
  return HEADER.split('\t').map((k) => r[k] ?? '').join('\t')
}

const HISTORY = [
  HEADER,
  row('2026-10-01', { growth_mobility: 7 }),
  row('2026-10-15', {}),
  row('2026-10-10', {}, { company: 'Othercorp', url: 'https://other.example/1' }),
].join('\n')

test('findPrior: latest row for the listing, matched by URL or company + role', () => {
  const rows = parseScoreHistory(HISTORY)
  const byUrl = findPrior(rows, { url: 'https://example.com/jobs/42?ref=feed' })
  assert.equal(byUrl.date, '2026-10-15')
  assert.equal(byUrl.dims.growth_mobility, 8)
  assert.equal(byUrl.verdict, 'go')
  const byRole = findPrior(rows, { company: 'LUMEN FREIGHT', role: 'Supply Chain Analyst (Lyon, March 2028 start)' })
  assert.equal(byRole.date, '2026-10-15')
  assert.equal(findPrior(rows, { company: 'Nobody', role: 'Analyst' }), null)
})

test('findPrior: a blocked prior has no dimension scores', () => {
  const rows = parseScoreHistory([HEADER, row('2026-10-01', Object.fromEntries(PRIOR_DIMS.map((d) => [d, ''])), { want: '', ease: '', priority: '', eligibility: 'red', verdict: 'blocked' })].join('\n'))
  const p = findPrior(rows, { url: 'https://example.com/jobs/42/' })
  assert.equal(p.blocked, true)
  assert.equal(p.dims.skills_match, null)
  assert.deepEqual(compareToPrior(p, { skills_match: 9 }), [])
})

test('compareToPrior: only judged dimensions that moved by 1 or more', () => {
  const prior = findPrior(parseScoreHistory(HISTORY), { url: 'https://example.com/jobs/42/' })
  const now = { ...prior.dims, growth_mobility: 9, work_life_balance: 7, brand_value: 8.6, competition: 6.5 }
  const changes = compareToPrior(prior, now)
  assert.deepEqual(changes.map((c) => [c.dimension, c.from, c.to, c.delta]), [
    ['growth_mobility', 8, 9, 1],
    ['work_life_balance', 6, 7, 1],
  ])
  assert.ok(changes.every((c) => typeof c.label === 'string' && c.label.length > 0))
})

test('scoreListing --prior-only path and prior.changes in a full run', async () => {
  const prior = findPrior(parseScoreHistory(HISTORY), { url: 'https://example.com/jobs/42/' })
  const only = await scoreListing({ prior }, { priorOnly: true })
  assert.equal(only.prior.date, '2026-10-15')

  const out = await scoreListing({
    company: 'Lumen Freight', role: 'Supply Chain Analyst (Lyon, March 2028 start)', url: 'https://example.com/jobs/42/',
    role_archetype: 'Strategy', city: 'Lyon', country: 'FR',
    comp: { base: 40000 }, tax_override: { rate: 0.25, source: 'test' }, col_override: { baseline_eur: 1950, source: 'test' },
    eligibility_facts: { employment: 'permanent', country: 'FR' }, eligibility_profile: {}, scoring_weights: {},
    prior,
    judgment_scores: { ...prior.dims, brand_value: 8, growth_mobility: 9 },
  })
  assert.deepEqual(out.prior.changes.map((c) => c.dimension), ['growth_mobility'])
})

test('scoreListing: prior false skips the lookup', async () => {
  const out = await scoreListing({ prior: false }, { priorOnly: true })
  assert.equal(out.prior, null)
})
