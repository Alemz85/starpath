import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
// The real predicate from the repo — the app maps exactly what the scripts
// call personal, so the tests pin the integration, not a copy.
import { isPersonalPath, resolveDataRoot } from '../../../scripts/lib/data-root.mjs'
import {
  cacheSlugFor, chatDirFor, demoAllowsRun, demoSpawnRefusal, demoWriteRefusal,
  findRepoRoot, normalizeRel, personalBase, planChatMigration, resolveAppPath,
  spawnEnvFor, type RootContext,
} from './dataRootMain'
import { DEMO_READ_ONLY, isDemoReadOnlyError } from './dataRoot'

const REPO = path.resolve('/tmp/fixture-repo')
const PRIV = path.join(REPO, 'private')
const DEMO = path.join(REPO, 'demo')
const EXT = path.resolve('/tmp/elsewhere/lyon-search')

const ctx = (kind: RootContext['kind'], root: string | null): RootContext =>
  ({ repoPath: REPO, root, kind, isPersonal: isPersonalPath })

// ─── normalizeRel ────────────────────────────────────────────────────────────

test('normalizeRel folds dot segments and refuses climbs', () => {
  assert.equal(normalizeRel('data/applications.md'), 'data/applications.md')
  assert.equal(normalizeRel('./data//x.md'), 'data/x.md')
  assert.equal(normalizeRel('data/../CLAUDE.md'), 'CLAUDE.md')
  assert.equal(normalizeRel('reports/'), 'reports')
  assert.equal(normalizeRel(''), '')
  assert.equal(normalizeRel('.'), '')
  assert.equal(normalizeRel('../x'), null)
  assert.equal(normalizeRel('data/../../x'), null)
  assert.equal(normalizeRel('data\\scouting.md'), 'data/scouting.md')
})

// ─── resolveAppPath: personal-path mapping ───────────────────────────────────

test('private: personal paths resolve under the private root', () => {
  const r = resolveAppPath(ctx('private', PRIV), 'data/applications.md')
  assert.deepEqual(r, { abs: path.join(PRIV, 'data/applications.md'), base: PRIV, personal: true, rel: 'data/applications.md' })
  assert.equal(resolveAppPath(ctx('private', PRIV), 'reports/tier-1/Northwind Analytics - Data Analyst.md')?.abs,
    path.join(PRIV, 'reports/tier-1/Northwind Analytics - Data Analyst.md'))
  assert.equal(resolveAppPath(ctx('private', PRIV), 'profiles/active')?.abs, path.join(PRIV, 'profiles/active'))
  assert.equal(resolveAppPath(ctx('private', PRIV), 'batch/tracker-additions/7-fabrikam.tsv')?.abs,
    path.join(PRIV, 'batch/tracker-additions/7-fabrikam.tsv'))
})

test('system paths stay in the repo', () => {
  for (const rel of ['modes/chat.md', 'batch/batch-prompt.md', 'templates/cv-template.html', 'CLAUDE.md']) {
    const r = resolveAppPath(ctx('private', PRIV), rel)
    assert.equal(r?.abs, path.join(REPO, rel), rel)
    assert.equal(r?.personal, false, rel)
  }
})

test('demo and external roots serve the same personal paths', () => {
  assert.equal(resolveAppPath(ctx('demo', DEMO), 'user/cv.md')?.abs, path.join(DEMO, 'user/cv.md'))
  assert.equal(resolveAppPath(ctx('external', EXT), 'data/scouting.md')?.abs, path.join(EXT, 'data/scouting.md'))
  // A directory listing walks relative to the data root, so results come
  // back as `reports/…` — the same strings the renderer passes in.
  const dir = resolveAppPath(ctx('external', EXT), 'reports')
  assert.equal(dir?.base, EXT)
  assert.equal(path.relative(dir!.base, path.join(dir!.abs, 'tier-2', 'x.md')), path.join('reports', 'tier-2', 'x.md'))
})

test('kind none keeps today\'s repo-relative behaviour', () => {
  const r = resolveAppPath(ctx('none', PRIV), 'data/applications.md')
  assert.equal(r?.abs, path.join(REPO, 'data/applications.md'))
  assert.equal(r?.personal, false)
  assert.equal(personalBase(ctx('none', PRIV)), REPO)
})

// ─── resolveAppPath: confinement ─────────────────────────────────────────────

