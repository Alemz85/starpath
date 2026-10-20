// Unit tests for scripts/lib/data-root.mjs and scripts/lib/overrides.mjs.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  LINKED_PATHS, linkTargetFor, resolveDataRoot, isPersonalPath, repoRootFrom,
} from './data-root.mjs'
import {
  isOverridable, appendPathFor, resolveSystemFile, composeSystemFile, listOverrides, materializeSystemFile,
} from './overrides.mjs'

const REPO = '/repo'
const has = (...paths) => (p) => paths.includes(p)

test('resolveDataRoot: config wins, then env, then private, then demo (only when allowed)', () => {
  const all = has('/repo/private', '/repo/demo')
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, configured: 'demo', env: { STARPATH_DATA: '/elsewhere' }, exists: all }),
    { root: '/repo/demo', kind: 'demo', source: 'config' })
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, env: { STARPATH_DATA: '/elsewhere' }, exists: all }),
    { root: '/elsewhere', kind: 'external', source: 'env' })
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, env: {}, exists: all }),
    { root: '/repo/private', kind: 'private', source: 'default' })
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, env: {}, exists: has('/repo/demo') }),
    { root: '/repo/private', kind: 'none', source: 'default' })
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, env: {}, exists: has('/repo/demo'), allowDemo: true }),
    { root: '/repo/demo', kind: 'demo', source: 'default' })
})

test('resolveDataRoot: env accepts demo, private and repo-relative paths', () => {
  const none = () => false
  assert.equal(resolveDataRoot({ repoRoot: REPO, env: { STARPATH_DATA: 'demo' }, exists: none }).kind, 'demo')
  assert.equal(resolveDataRoot({ repoRoot: REPO, env: { STARPATH_DATA: 'private' }, exists: none }).kind, 'private')
  assert.deepEqual(resolveDataRoot({ repoRoot: REPO, env: { STARPATH_DATA: './demo' }, exists: none }),
    { root: '/repo/demo', kind: 'demo', source: 'env' })
  assert.equal(resolveDataRoot({ repoRoot: REPO, env: { STARPATH_DATA: '  ' }, exists: has('/repo/private') }).source, 'default')
})

test('linked paths: relative targets point into private/', () => {
  assert.equal(linkTargetFor('data'), 'private/data')
  assert.equal(linkTargetFor('batch/logs'), '../private/batch/logs')
  const byPath = Object.fromEntries(LINKED_PATHS.map((e) => [e.path, e]))
  assert.equal(byPath.user.kind, 'dir')
  assert.equal(byPath['batch/cv-summary.md'].kind, 'file')
  assert.equal(byPath['batch/cv-summary.md'].link, '../private/batch/cv-summary.md')
})

test('isPersonalPath: linked paths and profiles/, never public docs or code', () => {
  for (const p of ['user/cv.md', 'data/scouting.md', './reports/tier-1/x.md', 'interview-prep/a.md',
    'output/cv.pdf', 'jds/x.md', 'batch/tracker-additions/1.tsv', 'batch/cv-summary.md', 'profiles/active', 'data']) {
    assert.equal(isPersonalPath(p), true, p)
  }
  for (const p of ['docs/REPO-GUIDE.md', 'modes/scouting.md', 'batch/batch-prompt.md', 'batch/batch-runner.sh',
    'scripts/scan.mjs', 'datastore/x', 'user-guide.md', '../data/x', '', 'demo/data/scouting.md']) {
    assert.equal(isPersonalPath(p), false, p)
  }
})

test('repoRootFrom finds the checkout that holds CLAUDE.md + scripts/', () => {
  const root = repoRootFrom(import.meta.url)
  assert.ok(root.endsWith('') && !root.includes('/scripts/lib'))
})

test('isOverridable / appendPathFor', () => {
  assert.equal(isOverridable('modes/scouting.md'), true)
  assert.equal(isOverridable('modes/_shared.md'), true)
  assert.equal(isOverridable('batch/batch-prompt.md'), true)
  assert.equal(isOverridable('templates/cv-template.html'), true)
  assert.equal(isOverridable('.claude/skills/career-ops/SKILL.md'), true)
  assert.equal(isOverridable('config/profile.example.yml'), true)
  assert.equal(isOverridable('scripts/scan.mjs'), false)
  assert.equal(isOverridable('modes/scouting.append.md'), false)
  assert.equal(isOverridable('CLAUDE.md'), false)
  assert.equal(appendPathFor('modes/scouting.md'), 'modes/scouting.append.md')
  assert.equal(appendPathFor('templates/cv-template.html'), null)
})

