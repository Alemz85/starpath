// Salary text helpers in score-listing.mjs: the plain one-line summary the
// report's Salary cell shows, and the markdown-safe math chain for the footer.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { salarySummary, scoreListing } from './score-listing.mjs'

test('salarySummary: positive savings, rounded to €10, with the city', () => {
  assert.equal(
    salarySummary({ savings: 213.4, city: 'Lyon' }),
    'About €210 a month left after living costs in Lyon.',
  )
})

test('salarySummary: negative savings read as a shortfall', () => {
  assert.equal(
    salarySummary({ savings: -148, city: 'Dublin' }),
    'About €150 a month short of living costs in Dublin.',
  )
})

test('salarySummary: notes estimated pay and the intern housing assumption', () => {
  assert.equal(
    salarySummary({ savings: 1234, city: 'Berlin', estimated: true, isIntern: true }),
    'About €1,230 a month left after living costs in Berlin (estimated pay, shared housing assumed).',
  )
})

test('salarySummary: near zero reads as break-even', () => {
  assert.equal(salarySummary({ savings: 3, city: '' }), 'Roughly breaks even after living costs.')
})

test('scoreListing: salary block carries summary + markdown-safe math', async () => {
  const out = await scoreListing({
    company: 'Lumen Freight', role_archetype: 'Business Analyst', city: 'Lyon', country: 'FR',
    comp: { base: 30000 },
    comp_source: 'estimate',
    tax_override: { rate: 0.25, source: 'test' },
    col_override: { baseline_eur: 1950, source: 'test' },
    is_intern: false,
    eligibility_facts: { employment: 'permanent', country: 'FR' },
    eligibility_profile: {},
    scoring_weights: {},
    judgment_scores: {
      growth_mobility: 7, optionality_exit: 7, brand_value: 6, role_content: 7,
      best_cities: 7, work_life_balance: 7,
      skills_match: 7, experience_bar: 7, competition: 6,
    },
  })
  const s = out.salary_adj_for_city
  assert.match(s.summary, /^About €\d[\d,]* a month (left after|short of) living costs in Lyon \(estimated pay\)\.$/)
  assert.ok(!s.math.includes('**'), 'no bold markers in the math chain')
  assert.ok(!/\[[^\]]*\]/.test(s.math), 'no bracket tokens in the math chain')
  assert.match(s.math, /\(estimated\)/)
})

test('scoreListing: comp_source "none" is the default-5 path (no comp, no tax or city lookups)', async () => {
  const base = {
    company: 'Lumen Freight', role_archetype: 'Business Analyst', city: 'Aldervale', country: 'XY',
    is_intern: true,
    eligibility_facts: { employment: 'internship', country: 'XY' },
    eligibility_profile: {}, scoring_weights: {},
    judgment_scores: {
      growth_mobility: 7, optionality_exit: 7, brand_value: 6, role_content: 7,
      best_cities: 7, work_life_balance: 7, skills_match: 7, experience_bar: 7, competition: 6,
    },
  }
  const out = await scoreListing({ ...base, comp_source: 'none' })
  const s = out.salary_adj_for_city
  assert.equal(out.error, undefined)
  assert.equal(s.base_score, 5)
  assert.equal(s.score, 5)
  assert.equal(out.dims.salary_adj_city, 5)
  assert.match(s.summary, /undisclosed/)
  assert.equal(s.computed, null)
  assert.ok(!s.math.includes('**') && !/\[[^\]]*\]/.test(s.math))

  const modified = await scoreListing({ ...base, comp_source: 'none', soft_benefits_modifier: 0.5 })
  assert.equal(modified.salary_adj_for_city.score, 5.5)

  const missing = await scoreListing(base)
  assert.equal(missing.error, 'comp_missing')
  assert.match(missing.message, /comp_source.*none/, 'the error names the way out')
})

// ─── --input (background workers write the JSON with the Write tool) ─────────

