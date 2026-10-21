// Tests for evalSpawn.ts — the compact-bundle eval spawn path
// (token-cost lever 3: stop loading CLAUDE.md + modes/* on every eval).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_EVAL_BUNDLE,
  claudeEvalArgs,
  pickPromptFile,
  scoreOnlyEvalPrompt,
  inboxEvalPrompt,
  filterAllPrompt,
  top5ReportsPrompt,
} from './evalSpawn'
import { NON_INTERACTIVE_SUFFIX, WORKER_FLAG } from './spawnFormat'

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
  assert.deepEqual(args.slice(0, 2), [WORKER_FLAG, 'eval-app'])
  assert.ok(!args.some(a => a.includes('skip-permissions')))
  assert.ok(args.includes('stream-json'))
  assert.ok(args.includes('--verbose'))
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'opus'])
  assert.equal(args[args.length - 1], 'task' + NON_INTERACTIVE_SUFFIX)
  assert.equal(args[args.length - 2], '-p')
})

test('claudeEvalArgs passes a resolved bundle (private override) when given one', () => {
  const file = '/tmp/fixture-repo/private/overrides/batch/batch-prompt.md'
  const args = claudeEvalArgs('task', 'sonnet', file)
  assert.equal(args[args.indexOf('--append-system-prompt-file') + 1], file)
})

test('pickPromptFile falls back to the repo default on anything unusable', () => {
  assert.equal(pickPromptFile('/abs/batch-prompt.md', COMPACT_EVAL_BUNDLE), '/abs/batch-prompt.md')
  assert.equal(pickPromptFile(null, COMPACT_EVAL_BUNDLE), COMPACT_EVAL_BUNDLE)
  assert.equal(pickPromptFile('', COMPACT_EVAL_BUNDLE), COMPACT_EVAL_BUNDLE)
  assert.equal(pickPromptFile({ path: 'x' }, COMPACT_EVAL_BUNDLE), COMPACT_EVAL_BUNDLE)
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

test('every eval prompt claims its row numbers instead of reading the tracker max', () => {
  for (const [name, p] of ALL_PROMPTS()) {
    assert.ok(p.includes('node scripts/reserve-report-num.mjs'), `${name} reserves {num}`)
    assert.ok(p.includes('never derive {num} from data/scouting.md'), `${name} forbids max+1`)
  }
})

test('score-only paths skip the report step; top5 writes exactly the deep-report exception', () => {
  for (const [name, p] of [ALL_PROMPTS()[0], ALL_PROMPTS()[1], ALL_PROMPTS()[2]]) {
    assert.ok(p.includes('NO report file'), `${name} skips Step 5`)
  }
  const top5 = top5ReportsPrompt('2026-07-01')
  assert.ok(top5.includes('5 highest-Priority survivors'))
  assert.ok(top5.includes('never a Blocked listing'))
  assert.ok(!/Overall/.test(top5))
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
    // A broad sample of school / city / nationality words — none belongs in a
    // generic task prompt, whoever the user is.
    assert.ok(!/\b(INSEAD|HEC|Bocconi|Esade|CEMS|LBS|Barcelona|Madrid|Milan|Paris|London|Copenhagen|Berlin|Italian|Spanish|French|German)\b/.test(p), `${name} carries no user-specific facts`)
  }
})

test('triage prompts route eligibility walls through the gate, never a silent discard', () => {
  for (const p of [inboxEvalPrompt('https://x.example/j', '2026-07-01'), filterAllPrompt('2026-07-01')]) {
    assert.ok(p.includes('--eligibility-only'))
    assert.ok(p.includes('logged — as Blocked'))
    assert.ok(!/Ease of Entry|Overall/.test(p))
  }
})

test('the whole-pipeline prompts park an unreadable posting once and skip it for a week', () => {
  for (const p of [filterAllPrompt('2026-07-01'), top5ReportsPrompt('2026-07-01')]) {
    assert.ok(p.includes('NOT EVALUATED YYYY-MM-DD'), 'one note format')
    assert.ok(p.includes('within the last 7 days, without fetching it'), 'no refetch while it waits for the user')
    assert.ok(p.includes('never guess a score'))
    assert.ok(p.includes('single `node scripts/append-score-rows.mjs --input` call'), 'one append for the whole run')
  }
  assert.ok(!scoreOnlyEvalPrompt('https://x.example/1', '2026-07-01').includes('NOT EVALUATED'), 'a single pasted URL is always tried')
})

test('every eval prompt can claim several row numbers in one call', () => {
  for (const [name, p] of ALL_PROMPTS()) assert.ok(p.includes('reserve-report-num.mjs --count <N>'), name)
})
