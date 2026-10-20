// Unit tests for scripts/lib/private-core.mjs — pure planning and checks for
// the private root. Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.
// Fixtures are fictional (Northwind Analytics, Dana Fox).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LINKED_PATHS } from './data-root.mjs'
import {
  PRIVATE_ENTRIES, MOVE_ONLY_PATHS, privateRelFor, isPlaceholderFile,
  linkPointsAt, classifyRootPath, planPrivate, predictLinkBreaks, compareManifests,
  countFilesByPath, manifestFileName, PRE_COMMIT_HOOK, CODE_FILE_RE, PRIVATE_GITIGNORE, PRIVATE_README,
  countPorcelain, backupMessage, ageDays, formatAge, statusProblems, linkOk,
  parsePs, findRunningApp, annotateOverrides, groupOverrides, formatOverridesBrief,
} from './private-core.mjs'

const REPO = '/work/starpath'
const entry = (path) => PRIVATE_ENTRIES.find((e) => e.path === path)
const absent = { type: 'absent' }
const dir = { type: 'dir' }
const file = { type: 'file' }
const link = (linkTarget, targetExists = true) => ({ type: 'symlink', linkTarget, targetExists })

/** Facts for every entry: defaults absent/absent, overridden per path. */
function facts(overrides = {}) {
  return PRIVATE_ENTRIES.map((e) => ({ entry: e, root: absent, priv: absent, ...(overrides[e.path] || {}) }))
}

// ── entries ─────────────────────────────────────────────────────────────────

test('PRIVATE_ENTRIES = the linked paths plus profiles (move only, no link)', () => {
  assert.equal(PRIVATE_ENTRIES.length, LINKED_PATHS.length + 1)
  assert.deepEqual(MOVE_ONLY_PATHS, [{ path: 'profiles', kind: 'dir', link: null }])
  assert.equal(privateRelFor('batch/logs'), 'private/batch/logs')
  assert.ok(isPlaceholderFile('.gitkeep', 0))
  assert.ok(!isPlaceholderFile('.gitkeep', 3))
  assert.ok(!isPlaceholderFile('notes.md', 0))
})

// ── classification ──────────────────────────────────────────────────────────

test('linkPointsAt resolves relative targets and absolute ones under any repo spelling', () => {
  assert.ok(linkPointsAt('data', 'private/data', 'private/data'))
  assert.ok(linkPointsAt('data', './private/data/', 'private/data'))
  assert.ok(linkPointsAt('batch/logs', '../private/batch/logs', 'private/batch/logs'))
  assert.ok(!linkPointsAt('batch/logs', 'private/batch/logs', 'private/batch/logs'))
  assert.ok(linkPointsAt('data', `${REPO}/private/data`, 'private/data', [REPO]))
  assert.ok(linkPointsAt('data', '/real/starpath/private/data', 'private/data', [REPO, '/real/starpath']))
  assert.ok(!linkPointsAt('data', '/other/checkout/private/data', 'private/data', [REPO]))
  assert.ok(!linkPointsAt('data', '', 'private/data'))
  assert.ok(!linkPointsAt('data', null, 'private/data'))
})

test('classifyRootPath: absent / real / linked / wrong / dangling', () => {
  const e = entry('data')
  assert.equal(classifyRootPath(e, absent), 'absent')
  assert.equal(classifyRootPath(e, dir), 'real')
  assert.equal(classifyRootPath(e, file), 'real')
  assert.equal(classifyRootPath(e, link('private/data', false)), 'linked')
  assert.equal(classifyRootPath(e, link('../somewhere/data', true)), 'wrong')
  assert.equal(classifyRootPath(e, link('../somewhere/data', false)), 'dangling')
})

test('linkOk: dir links need their private folder, file links may dangle', () => {
  assert.ok(linkOk('dir', 'linked', 'dir'))
  assert.ok(!linkOk('dir', 'linked', 'absent'))
  assert.ok(linkOk('file', 'linked', 'absent'))
  assert.ok(linkOk('file', 'linked', 'file'))
  assert.ok(!linkOk('file', 'linked', 'dir'))
  assert.ok(!linkOk('dir', 'real', 'dir'))
})

// ── init plan ───────────────────────────────────────────────────────────────

