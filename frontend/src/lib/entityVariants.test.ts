import { test } from 'node:test'
import assert from 'node:assert/strict'
import { variantGroupKey, variantLabel, splitVariantQualifiers, entityId, parseCities, formatLocation } from '@/lib/entityId'

test('location variants of one role share a group key; the country no longer splits them', () => {
  const lyon = variantGroupKey('Nimbus Robotics', 'Product Specialist, Launch Graduate Program 2027 – Lyon, France', 'Lyon, France')
  const rome = variantGroupKey('Nimbus Robotics', 'Product Specialist, Launch Graduate Program 2027 – Rome, Italy', 'Rome, Italy')
  const multi = variantGroupKey('Nimbus Robotics', 'Product Specialist, Launch Graduate Program 2027 – Milan/Rome, Italy', 'Milan, Italy; Rome, Italy')
  assert.equal(lyon, rome)
  assert.equal(lyon, multi)
  // …but each keeps its own entity
  assert.notEqual(entityId('Nimbus Robotics', 'Product Specialist, Launch Graduate Program 2027 – Lyon, France', parseCities('Lyon, France')),
    entityId('Nimbus Robotics', 'Product Specialist, Launch Graduate Program 2027 – Rome, Italy', parseCities('Rome, Italy')))
})

test('language / market variants share a group key and are labelled by their market', () => {
  const fr = 'Commercial Graduate Path  - French Market'
  const pl = 'Commercial Graduate Path  - Eastern Europe - Polish or Croatian or Czech Market'
  assert.equal(variantGroupKey('Contoso Labs', fr, 'Dublin, Ireland'), variantGroupKey('Contoso Labs', pl, 'Dublin, Ireland'))
  assert.equal(variantLabel(fr, 'Dublin, Ireland'), 'French Market')
  assert.equal(variantLabel(pl, 'Dublin, Ireland'), 'Eastern Europe · Polish or Croatian or Czech Market')
  assert.equal(variantGroupKey('Contoso Labs', 'Sales Associate (French speaking)', 'Lyon'), variantGroupKey('Contoso Labs', 'Sales Associate (German speaking)', 'Munich'))
})

test('different roles, tracks and levels stay apart', () => {
  const k = (role: string, loc = 'Lyon, France') => variantGroupKey('Nimbus Robotics', role, loc)
  assert.notEqual(k('Global Markets Intern, Summer 2027 - Lyon, France'), k('Product Management Intern, Summer 2027 - Lyon, France'))
  assert.notEqual(k('Associate Consultant Intern - Lyon'), k('Associate Consultant, Launch Program - Lyon'))
  assert.notEqual(k('Graduate Launch Program 2027 - Lyon, France'), k('Rotational Graduate Launch Program 2027 - (Sales & Product) - Cairo, Egypt', 'Cairo, Egypt'))
  assert.notEqual(variantGroupKey('Nimbus Robotics', 'Analyst - Lyon', 'Lyon'), variantGroupKey('Fabrikam Energy', 'Analyst - Lyon', 'Lyon'))
})

test('location labels and qualifier split', () => {
  assert.equal(variantLabel('Analyst – Lyon, France', 'Lyon, France'), 'Lyon')
  assert.equal(variantLabel('Analyst', ''), 'Analyst')
  const s = splitVariantQualifiers('Process Specialist Intern 2027 (Madrid)', 'Madrid, Spain')
  assert.equal(s.base.trim(), 'Process Specialist Intern 2027')
  assert.deepEqual(s.places, ['Madrid'])
  // a market word alone in the first segment never empties the role
  assert.equal(splitVariantQualifiers('Market Analyst', 'Lyon').base, 'Market Analyst')
})

test('a city followed by its country is one place, outside Europe too', () => {
  assert.equal(formatLocation('Cairo, Egypt'), 'Cairo')
  assert.equal(formatLocation('Bogota, Colombia'), 'Bogota')
})