test('resolveSystemFile: replace, append, both, none, not overridable', () => {
  const D = '/data'
  const r1 = resolveSystemFile({ repoRoot: REPO, dataRoot: D, rel: 'modes/scouting.md', exists: () => false })
  assert.deepEqual([r1.path, r1.source, r1.appendPath], ['/repo/modes/scouting.md', 'default', null])
  const r2 = resolveSystemFile({ repoRoot: REPO, dataRoot: D, rel: 'modes/scouting.md', exists: has('/data/overrides/modes/scouting.md') })
  assert.deepEqual([r2.path, r2.source], ['/data/overrides/modes/scouting.md', 'override'])
  const r3 = resolveSystemFile({ repoRoot: REPO, dataRoot: D, rel: 'modes/scouting.md', exists: has('/data/overrides/modes/scouting.append.md') })
  assert.deepEqual([r3.path, r3.source, r3.appendPath], ['/repo/modes/scouting.md', 'default', '/data/overrides/modes/scouting.append.md'])
  const r4 = resolveSystemFile({ repoRoot: REPO, dataRoot: D, rel: 'scripts/scan.mjs', exists: () => true })
  assert.deepEqual([r4.path, r4.source, r4.overridable], ['/repo/scripts/scan.mjs', 'default', false])
  const r5 = resolveSystemFile({ repoRoot: REPO, dataRoot: null, rel: 'modes/scouting.md', exists: () => true })
  assert.equal(r5.source, 'default')
})

test('composeSystemFile + listOverrides against a temp data root', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'overrides-'))
  try {
    const repo = join(tmp, 'repo'); const data = join(tmp, 'private')
    mkdirSync(join(repo, 'modes'), { recursive: true })
    mkdirSync(join(data, 'overrides/modes'), { recursive: true })
    writeFileSync(join(repo, 'modes/scouting.md'), '# Default\n')
    writeFileSync(join(repo, 'modes/pdf.md'), '# PDF default\n')
    writeFileSync(join(data, 'overrides/modes/scouting.append.md'), 'My extra rule.\n')
    writeFileSync(join(data, 'overrides/modes/pdf.md'), '# My PDF\n')
    writeFileSync(join(data, 'overrides/modes/nope.txt'), 'x')

    const c = composeSystemFile({ repoRoot: repo, dataRoot: data, rel: 'modes/scouting.md' })
    assert.equal(c.composed, true)
    assert.match(c.text, /^# Default\n\n<!-- appended from private overrides: modes\/scouting\.append\.md -->\n\nMy extra rule\.\n$/)
    const p = composeSystemFile({ repoRoot: repo, dataRoot: data, rel: 'modes/pdf.md' })
    assert.deepEqual([p.text, p.composed], ['# My PDF\n', false])

    const list = listOverrides({ dataRoot: data, repoRoot: repo })
    assert.deepEqual(list.map((e) => [e.rel, e.target, e.mode, e.valid]), [
      ['modes/nope.txt', 'modes/nope.txt', 'replace', false],
      ['modes/pdf.md', 'modes/pdf.md', 'replace', true],
      ['modes/scouting.append.md', 'modes/scouting.md', 'append', true],
    ])
    assert.deepEqual(listOverrides({ dataRoot: join(tmp, 'missing'), repoRoot: repo }), [])

    // materialize: plain files are returned as-is, composed ones are written to .cache/prompts
    assert.equal(materializeSystemFile({ repoRoot: repo, dataRoot: data, rel: 'modes/pdf.md' }), join(data, 'overrides/modes/pdf.md'))
    const m = materializeSystemFile({ repoRoot: repo, dataRoot: data, rel: 'modes/scouting.md' })
    assert.equal(m, join(data, '.cache/prompts/modes/scouting.md'))
    assert.equal(readFileSync(m, 'utf-8'), c.text)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
