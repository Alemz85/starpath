/**
 * private-core.mjs — pure logic for the private root (`private/`).
 *
 * Everything personal lives in `<repo>/private/` (its own git repo); the
 * repo-root paths in data-root.mjs › LINKED_PATHS are relative links into it,
 * and `profiles/` moves in with no link. scripts/private.mjs is the thin I/O
 * CLI (init / status / backup / link); this module owns the judgment:
 *
 *   - classifying each repo-root path (absent / real / linked / wrong /
 *     dangling) against what is already in private/,
 *   - the declarative migration + link-repair plans,
 *   - predicting which symlinks inside the moved folders would stop resolving,
 *   - comparing the before/after sha256 manifests,
 *   - the files `init` writes into private/ (.gitignore, README, the
 *     pre-commit hook that keeps code out of the private repo),
 *   - small helpers for status, backup, running-app detection, and the
 *     override drift report shared by scripts/overrides.mjs and doctor.
 *
 * PURE: no filesystem, no child processes, no process.exit. Unit-tested in
 * private-core.test.mjs. System layer: no user data, examples are fictional.
 */

import { posix } from 'node:path'
import { LINKED_PATHS, UNLINKED_PERSONAL, PRIVATE_DIR, isPersonalPath } from './data-root.mjs'

// ── What lives in private/ ──────────────────────────────────────────────────

/** Personal paths that move into private/ with NO repo-root link (profiles/). */
export const MOVE_ONLY_PATHS = UNLINKED_PERSONAL.map((path) => ({ path, kind: 'dir', link: null }))

/** Everything `init` handles: the linked paths, then the move-only ones. */
export const PRIVATE_ENTRIES = [...LINKED_PATHS, ...MOVE_ONLY_PATHS]

/** Repo-relative location of an entry inside the private root. */
export function privateRelFor(path) {
  return `${PRIVATE_DIR}/${path}`
}

/** Children of a real folder that do not count as content (safe to drop). */
export const IGNORABLE_CHILDREN = ['.gitkeep', '.DS_Store']

/** A tracked-placeholder file that means nothing inside private/. */
export function isPlaceholderFile(name, size) {
  return name === '.gitkeep' && size === 0
}

// ── Classification ──────────────────────────────────────────────────────────

const toPosix = (p) => String(p).replace(/\\/g, '/')
const trimSlash = (p) => p.replace(/\/+$/, '') || '/'

/**
 * Does a symlink at repo-relative `linkRel` with raw readlink value
 * `linkTarget` point at repo-relative `expectedRel`? Relative targets are
 * resolved with pure path math; absolute ones are compared against every
 * spelling of the repo root in `repoRoots` (e.g. the path and its realpath).
 */
export function linkPointsAt(linkRel, linkTarget, expectedRel, repoRoots = []) {
  if (typeof linkTarget !== 'string' || linkTarget === '') return false
  const t = toPosix(linkTarget)
  if (posix.isAbsolute(t)) {
    const clean = trimSlash(posix.normalize(t))
    return repoRoots.some((r) => clean === posix.join(toPosix(r), expectedRel))
  }
  const resolved = trimSlash(posix.normalize(posix.join(posix.dirname(linkRel), t)))
  return resolved === expectedRel
}

/**
 * State of a repo-root path:
 *   'absent'   nothing there
 *   'real'     a real folder or file (data to move, or a shadow)
 *   'linked'   a link to private/<path> (its target may still be missing)
 *   'wrong'    a link to somewhere else that exists
 *   'dangling' a link to somewhere else that does not exist
 *
 * @param {{ path: string }} entry
 * @param {{ type: 'absent'|'dir'|'file'|'symlink'|'other', linkTarget?: string|null, targetExists?: boolean }} root
 * @param {string[]} [repoRoots]
 */
