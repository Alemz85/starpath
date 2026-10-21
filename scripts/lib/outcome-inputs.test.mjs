import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHeaderTsv, loadOutcomeInputs, loadOutcomeSettings } from './outcome-inputs.mjs'
import { analyzeApplicationOutcomes } from './outcome-stats.mjs'

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'outcome-inputs-'))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'user'))
  mkdirSync(join(root, 'reports/tier-2'), { recursive: true })
  mkdirSync(join(root, 'materials'))
  writeFileSync(join(root, 'data/applications.md'), [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
    '| 1 | 2026-09-01 | Nimbus Robotics | Data Analyst | M7.3 E7.4 | Rejected | ✅ | n/d | [1](reports/tier-2/1-nimbus-2026-09-01.md) | via portal |',
    '| 2 | 2026-09-05 | Fabrikam | Strategy Associate | M8.4 E4.1 | Evaluated | ❌ | n/d | [2](reports/tier-2/2-fabrikam-2026-09-05.md) |  |',
  ].join('\n'))
  writeFileSync(join(root, 'data/status-log.tsv'), [
    'num\tdate\tcompany\trole\tfrom\tto\tstage\tsource\tnote\tlogged_at',
    '1\t2026-09-01\tNimbus Robotics\tData Analyst\tEvaluated\tApplied\t\tapp\t\t2026-09-01T10:00:00Z',
    '1\t2026-09-02\tNimbus Robotics\tData Analyst\tApplied\tRejected\t\tapp\t\t2026-09-02T10:00:00Z',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'data/score-history.tsv'), [
    'date\tarchetype\tease\tmatch\tverdict\tcompany\trole\tlocation',
    '2026-08-30\tdata\t7.4\t7.3\tgo\tNimbus Robotics\tData Analyst\tLyon, France',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'reports/tier-2/1-nimbus-2026-09-01.md'), '| Field | Value |\n|---|---|\n| **Team size** | 40 people |\n')
  writeFileSync(join(root, 'materials/index.tsv'), 'folder\tcompany\trole\tapp_num\tsent\tmaterials\tnotes\nx\tNimbus Robotics\tData Analyst\t1\t2026-09-01\tcv\t\n')
  writeFileSync(join(root, 'user/profile.yml'), 'outcomes:\n  materials_index: materials/index.tsv\n  no_response_days: 21\n')
  return root
}

test('parseHeaderTsv keys rows by header', () => {
  assert.deepEqual(parseHeaderTsv('a\tb\n1\t2\n\n3\n'), [{ a: '1', b: '2' }, { a: '3', b: '' }])
  assert.deepEqual(parseHeaderTsv(''), [])
})

test('loadOutcomeInputs reads every store from a data root and the profile settings', () => {
  const root = fixtureRoot()
  try {
    const inputs = loadOutcomeInputs(root, { today: '2026-10-20' })
    assert.equal(inputs.applications.length, 2)
    assert.equal(inputs.ledger.length, 2)
    assert.equal(inputs.scores.length, 1)
    assert.equal(inputs.materials.length, 1)
    assert.equal(inputs.sources.materialsFound, true)
    assert.deepEqual(inputs.rules, { noResponseDays: 21 })
    assert.equal([...inputs.sizes.values()][0], 'startup')
    const r = analyzeApplicationOutcomes(inputs)
    assert.equal(r.records.length, 1)
    assert.equal(r.records[0].companySize, 'startup')
    assert.equal(r.records[0].rejected.timing, 'fast')
    assert.equal(r.rules.noResponseDays, 21)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing files and settings degrade to empty inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'outcome-inputs-empty-'))
  try {
    const inputs = loadOutcomeInputs(root, { today: '2026-10-20' })
    assert.deepEqual([inputs.applications, inputs.ledger, inputs.scores, inputs.materials], [[], [], [], []])
    assert.deepEqual(inputs.rules, {})
    assert.deepEqual(loadOutcomeSettings(join(root, 'nope.yml')), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
