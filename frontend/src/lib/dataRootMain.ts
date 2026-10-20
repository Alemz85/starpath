// Data root — the Node half: pure helpers the Electron main process uses to
// map renderer paths, refuse demo writes, pick the chat folder and find the
// checkout in dev. Compiled into the main bundle (tsconfig.electron.json) and
// unit-tested in dataRootMain.test.ts; never imported by the renderer (it
// needs `path`).
//
// The decisions themselves come from the repo: `isPersonalPath` and
// `resolveDataRoot` live in scripts/lib/data-root.mjs, which main imports at
// runtime and hands in here as plain values — no TypeScript twin of the
// personal-path list.

import path from 'path'
import type { DataRootKind } from './dataRoot'
import { DEMO_READ_ONLY, DEMO_READ_ONLY_TOOLTIP } from './dataRoot'

export interface RootContext {
  /** Configured repo root (absolute). */
  repoPath: string
  /** Data root from resolveDataRoot; null when it could not be computed. */
  root: string | null
  kind: DataRootKind
  /** scripts/lib/data-root.mjs → isPersonalPath. */
  isPersonal: (rel: string) => boolean
}

/** Where a kind's personal paths are read from: the data root, or — with no
 *  private root yet — the repo itself (un-migrated checkouts keep working). */
export function personalBase(ctx: Pick<RootContext, 'repoPath' | 'root' | 'kind'>): string {
  return ctx.kind === 'none' || !ctx.root ? ctx.repoPath : ctx.root
}

