// Integration tests for scripts/private.mjs — real filesystem + real git in
// mkdtemp mini-repos, driving the CLI end-to-end via `--root`.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.
//
// Git runs hermetically (empty global config, no system config); each mini
// repo sets its own fictional identity. Remotes are local bare repos.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync, statSync, readdirSync, realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LINKED_PATHS } from './lib/data-root.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'private.mjs')
const GITIGNORE = readFileSync(join(HERE, '..', '.gitignore'), 'utf-8')

let sandbox
let GIT_ENV

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'private-cli-'))
  const emptyConfig = join(sandbox, 'gitconfig')
  writeFileSync(emptyConfig, '')
  GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STARPATH_DATA']) delete GIT_ENV[k]
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim()
}

/** Run the CLI against `root`; returns { code, json, stdout }. */
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { env: GIT_ENV, encoding: 'utf-8' })
  let json = null
  if (args.includes('--json')) {
    try { json = JSON.parse(r.stdout.trim()) } catch { /* asserted by callers */ }
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

/** A public mini-repo: git, fictional identity, the real .gitignore, batch/ system files. */
function makeRepo(name) {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Dana Fox')
  git(root, 'config', 'user.email', 'dana.fox@example.test')
  writeFileSync(join(root, '.gitignore'), GITIGNORE)
  write(root, 'batch/README.md', '# batch\n')
  write(root, 'CLAUDE.md', '# fixture\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'fixture')
  return root
}

const isLink = (root, rel) => lstatSync(join(root, rel)).isSymbolicLink()
const linkOf = (root, rel) => readlinkSync(join(root, rel))
const read = (root, rel) => readFileSync(join(root, rel), 'utf-8')

// ── Legacy checkout → private root ──────────────────────────────────────────

const CV = '# Dana Fox\n\nAnalyst at Northwind Analytics (fixture)\n'
const SCOUTING = '# Scouting Tracker\n\n| # | Company |\n|---|---|\n| 1 | Fabrikam |\n'
const APPS = '# Applications Tracker\n\n| # | Company |\n|---|---|\n| 1 | Contoso |\n'

let repo

test('setup: a legacy checkout with real folders, placeholders and a profile layout', () => {
  repo = makeRepo('legacy')
  write(repo, 'user/cv.md', CV)
  write(repo, 'data/scouting.md', SCOUTING)
  write(repo, 'data/companies/.gitkeep', '')
  write(repo, 'reports/tier-1/Fabrikam - Analyst.md', '# Fabrikam - Analyst\n')
  write(repo, 'output/cv-dana-fox.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))
  write(repo, 'batch/batch-state.tsv', 'id\turl\tstatus\n1\thttps://jobs.example.test/1\tcompleted\n')
  write(repo, 'batch/logs/.gitkeep', '')
  // Multi-profile layout: canonical paths are relative links into profiles/.
  write(repo, 'profiles/active', 'career\n')
  write(repo, 'profiles/career/data/applications.md', APPS)
  symlinkSync('../profiles/career/data/applications.md', join(repo, 'data/applications.md'))
  mkdirSync(join(repo, 'profiles/career/reports/tier-2'), { recursive: true })
  write(repo, 'profiles/career/reports/tier-2/Contoso - Planner.md', '# Contoso - Planner\n')
  symlinkSync('../profiles/career/reports/tier-2', join(repo, 'reports/tier-2'))
  assert.equal(read(repo, 'data/applications.md'), APPS)
})

test('init --dry-run plans the migration and changes nothing', () => {
  const { code, json } = run(repo, 'init', '--dry-run', '--json')
  assert.equal(code, 0)
  assert.equal(json.ok, true)
  assert.equal(json.dryRun, true)
  assert.deepEqual(json.moved, [
    { path: 'user', files: 1 },
    { path: 'data', files: 2 },
    { path: 'reports', files: 1 },
    { path: 'output', files: 1 },
    { path: 'batch/logs', files: 1 },
    { path: 'batch/batch-state.tsv', files: 1 },
    { path: 'profiles', files: 3 },
  ])
  assert.equal(json.manifest.files, 10)
  assert.equal(json.manifest.path, null)
  assert.equal(json.git.wouldInitialise, true)
  assert.deepEqual(json.conflicts, [])
  assert.ok(!existsSync(join(repo, 'private')), 'dry run creates nothing')
  assert.ok(!isLink(repo, 'data'))
})

test('init refuses while eval output is unmerged (guards), unless --force', () => {
  write(repo, 'batch/tracker-additions/001-fabrikam.tsv', 'fixture\n')
  const { code, json } = run(repo, 'init', '--json')
  assert.equal(code, 1)
  assert.equal(json.ok, false)
  assert.equal(json.error, 'guards')
  assert.deepEqual(json.guardFailures, ['unmerged TSVs in batch/tracker-additions (1 file)'])
  assert.ok(!existsSync(join(repo, 'private')))
  rmSync(join(repo, 'batch/tracker-additions'), { recursive: true })
})

test('init moves, links, verifies, drops placeholders and makes the first commit', () => {
  const { code, json, stdout } = run(repo, 'init', '--json')
  assert.equal(code, 0, stdout)
  assert.equal(json.ok, true)
  assert.equal(json.repoRoot, repo)
  assert.equal(json.privateRoot, join(repo, 'private'))
  assert.deepEqual(json.moved.map((m) => m.path), ['user', 'data', 'reports', 'output', 'batch/logs', 'batch/batch-state.tsv', 'profiles'])
  assert.deepEqual(json.linked, LINKED_PATHS.map((e) => e.path))
  assert.deepEqual(json.created, ['interview-prep', 'jds', 'batch/tracker-additions', 'batch/scouting-additions', 'batch/jobspy-merged'])
  assert.deepEqual(json.conflicts, [])
  assert.equal(json.manifest.verified, true)
  assert.equal(json.manifest.files, 10)
  assert.ok(json.manifest.path.startsWith(join(repo, 'private', '.cache', 'migration-')))
  const manifest = JSON.parse(readFileSync(json.manifest.path, 'utf-8'))
  assert.equal(manifest.verified, true)
  assert.ok(manifest.records.some((r) => r.path === 'data/scouting.md' && r.sha256.length === 64))
  assert.deepEqual(json.placeholdersRemoved.sort(), ['private/batch/logs/.gitkeep', 'private/data/companies/.gitkeep'])
  assert.equal(json.git.initialised, true)
  assert.equal(json.git.committed, true)
  assert.match(json.git.commit, /^[0-9a-f]{40}$/)

  // Every linked path is a relative link, the data lives in private/.
  for (const e of LINKED_PATHS) {
    assert.ok(isLink(repo, e.path), e.path)
    assert.equal(linkOf(repo, e.path), e.link)
  }
  assert.equal(linkOf(repo, 'batch/logs'), '../private/batch/logs')
  assert.ok(!existsSync(join(repo, 'profiles')), 'profiles/ has no repo-root link')
  assert.ok(statSync(join(repo, 'private/profiles/career')).isDirectory())
  assert.equal(read(repo, 'private/user/cv.md'), CV)
  assert.equal(read(repo, 'user/cv.md'), CV, 'readable through the link')
  assert.deepEqual([...readFileSync(join(repo, 'output/cv-dana-fox.pdf'))], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  assert.ok(read(repo, 'batch/batch-state.tsv').includes('completed'))
  assert.ok(existsSync(join(repo, 'private/batch')))
  assert.ok(!existsSync(join(repo, 'private/batch/cv-summary.md')), 'file links are created without a target')

  // Profile links inside the moved folders still resolve (profiles/ moved alongside).
  assert.equal(linkOf(repo, 'private/data/applications.md'), '../profiles/career/data/applications.md')
  assert.equal(read(repo, 'data/applications.md'), APPS)
  assert.ok(existsSync(join(repo, 'reports/tier-2/Contoso - Planner.md')))

  // The private repo: own history, fictional identity mirrored from the public repo, hook on.
  const priv = join(repo, 'private')
  assert.equal(realpathSync(git(priv, 'rev-parse', '--show-toplevel')), realpathSync(priv), 'its own repo, not the public one')
  assert.equal(git(priv, 'log', '-1', '--format=%s'), 'Initial import of personal data')
  assert.equal(git(priv, 'log', '-1', '--format=%an <%ae>'), 'Dana Fox <dana.fox@example.test>')
  assert.equal(git(priv, 'config', 'core.hooksPath'), '.githooks')
  assert.ok(statSync(join(priv, '.githooks/pre-commit')).mode & 0o100, 'hook is executable')
  const tracked = git(priv, 'ls-files').split('\n')
  for (const p of ['user/cv.md', 'data/scouting.md', 'README.md', '.gitignore', '.githooks/pre-commit', 'profiles/active']) {
    assert.ok(tracked.includes(p), p)
  }
  assert.ok(!tracked.some((p) => p.startsWith('.cache/')), '.cache/ is not committed')
  assert.equal(git(priv, 'remote'), '', 'init never adds a remote')

  // The public repo sees none of it.
  assert.equal(git(repo, 'status', '--porcelain'), '')
})

test('init again: everything already in place', () => {
  const { code, json } = run(repo, 'init', '--json')
  assert.equal(code, 0)
  assert.equal(json.ok, true)
  assert.deepEqual(json.moved, [])
  assert.deepEqual(json.linked, [])
  assert.deepEqual(json.created, [])
  assert.deepEqual(json.conflicts, [])
  assert.equal(json.git.initialised, false)
  assert.equal(json.manifest.path, null)
  assert.equal(json.skipped.length, LINKED_PATHS.length + 1)
  const human = run(repo, 'init')
  assert.match(human.stdout, /Everything is already in place/)
})

test('status --json reports links, the private repo and the ignore rule', () => {
  const { code, json } = run(repo, 'status', '--json')
  assert.equal(code, 0)
  assert.equal(json.ok, true)
  assert.equal(json.healthy, true)
  assert.equal(json.exists, true)
  assert.equal(json.linksOk, true)
  assert.equal(json.links.length, LINKED_PATHS.length)
  assert.deepEqual(json.links[0], {
    path: 'user', kind: 'dir', expected: 'private/user', state: 'linked', target: 'private/user', privateExists: true, ok: true,
  })
  assert.equal(json.dataRoot.kind, 'private')
  assert.equal(json.git.isRepo, true)
  assert.equal(json.git.branch, 'main')
  assert.equal(json.git.remote, null)
  assert.equal(json.git.uncommitted, 0)
  assert.equal(json.git.lastCommit.ageDays, 0)
  assert.equal(json.git.lastCommit.subject, 'Initial import of personal data')
  assert.equal(json.ignored, true)
  assert.deepEqual(json.problems, [])
})

test('backup --no-push commits only when something changed', () => {
  write(repo, 'data/pipeline.md', '# Pipeline\n\n- [ ] https://jobs.example.test/2 | Fabrikam | Analyst\n')
  const first = run(repo, 'backup', '--no-push', '--json')
  assert.equal(first.code, 0)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.committed, true)
  assert.equal(first.json.changes, 1)
  assert.match(first.json.message, /^backup \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(first.json.pushSkipped, 'no-push')
  assert.equal(git(join(repo, 'private'), 'log', '-1', '--format=%H'), first.json.commit)

  const again = run(repo, 'backup', '--no-push', '--json')
  assert.equal(again.code, 0)
  assert.equal(again.json.committed, false)
  assert.equal(again.json.commit, null)
})

test('backup without a remote says how to add one', () => {
  write(repo, 'data/pipeline.md', '# Pipeline\n')
  const { code, json, } = run(repo, 'backup', '-m', 'weekly tidy', '--json')
  assert.equal(code, 0)
  assert.equal(json.committed, true)
  assert.equal(json.message, 'weekly tidy')
  assert.equal(json.pushSkipped, 'no-remote')
  assert.equal(json.hint, 'git -C private remote add origin <url> && npm run backup')
})

test('backup pushes to a remote, setting upstream on the first push', () => {
  const bare = join(sandbox, 'remote.git')
  git(sandbox, 'init', '-q', '--bare', bare)
  git(join(repo, 'private'), 'remote', 'add', 'origin', bare)
  const first = run(repo, 'backup', '--json')
  assert.equal(first.code, 0, first.stdout + first.stderr)
  assert.equal(first.json.pushed, true)
  assert.equal(first.json.committed, false, 'nothing new, but unpushed history goes up')
  assert.equal(git(bare, 'rev-parse', 'main'), git(join(repo, 'private'), 'rev-parse', 'HEAD'))

  write(repo, 'interview-prep/story-bank.md', '# Stories\n')
  const second = run(repo, 'backup', '--json')
  assert.equal(second.code, 0)
  assert.equal(second.json.committed, true)
  assert.equal(second.json.pushed, true)
  assert.equal(git(bare, 'rev-parse', 'main'), second.json.commit)
  const status = run(repo, 'status', '--json').json
  assert.equal(status.git.remote, bare)
  assert.equal(status.git.unpushed, 0)
})

test('the private repo refuses code files', () => {
  write(repo, 'data/helper.mjs', 'export default 1\n')
  const { code, json } = run(repo, 'backup', '--no-push', '--json')
  assert.equal(code, 1)
  assert.equal(json.error, 'commit')
  assert.match(json.message, /refusing to commit code files/)
  git(join(repo, 'private'), 'reset', '-q')
  rmSync(join(repo, 'private/data/helper.mjs'))
})

test('link repairs missing and dangling links, never moves a real folder', () => {
  unlinkSync(join(repo, 'jds'))
  unlinkSync(join(repo, 'output'))
  symlinkSync('../gone/output', join(repo, 'output'))
  unlinkSync(join(repo, 'batch/cv-summary.md'))
  unlinkSync(join(repo, 'interview-prep'))
  write(repo, 'interview-prep/Fabrikam - Analyst.md', '# prep written while the link was missing\n')

  const { code, json } = run(repo, 'link', '--json')
  assert.equal(code, 1, 'the shadow folder needs attention')
  assert.deepEqual(json.linked.sort(), ['batch/cv-summary.md', 'jds', 'output'])
  assert.deepEqual(json.conflicts.map((c) => c.path), ['interview-prep'])
  assert.match(json.conflicts[0].reason, /shadows private\/interview-prep/)
  assert.equal(linkOf(repo, 'output'), 'private/output')
  assert.equal(linkOf(repo, 'jds'), 'private/jds')
  assert.ok(!isLink(repo, 'interview-prep'), 'the real folder is left alone')
  assert.ok(existsSync(join(repo, 'interview-prep/Fabrikam - Analyst.md')))

  const status = run(repo, 'status', '--json').json
  assert.equal(status.healthy, false)
  assert.equal(status.links.find((l) => l.path === 'interview-prep').state, 'real')

  // Resolve by hand (merge into private/), then link again.
  const moved = join(repo, 'private/interview-prep/Fabrikam - Analyst.md')
  writeFileSync(moved, read(repo, 'interview-prep/Fabrikam - Analyst.md'))
  rmSync(join(repo, 'interview-prep'), { recursive: true })
  const fixed = run(repo, 'link', '--json')
  assert.equal(fixed.code, 0)
  assert.deepEqual(fixed.json.linked, ['interview-prep'])
  assert.equal(run(repo, 'status', '--json').json.healthy, true)
})

// ── Conflicts, wrong links, link breaks ─────────────────────────────────────

test('init: a path present in both places is a conflict; the rest migrates', () => {
  const r = makeRepo('conflict')
  write(r, 'data/scouting.md', 'root copy\n')
  write(r, 'private/data/scouting.md', 'private copy\n')
  write(r, 'user/cv.md', CV)
  const { code, json } = run(r, 'init', '--json')
  assert.equal(code, 1)
  assert.equal(json.ok, false)
  assert.equal(json.error, 'conflicts')
  assert.deepEqual(json.conflicts.map((c) => c.path), ['data'])
  assert.equal(read(r, 'data/scouting.md'), 'root copy\n', 'never merged or overwritten')
  assert.equal(read(r, 'private/data/scouting.md'), 'private copy\n')
  assert.ok(isLink(r, 'user'))
  assert.equal(json.git.initialised, true, 'the data that did move is committed')
})

test('init: a wrong link refuses without --force and is re-pointed with it', () => {
  const r = makeRepo('wrong-link')
  mkdirSync(join(r, 'elsewhere/user'), { recursive: true })
  write(r, 'elsewhere/user/cv.md', CV)
  symlinkSync('elsewhere/user', join(r, 'user'))
  const plain = run(r, 'init', '--json')
  assert.equal(plain.code, 1)
  assert.equal(plain.json.conflicts[0].path, 'user')
  assert.match(plain.json.conflicts[0].reason, /--force/)
  assert.equal(linkOf(r, 'user'), 'elsewhere/user')

  const forced = run(r, 'init', '--force', '--json')
  assert.equal(forced.code, 0, forced.stdout)
  assert.equal(linkOf(r, 'user'), 'private/user')
  assert.ok(forced.json.warnings.some((w) => w.includes('re-pointed user')))
  assert.ok(existsSync(join(r, 'elsewhere/user/cv.md')), 'nothing behind the old target is touched')
})

test('init refuses when a link inside a moved folder would stop resolving', () => {
  const r = makeRepo('link-break')
  write(r, 'templates/cv-template.html', '<html></html>\n')
  write(r, 'output/notes.md', 'fixture\n')
  symlinkSync('../templates/cv-template.html', join(r, 'output/template.html'))
  const { code, json } = run(r, 'init', '--json')
  assert.equal(code, 1)
  assert.equal(json.error, 'link-breaks')
  assert.deepEqual(json.linkBreaks.map((b) => b.path), ['output/template.html'])
  assert.ok(!existsSync(join(r, 'private')), 'refused before anything moved')
})

test('init warns when the public repo still tracks files it moves', () => {
  const r = makeRepo('tracked')
  write(r, 'data/col-cache.tsv', 'city\tbaseline_eur\nLyon\t1\n')
  git(r, 'add', '-f', 'data/col-cache.tsv')
  git(r, 'commit', '-q', '-m', 'legacy tracked cache')
  const { code, json } = run(r, 'init', '--json')
  assert.equal(code, 0)
  assert.ok(json.warnings.some((w) => /still tracks 1 file under data/.test(w) && /git rm -r --cached/.test(w)), json.warnings.join('\n'))
  assert.equal(read(r, 'data/col-cache.tsv'), 'city\tbaseline_eur\nLyon\t1\n')
})

test('backup and link refuse without a private root', () => {
  const r = makeRepo('bare-checkout')
  const b = run(r, 'backup', '--json')
  assert.equal(b.code, 1)
  assert.equal(b.json.error, 'not-initialised')
  const l = run(r, 'link', '--json')
  assert.equal(l.code, 1)
  assert.equal(l.json.error, 'no-private-root')
  const s = run(r, 'status', '--json')
  assert.equal(s.code, 0)
  assert.equal(s.json.exists, false)
  assert.equal(s.json.healthy, false)
  assert.equal(s.json.git.isRepo, false, 'never mistakes the public repo for the private one')
  assert.equal(s.json.ignored, true)
  assert.deepEqual(readdirSync(r).sort(), ['.git', '.gitignore', 'CLAUDE.md', 'batch'])
})

test('a fresh checkout: init creates private/ with every folder and link', () => {
  const r = makeRepo('fresh')
  const { code, json } = run(r, 'init', '--json')
  assert.equal(code, 0, JSON.stringify(json))
  assert.deepEqual(json.moved, [])
  assert.equal(json.linked.length, LINKED_PATHS.length)
  assert.equal(json.git.committed, true)
  write(r, 'user/profile.yml', 'name: Dana Fox\n')
  assert.ok(existsSync(join(r, 'private/user/profile.yml')), 'onboarding writes land in private/')
  write(r, 'batch/cv-summary.md', '# summary\n')
  assert.ok(existsSync(join(r, 'private/batch/cv-summary.md')), 'file links write through')
  assert.equal(git(r, 'status', '--porcelain'), '')
})
