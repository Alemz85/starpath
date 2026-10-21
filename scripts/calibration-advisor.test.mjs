// calibration-advisor.test.mjs — the CLI against a temporary data root:
// gated suggestions are posted to Messages once (keyed), `--no-post` posts
// nothing, and user/* is never written. Fictional data only.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { historyTsv } from './lib/testing/score-history-fixture.mjs'
import { readMessages } from './lib/messages-store.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'calibration-advisor.mjs')

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'calibrate-'))
  mkdirSync(join(root, 'data'))
  mkdirSync(join(root, 'user'))
  // 20 scored roles with a chronically low salary score: the comp-target
  // advisory clears its gate (20) and nothing else in user/* is needed.
  const rows = Array.from({ length: 20 }, (_, i) => ({ company: `Fabrikam ${i}`, salary_adj_city: 3, url: `https://jobs.example.test/${i}` }))
  writeFileSync(join(root, 'data/score-history.tsv'), historyTsv(...rows))
  writeFileSync(join(root, 'user/profile.yml'), 'eligibility: {}\n')
  return root
}

const run = (root, ...extra) => spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', '--today', '2026-10-20', ...extra], { encoding: 'utf8' })

test('calibrate posts each gated suggestion to Messages once', () => {
  const root = dataRoot()
  try {
    const first = run(root)
    assert.equal(first.status, 0, first.stderr)
    const report = JSON.parse(first.stdout)
    assert.ok(report.suggestions.length >= 1)
    assert.ok(report.suggestions.some(s => s.id === 'calibrate:comp-above-market'))
    assert.deepEqual(report.messages, { posted: report.suggestions.length, existing: 0, failed: 0 })

    const messages = readMessages(join(root, 'data/agent-messages.jsonl'))
    assert.equal(messages.length, report.suggestions.length)
    const comp = messages.find(m => m.key === 'calibrate:comp-above-market')
    assert.equal(comp.source, 'calibrate')
    assert.equal(comp.kind, 'suggestion')
    assert.equal(comp.status, 'open')

    // A re-run finds them open and posts nothing new.
    const second = JSON.parse(run(root).stdout)
    assert.deepEqual(second.messages, { posted: 0, existing: report.suggestions.length, failed: 0 })
    assert.equal(readMessages(join(root, 'data/agent-messages.jsonl')).length, messages.length)

    // Suggest only: the profile is untouched.
    assert.equal(readFileSync(join(root, 'user/profile.yml'), 'utf8'), 'eligibility: {}\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('calibrate --no-post leaves Messages alone', () => {
  const root = dataRoot()
  try {
    const r = run(root, '--no-post')
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.ok(report.suggestions.length >= 1)
    assert.equal('messages' in report, false)
    assert.equal(existsSync(join(root, 'data/agent-messages.jsonl')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