function inside(base: string, abs: string): boolean {
  const rel = path.relative(base, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Normalise a renderer-supplied repo-relative path: forward slashes, no `.`
 * segments, `..` folded. Null when it climbs out (`../x`, `data/../../x`).
 * Absolute paths are handled by resolveAppPath.
 */
export function normalizeRel(rel: string): string | null {
  const s = String(rel).replace(/\\/g, '/')
  const norm = path.posix.normalize(s === '' ? '.' : s)
  if (norm === '..' || norm.startsWith('../')) return null
  if (norm === '.' || norm === './') return ''
  return norm.replace(/^\.\//, '').replace(/\/+$/, '')
}

export interface ResolvedAppPath {
  abs: string
  /** The folder `abs` is confined to (results of a walk are relative to it). */
  base: string
  /** Served from the data root (a personal path on a migrated layout). */
  personal: boolean
  /** Normalised repo-relative form ('' for the base itself). */
  rel: string
}

/**
 * Map one renderer path to disk. Personal paths (`data/…`, `user/…`,
 * `reports/…`, `profiles/…`) resolve under the data root; everything else
 * under the repo. Either way the result is confined to its base: anything
 * that escapes is refused (null). An absolute path is accepted only when it
 * already sits inside the repo or the data root.
 */
export function resolveAppPath(ctx: RootContext, input: string): ResolvedAppPath | null {
  if (typeof input !== 'string') return null
  const repo = path.resolve(ctx.repoPath)
  const dataBase = path.resolve(personalBase(ctx))
  let relInput = input
  if (path.isAbsolute(input)) {
    const abs = path.resolve(input)
    // A data root outside the repo (external) — or inside it (private/,
    // demo/) — is addressed directly when the caller already has its path.
    if (dataBase !== repo && inside(dataBase, abs)) {
      return { abs, base: dataBase, personal: true, rel: path.relative(dataBase, abs).split(path.sep).join('/') }
    }
    if (!inside(repo, abs)) return null
    relInput = path.relative(repo, abs)
  }
  const rel = normalizeRel(relInput)
  if (rel === null) return null
  // Showing the demo to someone must never surface the real data: private/
  // is unreachable by name while the demo is active.
  if (ctx.kind === 'demo' && rel.split('/')[0] === 'private') return null
  const personal = rel !== '' && ctx.kind !== 'none' && !!ctx.root && ctx.isPersonal(rel)
  const base = personal ? dataBase : repo
  const abs = path.resolve(base, rel)
  if (!inside(base, abs)) return null
  return { abs, base, personal, rel }
}

/** Top-level folders a demo-mode write can never touch, personal or not. */
const DEMO_PROTECTED_PREFIXES = ['demo', 'private']

/**
 * Demo is read-only: any write to a personal path, or into demo/ or private/
 * by their repo-relative names, is refused. Returns the error message to
 * throw (starting with the `demo-read-only` code), or null when allowed.
 */
export function demoWriteRefusal(
  kind: DataRootKind,
  target: { rel: string; personal?: boolean },
  isPersonal: (rel: string) => boolean,
): string | null {
  if (kind !== 'demo') return null
  const norm = normalizeRel(target.rel) ?? target.rel
  const top = norm.split('/')[0]
  if (target.personal || isPersonal(norm) || DEMO_PROTECTED_PREFIXES.includes(top)) {
    return `${DEMO_READ_ONLY}: ${DEMO_READ_ONLY_TOOLTIP}`
  }
  return null
}

/** The refusal message for spawned work (scans, evals, chat) in demo mode. */
export function demoSpawnRefusal(kind: DataRootKind): string | null {
  return kind === 'demo' ? `${DEMO_READ_ONLY}: ${DEMO_READ_ONLY_TOOLTIP}` : null
}

/**
 * One-shot runs allowed in demo mode: the read-only digests that resolve
 * their data through $STARPATH_DATA (daily brief, follow-up cadence, pattern
 * analysis). Everything else may write, so demo refuses it.
 */
const DEMO_READ_ONLY_SCRIPTS = new Set([
  'scripts/daily-brief.mjs',
  'scripts/followup-cadence.mjs',
  'scripts/analyze-patterns.mjs',
])

export function demoAllowsRun(cmd: string, args: readonly string[]): boolean {
  if (cmd !== 'node') return false
  const script = normalizeRel(args[0] ?? '')
  return !!script && DEMO_READ_ONLY_SCRIPTS.has(script)
}

/**
 * Env additions for spawned scripts and CLIs: `STARPATH_DATA` points them at
 * the demo or an external root (scripts read through dataRootFor). The
 * private root needs nothing — the repo-root links already lead there.
 */
export function spawnEnvFor<E extends Record<string, string | undefined>>(
  base: E,
  ctx: { kind: DataRootKind; root: string | null },
): E {
  if ((ctx.kind === 'demo' || ctx.kind === 'external') && ctx.root) {
    return { ...base, STARPATH_DATA: ctx.root }
  }
  return base
}

// ─── Chat folder ─────────────────────────────────────────────────────────────

/**
 * Where chat sessions live: inside the data root for private/external (so
 * they are backed up with the rest of it), a separate app-data folder for the
 * demo (never mixed with real conversations), and the legacy app-data folder
 * when there is no private root yet.
 */
export function chatDirFor(input: { kind: DataRootKind; root: string | null; userDataDir: string }): string {
  if ((input.kind === 'private' || input.kind === 'external') && input.root) {
    return path.join(input.root, 'chat')
  }
  if (input.kind === 'demo') return path.join(input.userDataDir, 'chat-demo')
  return path.join(input.userDataDir, 'chat')
}

/**
 * One-time move of `{userData}/chat/` into the data root: only when the
 * target is a real data root, the legacy folder holds a sessions file, and
 * nothing is at the target yet (never merge, never overwrite).
 */
export function planChatMigration(input: {
  kind: DataRootKind
  root: string | null
  userDataDir: string
  exists: (p: string) => boolean
}): { from: string; to: string } | null {
  if (input.kind !== 'private' && input.kind !== 'external') return null
  if (!input.root) return null
  const from = path.join(input.userDataDir, 'chat')
  const to = path.join(input.root, 'chat')
  if (from === to) return null
  if (!input.exists(path.join(from, 'sessions.json'))) return null
  if (input.exists(to)) return null
  return { from, to }
}

// ─── Dev repo detection ──────────────────────────────────────────────────────

/** A career-ops checkout root: CLAUDE.md and scripts/ side by side. */
export function isRepoRoot(dir: string, exists: (p: string) => boolean): boolean {
  return exists(path.join(dir, 'CLAUDE.md')) && exists(path.join(dir, 'scripts'))
}

/**
 * Walk up from each start folder (the compiled main's __dirname, the app
 * path) to the first checkout root. Used in dev when no repo is configured
 * yet: the app runs from `<repo>/frontend`, so the checkout is right above.
 */
export function findRepoRoot(starts: readonly string[], exists: (p: string) => boolean): string | null {
  for (const start of starts) {
    if (!start) continue
    let dir = path.resolve(start)
    for (;;) {
      if (isRepoRoot(dir, exists)) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** Cache file slug: the demo has its own cache; otherwise the active profile. */
export function cacheSlugFor(kind: DataRootKind, activeProfile: string | null): string {
  if (kind === 'demo') return 'demo'
  return activeProfile ?? 'default'
}
