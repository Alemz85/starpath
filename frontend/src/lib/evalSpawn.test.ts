// Tests for evalSpawn.ts — the compact-bundle eval spawn path
// (token-cost lever 3: stop loading CLAUDE.md + modes/* on every eval).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_EVAL_BUNDLE,
  claudeEvalArgs,
  scoreOnlyEvalPrompt,
  inboxEvalPrompt,
  filterAllPrompt,
  top5ReportsPrompt,
} from './evalSpawn'
import { NON_INTERACTIVE_SUFFIX, MODEL_IDS } from './spawnFormat'

// ─── claudeEvalArgs ──────────────────────────────────────────────────────────

test('claudeEvalArgs loads the compact bundle as an appended system prompt', () => {
  const args = claudeEvalArgs('do the thing', 'sonnet')
  const i = args.indexOf('--append-system-prompt-file')
  assert.ok(i >= 0, 'has --append-system-prompt-file')
  assert.equal(args[i + 1], COMPACT_EVAL_BUNDLE)
  assert.equal(COMPACT_EVAL_BUNDLE, 'batch/batch-prompt.md')
})

test('claudeEvalArgs keeps the non-interactive flag set from claudeArgs', () => {
  const args = claudeEvalArgs('task', 'opus')
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(args.includes('stream-json'))
  assert.ok(args.includes('--verbose'))
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', MODEL_IDS.opus])
  assert.equal(args[args.length - 1], 'task' + NON_INTERACTIVE_SUFFIX)
  assert.equal(args[args.length - 2], '-p')
})

test('claudeEvalArgs omits --model when none is given', () => {
  const args = claudeEvalArgs('task')
  assert.ok(!args.includes('--model'))
})

// ─── Prompt builders ─────────────────────────────────────────────────────────

const ALL_PROMPTS = () => [
  ['scoreOnly', scoreOnlyEvalPrompt('https://x.example/job/1', '2026-07-01')],
  ['inbox', inboxEvalPrompt('https://x.example/job/1', '2026-07-01')],
  ['filterAll', filterAllPrompt('2026-07-01')],
  ['top5', top5ReportsPrompt('2026-07-01')],
] as const

test('no eval prompt routes through the /career-ops slash command or loads mode files', () => {
  for (const [name, p] of ALL_PROMPTS()) {
    assert.ok(!p.includes('/career-ops'), `${name} must not invoke the skill router`)
    assert.ok(!p.includes('modes/'), `${name} must not reference modes/* files`)
    assert.ok(!p.includes('CLAUDE.md'), `${name} must not reference CLAUDE.md`)
  }
})

test('every eval prompt supplies the unresolved-placeholder values (date + batch id)', () => {
  for (const [name, p] of ALL_PROMPTS()) {
    assert.ok(p.includes('Date: 2026-07-01'), `${name} states the date`)
    assert.ok(/Batch ID: [a-z0-9-]+/.test(p), `${name} states a batch id`)
  }
})

test('every eval prompt merges scouting TSVs instead of editing scouting.md directly', () => {
  for (const [name, p] of ALL_PROMPTS()) {
    assert.ok(p.includes('merge-scouting.mjs'), `${name} runs the merge`)
    assert.ok(p.includes('never edit data/scouting.md'), `${name} forbids direct edits`)
  }
})

test('score-only paths skip the report step; top5 writes exactly the deep-report exception', () => {
  for (const [name, p] of [ALL_PROMPTS()[0], ALL_PROMPTS()[1], ALL_PROMPTS()[2]]) {
    assert.ok(p.includes('NO report file'), `${name} skips Step 5`)
  }
  const top5 = top5ReportsPrompt('2026-07-01')
  assert.ok(top5.includes('5 highest-scoring survivors'))
  assert.ok(top5.includes('reports/tier-{N}/{Company} - {Role}.md'))
})

test('gated prompts carry the relevance gate with the corrected borderline rule', () => {
  for (const p of [inboxEvalPrompt('https://x.example/j', '2026-07-01'), filterAllPrompt('2026-07-01'), top5ReportsPrompt('2026-07-01')]) {
    assert.ok(p.includes('Borderline = DISCARD'), 'when in doubt, the listing is out (modes/pipeline.md § 2c)')
    assert.ok(p.includes('[!] FILTERED | URL | Company | Role | reason'), 'auditable Filtered Out trail')
    assert.ok(p.includes('result, not a target'), 'no survivor-quota pressure')
  }
})

test('single-URL prompts embed the URL', () => {
  const url = 'https://boards.example.com/acme/analyst-42'
  assert.ok(scoreOnlyEvalPrompt(url, '2026-07-01').includes(url))
  assert.ok(inboxEvalPrompt(url, '2026-07-01').includes(url))
})

test('prompts contain no hardcoded user data (system-layer hygiene)', () => {
  // The gate criteria must be generic; user specifics flow from user/* files
  // referenced by path, never inlined.
  for (const [name, p] of ALL_PROMPTS()) {
    assert.ok(p.includes('user/_profile.md') || p.includes('system prompt'), `${name} defers to user files / the bundle`)
    assert.ok(!/Esade|CEMS|Barcelona|Copenhagen|Italian/.test(p), `${name} carries no user-specific facts`)
  }
})
