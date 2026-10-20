#!/usr/bin/env node

/**
 * overrides.mjs — list, brief and resolve your private overrides.
 *
 * A file at `<data root>/overrides/<repo path>` replaces a system file; one at
 * `<path minus .md>.append.md` is added after it (scripts/lib/overrides.mjs).
 * This CLI reports them and resolves the effective file for consumers.
 *
 * Usage:
 *   node scripts/overrides.mjs [list] [--json]
 *       Every override: file → target, replace|append, valid, and drift (the
 *       repo default was committed after your override was last modified).
 *   node scripts/overrides.mjs --brief
 *       For the Claude Code SessionStart hook: prints NOTHING when there are
 *       no overrides, else 1–3 short lines. Never fails (exit 0 always).
 *   node scripts/overrides.mjs resolve <repo path>
 *       Print the absolute path to hand to a tool (the default, the
 *       replacement, or the composed default + append under .cache/prompts/).
 *       Used by batch/batch-runner.sh. Prints the repo default when there is
 *       no data root.
 *
 * Every command accepts --root <repoRoot> (tests). The data root comes from
 * scripts/lib/data-root.mjs › resolveDataRoot ($STARPATH_DATA, then private/).
 *
 * Exports gatherOverrideReport() for scripts/doctor.mjs; the pure report
 * logic lives in scripts/lib/private-core.mjs (annotateOverrides & co).
 */

import { realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { repoRootFrom, resolveDataRoot } from './lib/data-root.mjs'
import { OVERRIDES_DIR, listOverrides, materializeSystemFile } from './lib/overrides.mjs'
import { annotateOverrides, formatOverridesBrief, groupOverrides } from './lib/private-core.mjs'

/** Seconds since epoch of the last public-repo commit touching `target` (null when none). */
function lastCommitTime(repoRoot, target) {
  const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', target], { cwd: repoRoot, encoding: 'utf-8' })
  const n = Number((r.stdout || '').trim())
  return r.status === 0 && Number.isFinite(n) && n > 0 ? n : null
}

function mtimeMs(path) {
  try { return statSync(path).mtimeMs } catch { return null }
}

/** The data root to read overrides from, or null when nothing is set up. */
export function overridesDataRoot(repoRoot, env = process.env) {
  const r = resolveDataRoot({ repoRoot, env })
  return r.kind === 'none' ? null : r.root
}

/**
 * Annotated overrides for a data root (empty when there is none).
 * @returns {{ dataRoot: string|null, overridesDir: string|null, entries: Array }}
 */
export function gatherOverrideReport({ repoRoot, dataRoot }) {
  if (!dataRoot) return { dataRoot: null, overridesDir: null, entries: [] }
  const entries = annotateOverrides(listOverrides({ dataRoot, repoRoot }), {
    commitTimeFor: (target) => lastCommitTime(repoRoot, target),
    mtimeFor: mtimeMs,
  })
  return { dataRoot, overridesDir: join(dataRoot, OVERRIDES_DIR), entries }
}

/** How to name the overrides folder in messages: repo-relative when inside the repo. */
function displayDir(repoRoot, dir) {
  const rel = relative(repoRoot, dir)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : dir
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const json = argv.includes('--json')
  const brief = argv.includes('--brief')
  const rootIdx = argv.indexOf('--root')
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root')

  if (brief) {
    // SessionStart hook: fast, silent when there is nothing, never throws.
    try {
      const repoRoot = rootIdx !== -1 ? resolve(argv[rootIdx + 1]) : repoRootFrom(import.meta.url)
      const report = gatherOverrideReport({ repoRoot, dataRoot: overridesDataRoot(repoRoot) })
      if (report.entries.length) {
        for (const line of formatOverridesBrief(report.entries, { overridesDir: displayDir(repoRoot, report.overridesDir) })) console.log(line)
      }
    } catch { /* silent by design */ }
    return 0
  }

  const repoRoot = rootIdx !== -1 ? resolve(argv[rootIdx + 1]) : repoRootFrom(import.meta.url)
  const [command = 'list', arg] = positional

  if (command === 'resolve') {
    if (!arg) {
      console.error('usage: node scripts/overrides.mjs resolve <repo path>')
      return 1
    }
    try {
      console.log(materializeSystemFile({ repoRoot, dataRoot: overridesDataRoot(repoRoot), rel: arg }))
      return 0
    } catch (err) {
      console.error(`overrides: could not resolve ${arg}: ${err.message}`)
      return 1
    }
  }

  if (command !== 'list') {
    console.error(`unknown command '${command}' — usage: node scripts/overrides.mjs [list|resolve <path>] [--brief] [--json]`)
    return 1
  }

  const report = gatherOverrideReport({ repoRoot, dataRoot: overridesDataRoot(repoRoot) })
  if (json) {
    console.log(JSON.stringify({ ok: true, dataRoot: report.dataRoot, overridesDir: report.overridesDir, overrides: report.entries }))
    return 0
  }
  if (!report.dataRoot) {
    console.log('No data root yet (no private/), so no overrides. Run: npm run private -- init')
    return 0
  }
  const dir = displayDir(repoRoot, report.overridesDir)
  if (!report.entries.length) {
    console.log(`No overrides in ${dir}/. Put your version of a system file at ${dir}/<repo path> (replace) or ${dir}/<path minus .md>.append.md (append).`)
    return 0
  }
  console.log(`Overrides in ${dir}/:`)
  const width = Math.max(...report.entries.map((e) => e.rel.length))
  for (const e of report.entries) {
    const flags = [
      !e.valid ? 'NOT OVERRIDABLE (ignored)' : null,
      e.valid && e.defaultExists === false ? 'no repo default (renamed or removed upstream?)' : null,
      e.drift ? 'DRIFT: default changed since your override' : null,
    ].filter(Boolean)
    console.log(`  ${e.rel.padEnd(width)}  → ${e.target}  ${e.mode.padEnd(7)}  ${flags.length ? flags.join('; ') : 'ok'}`)
  }
  const drifted = groupOverrides(report.entries).filter((g) => g.drift)
  if (drifted.length) {
    console.log(`\nReview what changed upstream: git log -p -- ${drifted.map((g) => g.target).join(' ')}`)
    console.log('Then update your override (saving it clears the drift flag).')
  }
  return 0
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) process.exitCode = main(process.argv.slice(2))
