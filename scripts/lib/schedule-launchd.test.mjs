import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installJob, uninstallJob, jobStatus, inspectPlist, resolveBinary, jobPath, plistPathFor } from './schedule-launchd.mjs'
import { LABEL, buildPlist } from './schedule-core.mjs'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sched-ld-'))
  const calls = []
  const run = (args) => { calls.push(args); return '' }
  return { dir, calls, run, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const slot = { weekday: 2, hour: 9, minute: 0 }
const base = { root: '/work/repo', slot, nodePath: '/opt/homebrew/bin/node', claudePath: '/opt/homebrew/bin/claude', home: '/Users/someone', uid: 501 }

test('resolveBinary returns the first match on PATH without resolving links', () => {
  const found = resolveBinary('node', '/a:/b:/c', (p) => p === '/b/node' || p === '/c/node')
  assert.equal(found, '/b/node')
  assert.equal(resolveBinary('node', '/a', () => false), null)
})

test('jobPath lists node and claude folders first, de-duplicated, then the system folders', () => {
  const p = jobPath({ nodePath: '/opt/homebrew/bin/node', claudePath: '/opt/homebrew/bin/claude' }).split(':')
  assert.equal(p[0], '/opt/homebrew/bin')
  assert.equal(p.filter((x) => x === '/opt/homebrew/bin').length, 1)
  assert.ok(p.includes('/usr/bin') && p.includes('/bin'))
})

test('install writes the plist and (re)loads it into the user domain', () => {
  const sb = sandbox()
  try {
    const r = installJob({ ...base, plistDir: sb.dir, run: sb.run })
    assert.equal(r.plistPath, plistPathFor(sb.dir))
    assert.ok(existsSync(r.plistPath))
    assert.match(readFileSync(r.plistPath, 'utf8'), /<key>Weekday<\/key><integer>2<\/integer>/)
    assert.deepEqual(sb.calls, [['bootout', `gui/501/${LABEL}`], ['bootstrap', 'gui/501', r.plistPath]])
    assert.equal(r.loaded, true)
  } finally { sb.done() }
})

test('install with load:false only writes the file', () => {
  const sb = sandbox()
  try {
    const r = installJob({ ...base, plistDir: sb.dir, run: sb.run, load: false })
    assert.equal(sb.calls.length, 0)
    assert.equal(r.loaded, false)
    assert.ok(existsSync(r.plistPath))
  } finally { sb.done() }
})

test('install survives bootout failing (job not loaded yet) but surfaces a bootstrap failure', () => {
  const sb = sandbox()
  try {
    const run = (args) => { if (args[0] === 'bootout') throw new Error('not loaded'); sb.calls.push(args) }
    assert.doesNotThrow(() => installJob({ ...base, plistDir: sb.dir, run }))
    const bad = (args) => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5') }
    assert.throws(() => installJob({ ...base, plistDir: sb.dir, run: bad }), /Bootstrap failed/)
  } finally { sb.done() }
})

test('install refuses without a node path', () => {
  assert.throws(() => installJob({ ...base, nodePath: null, plistDir: '/nowhere' }), /node/)
})

test('a new slot rewrites the plist in place', () => {
  const sb = sandbox()
  try {
    installJob({ ...base, plistDir: sb.dir, run: sb.run })
    installJob({ ...base, slot: { weekday: 4, hour: 7, minute: 30 }, plistDir: sb.dir, run: sb.run })
    const text = readFileSync(plistPathFor(sb.dir), 'utf8')
    assert.match(text, /<key>Weekday<\/key><integer>4<\/integer>/)
    assert.doesNotMatch(text, /<key>Weekday<\/key><integer>2<\/integer>/)
  } finally { sb.done() }
})

test('uninstall unloads and removes the plist, and is idempotent', () => {
  const sb = sandbox()
  try {
    installJob({ ...base, plistDir: sb.dir, run: sb.run })
    sb.calls.length = 0
    const r = uninstallJob({ plistDir: sb.dir, uid: 501, run: sb.run })
    assert.equal(r.existed, true)
    assert.ok(!existsSync(r.plistPath))
    assert.deepEqual(sb.calls, [['bootout', `gui/501/${LABEL}`]])
    assert.equal(uninstallJob({ plistDir: sb.dir, uid: 501, run: sb.run }).existed, false)
  } finally { sb.done() }
})

test('status: missing, healthy, and each way a installed job goes stale', () => {
  const sb = sandbox()
  try {
    assert.equal(jobStatus({ plistDir: sb.dir, uid: 501, run: sb.run }).installed, false)
    installJob({ ...base, plistDir: sb.dir, run: sb.run })
    const healthy = { plistDir: sb.dir, uid: 501, run: sb.run, expect: { slot, root: base.root }, executable: () => true, exists: () => true }
    const ok = jobStatus(healthy)
    assert.equal(ok.installed, true)
    assert.equal(ok.loaded, true)
    assert.deepEqual(ok.problems, [])
    assert.equal(ok.upToDate, true)

    const otherSlot = jobStatus({ ...healthy, expect: { slot: { weekday: 5, hour: 9, minute: 0 }, root: base.root } })
    assert.match(otherSlot.problems.join(), /slot differs/)
    const otherRoot = jobStatus({ ...healthy, expect: { slot, root: '/elsewhere' } })
    assert.match(otherRoot.problems.join(), /points at \/work\/repo/)
    const nodeGone = jobStatus({ ...healthy, executable: (p) => !p.endsWith('/node') })
    assert.match(nodeGone.problems.join(), /node is no longer at/)
    const noClaude = jobStatus({ ...healthy, executable: (p) => !p.endsWith('/claude') })
    assert.match(noClaude.problems.join(), /claude CLI is not reachable/)
    assert.equal(noClaude.upToDate, false)

    const notLoaded = jobStatus({ ...healthy, run: () => { throw new Error('Could not find service') } })
    assert.equal(notLoaded.loaded, false)
  } finally { sb.done() }
})

test('inspectPlist reads back what buildPlist wrote', () => {
  const text = buildPlist({
    nodePath: '/n/node', scriptPath: '/r/scripts/scheduled-run.mjs', root: '/r&x', slot: { weekday: 6, hour: 7, minute: 30 },
    pathEnv: '/a:/b', home: '/h', logPath: '/l',
  })
  const info = inspectPlist(text)
  assert.equal(info.nodePath, '/n/node')
  assert.equal(info.scriptPath, '/r/scripts/scheduled-run.mjs')
  assert.equal(info.root, '/r&x')
  assert.equal(info.pathEnv, '/a:/b')
  assert.deepEqual(info.slots, [7, 9, 11, 13, 15].map((hour) => ({ weekday: 6, hour, minute: 30 })))
})
