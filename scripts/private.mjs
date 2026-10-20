#!/usr/bin/env node

/**
 * private.mjs — set up, check and back up the private root (`private/`).
 *
 * Everything personal lives in `<repo>/private/`: gitignored by the public
 * repo and its own git repository. The repo-root paths in
 * scripts/lib/data-root.mjs › LINKED_PATHS (`user/ data/ reports/ …` and the
 * batch working files) are relative links into it, and `profiles/` lives at
 * `private/profiles/` with no link. See DATA_CONTRACT.md.
 *
 * All plan / classification / verification logic is pure in
 * scripts/lib/private-core.mjs (unit-tested); this file is thin I/O.
 *
 * Usage:
 *   node scripts/private.mjs init [--dry-run] [--force]
 *       Move this checkout's personal folders into private/ (rename, never
 *       copy), link them back, verify a sha256 manifest, git init + first
 *       commit. Refuses while eval output is unmerged, batch workers run,
 *       JobSpy staging is unmerged, the starpath app runs from this
 *       checkout, or a symlink inside a moving folder would stop resolving
 *       (--force overrides those and re-points wrong links). Never merges or
 *       overwrites: a path present in both places is a conflict.
 *   node scripts/private.mjs status
 *       Links, the private repo (branch, remote, uncommitted changes, last
 *       commit) and whether the public repo ignores private/.
 *   node scripts/private.mjs backup [-m <msg>] [--no-push]
 *       Commit everything in private/ (only when something changed) and push
 *       when a remote exists.
 *   node scripts/private.mjs link [--force]
 *       Repair links only (create missing / dangling ones); never moves data.
 *
 * Every command accepts --json and --root <repoRoot> (tests). Exit 0 on ok,
 * 1 on refusal or failure (JSON still printed with --json).
 */

import {
  existsSync, lstatSync, statSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  mkdirSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync,
} from 'node:fs'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve, relative } from 'node:path'

import {
  LINKED_PATHS, PRIVATE_DIR, repoRootFrom, resolveDataRoot,
} from './lib/data-root.mjs'
import { evaluateGuards, gatherGuardInputs } from './lib/profile-core.mjs'
import {
  PRIVATE_ENTRIES, IGNORABLE_CHILDREN, privateRelFor, isPlaceholderFile,
  classifyRootPath, planPrivate, predictLinkBreaks, compareManifests, countFilesByPath,
  manifestFileName, PRIVATE_GITIGNORE, PRIVATE_README, PRE_COMMIT_HOOK, INITIAL_COMMIT_MESSAGE,
  countPorcelain, backupMessage, ageDays, formatAge, remoteHint, statusProblems, linkOk,
  parsePs, findRunningApp,
} from './lib/private-core.mjs'

// ── Arguments ───────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2)
const JSON_MODE = rawArgs.includes('--json')
const FORCE = rawArgs.includes('--force')
const DRY_RUN = rawArgs.includes('--dry-run')
const NO_PUSH = rawArgs.includes('--no-push')

function argValue(...flags) {
  for (const flag of flags) {
    const i = rawArgs.indexOf(flag)
    if (i !== -1 && i + 1 < rawArgs.length) return rawArgs[i + 1]
  }
  return null
}

function positionals() {
  const withValue = new Set(['--root', '-m', '--message'])
  const out = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (withValue.has(a)) { i++; continue }
    if (a.startsWith('-')) continue
    out.push(a)
  }
  return out
}

const REPO = resolve(argValue('--root') || repoRootFrom(import.meta.url))
const PRIV = join(REPO, PRIVATE_DIR)
const REPO_ROOTS = [...new Set([REPO, safeRealpath(REPO)].filter(Boolean))]

// ── Small I/O helpers ───────────────────────────────────────────────────────

function safeRealpath(p) {
  try { return realpathSync(p) } catch { return null }
}

function emit(json, human, code) {
  if (JSON_MODE) console.log(JSON.stringify(json))
  else for (const line of human) console.log(line)
  process.exit(code)
}

// A caller's GIT_DIR / GIT_WORK_TREE (e.g. running inside a hook) must never
// redirect commands meant for private/ or the public repo.
const GIT_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX'].includes(k)))

function git(args, cwd = PRIV) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV })
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error }
}

/** lstat-based type of a path (links are reported, not followed). */
function lstatType(abs) {
  let st
  try { st = lstatSync(abs) } catch { return 'absent' }
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isDirectory()) return 'dir'
  if (st.isFile()) return 'file'
  return 'other'
}

