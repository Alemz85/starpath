import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScoreHistory } from '@/lib/parsers/tsv'

// The v2 header, verbatim from docs/scoring-v2.md §8.1 (29 columns).
const HEADER = [
  'date', 'archetype', 'skills_match', 'experience_bar', 'competition', 'ease',
  'growth_mobility', 'optionality_exit', 'brand_value', 'role_content',
  'best_cities', 'salary_adj_city', 'work_life_balance', 'match', 'priority',
  'eligibility', 'eligibility_flags', 'verdict', 'best_fit_roles', 'mode',
  'company', 'role', 'tier', 'source', 'location', 'employment_type',
  'duration', 'salary_raw', 'url',
]

function row(over: Record<string, string>): string {
  return HEADER.map(h => over[h] ?? '').join('\t')
}

test('the v2 header has the 29 spec columns', () => {
  assert.equal(HEADER.length, 29)
})

test('parseScoreHistory reads a scored v2 row by header name', () => {
  const tsv = [HEADER.join('\t'), row({
    date: '2026-10-01', archetype: 'Strategy', skills_match: '8', experience_bar: '6',
    competition: '5', ease: '5.6', growth_mobility: '8', optionality_exit: '8',
    brand_value: '9', role_content: '7', best_cities: '8', salary_adj_city: '6',
    work_life_balance: '6', match: '8.25', priority: '6.8', eligibility: 'amber',
    eligibility_flags: 'start_date:amber:start date not stated', verdict: 'stretch',
    mode: 'scouting', company: 'Acme', role: 'Analyst', tier: 'T2',
    location: 'City, Country', url: 'https://jobs.example.com/1',
  })].join('\n')
  const [r] = parseScoreHistory(tsv)
  assert.equal(r.match, 8.25)
  assert.equal(r.ease, 5.6)
  assert.equal(r.priority, 6.8)
  assert.equal(r.experience_bar, 6)
  assert.equal(r.role_content, 7)
  assert.equal(r.eligibility, 'amber')
  assert.equal(r.eligibility_flags, 'start_date:amber:start date not stated')
  assert.equal(r.verdict, 'stretch')
  assert.equal(r.tier, 'T2')
  assert.equal(r.url, 'https://jobs.example.com/1')
})

test('column order is not load-bearing — a shuffled header parses the same', () => {
  const shuffled = [...HEADER].reverse()
  const values: Record<string, string> = { company: 'Acme', role: 'Analyst', match: '7.1', ease: '7.4', eligibility: 'green' }
  const tsv = [shuffled.join('\t'), shuffled.map(h => values[h] ?? '').join('\t')].join('\n')
  const [r] = parseScoreHistory(tsv)
  assert.equal(r.match, 7.1)
  assert.equal(r.ease, 7.4)
  assert.equal(r.verdict, 'solid')   // empty cell → replayed from the grid
  assert.equal(r.tier, 'T2')         // empty cell → verdict tier
})

test('blocked rows: empty numeric cells parse as null, never 0', () => {
  const tsv = [HEADER.join('\t'), row({
    company: 'Globex', role: 'Intern', eligibility: 'red',
    eligibility_flags: 'language:red:German C1 required', verdict: 'blocked', tier: 'T4',
  })].join('\n')
  const [r] = parseScoreHistory(tsv)
  assert.equal(r.match, null)
  assert.equal(r.ease, null)
  assert.equal(r.priority, null)
  assert.equal(r.skills_match, null)
  assert.equal(r.brand_value, null)
  assert.equal(r.verdict, 'blocked')
  assert.equal(r.tier, 'T4')
})

test('a red row is blocked even when the verdict cell is empty', () => {
  const tsv = [HEADER.join('\t'), row({ company: 'Globex', role: 'Intern', eligibility: 'red' })].join('\n')
  const [r] = parseScoreHistory(tsv)
  assert.equal(r.verdict, 'blocked')
  assert.equal(r.tier, 'T4')
  assert.equal(r.priority, null)
})

test('priority is recomputed when the cell is empty on a scored row', () => {
  const tsv = [HEADER.join('\t'), row({ company: 'A', role: 'B', match: '8', ease: '8', eligibility: 'green' })].join('\n')
  assert.equal(parseScoreHistory(tsv)[0].priority, 8)
})

test('tier normalisation: T1–T4 (any case, tier-N) kept; verdict wins for an empty cell', () => {
  const tsv = [HEADER.join('\t'),
    row({ company: 'A', role: 'x', tier: 't1', verdict: 'go' }),
    row({ company: 'B', role: 'x', tier: 'tier-3', verdict: 'growth' }),
    row({ company: 'C', role: 'x', tier: '', verdict: 'thin' }),
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.deepEqual(rows.map(r => r.tier), ['T1', 'T3', 'T2'])
})

test('mode defaults to scouting; oferta is kept', () => {
  const tsv = [HEADER.join('\t'),
    row({ company: 'A', role: 'x', mode: 'oferta' }),
    row({ company: 'B', role: 'x', mode: '' }),
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.equal(rows[0].mode, 'oferta')
  assert.equal(rows[1].mode, 'scouting')
})

test('parseScoreHistory skips rows missing company or role', () => {
  const tsv = [
    'date\tcompany\trole\tmatch',
    '2026-04-27\t\tAnalyst\t8.4',   // no company
    '2026-04-27\tAcme\t\t8.4',       // no role
    '2026-04-27\tAcme\tAnalyst\t8.4',
  ].join('\n')
  assert.equal(parseScoreHistory(tsv).length, 1)
})

test('parseScoreHistory pads short rows instead of dropping them', () => {
  const tsv = [
    'date\tcompany\trole\tmatch\turl',
    '2026-04-27\tAcme\tAnalyst',
  ].join('\n')
  const rows = parseScoreHistory(tsv)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].match, null)   // empty → null (v1 coerced to 0)
  assert.equal(rows[0].url, '')
})

test('parseScoreHistory returns [] for an empty/headerless input', () => {
  assert.deepEqual(parseScoreHistory(''), [])
  assert.deepEqual(parseScoreHistory('date\tcompany\trole'), [])  // header only
})

test('a score-history written before the rename (a `want` column) reads as match', () => {
  const old = HEADER.map(h => (h === 'match' ? 'want' : h))
  const cells = old.map(h => (h === 'want' ? '8.5' : h === 'ease' ? '7' : h === 'company' ? 'Nimbus Robotics' : h === 'role' ? 'Analyst' : h === 'eligibility' ? 'green' : ''))
  const [entry] = parseScoreHistory(`${old.join('\t')}\n${cells.join('\t')}\n`)
  assert.equal(entry.match, 8.5)
  assert.equal(entry.ease, 7)
})
