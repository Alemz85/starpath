// browser-read.test.mjs — the CLI end to end against a throwaway data root
// (CAREER_OPS_ROOT): park writes the pipeline and ONE message, requeue needs
// the saved file and resolves the message. Fixtures are fictional.
//
// Run: node --test scripts/browser-read.test.mjs   (or `npm test`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMessages } from './lib/messages-store.mjs'
import { messageKey } from './lib/browser-read-core.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'browser-read.mjs')
const URL = 'https://jobs.example.com/nimbus-robotics/strategy-analyst-4417?gh_src=abc'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'starpath-browser-read-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data/pipeline.md'), [
    '# Pipeline — Pending Evaluations', '', '## Pending',
    `- [ ] ${URL} | Nimbus Robotics | Strategy Analyst | relevance 6.0 — fresh`,
    '- [ ] https://jobs.example.com/contoso/ops-1 | Contoso | Ops Analyst', '',
    '## Processed', '',
  ].join('\n'))
  return root
}

function run(root, ...args) {
  const r = spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const pipeline = (root) => readFileSync(join(root, 'data/pipeline.md'), 'utf-8')
const messages = (root) => readMessages(join(root, 'data/agent-messages.jsonl'))

test('park: out of Pending, into the section, one alert however often it runs', () => {
  const root = makeRoot()
  try {
    const a = run(root, 'park', '--url', URL, '--why', 'HTTP 403 to every script', '--json')
    assert.equal(a.code, 0, a.out)
    const res = JSON.parse(a.out)
    assert.equal(res.wasPending, true)
    assert.equal(res.posted, true)
    const text = pipeline(root)
    assert.match(text, /## Needs a browser read\n- \[!\] BROWSER READ \| https:\/\/jobs\.example\.com\/nimbus-robotics\/strategy-analyst-4417\?gh_src=abc \| Nimbus Robotics \| Strategy Analyst \| \d{4}-\d{2}-\d{2}: HTTP 403 to every script/)
    assert.ok(!/^- \[ \] https:\/\/jobs\.example\.com\/nimbus/m.test(text))

    const b = run(root, 'park', '--url', URL.replace('?gh_src=abc', ''), '--why', 'still 403', '--source', 'scan')
    assert.equal(b.code, 0, b.out)
    assert.match(b.out, /already open; not posted again/)
    const all = messages(root)
    assert.equal(all.length, 1)
    assert.equal(all[0].key, messageKey(URL))
    assert.equal(all[0].kind, 'alert')
    assert.equal(all[0].title, 'Needs a browser read: Nimbus Robotics — Strategy Analyst')
    assert.equal(pipeline(root).split('\n').filter((l) => l.includes('nimbus-robotics')).length, 1)

    const list = JSON.parse(run(root, 'list', '--json').out)
    assert.deepEqual(list.map((p) => p.why), ['still 403'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('requeue: refuses a missing file, then moves the line back and resolves the alert', () => {
  const root = makeRoot()
  try {
    assert.equal(run(root, 'park', '--url', URL, '--why', '403').code, 0)
    const missing = run(root, 'requeue', '--url', URL, '--jd-file', 'jds/nimbus-robotics-strategy-analyst.md')
    assert.equal(missing.code, 2)
    assert.match(missing.out, /save the posting text there first/)
    assert.equal(run(root, 'requeue', '--url', URL, '--jd-file', '../escape.md').code, 2)

    mkdirSync(join(root, 'jds'))
    writeFileSync(join(root, 'jds/nimbus-robotics-strategy-analyst.md'), '# Nimbus Robotics — Strategy Analyst\n\nThe posting.\n')
    const ok = run(root, 'requeue', '--url', URL, '--jd-file', 'jds/nimbus-robotics-strategy-analyst.md')
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /back in Pending: Nimbus Robotics — Strategy Analyst/)
    const text = pipeline(root)
    assert.ok(!text.includes('## Needs a browser read'))
    assert.match(text, /^- \[ \] https:\/\/jobs\.example\.com\/nimbus-robotics\/strategy-analyst-4417\?gh_src=abc \| Nimbus Robotics \| Strategy Analyst \| JD saved: jds\/nimbus-robotics-strategy-analyst\.md \(browser read \d{4}-\d{2}-\d{2}\)$/m)
    assert.equal(messages(root)[0].status, 'resolved')
    assert.equal(run(root, 'saved-jd', '--url', URL).out.trim(), 'jds/nimbus-robotics-strategy-analyst.md')
    assert.equal(run(root, 'saved-jd', '--url', 'https://jobs.example.com/contoso/ops-1').out.trim(), '')

    // A later failure posts a fresh alert: the old one is resolved, not open.
    assert.equal(run(root, 'park', '--url', URL, '--why', '403 again').code, 0)
    assert.equal(messages(root).filter((m) => m.status === 'open').length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('bad input fails with usage, and leaves no lock behind', () => {
  const root = makeRoot()
  try {
    assert.equal(run(root, 'park', '--url', 'https://jobs.example.com/unknown', '--why', '403').code, 2)
    assert.equal(run(root, 'park', '--url', URL).code, 2)
    assert.equal(run(root, 'bogus').code, 2)
    assert.equal(existsSync(join(root, 'data/.pipeline.md.lock')), false)
    assert.equal(messages(root).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