/** stat-based type (follows links; a dangling link is 'other'). */
function statType(abs) {
  const t = lstatType(abs)
  if (t !== 'symlink') return t
  try {
    const st = statSync(abs)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  } catch { return 'other' }
}

const isDir = (abs) => statType(abs) === 'dir'

/** Facts about one PRIVATE_ENTRIES entry, for planPrivate / classifyRootPath. */
function gatherFacts(entry) {
  const abs = join(REPO, entry.path)
  const type = lstatType(abs)
  const root = { type, linkTarget: null, targetExists: false }
  if (type === 'symlink') {
    try { root.linkTarget = readlinkSync(abs) } catch { /* unreadable link */ }
    root.targetExists = existsSync(abs)
  }
  let rootEmpty = false
  if (type === 'dir') {
    try { rootEmpty = readdirSync(abs).every((n) => IGNORABLE_CHILDREN.includes(n)) } catch { /* unreadable */ }
  }
  return { entry, root, rootEmpty, priv: { type: statType(join(PRIV, entry.path)) } }
}

function sha256(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/**
 * Manifest records for everything under `abs`, keyed by `key` (the pre-move
 * repo-relative path). Links are recorded with their raw target and whether
 * they resolve; they are never followed.
 */
function walkRecords(key, abs, out, { hash = true } = {}) {
  let st
  try { st = lstatSync(abs) } catch { return out }
  if (st.isSymbolicLink()) {
    let target = null
    try { target = readlinkSync(abs) } catch { /* unreadable */ }
    out.push({ path: key, type: 'link', target, resolves: existsSync(abs) })
  } else if (st.isDirectory()) {
    out.push({ path: key, type: 'dir' })
    for (const name of readdirSync(abs).sort()) walkRecords(`${key}/${name}`, join(abs, name), out, { hash })
  } else if (st.isFile()) {
    out.push({ path: key, type: 'file', size: st.size, ...(hash ? { sha256: sha256(abs) } : {}) })
  } else {
    out.push({ path: key, type: 'other' })
  }
  return out
}

/** Execute planPrivate ops against REPO. */
function execute(ops) {
  for (const op of ops) {
    const abs = join(REPO, op.path ?? op.from)
    switch (op.op) {
      case 'ensure-dir':
        mkdirSync(abs, { recursive: true })
        break
      case 'move': {
        const to = join(REPO, op.to)
        if (lstatType(to) !== 'absent') throw new Error(`refusing to move ${op.from}: ${op.to} appeared meanwhile`)
        renameSync(join(REPO, op.from), to)
        break
      }
      case 'remove-empty-dir':
        for (const name of IGNORABLE_CHILDREN) {
          const child = join(abs, name)
          if (lstatType(child) === 'file') rmSync(child)
        }
        rmdirSync(abs) // throws when anything else is inside
        break
      case 'unlink':
        if (lstatType(abs) !== 'symlink') throw new Error(`refusing to unlink ${op.path}: not a link`)
        unlinkSync(abs)
        break
      case 'symlink':
        if (lstatType(abs) !== 'absent') throw new Error(`refusing to link ${op.path}: something is already there`)
        symlinkSync(op.target, abs, op.kind === 'dir' ? 'dir' : 'file')
        break
      default:
        throw new Error(`unknown op: ${op.op}`)
    }
  }
}

/** Remove zero-byte .gitkeep placeholders anywhere in private/ (not .git/.cache). */
function removePlaceholders() {
  const removed = []
  const walk = (abs, rel) => {
    let names = []
    try { names = readdirSync(abs) } catch { return }
    for (const name of names) {
      if (rel === '' && (name === '.git' || name === '.cache')) continue
      const childAbs = join(abs, name)
      const childRel = rel ? `${rel}/${name}` : name
      let st
      try { st = lstatSync(childAbs) } catch { continue }
      if (st.isDirectory()) walk(childAbs, childRel)
      else if (st.isFile() && isPlaceholderFile(name, st.size)) {
        rmSync(childAbs)
        removed.push(`${PRIVATE_DIR}/${childRel}`)
      }
    }
  }
  walk(PRIV, '')
  return removed
}

/** True when private/ is the top of its own git repo (not the public one). */
function isPrivateRepo() {
  if (!existsSync(join(PRIV, '.git'))) return false
  const top = git(['rev-parse', '--show-toplevel'])
  return top.code === 0 && safeRealpath(top.stdout) === safeRealpath(PRIV)
}

/** True when REPO is the top of a git work tree (the public repo). */
function isPublicRepo() {
  const top = git(['rev-parse', '--show-toplevel'], REPO)
  return top.code === 0 && safeRealpath(top.stdout) === safeRealpath(REPO)
}

/** `git check-ignore` for private/ in the public repo (null when not a repo). */
function publicIgnoresPrivate() {
  if (!isPublicRepo()) return null
  // Trailing slash: `/private/` only matches directories, and the folder may not exist yet.
  return git(['check-ignore', '-q', `${PRIVATE_DIR}/`], REPO).code === 0
}

/** `-c user.name=… -c user.email=…` mirroring the public repo's identity. */
function identityArgs() {
  const args = []
  for (const key of ['user.name', 'user.email']) {
    const v = git(['config', key], REPO)
    if (v.code === 0 && v.stdout) args.push('-c', `${key}=${v.stdout}`)
  }
  return args
}

function privateRemote() {
  const names = git(['remote']).stdout.split('\n').filter(Boolean)
  if (names.length === 0) return null
  const name = names.includes('origin') ? 'origin' : names[0]
  const url = git(['remote', 'get-url', name])
  return { name, url: url.code === 0 ? url.stdout : null }
}

function currentBranch() {
  const r = git(['symbolic-ref', '--short', 'HEAD'])
  if (r.code === 0) return r.stdout
  const d = git(['rev-parse', '--short', 'HEAD'])
  return d.code === 0 ? `(detached ${d.stdout})` : null
}

function headCommit() {
  const r = git(['rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout : null
}

/** Starpath app processes using this checkout (best effort). */
function detectRunningApp() {
  if (process.platform === 'win32') return { pids: [], packagedPids: [], error: 'not supported on Windows' }
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' })
  if (r.status !== 0 || r.error) return { pids: [], packagedPids: [], error: 'ps failed' }
  const rows = parsePs(r.stdout)
  const found = { pids: [], packagedPids: [] }
  for (const root of REPO_ROOTS) {
    const f = findRunningApp(rows, { repoRoot: root, selfPid: process.pid })
    found.pids.push(...f.pids)
    found.packagedPids.push(...f.packagedPids)
  }
  return { pids: [...new Set(found.pids)], packagedPids: [...new Set(found.packagedPids)] }
}

const rel = (abs) => relative(REPO, abs) || '.'

// ── init ────────────────────────────────────────────────────────────────────

function initResult() {
  return {
    ok: true,
    dryRun: DRY_RUN,
    repoRoot: REPO,
    privateRoot: PRIV,
    moved: [],
    linked: [],
    created: [],
    skipped: [],
    conflicts: [],
    placeholdersRemoved: [],
    manifest: { files: 0, verified: false, path: null, mismatches: [] },
    git: { initialised: false, committed: false, commit: null },
    warnings: [],
  }
}

function refuseInit(result, error, message, extra = {}, detail = []) {
  Object.assign(result, { ok: false, error, message, ...extra })
  emit(result, [`refusing: ${message}`, ...detail], 1)
}

/** git init + scaffolding + first commit, only when private/.git is missing. */
function ensurePrivateGit(result) {
  if (existsSync(join(PRIV, '.git'))) {
    if (!isPrivateRepo()) result.warnings.push('private/.git exists but is not a working git repo — left untouched')
    return
  }
  if (git(['init', '-q', '-b', 'main']).code !== 0) {
    const r = git(['init', '-q'])
    if (r.code !== 0) { result.git.error = r.stderr || 'git init failed'; result.warnings.push(`git init failed: ${result.git.error}`); return }
  }
  result.git.initialised = true
  const writeIfAbsent = (name, content, mode) => {
    const p = join(PRIV, name)
    if (lstatType(p) !== 'absent') return
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf-8')
    if (mode) chmodSync(p, mode)
  }
  writeIfAbsent('.gitignore', PRIVATE_GITIGNORE)
  writeIfAbsent('README.md', PRIVATE_README)
  writeIfAbsent('.githooks/pre-commit', PRE_COMMIT_HOOK, 0o755)
  git(['config', 'core.hooksPath', '.githooks'])

  git(['add', '-A'])
  const c = git([...identityArgs(), 'commit', '-q', '-m', INITIAL_COMMIT_MESSAGE])
  if (c.code === 0) {
    result.git.committed = true
    result.git.commit = headCommit()
  } else {
    result.git.error = c.stderr || c.stdout || 'git commit failed'
    result.warnings.push(`first commit failed (run npm run backup once fixed): ${result.git.error}`)
  }
}

function cmdInit() {
  const result = initResult()

  const privType = statType(PRIV)
  if (privType !== 'absent' && privType !== 'dir') {
    refuseInit(result, 'private-not-dir', `${PRIVATE_DIR} exists but is not a folder`)
  }

  if (!FORCE) {
    const guards = evaluateGuards(gatherGuardInputs(REPO, fs))
    if (guards.length) {
      refuseInit(result, 'guards', 'unmerged or in-flight work would be moved under a running writer',
        { guardFailures: guards },
        [...guards.map((g) => `  ✗ ${g}`), 'Merge or finish it first, or re-run with --force.'])
    }
  }

  const app = detectRunningApp()
  if (app.error) result.warnings.push(`could not check whether the starpath app is running (${app.error}) — quit it before migrating`)
  if (app.packagedPids.length) result.warnings.push(`a packaged starpath app is running (pid ${app.packagedPids.join(', ')}) — make sure it is not using this checkout`)
  if (app.pids.length && !FORCE) {
    refuseInit(result, 'app-running',
      `the starpath app is running from this checkout (pid ${app.pids.join(', ')}) — quit it first, or re-run with --force`,
      { pids: app.pids })
  }

  const facts = PRIVATE_ENTRIES.map(gatherFacts)
  const plan = planPrivate(facts, { mode: 'init', force: FORCE, repoRoots: REPO_ROOTS })
  for (const k of ['linked', 'created', 'skipped', 'conflicts', 'warnings']) result[k].push(...plan[k])

  // Manifest of everything that moves (links recorded, never followed).
  const before = []
  for (const p of plan.moved) walkRecords(p, join(REPO, p), before, { hash: !DRY_RUN })
  result.moved = countFilesByPath(before, plan.moved)
  result.manifest.files = before.filter((r) => r.type === 'file').length

  const breaks = predictLinkBreaks(before, { repoRoots: REPO_ROOTS, movedPaths: plan.moved })
  if (breaks.length) {
    const lines = breaks.map((b) => `${b.path} → ${b.target} (${b.reason})`)
    if (!FORCE) {
      refuseInit(result, 'link-breaks', `${breaks.length} link${breaks.length === 1 ? '' : 's'} inside the moved folders would stop resolving`,
        { linkBreaks: breaks }, lines.map((l) => `  ✗ ${l}`))
    }
    result.warnings.push(...lines.map((l) => `link will break: ${l}`))
  }

  // Files the public repo still tracks under a moving path would show up as
  // deletions there (untracking them is the fix, not a reason to refuse).
  if (plan.moved.length && isPublicRepo()) {
    const tracked = git(['ls-files', '--', ...plan.moved], REPO).stdout.split('\n').filter(Boolean)
    if (tracked.length) {
      result.warnings.push(`the public repo still tracks ${tracked.length} file${tracked.length === 1 ? '' : 's'} under ${plan.moved.join(', ')} — untrack with: git rm -r --cached --ignore-unmatch ${plan.moved.join(' ')} && git commit`)
    }
  }

  // rename() only works within one filesystem; never fall back to copying.
  if (plan.moved.length && privType === 'dir') {
    const dev = statSync(PRIV).dev
    const cross = plan.moved.filter((p) => statSync(join(REPO, p)).dev !== dev)
    if (cross.length) {
      refuseInit(result, 'cross-device', `private/ is on another filesystem than ${cross.join(', ')} — move it next to the repo first (init never copies)`)
    }
  }

  if (DRY_RUN) {
    result.git.wouldInitialise = !existsSync(join(PRIV, '.git'))
    if (result.conflicts.length) {
      Object.assign(result, {
        ok: false,
        error: 'conflicts',
        message: `${result.conflicts.length} path${result.conflicts.length === 1 ? '' : 's'} would be left in place (conflict)`,
      })
    }
    emit(result, humanInit(result, plan.ops), result.ok ? 0 : 1)
  }

  try {
    execute(plan.ops)
  } catch (err) {
    result.ok = false
    result.error = 'execute'
    result.message = err.message
  }

  // Re-hash through the new locations and compare.
  if (plan.moved.length) {
    const after = []
    for (const p of plan.moved) walkRecords(p, join(PRIV, p), after)
    const cmp = compareManifests(before, after)
    result.manifest.verified = cmp.verified
    result.manifest.mismatches = cmp.mismatches
    try {
      const dir = join(PRIV, '.cache')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, manifestFileName(new Date()))
      writeFileSync(file, JSON.stringify({
        createdAt: new Date().toISOString(),
        repoRoot: REPO,
        moved: result.moved,
        verified: cmp.verified,
        mismatches: cmp.mismatches,
        records: before,
      }, null, 2) + '\n', 'utf-8')
      result.manifest.path = file
    } catch (err) {
      result.warnings.push(`could not write the migration manifest: ${err.message}`)
    }
    if (!cmp.verified) {
      result.ok = false
      result.error = result.error || 'verify'
      result.message = result.message || `${cmp.mismatches.length} file${cmp.mismatches.length === 1 ? '' : 's'} did not arrive intact — see manifest.mismatches`
    }
  } else {
    result.manifest.verified = true
  }

  if (!result.error && isDir(PRIV)) result.placeholdersRemoved = removePlaceholders()

  // The private repo: only once the data arrived intact.
  if (!result.error && isDir(PRIV)) ensurePrivateGit(result)

  if (result.conflicts.length) {
    result.ok = false
    result.error = result.error || 'conflicts'
    result.message = result.message || `${result.conflicts.length} path${result.conflicts.length === 1 ? '' : 's'} left in place (conflict) — resolve and re-run`
  }
  emit(result, humanInit(result, plan.ops), result.ok ? 0 : 1)
}

function humanInit(r, ops) {
  const out = []
  out.push(`${r.dryRun ? 'Plan (dry run, nothing changed)' : 'private root'}: ${rel(r.privateRoot)}/`)
  for (const m of r.moved) out.push(`  ${r.dryRun ? 'would move' : 'moved'}   ${m.path} (${m.files} file${m.files === 1 ? '' : 's'}) → ${privateRelFor(m.path)}`)
  for (const p of r.created) out.push(`  ${r.dryRun ? 'would create' : 'created'} ${privateRelFor(p)}/`)
  for (const p of r.linked) {
    const op = ops.find((o) => o.op === 'symlink' && o.path === p)
    out.push(`  ${r.dryRun ? 'would link' : 'linked'}  ${p} → ${op ? op.target : privateRelFor(p)}`)
  }
  for (const s of r.skipped) out.push(`  ok      ${s.path} (${s.reason})`)
  for (const c of r.conflicts) out.push(`  CONFLICT ${c.path}: ${c.reason}`)
  if (r.placeholdersRemoved.length) out.push(`  removed ${r.placeholdersRemoved.length} placeholder .gitkeep file${r.placeholdersRemoved.length === 1 ? '' : 's'}`)
  if (r.dryRun) {
    out.push(`manifest: ${r.manifest.files} file${r.manifest.files === 1 ? '' : 's'} would be moved and verified`)
    out.push(`git: ${r.git.wouldInitialise ? 'would git init private/ and make the first commit' : 'private/ is already a git repo'}`)
  } else {
    if (r.moved.length) {
      out.push(r.manifest.verified
        ? `manifest: ${r.manifest.files} file${r.manifest.files === 1 ? '' : 's'} verified (sha256) → ${r.manifest.path ? rel(r.manifest.path) : 'not written'}`
        : `MANIFEST MISMATCH — ${r.manifest.mismatches.length} problem${r.manifest.mismatches.length === 1 ? '' : 's'}:`)
      for (const m of r.manifest.mismatches) out.push(`  ✗ ${m.path}: ${m.reason}`)
    }
    if (r.git.initialised) {
      out.push(r.git.committed
        ? `git: initialised private/ and committed "${INITIAL_COMMIT_MESSAGE}" (${(r.git.commit || '').slice(0, 7)})`
        : 'git: initialised private/ (first commit failed, see warnings)')
    } else if (!r.error) {
      out.push('git: private/ is already a git repo')
    }
  }
  for (const w of r.warnings) out.push(`warning: ${w}`)
  if (r.ok && !r.dryRun) {
    if (!r.moved.length && !r.linked.length && !r.created.length && !r.git.initialised) out.push('Everything is already in place.')
    else out.push(`Done. Back up with: npm run backup  (add a private remote first: ${remoteHint()})`)
  } else if (!r.ok) {
    out.push(`error: ${r.message}`)
  }
  return out
}

// ── status ──────────────────────────────────────────────────────────────────

function linkStates() {
  return LINKED_PATHS.map((entry) => {
    const f = gatherFacts(entry)
    const state = classifyRootPath(entry, f.root, REPO_ROOTS)
    return {
      path: entry.path,
      kind: entry.kind,
      expected: entry.link,
      state,
      target: f.root.linkTarget,
      privateExists: f.priv.type !== 'absent',
      ok: linkOk(entry.kind, state, f.priv.type),
    }
  })
}

function privateGitFacts() {
  if (!isPrivateRepo()) return { isRepo: false, branch: null, remote: null, uncommitted: null, lastCommit: null, unpushed: null }
  const remote = privateRemote()
  const last = git(['log', '-1', '--format=%ct%x09%s'])
  let lastCommit = null
  if (last.code === 0 && last.stdout) {
    const [ts, ...subject] = last.stdout.split('\t')
    const ms = Number(ts) * 1000
    lastCommit = { at: new Date(ms).toISOString(), ageDays: ageDays(ms, Date.now()), subject: subject.join('\t') }
  }
  let unpushed = null
  const ahead = git(['rev-list', '--count', '@{u}..HEAD'])
  if (ahead.code === 0) unpushed = Number(ahead.stdout) || 0
  return {
    isRepo: true,
    branch: currentBranch(),
    remote: remote ? remote.url : null,
    uncommitted: countPorcelain(git(['status', '--porcelain']).stdout),
    lastCommit,
    unpushed,
  }
}

function cmdStatus() {
  const exists = isDir(PRIV)
  const links = linkStates()
  const gitFacts = exists ? privateGitFacts() : { isRepo: false, branch: null, remote: null, uncommitted: null, lastCommit: null, unpushed: null }
  const ignored = publicIgnoresPrivate()
  const dataRoot = resolveDataRoot({ repoRoot: REPO })
  const problems = statusProblems({ exists, links, git: gitFacts, ignored })
  const json = {
    ok: true,
    healthy: problems.length === 0,
    repoRoot: REPO,
    privateRoot: PRIV,
    exists,
    dataRoot,
    links,
    linksOk: links.every((l) => l.ok),
    git: gitFacts,
    ignored,
    problems,
  }
  const human = [`private root: ${rel(PRIV)}/ ${exists ? '' : '(missing)'}`.trimEnd()]
  human.push(`data root: ${dataRoot.root} (${dataRoot.kind}, from ${dataRoot.source})`)
  for (const l of links) {
    human.push(`  ${l.ok ? 'ok ' : '!! '} ${l.path.padEnd(26)} ${l.state}${l.target ? ` → ${l.target}` : ''}`)
  }
  if (gitFacts.isRepo) {
    human.push(`git: branch ${gitFacts.branch ?? '?'} · remote ${gitFacts.remote ?? 'none'} · ${gitFacts.uncommitted} uncommitted change${gitFacts.uncommitted === 1 ? '' : 's'}`)
    human.push(`last commit: ${gitFacts.lastCommit ? `${formatAge(gitFacts.lastCommit.ageDays)} (${gitFacts.lastCommit.subject})` : 'none'}${gitFacts.unpushed ? ` · ${gitFacts.unpushed} not pushed` : ''}`)
    if (!gitFacts.remote) human.push(`no remote yet: ${remoteHint()}`)
  }
  human.push(`public repo ignores private/: ${ignored == null ? 'n/a (not a git repo)' : ignored ? 'yes' : 'NO'}`)
  for (const p of problems) human.push(`problem: ${p}`)
  emit(json, human, 0)
}

// ── backup ──────────────────────────────────────────────────────────────────

function cmdBackup() {
  const result = {
    ok: true, privateRoot: PRIV, committed: false, commit: null, message: null, changes: 0,
    pushed: false, remote: null, pushSkipped: null, hint: null,
  }
  if (!isDir(PRIV) || !isPrivateRepo()) {
    Object.assign(result, { ok: false, error: 'not-initialised', message: `${rel(PRIV)}/ is missing or not a git repo — run: npm run private -- init` })
    emit(result, [`error: ${result.message}`], 1)
  }

  git(['add', '-A'])
  result.changes = countPorcelain(git(['status', '--porcelain']).stdout)
  if (result.changes > 0) {
    const msg = argValue('-m', '--message') || backupMessage(new Date())
    const c = git([...identityArgs(), 'commit', '-q', '-m', msg])
    if (c.code !== 0) {
      Object.assign(result, { ok: false, error: 'commit', message: c.stderr || c.stdout || 'git commit failed' })
      emit(result, ['error: commit failed', ...(result.message ? [result.message] : [])], 1)
    }
    result.committed = true
    result.commit = headCommit()
    result.message = msg
  }

  const remote = privateRemote()
  result.remote = remote ? remote.url : null
  if (NO_PUSH) {
    result.pushSkipped = 'no-push'
  } else if (!remote) {
    result.pushSkipped = 'no-remote'
    result.hint = remoteHint()
  } else if (!headCommit()) {
    result.pushSkipped = 'no-commits'
  } else {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const branch = git(['symbolic-ref', '--short', 'HEAD']).stdout
    const p = upstream.code === 0 ? git(['push', '-q']) : git(['push', '-q', '-u', remote.name, branch])
    if (p.code !== 0) {
      Object.assign(result, { ok: false, error: 'push', stderr: p.stderr })
      emit(result, [
        result.committed ? `committed "${result.message}" (${result.commit.slice(0, 7)})` : 'nothing new to commit',
        `error: push to ${remote.name} failed`, p.stderr,
      ].filter(Boolean), 1)
    }
    result.pushed = true
  }

  const human = [
    result.committed
      ? `committed "${result.message}" (${result.commit.slice(0, 7)}, ${result.changes} change${result.changes === 1 ? '' : 's'})`
      : 'nothing new to commit',
  ]
  if (result.pushed) human.push(`pushed to ${remote.name} (${result.remote})`)
  else if (result.pushSkipped === 'no-remote') human.push(`no remote, so the backup stays on this machine. Add one: ${result.hint}`)
  else if (result.pushSkipped === 'no-push') human.push('not pushed (--no-push)')
  emit(result, human, 0)
}

// ── link ────────────────────────────────────────────────────────────────────

function cmdLink() {
  const result = {
    ok: true, dryRun: DRY_RUN, repoRoot: REPO, privateRoot: PRIV,
    linked: [], created: [], skipped: [], conflicts: [], warnings: [],
  }
  if (!isDir(PRIV)) {
    Object.assign(result, { ok: false, error: 'no-private-root', message: `${rel(PRIV)}/ not found — run: npm run private -- init` })
    emit(result, [`error: ${result.message}`], 1)
  }
  const plan = planPrivate(LINKED_PATHS.map(gatherFacts), { mode: 'link', force: FORCE, repoRoots: REPO_ROOTS })
  for (const k of ['linked', 'created', 'skipped', 'conflicts', 'warnings']) result[k].push(...plan[k])
  if (!DRY_RUN) {
    try { execute(plan.ops) } catch (err) {
      Object.assign(result, { ok: false, error: 'execute', message: err.message })
    }
  }
  if (result.conflicts.length) {
    result.ok = false
    result.error = result.error || 'conflicts'
    result.message = result.message || `${result.conflicts.length} path${result.conflicts.length === 1 ? '' : 's'} need attention`
  }
  const verb = DRY_RUN ? 'would ' : ''
  const human = [
    ...result.created.map((p) => `  ${verb}create ${privateRelFor(p)}/`),
    ...result.linked.map((p) => `  ${verb}link   ${p} → ${LINKED_PATHS.find((e) => e.path === p).link}`),
    ...result.conflicts.map((c) => `  CONFLICT ${c.path}: ${c.reason}`),
    ...result.warnings.map((w) => `warning: ${w}`),
  ]
  if (!result.linked.length && !result.created.length && !result.conflicts.length) human.push('All links are in place.')
  if (!result.ok) human.push(`error: ${result.message}`)
  emit(result, human, result.ok ? 0 : 1)
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const [command] = positionals()
switch (command) {
  case 'init': cmdInit(); break
  case 'status': cmdStatus(); break
  case 'backup': cmdBackup(); break
  case 'link': cmdLink(); break
  default:
    emit(
      { ok: false, error: 'usage', message: `unknown command '${command ?? ''}'` },
      [`usage: npm run private -- <init [--dry-run] [--force] | status | backup [-m <msg>] [--no-push] | link [--force]> [--json]`],
      command ? 1 : 0,
    )
}
