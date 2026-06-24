import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeArchetype } from '@/lib/archetype'

test('canonicalizeArchetype maps verbose strings to stable buckets', () => {
  assert.equal(canonicalizeArchetype('Strategy & Operations Analyst — Technology Sector'), 'Strategy & Ops')
  assert.equal(canonicalizeArchetype('M&A Associate'), 'M&A')
  assert.equal(canonicalizeArchetype('Software Engineer, Backend'), 'Software Engineer')
  assert.equal(canonicalizeArchetype('Data Scientist, NLP'), 'Data Scientist')
  assert.equal(canonicalizeArchetype('Investment Banking Analyst'), 'Investment Banking')
})

test('canonicalizeArchetype returns empty for empty/nullish input', () => {
  assert.equal(canonicalizeArchetype(''), '')
  assert.equal(canonicalizeArchetype(null), '')
  assert.equal(canonicalizeArchetype(undefined), '')
})

test('canonicalizeArchetype falls back to the first short segment', () => {
  assert.equal(canonicalizeArchetype('Underwater Basket Weaver'), 'Underwater Basket Weaver')
  // First segment before a comma/paren/dash is taken.
  assert.equal(canonicalizeArchetype('Quant Researcher, Systematic'), 'Quant Researcher')
})

test('canonicalizeArchetype caps an unmapped long label at 28 chars with an ellipsis', () => {
  const out = canonicalizeArchetype('Chief Happiness Officer of Galaxy Division Worldwide')
  assert.equal(out.length, 28)
  assert.ok(out.endsWith('…'))
})
