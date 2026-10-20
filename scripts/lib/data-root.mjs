/**
 * data-root.mjs — where personal data lives.
 *
 * Everything personal (CV, profile, trackers, reports, prep, outputs, batch
 * state, chat, overrides, personal docs) lives under ONE data root, by default
 * `<repo>/private/` — a gitignored folder that is its own private git repo.
 * The repo-root folders `user/ data/ reports/ …` are directory links into it
 * (LINKED_PATHS), so repo-relative paths in modes, scripts and prompts keep
 * working. Code that must also work against the fictional demo dataset or an
 * external folder resolves through `resolveDataRoot()` instead of the links.
 *
 * Resolution order (first hit wins):
 *   1. `configured`  — the app's saved choice (config.json `dataPath`, or 'demo')
 *   2. $STARPATH_DATA — absolute path, repo-relative path, or 'demo'
 *   3. <repo>/private — when it exists
 *   4. <repo>/demo    — only when `allowDemo` (the app's read-only fallback)
 *   5. <repo>/private — kind 'none': nothing set up yet; writers create it
 *
 * Pure apart from the injectable `exists` probe; unit-tested in
 * data-root.test.mjs.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRIVATE_DIR = 'private'
export const DEMO_DIR = 'demo'
export const ENV_VAR = 'STARPATH_DATA'

/**
 * Repo-relative paths that live under the data root and are linked from the
 * repo root. `kind` is the link type; `link` is the link's target relative to
 * the link's own directory (what `private init` creates).
 */
export const LINKED_PATHS = [
  { path: 'user', kind: 'dir' },
  { path: 'data', kind: 'dir' },
  { path: 'reports', kind: 'dir' },
  { path: 'interview-prep', kind: 'dir' },
  { path: 'output', kind: 'dir' },
  { path: 'jds', kind: 'dir' },
  { path: 'batch/tracker-additions', kind: 'dir' },
  { path: 'batch/scouting-additions', kind: 'dir' },
  { path: 'batch/logs', kind: 'dir' },
  { path: 'batch/jobspy-merged', kind: 'dir' },
  { path: 'batch/batch-state.tsv', kind: 'file' },
  { path: 'batch/batch-input.tsv', kind: 'file' },
  { path: 'batch/cv-summary.md', kind: 'file' },
].map((e) => ({ ...e, link: linkTargetFor(e.path) }))

/**
 * Personal repo-relative prefixes with no repo-root link: the app and the
 * profile CLI address them repo-relatively and resolve them to the data root.
 */
export const UNLINKED_PERSONAL = ['profiles']

/**
 * Locations that exist ONLY inside the data root (never addressed by a
 * repo-relative path — `docs/` at the repo root is the public docs folder).
 * Code reaches them with dataPath(root, …).
 */
export const DATA_ROOT_ONLY = ['chat', 'overrides', 'docs', '.cache', 'leak-terms.txt', 'README.md']
export const LEAK_TERMS_FILE = 'leak-terms.txt'

/** Relative link target from a repo-root link to its home in private/. */
export function linkTargetFor(relPath) {
  const depth = relPath.split('/').length - 1
  return '../'.repeat(depth) + `${PRIVATE_DIR}/${relPath}`
}

/** The repo root for a script at scripts/<file> or scripts/lib/<file>. */
export function repoRootFrom(importMetaUrl) {
  let dir = dirname(fileURLToPath(importMetaUrl))
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'CLAUDE.md')) && existsSync(join(dir, 'scripts'))) return dir
    dir = dirname(dir)
  }
  throw new Error('data-root: could not find the repo root (no CLAUDE.md above ' + importMetaUrl + ')')
}

function fromSetting(value, repoRoot) {
  const v = value == null ? '' : String(value).trim()
  if (v === '') return null
  if (v === 'demo') return { root: join(repoRoot, DEMO_DIR), kind: 'demo' }
  if (v === 'private') return { root: join(repoRoot, PRIVATE_DIR), kind: 'private' }
  const root = isAbsolute(v) ? v : resolve(repoRoot, v)
  if (root === join(repoRoot, DEMO_DIR)) return { root, kind: 'demo' }
  if (root === join(repoRoot, PRIVATE_DIR)) return { root, kind: 'private' }
  return { root, kind: 'external' }
}

/**
 * @returns {{ root: string, kind: 'private'|'external'|'demo'|'none', source: 'config'|'env'|'default' }}
 */
export function resolveDataRoot({
  repoRoot,
  env = process.env,
  configured = null,
  allowDemo = false,
  exists = existsSync,
} = {}) {
  if (!repoRoot) throw new Error('resolveDataRoot: repoRoot is required')
  const fromConfig = fromSetting(configured, repoRoot)
  if (fromConfig) return { ...fromConfig, source: 'config' }
  const fromEnv = fromSetting(env?.[ENV_VAR], repoRoot)
  if (fromEnv) return { ...fromEnv, source: 'env' }
  const priv = join(repoRoot, PRIVATE_DIR)
  if (exists(priv)) return { root: priv, kind: 'private', source: 'default' }
  const demo = join(repoRoot, DEMO_DIR)
  if (allowDemo && exists(demo)) return { root: demo, kind: 'demo', source: 'default' }
  return { root: priv, kind: 'none', source: 'default' }
}

/**
 * For CLI scripts: the folder that holds `data/`, `user/`, `reports/`… for
 * this checkout. Honours $STARPATH_DATA (the app sets it, e.g. to the demo),
 * then private/; with neither, the repo root itself (a checkout that still has
 * real top-level folders, or links), so un-migrated layouts keep working.
 */
export function dataRootFor(repoRoot, opts = {}) {
  const r = resolveDataRoot({ repoRoot, ...opts })
  return r.kind === 'none' ? repoRoot : r.root
}

/**
 * Is a repo-relative path personal (served from the data root)? True for the
 * linked paths and anything under them, plus `profiles/…`.
 */
export function isPersonalPath(relPath) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (!p || p.startsWith('..')) return false
  for (const { path } of LINKED_PATHS) {
    if (p === path || p.startsWith(path + '/')) return true
  }
  return UNLINKED_PERSONAL.includes(p.split('/')[0])
}

/** Absolute path of a personal repo-relative path under a given data root. */
export function dataPath(root, ...rel) {
  return join(root, ...rel)
}
