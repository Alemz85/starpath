import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slug, canonicalRoleSlug, parseCities, entityId, formatLocation } from '@/lib/entityId'

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

test('parseCities: multi-city takes the first listed place as primary', () => {
  assert.deepEqual(parseCities('Berlin / Paris'), { cities: ['Berlin', 'Paris'], isMulti: true, primary: 'Berlin' })
  assert.deepEqual(parseCities('Hong Kong / EU'), { cities: ['Hong Kong', 'EU'], isMulti: true, primary: 'Hong Kong' })
  // The eval writes the scored city first; an unknown first city still wins.
  assert.equal(parseCities('Lyon, France; Vienna, Austria; Prague, Czechia').primary, 'Lyon')
  assert.equal(formatLocation('Lyon, France; Vienna, Austria; Prague, Czechia'), 'Lyon +2')
})

test('parseCities: every separator a multi-city posting uses splits into cities', () => {
  const three = ['Leeds', 'York', 'Bath']
  for (const raw of [
    'Leeds, York, Bath, United Kingdom',
    'Leeds; York; Bath',
    'Leeds | York | Bath',
    'Leeds · York · Bath',
    'Leeds • York • Bath',
    'Leeds, York and Bath',
    'Leeds, York or Bath',
    'Leeds, UK; York, UK; Bath, UK',
    'Leeds, York, Bath - United Kingdom',
    'Multiple locations: Leeds, York, Bath',
    'United Kingdom (Leeds, York, Bath)',
  ]) {
    const parsed = parseCities(raw)
    assert.deepEqual(parsed.cities, three, raw)
    assert.equal(parsed.isMulti, true, raw)
    assert.equal(formatLocation(raw), 'Leeds +2', raw)
  }
})

test('parseCities: work-mode words are not cities', () => {
  assert.deepEqual(parseCities('Lyon, France, hybrid, 3 office days').cities, ['Lyon'])
  assert.deepEqual(parseCities('Lyon, France hybrid').cities, ['Lyon'])
  assert.deepEqual(parseCities('Lyon, on-site').cities, ['Lyon'])
  // An unspaced dash belongs to the name; a spaced one without a country too.
  assert.deepEqual(parseCities('Saint-Étienne').cities, ['Saint-Étienne'])
  assert.deepEqual(parseCities('Paris - La Défense').cities, ['Paris - La Défense'])
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

test('parseCities: "City, Country" is one city with its country attached', () => {
  assert.deepEqual(parseCities('Milan, Italy'), { cities: ['Milan'], isMulti: false, primary: 'Milan', country: 'Italy' })
  assert.deepEqual(parseCities('Lyon, France (also Paris/Nice)'), { cities: ['Lyon'], isMulti: false, primary: 'Lyon', country: 'France' })
  // Country alone still names a place.
  assert.deepEqual(parseCities('Italy'), { cities: ['Italy'], isMulti: false, primary: 'Italy' })
  // Two cities + a country stays multi-city.
  assert.deepEqual(parseCities('Rome / Milan, Italy'), { cities: ['Rome', 'Milan'], isMulti: true, primary: 'Rome', country: 'Italy' })
})

test('entityId: "City, Country" embeds the city slug, not "multi"', () => {
  assert.equal(entityId('Acme', 'Intern (Italy)', parseCities('Milan, Italy')), 'acme::intern-italy::milan')
})
