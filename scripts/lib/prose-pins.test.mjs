// The extractors behind scripts/prose-pins.test.mjs, fed text that is wrong on
// purpose: a pin that cannot fail pins nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerLabels, isSubsequence, labelsOf, scriptPaths, sharedHeaderLabels, statusWrites } from './prose-pins.mjs'

test('statusWrites finds the three ways a prompt hands over a status', () => {
  const text = [
    'Move it to status `Evaluated`.',
    'Set the Status cell `Aplicado` for it.',
    'Keep it in `Applied` status for now.',
    'Run `node scripts/set-status.mjs 12 Interview` after the call.',
    'Run `node scripts/set-status.mjs <num> <status>` to change one.',
  ].join('\n')
  assert.deepEqual(statusWrites(text).map((w) => w.value), ['Evaluated', 'Aplicado', 'Applied', 'Interview'])
  assert.equal(statusWrites(text)[1].line, 2)
})

test('statusWrites ignores the other status vocabularies', () => {
  const text = 'Mark `status: red` when the JD says so; scan rows end `status skipped_dup`; the JSON has `"status": "failed"`.'
  assert.deepEqual(statusWrites(text), [])
})

test('scriptPaths reports the line and skips globs, placeholders and foreign paths', () => {
  const text = 'a\nRun `node scripts/foo.mjs` and scripts/lib/bar.mjs.\nSee scripts/*.mjs, scripts/{name}.mjs and frontend/scripts/nope.mjs.'
  assert.deepEqual(scriptPaths(text), [
    { path: 'scripts/foo.mjs', line: 2 },
    { path: 'scripts/lib/bar.mjs', line: 2 },
  ])
})

test('labelsOf reads both labels of the Want · Ease line, in order', () => {
  assert.deepEqual(labelsOf('**Date:** x\n**Want:** 1/10 · **Ease:** 2/10\n**URL:** y'), ['Date', 'Want', 'Ease', 'URL'])
})

test('headerLabels reads the first report template and refuses a file without one', () => {
  const doc = 'text\n```markdown\n# Scouting: A — B\n\n**Date:** d\n**Tier:** T1\n```\n```markdown\n# Scouting: later\n**Other:** x\n```'
  assert.deepEqual(headerLabels(doc), ['Date', 'Tier'])
  assert.throws(() => headerLabels('no template here'))
})

test('sharedHeaderLabels reads the block under "Standard report block format"', () => {
  const doc = '```markdown\n**Early:** x\n```\n### Standard report block format\n\n```markdown\n**Want:** 1 · **Ease:** 2\n**URL:** u\n```'
  assert.deepEqual(sharedHeaderLabels(doc), ['Want', 'Ease', 'URL'])
  assert.throws(() => sharedHeaderLabels('nothing'))
})

test('isSubsequence keeps order and allows gaps', () => {
  assert.ok(isSubsequence(['a', 'c'], ['a', 'b', 'c']))
  assert.ok(!isSubsequence(['c', 'a'], ['a', 'b', 'c']))
  assert.ok(!isSubsequence(['d'], ['a', 'b', 'c']))
})