test('planPrivate init: fresh checkout creates every folder and link, no moves', () => {
  const plan = planPrivate(facts())
  assert.deepEqual(plan.moved, [])
  assert.deepEqual(plan.conflicts, [])
  assert.deepEqual(plan.linked, LINKED_PATHS.map((e) => e.path))
  // Dir entries get a private folder; file entries only a link (writers create them).
  assert.deepEqual(plan.created, LINKED_PATHS.filter((e) => e.kind === 'dir').map((e) => e.path))
  assert.deepEqual(plan.skipped, [{ path: 'profiles', reason: 'not present' }])
  const ensured = plan.ops.filter((o) => o.op === 'ensure-dir').map((o) => o.path)
  assert.ok(ensured.includes('private'))
  assert.ok(ensured.includes('private/batch'), 'file links need private/batch/ to exist')
  assert.ok(!ensured.includes('private/batch/batch-state.tsv'))
  const sym = plan.ops.find((o) => o.op === 'symlink' && o.path === 'batch/cv-summary.md')
  assert.deepEqual(sym, { op: 'symlink', path: 'batch/cv-summary.md', target: '../private/batch/cv-summary.md', kind: 'file' })
})

test('planPrivate init: real folders and files move, then link; ops are phased', () => {
  const plan = planPrivate(facts({
    data: { root: dir },
    'batch/batch-state.tsv': { root: file },
    profiles: { root: dir },
  }))
  assert.deepEqual(plan.moved, ['data', 'batch/batch-state.tsv', 'profiles'])
  assert.ok(plan.linked.includes('data') && plan.linked.includes('batch/batch-state.tsv'))
  assert.ok(!plan.linked.includes('profiles'), 'profiles moves with no link')
  assert.ok(!plan.created.includes('data'))
  const order = plan.ops.map((o) => o.op)
  const lastMove = order.lastIndexOf('move')
  const firstLink = order.indexOf('symlink')
  assert.ok(lastMove < firstLink, 'every move happens before any link')
  assert.deepEqual(plan.ops.find((o) => o.op === 'move' && o.path === 'profiles'), { op: 'move', from: 'profiles', to: 'private/profiles', path: 'profiles' })
  assert.ok(order.indexOf('ensure-dir') < order.indexOf('move'))
})

test('planPrivate init: real path + existing private copy is a conflict, never merged', () => {
  const plan = planPrivate(facts({ data: { root: dir, priv: dir }, profiles: { root: dir, priv: dir } }))
  assert.deepEqual(plan.conflicts.map((c) => c.path), ['data', 'profiles'])
  assert.ok(!plan.ops.some((o) => o.path === 'data'), 'no op touches a conflicting entry')
  assert.ok(!plan.moved.includes('data'))
})

test('planPrivate init: an EMPTY real folder next to an existing private copy is dropped and linked', () => {
  const plan = planPrivate(facts({ data: { root: dir, priv: dir, rootEmpty: true } }))
  assert.deepEqual(plan.conflicts, [])
  assert.ok(plan.ops.some((o) => o.op === 'remove-empty-dir' && o.path === 'data'))
  assert.ok(plan.linked.includes('data'))
  assert.ok(plan.warnings.some((w) => w.includes('empty data/')))
})

test('planPrivate init: wrong link refuses without --force, re-points with it', () => {
  const f = facts({ user: { root: link('../elsewhere/user', true) } })
  const plain = planPrivate(f)
  assert.equal(plain.conflicts.length, 1)
  assert.equal(plain.conflicts[0].path, 'user')
  assert.match(plain.conflicts[0].reason, /--force/)
  assert.ok(!plain.ops.some((o) => o.path === 'user'))

  const forced = planPrivate(f, { force: true })
  assert.deepEqual(forced.conflicts, [])
  const userOps = forced.ops.filter((o) => o.path === 'user' || o.path === 'private/user').map((o) => o.op)
  assert.deepEqual(userOps, ['ensure-dir', 'unlink', 'symlink'])
  assert.ok(forced.warnings.some((w) => w.includes('re-pointed user')))
})

test('planPrivate init: dangling foreign link is re-pointed without --force', () => {
  const plan = planPrivate(facts({ jds: { root: link('/gone/jds', false) } }))
  assert.deepEqual(plan.conflicts, [])
  assert.ok(plan.ops.some((o) => o.op === 'unlink' && o.path === 'jds'))
  assert.ok(plan.linked.includes('jds'))
})

