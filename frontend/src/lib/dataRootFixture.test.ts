// End-to-end check of the main process's data-root plumbing against a tiny
// throwaway checkout on disk: the repo's real scripts/lib/data-root.mjs is
// copied in, next to a fictional demo/ dataset. Covers what the pure tests
// can't: the runtime import, the existence probes, and the chat move.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeDataRoot, moveChatFolder, rootContext, toInfo } from '../../electron/dataRoot'
import { chatDirFor, planChatMigration, resolveAppPath } from './dataRootMain'

const REAL_REPO = fileURLToPath(new URL('../../..', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starpath-dataroot-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function write(rel: string, text: string, base = tmp): void {
  const file = path.join(base, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf-8')
}

function makeRepo(name: string, opts: { demo?: boolean; private?: boolean; legacy?: boolean } = {}): string {
  const repo = path.join(tmp, name)
  write('CLAUDE.md', '# fixture\n', repo)
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true })
  fs.copyFileSync(path.join(REAL_REPO, 'scripts/lib/data-root.mjs'), path.join(repo, 'scripts/lib/data-root.mjs'))
  if (opts.demo) {
    write('demo/user/profile.yml', 'candidate:\n  full_name: Dana Example\n  location: Lyon\n', repo)
    write('demo/data/applications.md', '| # | Date | Company | Role | Score | Status | PDF | Deadline | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 2026-09-01 | Northwind Analytics | Data Analyst | W7.9 E6.1 | Applied | ❌ | — | — | fixture |\n', repo)
    write('demo/reports/tier-2/Fabrikam - Product Analyst.md', '# Fabrikam — Product Analyst\n\n**URL:** https://jobs.example.test/fabrikam/1\n', repo)
  }
  if (opts.private) write('private/data/applications.md', '| # | Date | Company | Role |\n', repo)
  if (opts.legacy) write('user/cv.md', '# CV\n', repo)
  return repo
}

test('no private root: kind none, repo-relative, legacy data counts as own data', async () => {
  const repo = makeRepo('legacy', { demo: true, legacy: true })
  const s = await computeDataRoot(repo, null, {})
  assert.equal(s.kind, 'none')
  assert.equal(s.demoAvailable, true)
  assert.equal(s.privateExists, false)
  assert.equal(s.ownDataAvailable, true)
  const r = resolveAppPath(rootContext(s)!, 'user/cv.md')
  assert.equal(r?.abs, path.join(repo, 'user/cv.md'))
})

test('private root: personal paths land in private/, system paths in the repo', async () => {
  const repo = makeRepo('migrated', { demo: true, private: true })
  const s = await computeDataRoot(repo, null, {})
  assert.equal(s.kind, 'private')
  assert.equal(s.root, path.join(repo, 'private'))
  const ctx = rootContext(s)!
  assert.equal(resolveAppPath(ctx, 'data/applications.md')?.abs, path.join(repo, 'private/data/applications.md'))
  assert.equal(resolveAppPath(ctx, 'CLAUDE.md')?.abs, path.join(repo, 'CLAUDE.md'))
  assert.deepEqual(toInfo(s), {
    root: path.join(repo, 'private'), kind: 'private', source: 'default', repoPath: repo,
    demoAvailable: true, privateExists: true, ownDataAvailable: true,
  })
})

test('demo mode serves the fictional files and keeps private/ out of reach', async () => {
  const repo = makeRepo('demo-on', { demo: true, private: true })
  const s = await computeDataRoot(repo, 'demo', {})
  assert.equal(s.kind, 'demo')
  assert.equal(s.source, 'config')
  const ctx = rootContext(s)!
  const apps = resolveAppPath(ctx, 'data/applications.md')!
  assert.match(fs.readFileSync(apps.abs, 'utf-8'), /Northwind Analytics/)
  assert.ok(fs.existsSync(resolveAppPath(ctx, 'reports/tier-2/Fabrikam - Product Analyst.md')!.abs))
  assert.equal(resolveAppPath(ctx, 'private/data/applications.md'), null)
})

test('a saved demo choice without a demo/ folder falls back to own data', async () => {
  const repo = makeRepo('demo-gone', { private: true })
  const s = await computeDataRoot(repo, 'demo', {})
  assert.equal(s.kind, 'private')
  assert.equal(s.demoAvailable, false)
})

test('STARPATH_DATA points the app at an external folder', async () => {
  const repo = makeRepo('external', { private: true })
  const ext = path.join(tmp, 'vienna-search')
  write('data/applications.md', '| # |\n', ext)
  const s = await computeDataRoot(repo, null, { STARPATH_DATA: ext })
  assert.equal(s.kind, 'external')
  assert.equal(s.root, ext)
  assert.equal(resolveAppPath(rootContext(s)!, 'data/applications.md')?.abs, path.join(ext, 'data/applications.md'))
})

test('a checkout without the resolver keeps working repo-relative', async () => {
  const repo = path.join(tmp, 'old-checkout')
  write('CLAUDE.md', '# old\n', repo)
  const s = await computeDataRoot(repo, null, {})
  assert.equal(s.kind, 'none')
  assert.equal(resolveAppPath(rootContext(s)!, 'data/applications.md')?.abs, path.join(repo, 'data/applications.md'))
})

test('no repo yet: nothing resolves', async () => {
  const s = await computeDataRoot(null, null, {})
  assert.equal(s.kind, 'none')
  assert.equal(rootContext(s), null)
})

test('chat moves from app data into the private root once, files stay 0600', () => {
  const userDataDir = path.join(tmp, 'app-data')
  const root = path.join(tmp, 'chat-move', 'private')
  fs.mkdirSync(root, { recursive: true })
  write('chat/sessions.json', '{"version":1,"sessions":[]}', userDataDir)
  fs.chmodSync(path.join(userDataDir, 'chat/sessions.json'), 0o644)
  const plan = planChatMigration({ kind: 'private', root, userDataDir, exists: fs.existsSync })
  assert.ok(plan)
  moveChatFolder(plan!.from, plan!.to)
  const moved = path.join(root, 'chat', 'sessions.json')
  assert.ok(fs.existsSync(moved))
  assert.equal(fs.existsSync(path.join(userDataDir, 'chat')), false)
  assert.equal(fs.statSync(moved).mode & 0o777, 0o600)
  assert.equal(chatDirFor({ kind: 'private', root, userDataDir }), path.join(root, 'chat'))
  // Second launch: nothing left to move.
  assert.equal(planChatMigration({ kind: 'private', root, userDataDir, exists: fs.existsSync }), null)
})
