// Tests for cv-summary-core.mjs — the deterministic CV summarizer behind
// the batch/cv-summary.md artifact (token-cost lever 3).
//
// All fixtures are fictional (data-contract hygiene: no real user data in
// system-layer files).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capBulletRun,
  summarizeCv,
  extractProfileFacts,
  renderCvSummary,
  renderProfileStamp,
  extractProfileStamp,
  profileStampMatches,
  GENERATED_HEADER,
} from './cv-summary-core.mjs'

// ─── capBulletRun ────────────────────────────────────────────────────────────

test('capBulletRun keeps everything when under the cap', () => {
  const bullets = ['- a', '- b']
  assert.deepEqual(capBulletRun(bullets, 4), bullets)
})

test('capBulletRun prefers quantified bullets and preserves order', () => {
  const bullets = [
    '- Wrote docs for the team',
    '- Cut costs by 30% across 4 vendors',
    '- Attended meetings',
    '- Shipped 12 dashboards used by 200 analysts',
    '- Helped onboard new hires',
    '- Raised €1.2M in grant funding',
  ]
  const kept = capBulletRun(bullets, 3)
  assert.deepEqual(kept, [
    '- Cut costs by 30% across 4 vendors',
    '- Shipped 12 dashboards used by 200 analysts',
    '- Raised €1.2M in grant funding',
  ])
})

test('capBulletRun backfills with prose bullets when too few are quantified', () => {
  const bullets = ['- alpha', '- beta', '- gamma 5x', '- delta']
  const kept = capBulletRun(bullets, 2)
  // one quantified + earliest prose bullet, original order preserved
  assert.deepEqual(kept, ['- alpha', '- gamma 5x'])
})

// ─── summarizeCv ─────────────────────────────────────────────────────────────

const FIXTURE_CV = `# Jane Doe

**Nationality:** Utopia | **Work Permit:** EU
**Contact:** +11 5550 123456 | jane.doe@example.com

## Experience

### Data Analyst
**Acme Corp** — Springfield | 2023 – 2025

- Built ETL pipeline processing 2M rows/day
- Organized the team offsite
- Presented findings to leadership
- Reduced churn by 8% via cohort analysis
- Wrote weekly status updates
- Automated 15 manual reports

## Technical Skills

- SQL, Python, dbt
- Tableau, Looker
- Git, Docker
- Airflow
- Spark
- Kafka

## Languages

- Utopian (native)
- English (fluent)
`

test('summarizeCv caps bullet runs outside verbatim sections, preferring quantified', () => {
  const out = summarizeCv(FIXTURE_CV, { maxBullets: 3 })
  // 3 quantified bullets survive; the prose-only ones are dropped
  assert.ok(out.includes('2M rows/day'))
  assert.ok(out.includes('Reduced churn by 8%'))
  assert.ok(out.includes('Automated 15 manual reports'))
  assert.ok(!out.includes('team offsite'))
  assert.ok(!out.includes('weekly status updates'))
})

test('summarizeCv keeps skills/languages sections whole', () => {
  const out = summarizeCv(FIXTURE_CV, { maxBullets: 3 })
  for (const item of ['SQL, Python, dbt', 'Kafka', 'Utopian (native)', 'English (fluent)']) {
    assert.ok(out.includes(item), `verbatim section keeps "${item}"`)
  }
})

test('summarizeCv strips contact PII from the preamble but keeps other facts', () => {
  const out = summarizeCv(FIXTURE_CV)
  assert.ok(!out.includes('jane.doe@example.com'), 'email dropped')
  assert.ok(!out.includes('5550 123456'), 'phone dropped')
  assert.ok(out.includes('# Jane Doe'), 'name heading kept')
  assert.ok(out.includes('**Nationality:** Utopia'), 'work-rights fact kept')
})

test('summarizeCv preserves all headings and employer/date lines', () => {
  const out = summarizeCv(FIXTURE_CV, { maxBullets: 2 })
  for (const h of ['## Experience', '### Data Analyst', '**Acme Corp** — Springfield | 2023 – 2025', '## Technical Skills', '## Languages']) {
    assert.ok(out.includes(h), `keeps "${h}"`)
  }
})

test('summarizeCv is deterministic and ends with exactly one trailing newline', () => {
  const a = summarizeCv(FIXTURE_CV)
  const b = summarizeCv(FIXTURE_CV)
  assert.equal(a, b)
  assert.match(a, /[^\n]\n$/)
})