test('escapes are refused against either base', () => {
  for (const kind of ['private', 'demo', 'none'] as const) {
    const c = ctx(kind, kind === 'demo' ? DEMO : PRIV)
    assert.equal(resolveAppPath(c, '../outside.md'), null, kind)
    assert.equal(resolveAppPath(c, 'data/../../outside.md'), null, kind)
    assert.equal(resolveAppPath(c, '/etc/passwd'), null, kind)
  }
  // `data/../CLAUDE.md` folds to a system path, never a data-root one.
  assert.equal(resolveAppPath(ctx('private', PRIV), 'data/../CLAUDE.md')?.abs, path.join(REPO, 'CLAUDE.md'))
})

test('absolute paths are accepted only inside the repo or the data root', () => {
  assert.equal(resolveAppPath(ctx('external', EXT), path.join(EXT, 'data/pipeline.md'))?.abs, path.join(EXT, 'data/pipeline.md'))
  // The repo-root link form maps through the data root.
  assert.equal(resolveAppPath(ctx('private', PRIV), path.join(REPO, 'data/pipeline.md'))?.abs, path.join(PRIV, 'data/pipeline.md'))
  assert.equal(resolveAppPath(ctx('external', EXT), path.resolve('/tmp/elsewhere/other/x.md')), null)
})

test('the demo can never reach private/ by name', () => {
  assert.equal(resolveAppPath(ctx('demo', DEMO), 'private/data/applications.md'), null)
  assert.equal(resolveAppPath(ctx('demo', DEMO), path.join(PRIV, 'user/cv.md')), null)
  // …while own-data modes still can (the private repo's README, docs).
  assert.ok(resolveAppPath(ctx('private', PRIV), 'private/README.md'))
})

// ─── Demo refusals ───────────────────────────────────────────────────────────

test('demo refuses personal writes with the demo-read-only code', () => {
  const msg = demoWriteRefusal('demo', { rel: 'data/applications.md' }, isPersonalPath)
  assert.ok(msg?.startsWith(DEMO_READ_ONLY))
  assert.ok(isDemoReadOnlyError(new Error(`Error invoking remote method 'fs:write': Error: ${msg}`)))
  assert.ok(demoWriteRefusal('demo', { rel: 'user/profile.yml' }, isPersonalPath))
  assert.ok(demoWriteRefusal('demo', { rel: 'demo/data/x.md' }, isPersonalPath))
  assert.ok(demoWriteRefusal('demo', { rel: 'private/data/x.md' }, isPersonalPath))
  assert.ok(demoWriteRefusal('demo', { rel: 'anything', personal: true }, isPersonalPath))
})

test('own-data modes never refuse', () => {
  for (const kind of ['private', 'external', 'none'] as const) {
    assert.equal(demoWriteRefusal(kind, { rel: 'data/applications.md' }, isPersonalPath), null, kind)
    assert.equal(demoSpawnRefusal(kind), null, kind)
  }
  assert.ok(demoSpawnRefusal('demo')?.startsWith(DEMO_READ_ONLY))
})

test('demo allows only the read-only digests as one-shot runs', () => {
  assert.equal(demoAllowsRun('node', ['scripts/daily-brief.mjs', '--json']), true)
  assert.equal(demoAllowsRun('node', ['./scripts/followup-cadence.mjs']), true)
  assert.equal(demoAllowsRun('node', ['scripts/cv-summary.mjs', '--if-stale']), false)
  assert.equal(demoAllowsRun('node', ['scripts/scan.mjs']), false)
  assert.equal(demoAllowsRun('claude', ['-p', 'hi']), false)
  assert.equal(demoAllowsRun('node', []), false)
})

// ─── Spawn env ───────────────────────────────────────────────────────────────

test('STARPATH_DATA is set for demo and external roots only', () => {
  const base: Record<string, string | undefined> = { PATH: '/usr/bin' }
  assert.equal(spawnEnvFor(base, { kind: 'demo', root: DEMO }).STARPATH_DATA, DEMO)
  assert.equal(spawnEnvFor(base, { kind: 'external', root: EXT }).STARPATH_DATA, EXT)
  assert.equal(spawnEnvFor(base, { kind: 'private', root: PRIV }), base)
  assert.equal(spawnEnvFor(base, { kind: 'none', root: PRIV }), base)
  assert.equal(base.PATH, '/usr/bin')
  assert.equal('STARPATH_DATA' in base, false)
})