test('planPrivate init: wrong types are conflicts (file at a folder path and vice versa)', () => {
  const plan = planPrivate(facts({
    data: { root: file },
    'batch/cv-summary.md': { root: dir },
    reports: { priv: file },
  }))
  assert.deepEqual(plan.conflicts.map((c) => c.path).sort(), ['batch/cv-summary.md', 'data', 'reports'])
})

test('planPrivate init: rerun on a migrated checkout is a no-op', () => {
  const migrated = {}
  for (const e of LINKED_PATHS) migrated[e.path] = { root: link(e.link, true), priv: e.kind === 'dir' ? dir : absent }
  migrated.profiles = { priv: dir }
  const plan = planPrivate(facts(migrated))
  assert.deepEqual(plan.moved, [])
  assert.deepEqual(plan.linked, [])
  assert.deepEqual(plan.created, [])
  assert.deepEqual(plan.conflicts, [])
  assert.equal(plan.skipped.length, PRIVATE_ENTRIES.length)
  assert.ok(plan.skipped.every((s) => /already/.test(s.reason)))
  assert.ok(plan.ops.every((o) => o.op === 'ensure-dir'), 'only idempotent mkdirs remain')
})

test('planPrivate: a correct dir link whose private folder vanished gets the folder back', () => {
  const plan = planPrivate(facts({ output: { root: link('private/output', false), priv: absent } }))
  assert.deepEqual(plan.created.includes('output'), true)
  assert.ok(!plan.linked.includes('output'))
  assert.ok(plan.ops.some((o) => o.op === 'ensure-dir' && o.path === 'private/output'))
})

test('planPrivate: absolute link to this checkout counts as linked', () => {
  const plan = planPrivate(facts({ data: { root: link(`${REPO}/private/data`), priv: dir } }), { repoRoots: [REPO] })
  assert.deepEqual(plan.skipped.find((s) => s.path === 'data'), { path: 'data', reason: 'already linked' })
})

// ── link plan ───────────────────────────────────────────────────────────────

test('planPrivate link: repairs links but never moves data', () => {
  const plan = planPrivate(facts({
    data: { root: dir, priv: absent },
    user: { root: dir, priv: dir },
    reports: { root: dir, priv: dir, rootEmpty: true },
    jds: { root: link('/gone', false), priv: dir },
    profiles: { root: dir },
  }), { mode: 'link' })
  assert.deepEqual(plan.moved, [])
  assert.ok(!plan.ops.some((o) => o.op === 'move'))
  const conflict = Object.fromEntries(plan.conflicts.map((c) => [c.path, c.reason]))
  assert.match(conflict.data, /npm run private -- init/)
  assert.match(conflict.user, /shadows private\/user/)
  assert.ok(!('profiles' in conflict), 'link ignores profiles/')
  assert.ok(plan.linked.includes('reports'), 'an empty real folder is replaced by the link')
  assert.ok(plan.linked.includes('jds'))
  assert.ok(plan.linked.includes('interview-prep'), 'missing links are created')
})

// ── link breaks ─────────────────────────────────────────────────────────────

test('predictLinkBreaks: profile links survive because profiles/ moves too', () => {
  const records = [
    { path: 'data/scouting.md', type: 'link', target: '../profiles/career/data/scouting.md', resolves: true },
    { path: 'reports/tier-1', type: 'link', target: '../profiles/career/reports/tier-1', resolves: true },
    { path: 'user/profile.yml', type: 'link', target: '../profiles/career/user/profile.yml', resolves: false },
    { path: 'batch/logs/latest', type: 'link', target: '../../data/run.log', resolves: true },
  ]
  assert.deepEqual(predictLinkBreaks(records, { movedPaths: ['data', 'reports', 'profiles', 'batch/logs'] }), [])
})

test('predictLinkBreaks: links to public files, outside the repo, or absolute into moved folders break', () => {
  const records = [
    { path: 'output/template.html', type: 'link', target: '../templates/cv-template.html', resolves: true },
    { path: 'data/outside', type: 'link', target: '../../shared/notes.md', resolves: true },
    { path: 'data/abs', type: 'link', target: `${REPO}/profiles/career/data/a.md`, resolves: true },
    { path: 'data/abs-ok', type: 'link', target: '/mnt/archive/data.md', resolves: true },
    { path: 'data/file.md', type: 'file', size: 1, sha256: 'x' },
  ]
  const breaks = predictLinkBreaks(records, { repoRoots: [REPO], movedPaths: ['data', 'output', 'profiles'] })
  assert.deepEqual(breaks.map((b) => b.path), ['output/template.html', 'data/outside', 'data/abs'])
})

