// Smoke tests for scripts/doctor.mjs against mkdtemp mini-repos (`--root`):
// it must never create folders at the repo root (a real data/ would shadow
// the data → private/data link) and must read personal files through the
// data root. Check logic itself is unit-tested in lib/doctor-checks.test.mjs.
// Plain ESM, zero deps: `node --test scripts/**/*.test.mjs`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCTOR = join(HERE, 'doctor.mjs')
const PRIVATE = join(HERE, 'private.mjs')
const GITIGNORE = readFileSync(join(HERE, '..', '.gitignore'), 'utf-8')

let sandbox
let ENV

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'doctor-cli-'))
  writeFileSync(join(sandbox, 'gitconfig'), '')
  ENV = { ...process.env, GIT_CONFIG_GLOBAL: join(sandbox, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STARPATH_DATA']) delete ENV[k]
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function makeRepo(name) {
  const root = join(sandbox, name)
  mkdirSync(join(root, 'batch'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), GITIGNORE)
  writeFileSync(join(root, 'CLAUDE.md'), '# fixture\n')
  writeFileSync(join(root, 'batch/README.md'), '# batch\n')
  const git = (...a) => execFileSync('git', a, { cwd: root, env: ENV, encoding: 'utf-8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Dana Fox')
  git('config', 'user.email', 'dana.fox@example.test')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return root
}

function doctor(root) {
  const r = spawnSync(process.execPath, [DOCTOR, '--root', root], { env: ENV, encoding: 'utf-8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('fresh checkout: first-run hint, no crash, no folders created', () => {
  const root = makeRepo('fresh')
  const before = readdirSync(root).sort()
  const { out } = doctor(root)
  assert.match(out, /2\. Private root/)
  assert.match(out, /first run: no private\/ yet/)
  assert.match(out, /private\/ is gitignored by the public repo/)
  assert.match(out, /Result:/)
  assert.doesNotMatch(out, /doctor\.mjs failed/)
  assert.deepEqual(readdirSync(root).sort(), before, 'doctor never mkdirs data/ output/ reports/ jds/')
  assert.deepEqual(readdirSync(join(root, 'batch')), ['README.md'])
})

test('legacy checkout: "not migrated" warning', () => {
  const root = makeRepo('legacy')
  mkdirSync(join(root, 'data'))
  writeFileSync(join(root, 'data/scouting.md'), '# Scouting Tracker\n')
  const { out } = doctor(root)
  assert.match(out, /not migrated: personal folders still live at the repo root \(data\)/)
  assert.match(out, /npm run private -- init/)
})

test('migrated checkout: links verified, user files read through private/, shadows fail', () => {
  const root = makeRepo('migrated')
  const init = spawnSync(process.execPath, [PRIVATE, 'init', '--json', '--root', root], { env: ENV, encoding: 'utf-8' })
  assert.equal(init.status, 0, init.stdout)
  writeFileSync(join(root, 'private/user/cv.md'), '# Dana Fox\n')
  let { out } = doctor(root)
  assert.match(out, /all 13 repo-root links point into private\//)
  assert.match(out, /private\/ is its own git repo \(branch main\)/)
  assert.match(out, /private\/ has no remote/)
  assert.match(out, /✓ user\/cv\.md present/)

  // A writer replaced a link with a real folder: doctor reports it, never "fixes" it.
  rmSync(join(root, 'jds'))
  mkdirSync(join(root, 'jds'))
  writeFileSync(join(root, 'jds/fabrikam-analyst.md'), 'fixture JD\n')
  ;({ out } = doctor(root))
  assert.match(out, /✗ real folder\/file shadows its link: jds/)
  assert.deepEqual(readdirSync(join(root, 'jds')), ['fabrikam-analyst.md'])
})
