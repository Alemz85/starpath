import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slug, canonicalRoleSlug, parseCities, entityId } from '@/lib/entityId'

test('slug lowercases, strips diacritics, and collapses punctuation', () => {
  assert.equal(slug('Société Générale'), 'societe-generale')
  assert.equal(slug('  Hello,  World!  '), 'hello-world')
  assert.equal(slug('München'), 'munchen')
})

test('canonicalRoleSlug strips requisition / year / gender noise', () => {
  assert.equal(canonicalRoleSlug('Data Analyst Intern (m/f/d) Summer 2026'), 'data-analyst-intern')
  assert.equal(canonicalRoleSlug('Consultant (req 7645479)'), 'consultant')
  assert.equal(canonicalRoleSlug('Analyst (all genders) 2025-2026'), 'analyst')
})

test('canonicalRoleSlug strips the row city (and its aliases) anywhere in the title', () => {
  // "Roma" is an alias of "Rome" — both must drop so the Rome/Milan sibling
  // pair canonicalizes to the same role slug.
  assert.equal(canonicalRoleSlug('Junior Consultant - Roma - INTERNSHIP', 'Rome'), 'junior-consultant-internship')
  assert.equal(canonicalRoleSlug('Data Analyst Berlin', 'Berlin'), 'data-analyst')
})

test('parseCities: single city', () => {
  assert.deepEqual(parseCities('Barcelona'), { cities: ['Barcelona'], isMulti: false, primary: 'Barcelona' })
})

test('parseCities: strips parentheticals and bare Remote', () => {
  assert.deepEqual(parseCities('Madrid (hybrid)'), { cities: ['Madrid'], isMulti: false, primary: 'Madrid' })
  assert.deepEqual(parseCities('Remote'), { cities: [], isMulti: false, primary: null })
  assert.deepEqual(parseCities('n/d'), { cities: [], isMulti: false, primary: null })
  assert.deepEqual(parseCities(undefined), { cities: [], isMulti: false, primary: null })
})

test('parseCities: multi-city picks the first RECOGNIZED city as primary', () => {
  assert.deepEqual(parseCities('Berlin / Paris'), { cities: ['Berlin', 'Paris'], isMulti: true, primary: 'Berlin' })
  // Neither recognized → falls back to the first token, still deterministic.
  assert.deepEqual(parseCities('Hong Kong / EU'), { cities: ['Hong Kong', 'EU'], isMulti: true, primary: 'Hong Kong' })
})

test('entityId: single-city embeds the city slug and scrubs it from the role', () => {
  assert.equal(entityId('Acme', 'Data Analyst Berlin', parseCities('Berlin')), 'acme::data-analyst::berlin')
})

test('entityId: multi-city uses the literal "multi" city key', () => {
  assert.equal(
    entityId('Trade Republic', 'Werkstudent', parseCities('Berlin / Paris')),
    'trade-republic::werkstudent::multi',
  )
})

test('entityId: unusable location key is "unknown"', () => {
  assert.equal(entityId('Acme', 'PM', parseCities('Remote')), 'acme::pm::unknown')
})