export function classifyRootPath(entry, root, repoRoots = []) {
  if (!root || root.type === 'absent') return 'absent'
  if (root.type !== 'symlink') return 'real'
  if (linkPointsAt(entry.path, root.linkTarget, privateRelFor(entry.path), repoRoots)) return 'linked'
  return root.targetExists ? 'wrong' : 'dangling'
}

/**
 * Plan the migration (`mode: 'init'`) or a link repair (`mode: 'link'`).
 *
 * @param {Array<{ entry: {path, kind, link}, root: object, priv: { type: string } , rootEmpty?: boolean }>} factsList
 *   One item per PRIVATE_ENTRIES entry, gathered by the CLI. `rootEmpty` is
 *   true for a real folder holding nothing but IGNORABLE_CHILDREN.
 * @param {{ mode?: 'init'|'link', force?: boolean, repoRoots?: string[] }} opts
 * @returns {{
 *   ops: Array<object>,
 *   moved: string[], linked: string[], created: string[],
 *   skipped: Array<{path, reason}>, conflicts: Array<{path, reason}>, warnings: string[],
 *   states: Array<{ path, state }>,
 * }}
 *
 * Op vocabulary (executed in this order, grouped by phase):
 *   { op: 'ensure-dir', path }            mkdir -p (repo-relative)
 *   { op: 'move', from, to, path }        fs.renameSync, never a copy
 *   { op: 'remove-empty-dir', path }      drop IGNORABLE_CHILDREN, then rmdir
 *   { op: 'unlink', path }                remove a wrong/dangling link
 *   { op: 'symlink', path, target, kind } create the relative link
 */