// ── manifests ───────────────────────────────────────────────────────────────

const rec = [
  { path: 'data', type: 'dir' },
  { path: 'data/scouting.md', type: 'file', size: 10, sha256: 'aa' },
  { path: 'data/companies/northwind-analytics.md', type: 'file', size: 4, sha256: 'bb' },
  { path: 'data/active', type: 'link', target: '../profiles/career/data/x', resolves: true },
]

test('compareManifests: identical → verified', () => {
  const r = compareManifests(rec, rec.map((x) => ({ ...x })))
  assert.deepEqual(r, { verified: true, files: 2, mismatches: [] })
})

test('compareManifests: missing file, changed bytes, broken link are each reported', () => {
  const after = [
    { path: 'data', type: 'dir' },
    { path: 'data/scouting.md', type: 'file', size: 10, sha256: 'zz' },
    { path: 'data/active', type: 'link', target: '../profiles/career/data/x', resolves: false },
  ]
  const r = compareManifests(rec, after)
  assert.equal(r.verified, false)
  assert.deepEqual(r.mismatches.map((m) => m.path), ['data/scouting.md', 'data/companies/northwind-analytics.md', 'data/active'])
  assert.match(r.mismatches[2].reason, /no longer resolves/)
})

test('countFilesByPath and manifestFileName', () => {
  assert.deepEqual(countFilesByPath(rec, ['data', 'reports']), [{ path: 'data', files: 2 }, { path: 'reports', files: 0 }])
  assert.equal(manifestFileName(new Date('2026-10-20T09:05:07.123Z')), 'migration-2026-10-20T09-05-07Z.json')
})

// ── private repo files ──────────────────────────────────────────────────────

