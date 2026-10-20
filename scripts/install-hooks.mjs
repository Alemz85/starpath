#!/usr/bin/env node
/**
 * install-hooks.mjs — turn on the leak gate's git hooks (`npm run hooks`).
 *
 * Points `core.hooksPath` at the tracked `.githooks/` folder (pre-commit,
 * commit-msg, pre-push → scripts/lib/hygiene-guard.mjs) and makes the hooks
 * executable. The setting lives in the shared repo config, so one install
 * covers the main checkout and every linked worktree; a relative hooksPath
 * resolves inside whichever worktree runs the hook.
 *
 *   node scripts/install-hooks.mjs            install (idempotent)
 *   node scripts/install-hooks.mjs --check    exit 1 when not installed (doctor, test-all)
 *   --root <checkout>                         operate on another checkout (tests)
 *   --quiet                                   no output on success
 */

import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const HOOKS_DIR = '.githooks'
export const HOOKS = ['pre-commit', 'commit-msg', 'pre-push']

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() }
}

function isExecutable(path) {
  try { return (statSync(path).mode & 0o111) !== 0 } catch { return false }
}

/**
 * @returns {{ installed: boolean, hooksPath: string|null, missing: string[], notExecutable: string[] }}
 */
export function checkHooks({ root }) {
  const hp = git(root, ['config', '--get', 'core.hooksPath'])
  const hooksPath = hp.ok && hp.out ? hp.out : null
  const missing = HOOKS.filter((h) => !existsSync(join(root, HOOKS_DIR, h)))
  const notExecutable = HOOKS.filter((h) => !missing.includes(h) && !isExecutable(join(root, HOOKS_DIR, h)))
  const pointsHere = hooksPath === HOOKS_DIR || hooksPath === `./${HOOKS_DIR}` || hooksPath === `${HOOKS_DIR}/`
  return { installed: pointsHere && missing.length === 0 && notExecutable.length === 0, hooksPath, missing, notExecutable }
}

/** Hooks in <git-common-dir>/hooks that core.hooksPath will shadow. */
function shadowedHooks(root) {
  const cd = git(root, ['rev-parse', '--git-common-dir'])
  if (!cd.ok) return []
  const dir = join(resolve(root, cd.out), 'hooks')
  try { return readdirSync(dir).filter((f) => !f.endsWith('.sample') && !f.startsWith('.')) } catch { return [] }
}

export function installHooks({ root }) {
  const missing = HOOKS.filter((h) => !existsSync(join(root, HOOKS_DIR, h)))
  if (missing.length) throw new Error(`missing hook file(s) in ${HOOKS_DIR}/: ${missing.join(', ')}`)
  for (const h of HOOKS) chmodSync(join(root, HOOKS_DIR, h), 0o755)
  const before = git(root, ['config', '--get', 'core.hooksPath'])
  const set = git(root, ['config', 'core.hooksPath', HOOKS_DIR])
  if (!set.ok) throw new Error(`git config core.hooksPath failed: ${set.err}`)
  return { previous: before.ok && before.out ? before.out : null, shadowed: shadowedHooks(root) }
}

function main(argv) {
  const check = argv.includes('--check')
  const quiet = argv.includes('--quiet')
  const ri = argv.indexOf('--root')
  const root = resolve(ri !== -1 && argv[ri + 1] ? argv[ri + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (!git(root, ['rev-parse', '--git-dir']).ok) {
    console.error(`install-hooks: ${root} is not a git checkout`)
    return 2
  }

  if (check) {
    const s = checkHooks({ root })
    if (s.installed) {
      if (!quiet) console.log(`Leak-gate hooks installed (core.hooksPath=${s.hooksPath}: ${HOOKS.join(', ')}).`)
      return 0
    }
    const why = s.hooksPath !== HOOKS_DIR && s.hooksPath !== `./${HOOKS_DIR}` && s.hooksPath !== `${HOOKS_DIR}/`
      ? `core.hooksPath is ${s.hooksPath ? `"${s.hooksPath}"` : 'not set'}`
      : [s.missing.length && `missing: ${s.missing.join(', ')}`, s.notExecutable.length && `not executable: ${s.notExecutable.join(', ')}`].filter(Boolean).join('; ')
    console.log(`Leak-gate hooks NOT installed (${why}). Run: npm run hooks`)
    return 1
  }

  try {
    const { previous, shadowed } = installHooks({ root })
    if (!quiet) {
      console.log(`Leak-gate hooks installed: core.hooksPath=${HOOKS_DIR} (${HOOKS.join(', ')}).`)
      if (previous && previous !== HOOKS_DIR) console.log(`  (replaced the previous core.hooksPath "${previous}")`)
      if (shadowed.length) console.log(`  Note: hooks in .git/hooks no longer run: ${shadowed.join(', ')}`)
      console.log('  Applies to this checkout and every linked worktree. A blocked push means fix the commits, never --no-verify.')
    }
    return 0
  } catch (e) {
    console.error(`install-hooks: ${e.message}`)
    return 1
  }
}

function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b) } catch { return resolve(a) === resolve(b) }
}
if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
