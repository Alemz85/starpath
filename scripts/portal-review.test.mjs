// portal-review.test.mjs — the review end to end over files in a temp data root:
// posts to Messages once, never edits portals.yml, honours dry-run, dream
// companies and the config switch. Fixtures are fictional.
//
// Run: node --test scripts/portal-review.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runReview, historyRows, scoreRows } from './portal-review.mjs'
import { MESSAGES_REL, readMessages, setMessageStatus } from './lib/messages-store.mjs'
import { HISTORY_HEADER_FULL } from './lib/scan-history.mjs'

const CLI = fileURLToPath(new URL('./portal-review.mjs', import.meta.url))
const providers = [{ id: 'greenhouse', detect: (e) => (e.api ? { url: e.api, explicit: true } : null), fetch: async () => [] }]
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const WEEKS = Array.from({ length: 24 }, (_, i) => addDays('2026-10-21', i * 7)) // ~5.5 months of weekly scans

const PORTALS = `tracked_companies:
  # probation since 2026-10-21
  - name: Quiet Labs
    api: https://boards-api.greenhouse.io/v1/boards/quiet-labs/jobs
    enabled: true

  # probation since 2026-10-21
  - name: Fresh Start
    api: https://boards-api.greenhouse.io/v1/boards/fresh-start/jobs
    enabled: true

  # probation since 2026-10-21
  - name: Northwind Dream
    api: https://boards-api.greenhouse.io/v1/boards/northwind/jobs
    enabled: true
`
const PROFILE = `target_roles:
  dream_companies:
    - name: Northwind Dream
`

function tsv(rows) {
  const cols = HISTORY_HEADER_FULL.split('\t')
  return [HISTORY_HEADER_FULL, ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n') + '\n'
}

function makeRoot({ profile = PROFILE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'starpath-portal-review-'))
  mkdirSync(join(root, 'user'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'user/portals.yml'), PORTALS)
  writeFileSync(join(root, 'user/profile.yml'), profile)
  const busy = { url: 'https://example.com/busy', first_seen: WEEKS[0], portal: 'greenhouse-api', title: 'Intern', company: 'Busy Systems', status: 'added', scan_dates: WEEKS.join('|') }
  const fresh = { url: 'https://example.com/fresh/1', first_seen: '2026-10-28', portal: 'greenhouse-api', title: 'Strategy Intern', company: 'Fresh Start', status: 'added', scan_dates: '2026-10-28' }
  writeFileSync(join(root, 'data/scan-history.tsv'), tsv([busy, fresh]))
  return root
}
const opts = (root, extra = {}) => ({ root, providers, today: '2027-04-07', now: new Date('2027-04-07T09:00:00Z'), ...extra })

test('posts one suggestion per company+action: pause the quiet one, keep the fresh one, never the dream company', async () => {
  const root = makeRoot()
  try {
    const before = readFileSync(join(root, 'user/portals.yml'), 'utf-8')
    const r = await runReview(opts(root))
    assert.deepEqual(r.posted.map((s) => s.key).sort(), ['portal-review:keep:freshstart', 'portal-review:pause:quietlabs'])
    const msgs = readMessages(join(root, MESSAGES_REL))
    assert.equal(msgs.length, 2)
    for (const m of msgs) {
      assert.equal(m.source, 'scan')
      assert.equal(m.kind, 'suggestion')
      assert.equal(m.status, 'open')
    }
    assert.match(msgs.find((m) => m.key.includes('quietlabs')).body, /24 scans spanning 161 days/)
    assert.equal(readFileSync(join(root, 'user/portals.yml'), 'utf-8'), before, 'portals.yml is never edited')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('running again posts nothing new — open, dismissed and resolved suggestions stay posted once', async () => {
  const root = makeRoot()
  try {
    await runReview(opts(root))
    const file = join(root, MESSAGES_REL)
    const [a, b] = readMessages(file)
    setMessageStatus(file, a.id, 'dismissed')
    setMessageStatus(file, b.id, 'resolved')
    const again = await runReview(opts(root))
    assert.equal(again.posted.length, 0)
    assert.equal(readMessages(file).length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--dry-run lists what it would post and writes no messages file', async () => {
  const root = makeRoot()
  try {
    const r = await runReview(opts(root, { dryRun: true }))
    assert.equal(r.posted.length, 2)
    assert.equal(existsSync(join(root, MESSAGES_REL)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('max_per_run caps the posts; the rest wait for the next run', async () => {
  const root = makeRoot({ profile: `${PROFILE}scanner:\n  portal_review:\n    max_per_run: 1\n` })
  try {
    const first = await runReview(opts(root))
    assert.equal(first.posted.length, 1)
    const second = await runReview(opts(root))
    assert.equal(second.posted.length, 1)
    assert.equal(readMessages(join(root, MESSAGES_REL)).length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('scanner.portal_review.enabled: false turns the review off', async () => {
  const root = makeRoot({ profile: `${PROFILE}scanner:\n  portal_review:\n    enabled: false\n` })
  try {
    const r = await runReview(opts(root))
    assert.equal(r.enabled, false)
    assert.equal(existsSync(join(root, MESSAGES_REL)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing data folder is not an error: no files, no suggestions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'starpath-portal-review-'))
  try {
    const r = await runReview(opts(root))
    assert.deepEqual(r.posted, [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI: --dry-run --json prints the result and exits 0', () => {
  const root = makeRoot()
  try {
    const out = spawnSync(process.execPath, [CLI, '--dry-run', '--json', '--today', '2027-04-07'], { env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: 'utf-8' })
    assert.equal(out.status, 0, out.stderr)
    const json = JSON.parse(out.stdout)
    assert.equal(json.enabled, true)
    assert.ok(json.posted.every((k) => k.startsWith('portal-review:')))
    assert.equal(existsSync(join(root, MESSAGES_REL)), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('historyRows / scoreRows read header-named columns and tolerate short rows', () => {
  const [h] = historyRows(`${HISTORY_HEADER_FULL}\nhttps://example.com/x\t2026-10-21\tashby-api\tIntern\tNimbus\tLyon\tadded\t2026-10-21|2026-10-28\n`)
  assert.equal(h.company, 'Nimbus')
  assert.deepEqual(h.scan_dates, ['2026-10-21', '2026-10-28'])
  assert.deepEqual(scoreRows('date\tcompany\trole\tverdict\n2026-10-21\tNimbus\tIntern\tgo\n'), [{ company: 'Nimbus', role: 'Intern', verdict: 'go', date: '2026-10-21' }])
  assert.deepEqual(scoreRows('nothing useful'), [])
})