export function planPrivate(factsList, { mode = 'init', force = false, repoRoots = [] } = {}) {
  const phases = { prepare: [], move: [], create: [], clear: [], link: [] }
  const out = { moved: [], linked: [], created: [], skipped: [], conflicts: [], warnings: [], states: [] }
  const ensured = new Set()
  const ensure = (phase, rel) => {
    if (!rel || rel === '.' || ensured.has(rel)) return
    ensured.add(rel)
    phases[phase].push({ op: 'ensure-dir', path: rel })
  }
  ensure('prepare', PRIVATE_DIR)

  for (const facts of factsList) {
    const { entry, root, priv = { type: 'absent' }, rootEmpty = false } = facts
    const { path, kind } = entry
    const privRel = privateRelFor(path)
    const moveOnly = entry.link == null
    const state = classifyRootPath(entry, root, repoRoots)
    out.states.push({ path, state })
    const privPresent = priv.type !== 'absent'
    const privWrongType = privPresent && (kind === 'dir' ? priv.type !== 'dir' : priv.type === 'dir')

    if (moveOnly && mode === 'link') continue // link never touches move-only paths

    const link = () => {
      ensure('prepare', posix.dirname(path))
      phases.link.push({ op: 'symlink', path, target: entry.link, kind })
      out.linked.push(path)
    }
    const ensurePrivate = () => {
      if (kind === 'dir') {
        if (!privPresent) {
          ensure('create', privRel)
          out.created.push(path)
        }
      } else {
        ensure('prepare', posix.dirname(privRel)) // writers create the file through the link
      }
    }

    if (privWrongType) {
      out.conflicts.push({
        path,
        reason: `${privRel} is a ${priv.type === 'dir' ? 'folder' : 'file'}, expected a ${kind === 'dir' ? 'folder' : 'file'}`,
      })
      continue
    }

    if (moveOnly) {
      if (state === 'absent') {
        out.skipped.push({ path, reason: privPresent ? `already in ${privRel}` : 'not present' })
      } else if (state !== 'real') {
        out.skipped.push({ path, reason: 'is a link (left as is)' })
        out.warnings.push(`${path} is a link at the repo root; ${path}/ belongs in ${privRel}/ with no link`)
      } else if (root.type !== 'dir') {
        out.conflicts.push({ path, reason: `${path} is a file, expected a folder` })
      } else if (!privPresent) {
        ensure('prepare', posix.dirname(privRel))
        phases.move.push({ op: 'move', from: path, to: privRel, path })
        out.moved.push(path)
      } else if (rootEmpty) {
        phases.clear.push({ op: 'remove-empty-dir', path })
        out.skipped.push({ path, reason: `already in ${privRel} (removed an empty ${path}/ at the repo root)` })
      } else {
        out.conflicts.push({ path, reason: `both ${path}/ and ${privRel}/ exist — merge them by hand, then re-run` })
      }
      continue
    }

    switch (state) {
      case 'absent':
        ensurePrivate()
        link()
        break

      case 'linked':
        if (kind === 'dir' && !privPresent) {
          ensurePrivate()
        } else {
          if (kind === 'file') ensurePrivate()
          out.skipped.push({ path, reason: 'already linked' })
        }
        break

      case 'dangling':
        phases.clear.push({ op: 'unlink', path })
        out.warnings.push(`re-pointed dangling link ${path} (was → ${root.linkTarget})`)
        ensurePrivate()
        link()
        break

      case 'wrong':
        if (!force) {
          out.conflicts.push({
            path,
            reason: `link points to ${root.linkTarget}, not ${entry.link} — re-run with --force to re-point it (nothing behind the old target is moved)`,
          })
          break
        }
        phases.clear.push({ op: 'unlink', path })
        out.warnings.push(`re-pointed ${path} (was → ${root.linkTarget}; nothing was moved from there)`)
        ensurePrivate()
        link()
        break

      case 'real': {
        const realKind = root.type === 'dir' ? 'dir' : 'file'
        if (realKind !== kind) {
          out.conflicts.push({ path, reason: `${path} is a ${realKind === 'dir' ? 'folder' : 'file'}, expected a ${kind === 'dir' ? 'folder' : 'file'}` })
          break
        }
        if (kind === 'dir' && rootEmpty && (privPresent || mode === 'link')) {
          // An empty folder (only .gitkeep / .DS_Store) carries no data.
          phases.clear.push({ op: 'remove-empty-dir', path })
          out.warnings.push(`removed an empty ${path}/ at the repo root`)
          ensurePrivate()
          link()
          break
        }
        if (mode === 'link') {
          out.conflicts.push({
            path,
            reason: privPresent
              ? `real ${kind === 'dir' ? 'folder' : 'file'} at ${path} shadows ${privRel} — merge it into ${privRel} by hand, delete it, then run: npm run private -- link`
              : `real ${kind === 'dir' ? 'folder' : 'file'} at ${path} — run: npm run private -- init (moves it into ${privRel})`,
          })
          break
        }
        if (privPresent) {
          out.conflicts.push({
            path,
            reason: `both ${path} and ${privRel} exist — merge them by hand (nothing was moved), then re-run`,
          })
          break
        }
        ensure('prepare', posix.dirname(privRel))
        phases.move.push({ op: 'move', from: path, to: privRel, path })
        out.moved.push(path)
        link()
        break
      }
    }
  }

  const ops = [...phases.prepare, ...phases.move, ...phases.create, ...phases.clear, ...phases.link]
  return { ops, ...out }
}

// ── Manifests ───────────────────────────────────────────────────────────────

/**
 * Manifest records (built by the CLI by walking each to-be-moved path; links
 * are recorded, never followed):
 *   { path, type: 'file', size, sha256 }
 *   { path, type: 'link', target, resolves }
 *   { path, type: 'dir' }
 * `path` is always the PRE-move repo-relative path (e.g. `data/scouting.md`).
 */

/**
 * Symlinks inside the to-be-moved folders that resolve today but would stop
 * resolving after the move: relative links whose target is not itself moving
 * into private/, and absolute links into a moving path.
 *
 * @param {Array<{path, type, target, resolves}>} records
 * @param {{ repoRoots?: string[], movedPaths?: string[] }} opts
 * @returns {Array<{ path, target, reason }>}
 */
