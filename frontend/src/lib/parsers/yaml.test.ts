import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProfileYaml } from '@/lib/parsers/yaml'

test('parseProfileYaml extracts the candidate block', () => {
  const yaml = [
    'candidate:',
    '  full_name: "Jane Doe"',
    '  email: jane@example.com',
    '  location: Berlin, Germany',
    'compensation:',
    '  target_range: "60-80k"',
  ].join('\n')
  const cfg = parseProfileYaml(yaml)
  assert.equal(cfg.candidate?.full_name, 'Jane Doe')   // quotes stripped
  assert.equal(cfg.candidate?.email, 'jane@example.com')
  assert.equal(cfg.candidate?.location, 'Berlin, Germany')
})

test('parseProfileYaml returns no candidate when the block is absent', () => {
  const cfg = parseProfileYaml('compensation:\n  target_range: 60k\n')
  assert.equal(cfg.candidate, undefined)
})

test('parseProfileYaml is total — never throws on junk input', () => {
  assert.doesNotThrow(() => parseProfileYaml(''))
  assert.doesNotThrow(() => parseProfileYaml(':::not yaml:::'))
})