test('--input reads the JSON from a file inside the checkout, and refuses one outside', async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { fileURLToPath } = await import('node:url')
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const script = join(root, 'scripts/score-listing.mjs')
  const inside = mkdtempSync(join(root, 'batch', '.score-input-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'score-input-'))
  try {
    const facts = JSON.stringify({ eligibility_facts: { employment: 'internship', other: [{ status: 'amber', reason: 'enrolment', question: 'Can a graduate apply?', text: "Bachelor's or Master's student" }] } })
    writeFileSync(join(inside, 'in.json'), facts)
    const ok = spawnSync(process.execPath, [script, '--input', join(inside, 'in.json'), '--eligibility-only'], { encoding: 'utf8', cwd: root })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(ok.stdout).eligibility.status, 'amber')
    writeFileSync(join(outside, 'in.json'), facts)
    const refused = spawnSync(process.execPath, [script, '--input', join(outside, 'in.json'), '--eligibility-only'], { encoding: 'utf8', cwd: root })
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /inside the checkout/)
  } finally {
    rmSync(inside, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('scoreListing: a red listing the profile scores through keeps verdict blocked but gets Want / Ease', async () => {
  const base = {
    company: 'Lumen Freight', role_archetype: 'Business Analyst', city: 'Lyon', country: 'FR',
    comp: { base: 30000 }, comp_source: 'estimate',
    tax_override: { rate: 0.25, source: 'test' }, col_override: { baseline_eur: 1950, source: 'test' },
    is_intern: false, scoring_weights: {},
    eligibility_facts: { employment: 'permanent', country: 'FR', languages: [{ language: 'Spanish', level: 'C1', required: true }] },
    judgment_scores: {
      growth_mobility: 7, optionality_exit: 7, brand_value: 6, role_content: 7,
      best_cities: 7, work_life_balance: 7, skills_match: 7, experience_bar: 7, competition: 6,
    },
  }
  const profile = { languages: [{ language: 'Spanish', level: 'B2' }], work_authorisation: ['EU'] }
  const blocked = await scoreListing({ ...base, eligibility_profile: profile })
  assert.equal(blocked.verdict, 'blocked')
  assert.equal(blocked.want, null)

  const scored = await scoreListing({ ...base, eligibility_profile: { ...profile, score_through_red: { languages: ['Spanish'] } } })
  assert.equal(scored.verdict, 'blocked')
  assert.equal(scored.tier, 'T4')
  assert.equal(scored.priority, null)
  assert.ok(Number.isFinite(scored.want.score) && Number.isFinite(scored.ease.score))
})

// ─── duration ranges per role type ──────────────────────────────────────────

test('scoreListing: a graduate programme inside its own duration range carries no amber Ease penalty', async () => {
  const run = (duration_months) => scoreListing({
    company: 'Nimbus Robotics', role_archetype: 'Strategy Analyst', city: 'Lyon', country: 'FR',
    comp: { base: 38000 },
    tax_override: { rate: 0.25, source: 'test' },
    col_override: { baseline_eur: 1500, source: 'test' },
    eligibility_facts: { employment: 'graduate_programme', duration_months: 18, country: 'FR' },
    eligibility_profile: { duration_months },
    scoring_weights: {},
    prior: false,
    judgment_scores: {
      growth_mobility: 7, optionality_exit: 7, brand_value: 7, role_content: 7,
      best_cities: 7, work_life_balance: 7,
      skills_match: 7, experience_bar: 7, competition: 6,
    },
  })
  const single = await run({ min: 3, max: 12 })
  const perType = await run({ min: 3, max: 12, graduate_programme: { min: 12, max: 24 } })
  assert.equal(single.eligibility.status, 'amber')
  assert.equal(single.ease.amber_penalty, 0.5)
  assert.equal(perType.eligibility.status, 'green')
  assert.equal(perType.ease.amber_penalty, 0)
  assert.equal(perType.ease.score, Math.round((single.ease.score + 0.5) * 100) / 100)
})