export function predictLinkBreaks(records, { repoRoots = [], movedPaths = [] } = {}) {
  const breaks = []
  const underMoved = (rel) => movedPaths.some((m) => rel === m || rel.startsWith(m + '/'))
  for (const r of records) {
    if (r.type !== 'link' || !r.resolves) continue
    const t = toPosix(r.target)
    if (posix.isAbsolute(t)) {
      const clean = trimSlash(posix.normalize(t))
      for (const root of repoRoots) {
        const base = posix.join(toPosix(root), '/')
        if (clean.startsWith(base) && underMoved(clean.slice(base.length))) {
          breaks.push({ path: r.path, target: r.target, reason: 'absolute link into a folder that moves to private/' })
          break
        }
      }
      continue
    }
    // After the move the link sits one level deeper (private/<path>), so a
    // relative target keeps resolving exactly when what it points at moves
    // into private/ too (and it never climbed out of the repo).
    const before = posix.normalize(posix.join(posix.dirname(r.path), t))
    if (!(isPersonalPath(before) || underMoved(before))) {
      breaks.push({ path: r.path, target: r.target, reason: `relative link to ${before}, which does not move to private/` })
    }
  }
  return breaks
}

/**
 * Compare the pre-move manifest with the one re-hashed through the new
 * locations (same pre-move keys). Every file must arrive byte-identical and
 * every link that resolved before must still resolve.
 *
 * @returns {{ verified: boolean, files: number, mismatches: Array<{ path, reason }> }}
 */
export function compareManifests(before, after) {
  const byPath = new Map(after.map((r) => [r.path, r]))
  const mismatches = []
  for (const b of before) {
    const a = byPath.get(b.path)
    if (!a) { mismatches.push({ path: b.path, reason: 'missing after the move' }); continue }
    if (a.type !== b.type) { mismatches.push({ path: b.path, reason: `was a ${b.type}, now a ${a.type}` }); continue }
    if (b.type === 'file' && (a.size !== b.size || a.sha256 !== b.sha256)) {
      mismatches.push({ path: b.path, reason: 'content changed during the move' })
    } else if (b.type === 'link') {
      if (a.target !== b.target) mismatches.push({ path: b.path, reason: `link target changed (${b.target} → ${a.target})` })
      else if (b.resolves && !a.resolves) mismatches.push({ path: b.path, reason: `link no longer resolves (→ ${b.target})` })
    }
  }
  return {
    verified: mismatches.length === 0,
    files: before.filter((r) => r.type === 'file').length,
    mismatches,
  }
}

/** File count per moved top-level path, from manifest records. */
export function countFilesByPath(records, paths) {
  return paths.map((p) => ({
    path: p,
    files: records.filter((r) => r.type === 'file' && (r.path === p || r.path.startsWith(p + '/'))).length,
  }))
}

/** `migration-2026-10-20T09-05-00Z.json` — filesystem-safe ISO timestamp. */
export function manifestFileName(date) {
  return `migration-${date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.json`
}

// ── Files init writes into private/ ─────────────────────────────────────────

export const PRIVATE_GITIGNORE = '.cache/\n.DS_Store\nnode_modules\n'

export const PRIVATE_README = `# private/

Your personal starpath data: CV, profile, trackers, reports, interview prep,
generated CVs, batch state, chat history, and your own versions of system
files (\`overrides/\`). The public starpath repo ignores this folder; it is its
own git repository, with its own history and its own (private) remote.

- **Never put app code here.** Scripts, packages and \`package.json\` belong in
  the public repo; \`.githooks/pre-commit\` refuses them.
- **Back up with \`npm run backup\`** (commits this folder and pushes it). Add
  a private remote once: \`git -C private remote add origin <url>\`.
- \`npm run private -- status\` shows the links and the backup state;
  \`npm run doctor\` checks the whole setup.
- \`.cache/\` holds derived files (composed prompts, migration manifests) and
  is not committed.
`

/** Staged paths the private repo refuses (app code never lands here). */
export const CODE_FILE_PATTERNS = ['*.mjs', '*.js', '*.cjs', '*.ts', '*.tsx', '*.jsx', '*.py', 'package.json', 'package-lock.json']