test('pre-commit hook refuses the same code files as CODE_FILE_RE', () => {
  assert.match(PRE_COMMIT_HOOK, /^#!\/bin\/sh\n/)
  assert.match(PRE_COMMIT_HOOK, /exit 1/)
  for (const p of ['scripts/x.mjs', 'a.js', 'b.cjs', 'c.ts', 'd.tsx', 'e.jsx', 'f.py', 'package.json', 'sub/package-lock.json']) {
    assert.ok(CODE_FILE_RE.test(p), p)
  }
  for (const p of ['data/scouting.md', 'user/profile.yml', 'output/cv.pdf', 'data/packages.json', 'notes.json']) {
    assert.ok(!CODE_FILE_RE.test(p), p)
  }
  assert.equal(PRIVATE_GITIGNORE, '.cache/\n.DS_Store\nnode_modules\n')
  assert.match(PRIVATE_README, /npm run backup/)
  assert.match(PRIVATE_README, /Never put app code here/)
})

// ── status / backup helpers ─────────────────────────────────────────────────

test('countPorcelain, backupMessage, ageDays, formatAge', () => {
  assert.equal(countPorcelain(''), 0)
  assert.equal(countPorcelain(' M data/a.md\n?? data/b.md\n'), 2)
  assert.equal(backupMessage(new Date(2026, 9, 5, 8, 3)), 'backup 2026-10-05 08:03')
  const day = 86400000
  assert.equal(ageDays(0, 3 * day + 5), 3)
  assert.equal(ageDays(null, 1), null)
  assert.equal(formatAge(null), 'never')
  assert.equal(formatAge(0), 'today')
  assert.equal(formatAge(1), '1 day ago')
  assert.equal(formatAge(9), '9 days ago')
})

test('statusProblems lists what is wrong, nothing when healthy', () => {
  assert.match(statusProblems({ exists: false })[0], /private -- init/)
  assert.deepEqual(statusProblems({ exists: true, links: [{ path: 'data', ok: true }], git: { isRepo: true }, ignored: true }), [])
  const p = statusProblems({ exists: true, links: [{ path: 'data', ok: false, state: 'real' }], git: { isRepo: false }, ignored: false })
  assert.equal(p.length, 3)
  assert.match(p[0], /data \(real\)/)
})

// ── running app detection ───────────────────────────────────────────────────

test('findRunningApp: dev Electron from this checkout, minus helpers and our own ancestors', () => {
  const ps = parsePs([
    '  100     1 /work/starpath/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
    '  101   100 /work/starpath/frontend/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process',
    '  200     1 /work/starpath/.claude/worktrees/x/frontend/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
    '  300     1 /Applications/starpath.app/Contents/MacOS/starpath',
    '  400     1 /Applications/Other.app/Contents/Frameworks/Electron Framework.framework/Helpers/crashpad',
    '  500     1 node /work/starpath/frontend/node_modules/.bin/next dev',
    '  600   100 node scripts/private.mjs init --json',
    '  700     1 /Applications/Editor.app/Contents/MacOS/Editor Helper (Plugin) --ms-enable-electron-run-as-node /work/starpath/frontend/node_modules/typescript/lib/tsserver.js',
    '  800     1 /work/starpath/frontend/dist/mac-arm64/starpath.app/Contents/MacOS/starpath',
    '  900     1 node /work/starpath/frontend/node_modules/.bin/concurrently -n next,electron next dev',
    'garbage line',
  ].join('\n'))
  assert.equal(ps.length, 10)
  assert.deepEqual(findRunningApp(ps, { repoRoot: '/work/starpath', selfPid: 9999 }), { pids: [100, 800], packagedPids: [300] })
  // The app spawning `private init` itself is not a reason to refuse.
  assert.deepEqual(findRunningApp(ps, { repoRoot: '/work/starpath', selfPid: 600 }).pids, [800])
})

// ── overrides report ────────────────────────────────────────────────────────

const ov = [
  { rel: 'modes/scouting.append.md', target: 'modes/scouting.md', mode: 'append', valid: true, defaultExists: true, path: '/d/overrides/modes/scouting.append.md' },
  { rel: 'modes/scouting.md', target: 'modes/scouting.md', mode: 'replace', valid: true, defaultExists: true, path: '/d/overrides/modes/scouting.md' },
  { rel: 'templates/cv-template.html', target: 'templates/cv-template.html', mode: 'replace', valid: true, defaultExists: true, path: '/d/overrides/templates/cv-template.html' },
  { rel: 'scripts/scan.mjs', target: 'scripts/scan.mjs', mode: 'replace', valid: false, defaultExists: true, path: '/d/overrides/scripts/scan.mjs' },
]

test('annotateOverrides: drift when the default was committed after the override changed', () => {
  const commits = { 'modes/scouting.md': 2000, 'templates/cv-template.html': 1000 }
  const calls = []
  const out = annotateOverrides(ov, {
    commitTimeFor: (t) => { calls.push(t); return commits[t] ?? null },
    mtimeFor: () => 1500 * 1000,
  })
  assert.deepEqual(out.map((e) => e.drift), [true, true, false, false])
  assert.deepEqual(calls, ['modes/scouting.md', 'templates/cv-template.html'], 'one git lookup per valid target')
  assert.equal(out[0].defaultCommittedAt, new Date(2000 * 1000).toISOString())
  assert.equal(out[3].defaultCommittedAt, null)
})

test('groupOverrides merges replace + append per target', () => {
  const g = groupOverrides(ov.map((e) => ({ ...e, drift: e.target === 'modes/scouting.md' })))
  assert.deepEqual(g.map((x) => [x.target, x.modes.join('+'), x.drift, x.valid]), [
    ['modes/scouting.md', 'replace+append', true, true],
    ['scripts/scan.mjs', 'replace', false, false],
    ['templates/cv-template.html', 'replace', false, true],
  ])
})

test('formatOverridesBrief: nothing when empty, else 1–3 short lines', () => {
  assert.deepEqual(formatOverridesBrief([]), [])
  const lines = formatOverridesBrief(ov.map((e) => ({ ...e, drift: e.target === 'modes/scouting.md' })))
  assert.equal(lines.length, 3)
  assert.equal(lines[0], 'Private overrides active in private/overrides/ (read these instead of / after the repo defaults): modes/scouting.md (replace + append), templates/cv-template.html (replace).')
  assert.equal(lines[1], 'Drift: modes/scouting.md default changed since your override.')
  assert.equal(lines[2], 'Ignored (not overridable): scripts/scan.mjs.')
  const one = formatOverridesBrief([{ ...ov[2], drift: false }], { overridesDir: 'demo/overrides' })
  assert.deepEqual(one, ['Private overrides active in demo/overrides/ (read these instead of / after the repo defaults): templates/cv-template.html (replace).'])
})