// ─── Chat folder ─────────────────────────────────────────────────────────────

test('chat lives in the data root, a demo folder, or the legacy app folder', () => {
  const userDataDir = path.resolve('/tmp/app-data')
  assert.equal(chatDirFor({ kind: 'private', root: PRIV, userDataDir }), path.join(PRIV, 'chat'))
  assert.equal(chatDirFor({ kind: 'external', root: EXT, userDataDir }), path.join(EXT, 'chat'))
  assert.equal(chatDirFor({ kind: 'demo', root: DEMO, userDataDir }), path.join(userDataDir, 'chat-demo'))
  assert.equal(chatDirFor({ kind: 'none', root: PRIV, userDataDir }), path.join(userDataDir, 'chat'))
})

test('chat migration moves the legacy folder once, never over existing data', () => {
  const userDataDir = path.resolve('/tmp/app-data')
  const legacy = path.join(userDataDir, 'chat', 'sessions.json')
  const has = (...present: string[]) => (p: string) => present.includes(p)
  assert.deepEqual(
    planChatMigration({ kind: 'private', root: PRIV, userDataDir, exists: has(legacy) }),
    { from: path.join(userDataDir, 'chat'), to: path.join(PRIV, 'chat') },
  )
  assert.equal(planChatMigration({ kind: 'private', root: PRIV, userDataDir, exists: has(legacy, path.join(PRIV, 'chat')) }), null)
  assert.equal(planChatMigration({ kind: 'private', root: PRIV, userDataDir, exists: has() }), null)
  assert.equal(planChatMigration({ kind: 'demo', root: DEMO, userDataDir, exists: has(legacy) }), null)
  assert.equal(planChatMigration({ kind: 'none', root: PRIV, userDataDir, exists: has(legacy) }), null)
})

// ─── Dev repo detection ──────────────────────────────────────────────────────

test('findRepoRoot walks up to the first CLAUDE.md + scripts/ folder', () => {
  const present = new Set([path.join(REPO, 'CLAUDE.md'), path.join(REPO, 'scripts')])
  const exists = (p: string) => present.has(p)
  assert.equal(findRepoRoot([path.join(REPO, 'frontend/dist-electron/electron')], exists), REPO)
  assert.equal(findRepoRoot(['', path.join(REPO, 'frontend')], exists), REPO)
  assert.equal(findRepoRoot([path.resolve('/tmp/unrelated/app')], exists), null)
  // CLAUDE.md alone (a home folder with notes) is not a checkout.
  const onlyNotes = (p: string) => p === path.join(REPO, 'CLAUDE.md')
  assert.equal(findRepoRoot([path.join(REPO, 'frontend')], onlyNotes), null)
})

// ─── Cache slug ──────────────────────────────────────────────────────────────

test('cache slug: demo has its own cache, otherwise the active profile', () => {
  assert.equal(cacheSlugFor('demo', 'career'), 'demo')
  assert.equal(cacheSlugFor('private', 'career'), 'career')
  assert.equal(cacheSlugFor('private', null), 'default')
  assert.equal(cacheSlugFor('none', null), 'default')
})

// ─── The resolver main calls (scripts/lib/data-root.mjs) ─────────────────────

test('resolveDataRoot as main calls it: demo config, private default, none', () => {
  // Typed the way main types its dynamic import of the module.
  const resolve = resolveDataRoot as unknown as (o: {
    repoRoot: string; configured: string | null; env: Record<string, string | undefined>
    allowDemo: boolean; exists: (p: string) => boolean
  }) => { root: string; kind: string }
  const exists = (...present: string[]) => (p: string) => present.includes(p)
  assert.equal(resolve({ repoRoot: REPO, configured: 'demo', env: {}, allowDemo: false, exists: exists() }).kind, 'demo')
  assert.equal(resolve({ repoRoot: REPO, configured: null, env: {}, allowDemo: false, exists: exists(PRIV) }).kind, 'private')
  assert.equal(resolve({ repoRoot: REPO, configured: null, env: {}, allowDemo: false, exists: exists(DEMO) }).kind, 'none')
  assert.equal(resolve({ repoRoot: REPO, configured: null, env: { STARPATH_DATA: EXT }, allowDemo: false, exists: exists(PRIV) }).root, EXT)
})