/** The same rule as a regex over repo-relative paths (mirrors the hook). */
export const CODE_FILE_RE = /(\.(mjs|js|cjs|ts|tsx|jsx|py)$|(^|\/)package(-lock)?\.json$)/

export const PRE_COMMIT_HOOK = `#!/bin/sh
# private/.githooks/pre-commit, written by \`npm run private -- init\`.
# This repo holds personal data only; app code belongs in the public repo.
# Refused: ${CODE_FILE_PATTERNS.join(' ')}
blocked=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '(\\.(mjs|js|cjs|ts|tsx|jsx|py)$|(^|/)package(-lock)?\\.json$)')
if [ -n "$blocked" ]; then
  echo "private repo: refusing to commit code files (app code belongs in the public repo):" >&2
  echo "$blocked" | sed 's/^/  /' >&2
  echo "Unstage them with: git -C private reset -q -- <file>" >&2
  exit 1
fi
exit 0
`

export const INITIAL_COMMIT_MESSAGE = 'Initial import of personal data'

// ── Status / backup helpers ─────────────────────────────────────────────────

/** Number of entries in `git status --porcelain` output. */
export function countPorcelain(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim() !== '').length
}

const pad = (n) => String(n).padStart(2, '0')

/** `backup YYYY-MM-DD HH:MM` in local time. */
export function backupMessage(date) {
  return `backup ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Whole days between two epoch-ms instants (null when `thenMs` is null). */
export function ageDays(thenMs, nowMs) {
  if (thenMs == null || !Number.isFinite(thenMs)) return null
  return Math.max(0, Math.floor((nowMs - thenMs) / 86400000))
}

/** `today` / `1 day ago` / `12 days ago`. */
export function formatAge(days) {
  if (days == null) return 'never'
  if (days === 0) return 'today'
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** What to tell the user when private/ has no remote yet. */
export function remoteHint() {
  return 'git -C private remote add origin <url> && npm run backup'
}

/** One-line problems for `private status` (empty = healthy). */
export function statusProblems({ exists, links = [], git = {}, ignored = null }) {
  const problems = []
  if (!exists) {
    problems.push('private/ does not exist — run: npm run private -- init')
    return problems
  }
  const bad = links.filter((l) => !l.ok)
  if (bad.length) problems.push(`${bad.length} link${bad.length === 1 ? '' : 's'} not in place: ${bad.map((l) => `${l.path} (${l.state})`).join(', ')}`)
  if (!git.isRepo) problems.push('private/ is not a git repo — run: npm run private -- init')
  if (ignored === false) problems.push('private/ is NOT ignored by the public repo')
  return problems
}

/**
 * Is a link healthy? Dir links need their private/ folder; file links may
 * dangle (writers create the file through them).
 */
export function linkOk(kind, state, privType) {
  if (state !== 'linked') return false
  return kind === 'file' ? privType !== 'dir' : privType === 'dir'
}

// ── Running-app detection ───────────────────────────────────────────────────

/** Parse `ps -axo pid=,ppid=,command=` output. */
export function parsePs(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  return rows
}

/**
 * The starpath app's MAIN processes that could be using this checkout,
 * excluding Electron helpers (`--type=…`) and our own ancestors (the app
 * spawning `private init` is fine). A dev build runs the Electron binary
 * from <repo>/frontend/node_modules/electron/; a build packaged into
 * <repo>/frontend/dist/ counts too. A packaged app elsewhere can't be tied
 * to a checkout, so it is reported separately (warning only).
 *
 * @returns {{ pids: number[], packagedPids: number[] }}
 */
export function findRunningApp(rows, { repoRoot, selfPid }) {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]))
  const ancestors = new Set()
  for (let p = selfPid, guard = 0; p && guard < 64; p = parent.get(p), guard++) ancestors.add(p)
  const frontend = toPosix(repoRoot).replace(/\/+$/, '') + '/frontend/'
  const packaged = /\/starpath\.app\/Contents\/MacOS\/starpath(\s|$)/
  const pids = []
  const packagedPids = []
  for (const r of rows) {
    if (ancestors.has(r.pid) || /--type=/.test(r.command)) continue
    const cmd = toPosix(r.command)
    if (cmd.includes(frontend + 'node_modules/electron/')) pids.push(r.pid)
    else if (packaged.test(cmd)) (cmd.includes(frontend) ? pids : packagedPids).push(r.pid)
  }
  return { pids, packagedPids }
}

// ── Overrides report (shared by scripts/overrides.mjs and doctor) ───────────

/**
 * Add drift facts to listOverrides() entries. Drift = the repo default was
 * committed after the override file was last modified.
 *
 * @param {Array<{rel, target, mode, valid, defaultExists, path}>} entries
 * @param {{ commitTimeFor: (target: string) => number|null, mtimeFor: (path: string) => number|null }} probes
 *   commitTimeFor → seconds since epoch of the last public-repo commit touching target
 *   mtimeFor      → epoch ms of the override file's mtime
 */
export function annotateOverrides(entries, { commitTimeFor, mtimeFor }) {
  const cache = new Map()
  return entries.map((e) => {
    if (!cache.has(e.target)) cache.set(e.target, e.valid && e.defaultExists !== false ? commitTimeFor(e.target) : null)
    const defaultCommittedAt = cache.get(e.target)
    const overrideModifiedAt = mtimeFor(e.path)
    const drift = defaultCommittedAt != null && overrideModifiedAt != null &&
      defaultCommittedAt * 1000 > overrideModifiedAt
    return {
      ...e,
      defaultCommittedAt: defaultCommittedAt != null ? new Date(defaultCommittedAt * 1000).toISOString() : null,
      overrideModifiedAt: overrideModifiedAt != null ? new Date(overrideModifiedAt).toISOString() : null,
      drift,
    }
  })
}

/** Group annotated entries by target: [{ target, modes: ['replace','append'], drift, valid }]. */
export function groupOverrides(entries) {
  const byTarget = new Map()
  for (const e of entries) {
    const g = byTarget.get(e.target) ?? { target: e.target, modes: [], drift: false, valid: true, defaultExists: e.defaultExists }
    if (!g.modes.includes(e.mode)) g.modes.push(e.mode)
    g.drift = g.drift || !!e.drift
    g.valid = g.valid && e.valid
    byTarget.set(e.target, g)
  }
  return [...byTarget.values()]
    .map((g) => ({ ...g, modes: ['replace', 'append'].filter((m) => g.modes.includes(m)) }))
    .sort((a, b) => a.target.localeCompare(b.target))
}

/**
 * The SessionStart brief: [] when there is nothing to say, else 1–3 lines.
 * @param {Array} entries annotated entries
 * @param {{ overridesDir?: string }} opts how to name the overrides folder
 */
export function formatOverridesBrief(entries, { overridesDir = 'private/overrides' } = {}) {
  const groups = groupOverrides(entries)
  const active = groups.filter((g) => g.valid)
  const ignored = groups.filter((g) => !g.valid)
  const lines = []
  if (active.length) {
    lines.push(
      `Private overrides active in ${overridesDir}/ (read these instead of / after the repo defaults): ` +
      active.map((g) => `${g.target} (${g.modes.join(' + ')})`).join(', ') + '.'
    )
  }
  const drifted = active.filter((g) => g.drift)
  if (drifted.length) {
    const many = drifted.length > 1
    lines.push(`Drift: ${drifted.map((g) => g.target).join(', ')} ${many ? 'defaults' : 'default'} changed since your ${many ? 'overrides' : 'override'}.`)
  }
  if (ignored.length) {
    lines.push(`Ignored (not overridable): ${ignored.map((g) => g.target).join(', ')}.`)
  }
  return lines
}
