/**
 * leak-gate.test.mjs — end-to-end test of the leak gate's git hooks.
 *
 * Builds a throwaway "public" repo with the real .githooks/ + guard scripts,
 * a fictional private/ folder, and a bare "remote"; installs the hooks there
 * (never in the real repo) and checks that:
 *   - a push whose range adds a private term is rejected, the output shows
 *     only the masked term, and nothing reaches the remote;
 *   - amending the commit to clean content lets the push through;
 *   - commit-msg and pre-commit block early (term in message, personal path);
 *   - the gate works from a linked worktree (finds the main checkout's private/).
 *
 * Run: node --test scripts/leak-gate.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMPANY = 'Quillfeather Dynamics'
const ROLE = 'Orbital Logistics Analyst (Lyon)'

// Never touch the real repo or the user's git config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
delete process.env.STARPATH_DATA
const SCRATCH = mkdtempSync(join(tmpdir(), 'leak-gate-'))
writeFileSync(join(SCRATCH, 'gitconfig'), '')
const ENV = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(SCRATCH, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
}

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, env: ENV, encoding: 'utf-8' })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}
const git = (cwd, ...args) => sh(cwd, 'git', args)
function ok(r, what) {
  assert.equal(r.status, 0, `${what} failed:\n${r.out}`)
  return r
}
function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

const SHIPPED = [
  '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push',
  'scripts/install-hooks.mjs',
  'scripts/lib/hygiene-guard.mjs', 'scripts/lib/leak-patterns.mjs', 'scripts/lib/data-root.mjs',
]

let pub
let remote

before(() => {
  pub = join(SCRATCH, 'public')
  remote = join(SCRATCH, 'remote.git')
  mkdirSync(pub)
  ok(git(pub, 'init', '-q', '-b', 'main'), 'init')
  for (const rel of SHIPPED) {
    mkdirSync(dirname(join(pub, rel)), { recursive: true })
    copyFileSync(join(REPO, rel), join(pub, rel))
  }
  for (const h of ['pre-commit', 'commit-msg', 'pre-push']) chmodSync(join(pub, '.githooks', h), 0o644)
  write(pub, '.gitignore', '/private/\n/user\n/data\n/reports\n')
  write(pub, 'README.md', '# Public demo\n')
  // Fictional private data: one tracker row.
  write(pub, 'private/data/applications.md', [
    '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|----------|--------|-------|',
    `| 1 | 2026-05-05 | ${COMPANY} | ${ROLE} | M8 E7 | Applied | ❌ | | | |`,
    '',
  ].join('\n'))
  ok(sh(SCRATCH, 'git', ['init', '-q', '--bare', remote]), 'init bare')
  ok(git(pub, 'remote', 'add', 'origin', remote), 'remote add')
})

after(() => rmSync(SCRATCH, { recursive: true, force: true }))

describe('leak gate hooks (temp public repo + bare remote)', () => {
  it('install-hooks: --check fails before, install sets core.hooksPath and chmods, --check passes after', () => {
    const installer = join(pub, 'scripts', 'install-hooks.mjs')
    assert.equal(sh(pub, process.execPath, [installer, '--check']).status, 1)
    ok(sh(pub, process.execPath, [installer]), 'install')
    assert.equal(git(pub, 'config', '--get', 'core.hooksPath').out.trim(), '.githooks')
    ok(sh(pub, process.execPath, [installer, '--check']), 'check')
  })

  it('a clean first push goes through', () => {
    ok(git(pub, 'add', '-A'), 'add')
    ok(git(pub, 'commit', '-q', '-m', 'chore: initial public files'), 'commit')
    ok(git(pub, 'push', '-q', 'origin', 'main'), 'push')
  })

  it('pre-commit blocks a staged private term (masked output)', () => {
    write(pub, 'docs/notes.md', `Notes\nCall with ${COMPANY} about the ${ROLE} role.\n`)
    ok(git(pub, 'add', 'docs/notes.md'), 'add')
    const r = git(pub, 'commit', '-q', '-m', 'docs: notes')
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /docs\/notes\.md:2 {2}\[company\+role\] {2}Q·····s \+ O·····n/)
    assert.match(r.out, /Commit blocked/)
    assert.ok(!r.out.includes('Quillfeather'), r.out)
  })

  it('pre-push blocks a range that adds a private term; nothing reaches the remote', () => {
    // The commit gets in with --no-verify (e.g. made before the hooks were installed).
    ok(git(pub, 'commit', '-q', '--no-verify', '-m', 'docs: notes'), 'commit --no-verify')
    const r = git(pub, 'push', 'origin', 'main')
    assert.notEqual(r.status, 0, 'push must be rejected')
    assert.match(r.out, /\[company\+role\] {2}Q·····s \+ O·····n/)
    assert.match(r.out, /Push blocked: personal data in the push range\. Fix the commits \(amend\/rebase\) — never use --no-verify\./)
    for (const s of ['Quillfeather', 'Orbital Logistics', COMPANY]) assert.ok(!r.out.includes(s), `output leaks "${s}":\n${r.out}`)
    const remoteLog = sh(SCRATCH, 'git', ['--git-dir', remote, 'log', '-p', 'main'])
    assert.ok(!remoteLog.out.includes('Quillfeather'))
  })

  it('amending the commit to clean content lets the push through', () => {
    write(pub, 'docs/notes.md', 'Notes\nCall with a logistics company about an analyst role.\n')
    ok(git(pub, 'add', 'docs/notes.md'), 'add')
    ok(git(pub, 'commit', '-q', '--amend', '-m', 'docs: notes'), 'amend')
    const r = ok(git(pub, 'push', 'origin', 'main'), 'push after amend')
    assert.match(r.out, /0 blocking/)
  })

  it('commit-msg blocks a private term in the message', () => {
    write(pub, 'docs/more.md', 'clean\n')
    ok(git(pub, 'add', 'docs/more.md'), 'add')
    const r = git(pub, 'commit', '-q', '-m', `docs: follow up with ${COMPANY}`)
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /commit message:1 {2}\[company\] {2}Q·····s/)
    assert.ok(!r.out.includes('Quillfeather'), r.out)
    ok(git(pub, 'commit', '-q', '-m', 'docs: follow up'), 'clean message')
  })

  it('pre-commit refuses personal paths even when force-added', () => {
    write(pub, 'data/applications.md', 'anything\n')
    ok(git(pub, 'add', '-f', 'data/applications.md'), 'add -f')
    const r = git(pub, 'commit', '-q', '-m', 'oops')
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /data\/…  \[personal-path\]/)
    ok(git(pub, 'reset', '-q'), 'reset')
    rmSync(join(pub, 'data'), { recursive: true, force: true })
  })

  it('works from a linked worktree: the main checkout\'s private/ supplies the terms', () => {
    const wt = join(SCRATCH, 'wt')
    ok(git(pub, 'worktree', 'add', '-q', '-b', 'feat/wt', wt), 'worktree add')
    write(wt, 'docs/wt.md', `${COMPANY}\n`)
    ok(git(wt, 'add', 'docs/wt.md'), 'add')
    const blocked = git(wt, 'commit', '-q', '-m', 'docs: wt')
    assert.notEqual(blocked.status, 0, blocked.out)
    assert.match(blocked.out, /docs\/wt\.md:1 {2}\[company\] {2}Q·····s/)
    ok(git(wt, 'commit', '-q', '--no-verify', '-m', 'docs: wt'), 'commit --no-verify')
    const push = git(wt, 'push', 'origin', 'feat/wt')
    assert.notEqual(push.status, 0, push.out)
    assert.match(push.out, /\(main worktree\)/)
    assert.ok(!push.out.includes('Quillfeather'))
  })

  it('deleting a remote branch is not scanned', () => {
    ok(git(pub, 'push', '-q', 'origin', 'main:refs/heads/tmp-branch'), 'push tmp')
    ok(git(pub, 'push', '-q', 'origin', ':refs/heads/tmp-branch'), 'delete tmp')
  })
})