test('kept bullets are verbatim CV lines (citation contract)', () => {
  const out = summarizeCv(FIXTURE_CV, { maxBullets: 3 })
  const keptBullets = out.split('\n').filter(l => l.startsWith('- '))
  const sourceLines = new Set(FIXTURE_CV.split('\n'))
  for (const b of keptBullets) {
    assert.ok(sourceLines.has(b), `"${b}" exists verbatim in the source CV`)
  }
})

// ─── extractProfileFacts ─────────────────────────────────────────────────────

const FIXTURE_PROFILE = `candidate:
  full_name: "Jane Doe"
  email: "jane.doe@example.com"
  nationality: "Utopia"
  work_permit: "EU"
  languages: "Utopian (native), English (fluent)"

compensation:
  target_range: "€30K-50K"   # gross, annual

location:
  visa_status: "EU citizen — no sponsorship needed"
  visa_status: "duplicate should be ignored"
`

test('extractProfileFacts pulls only the whitelisted scalars, first occurrence, quotes stripped', () => {
  const facts = extractProfileFacts(FIXTURE_PROFILE)
  assert.deepEqual(facts, [
    { key: 'nationality', value: 'Utopia' },
    { key: 'work_permit', value: 'EU' },
    { key: 'visa_status', value: 'EU citizen — no sponsorship needed' },
    { key: 'languages', value: 'Utopian (native), English (fluent)' },
    { key: 'target_range', value: '€30K-50K' },
  ])
})

test('extractProfileFacts never leaks name/email/phone and handles empty input', () => {
  const facts = extractProfileFacts(FIXTURE_PROFILE)
  const joined = JSON.stringify(facts)
  assert.ok(!joined.includes('Jane Doe'))
  assert.ok(!joined.includes('example.com'))
  assert.deepEqual(extractProfileFacts(''), [])
  assert.deepEqual(extractProfileFacts(undefined), [])
})

// ─── renderCvSummary ─────────────────────────────────────────────────────────

test('renderCvSummary composes header + facts + summarized CV', () => {
  const out = renderCvSummary({ cvText: FIXTURE_CV, profileText: FIXTURE_PROFILE })
  assert.ok(out.startsWith(GENERATED_HEADER))
  assert.ok(out.includes('## Candidate facts (from user/profile.yml)'))
  assert.ok(out.includes('- **visa_status:** EU citizen — no sponsorship needed'))
  assert.ok(out.includes('## Technical Skills'))
})

test('renderCvSummary omits the facts section when the profile is absent', () => {
  const out = renderCvSummary({ cvText: FIXTURE_CV })
  assert.ok(!out.includes('Candidate facts'))
  assert.ok(out.includes('# Jane Doe'))
})

// ─── Profile stamp (multi-profile staleness) ─────────────────────────────────

test('renderCvSummary stamps the active slug when given one, omits it otherwise', () => {
  const stamped = renderCvSummary({ cvText: FIXTURE_CV, profileSlug: 'career' })
  assert.ok(stamped.includes(renderProfileStamp('career')))
  assert.equal(extractProfileStamp(stamped), 'career')

  const unstamped = renderCvSummary({ cvText: FIXTURE_CV })
  assert.equal(extractProfileStamp(unstamped), null)
})

test('extractProfileStamp reads the stamp anywhere in the text, null when absent', () => {
  assert.equal(extractProfileStamp('x\n<!-- profile: cph-student -->\ny'), 'cph-student')
  assert.equal(extractProfileStamp('<!--profile: a1-->'), 'a1')
  assert.equal(extractProfileStamp('no stamp here'), null)
  assert.equal(extractProfileStamp(''), null)
  assert.equal(extractProfileStamp(null), null)
})

test('profileStampMatches: mismatched slug forces regeneration', () => {
  const summary = renderCvSummary({ cvText: FIXTURE_CV, profileSlug: 'career' })
  assert.equal(profileStampMatches(summary, 'career'), true)
  assert.equal(profileStampMatches(summary, 'cph-student'), false)
})

test('profileStampMatches: pre-migration compat — no profiles/ or no stamp passes', () => {
  const stamped = renderCvSummary({ cvText: FIXTURE_CV, profileSlug: 'career' })
  const unstamped = renderCvSummary({ cvText: FIXTURE_CV })
  // No multi-profile layout (activeSlug null) → always matches, even stamped.
  assert.equal(profileStampMatches(stamped, null), true)
  assert.equal(profileStampMatches(unstamped, null), true)
  // Migrated layout but pre-stamp artifact → matches (mtime gate still applies).
  assert.equal(profileStampMatches(unstamped, 'career'), true)
  assert.equal(profileStampMatches('', 'career'), true)
})
