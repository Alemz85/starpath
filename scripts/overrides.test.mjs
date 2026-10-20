// Integration tests for scripts/overrides.mjs — list / --brief / resolve in a
// mkdtemp mini-repo with real git (commit dates drive the drift check).
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gatherOverrideReport } from './overrides.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'overrides.mjs')

let root
let configDir
let ENV

const COMMIT_TS = 1_800_000_000 // the defaults' commit time (seconds)

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    env: { ...ENV, GIT_AUTHOR_DATE: `@${COMMIT_TS} +0000`, GIT_COMMITTER_DATE: `@${COMMIT_TS} +0000` },
    encoding: 'utf-8',
  }).trim()
}

function write(rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { env: ENV, encoding: 'utf-8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'overrides-cli-'))
  configDir = mkdtempSync(join(tmpdir(), 'overrides-gitconfig-'))
  const emptyConfig = join(configDir, 'gitconfig')
  writeFileSync(emptyConfig, '')
  ENV = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STARPATH_DATA']) delete ENV[k]
  write('CLAUDE.md', '# fixture\n')
  write('modes/scouting.md', '# Scouting (default)\n')
  write('templates/cv-template.html', '<html>default</html>\n')
  write('batch/batch-prompt.md', '# Batch prompt (default)\n')
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Dana Fox')
  git('config', 'user.email', 'dana.fox@example.test')
  git('add', '-A')
  git('commit', '-q', '-m', 'defaults')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

const setMtime = (rel, seconds) => utimesSync(join(root, rel), seconds, seconds)

test('no private root: brief is silent, list says so, resolve prints the default', () => {
  const brief = run('--brief')
  assert.equal(brief.code, 0)
  assert.equal(brief.stdout, '')
  const list = run('list')
  assert.equal(list.code, 0)
  assert.match(list.stdout, /No data root yet/)
  const json = JSON.parse(run('--json').stdout)
  assert.deepEqual(json, { ok: true, dataRoot: null, overridesDir: null, overrides: [] })
  const resolved = run('resolve', 'batch/batch-prompt.md')
  assert.equal(resolved.code, 0)
  assert.equal(resolved.stdout.trim(), join(root, 'batch/batch-prompt.md'))
})

test('private root without overrides: brief stays silent', () => {
  mkdirSync(join(root, 'private'), { recursive: true })
  assert.equal(run('--brief').stdout, '')
  assert.match(run().stdout, /No overrides in private\/overrides\//)
})

test('list --json reports replace / append / invalid entries with drift', () => {
  write('private/overrides/modes/scouting.append.md', '## My extra rules\n')
  write('private/overrides/templates/cv-template.html', '<html>mine</html>\n')
  write('private/overrides/scripts/scan.mjs', '// not overridable\n')
  setMtime('private/overrides/modes/scouting.append.md', COMMIT_TS - 3600) // older than the default → drift
  setMtime('private/overrides/templates/cv-template.html', COMMIT_TS + 3600) // newer → no drift

  const { code, stdout } = run('list', '--json')
  assert.equal(code, 0)
  const json = JSON.parse(stdout)
  assert.equal(json.ok, true)
  assert.equal(json.dataRoot, join(root, 'private'))
  assert.equal(json.overridesDir, join(root, 'private', 'overrides'))
  const by = Object.fromEntries(json.overrides.map((e) => [e.rel, e]))
  assert.deepEqual(Object.keys(by).sort(), ['modes/scouting.append.md', 'scripts/scan.mjs', 'templates/cv-template.html'])
  assert.equal(by['modes/scouting.append.md'].mode, 'append')
  assert.equal(by['modes/scouting.append.md'].target, 'modes/scouting.md')
  assert.equal(by['modes/scouting.append.md'].drift, true)
  assert.equal(by['modes/scouting.append.md'].defaultCommittedAt, new Date(COMMIT_TS * 1000).toISOString())
  assert.equal(by['templates/cv-template.html'].mode, 'replace')
  assert.equal(by['templates/cv-template.html'].drift, false)
  assert.equal(by['scripts/scan.mjs'].valid, false)
  assert.equal(by['scripts/scan.mjs'].drift, false)

  const human = run('list').stdout
  assert.match(human, /DRIFT: default changed since your override/)
  assert.match(human, /NOT OVERRIDABLE/)
  assert.match(human, /git log -p -- modes\/scouting\.md/)
})

test('--brief prints 1–3 short lines for the SessionStart hook', () => {
  const { code, stdout } = run('--brief')
  assert.equal(code, 0)
  assert.deepEqual(stdout.trim().split('\n'), [
    'Private overrides active in private/overrides/ (read these instead of / after the repo defaults): modes/scouting.md (append), templates/cv-template.html (replace).',
    'Drift: modes/scouting.md default changed since your override.',
    'Ignored (not overridable): scripts/scan.mjs.',
  ])
})

test('--brief never fails, even on a broken root', () => {
  const r = spawnSync(process.execPath, [CLI, '--brief', '--root', join(root, 'does-not-exist')], { env: ENV, encoding: 'utf-8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('resolve: replacement path as-is, append composed under .cache/prompts', () => {
  const replaced = run('resolve', 'templates/cv-template.html')
  assert.equal(replaced.code, 0)
  assert.equal(replaced.stdout.trim(), join(root, 'private/overrides/templates/cv-template.html'))

  const composed = run('resolve', 'modes/scouting.md')
  assert.equal(composed.code, 0)
  const path = composed.stdout.trim()
  assert.equal(path, join(root, 'private/.cache/prompts/modes/scouting.md'))
  const text = readFileSync(path, 'utf-8')
  assert.ok(text.startsWith('# Scouting (default)\n'))
  assert.ok(text.endsWith('## My extra rules\n'))

  const untouched = run('resolve', 'batch/batch-prompt.md')
  assert.equal(untouched.stdout.trim(), join(root, 'batch/batch-prompt.md'))

  const usage = run('resolve')
  assert.equal(usage.code, 1)
  assert.equal(usage.stdout, '', 'nothing on stdout, so `$(… || echo default)` falls back cleanly')
})

test('STARPATH_DATA points the report at another data root', () => {
  const ext = join(root, 'elsewhere')
  write('elsewhere/overrides/modes/scouting.md', '# Scouting (mine)\n')
  const report = gatherOverrideReport({ repoRoot: root, dataRoot: ext })
  assert.deepEqual(report.entries.map((e) => [e.rel, e.mode, e.valid]), [['modes/scouting.md', 'replace', true]])
  const r = spawnSync(process.execPath, [CLI, 'resolve', 'modes/scouting.md', '--root', root], {
    env: { ...ENV, STARPATH_DATA: ext }, encoding: 'utf-8',
  })
  assert.equal(r.stdout.trim(), join(ext, 'overrides/modes/scouting.md'))
  assert.deepEqual(gatherOverrideReport({ repoRoot: root, dataRoot: null }), { dataRoot: null, overridesDir: null, entries: [] })
})
