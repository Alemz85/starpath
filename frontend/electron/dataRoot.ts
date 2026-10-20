// Data root — main-process I/O half.
//
// Where personal data lives is decided by the repo's own resolver,
// scripts/lib/data-root.mjs (resolveDataRoot + isPersonalPath), imported at
// runtime from the configured checkout — the same pattern as the network
// lens. There is no TypeScript twin: if the repo predates the module, the app
// falls back to kind 'none' (today's repo-relative behaviour).
//
// The pure parts (path mapping, refusals, chat folder) are in
// src/lib/dataRootMain.ts; this file only loads modules and probes the disk.

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import type { DataRootInfo, DataRootKind, DataRootSource } from '../src/lib/dataRoot'
import { DEMO_DATA_PATH } from '../src/lib/dataRoot'
import type { RootContext } from '../src/lib/dataRootMain'

// ESM cores from a CommonJS main: a real dynamic import(), kept out of tsc's
// reach so it is not down-compiled to require().
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function('s', 'return import(s)') as
  (s: string) => Promise<Record<string, unknown>>

// Cached per absolute file — modules are code, not data, and Node's ESM cache
// can't be evicted anyway. A failed import is not cached, so a repo updated
// mid-session is retried on the next call.
const moduleCache = new Map<string, Promise<unknown>>()

export function importRepoModule<T>(repoPath: string, rel: string): Promise<T> {
  const file = path.join(repoPath, rel)
  const hit = moduleCache.get(file)
  if (hit) return hit as Promise<T>
  const mod = dynamicImport(pathToFileURL(file).href)
  moduleCache.set(file, mod)
  mod.catch(() => { moduleCache.delete(file) })
  return mod as unknown as Promise<T>
}

interface DataRootModule {
  resolveDataRoot: (opts: {
    repoRoot: string
    configured: string | null
    env: Record<string, string | undefined>
    allowDemo: boolean
  }) => { root: string; kind: DataRootKind; source: DataRootSource }
  isPersonalPath: (rel: string) => boolean
}

export interface OverridesModule {
  materializeSystemFile: (opts: { repoRoot: string; dataRoot: string; rel: string }) => string
}

export interface DataRootState {
  repoPath: string | null
  root: string | null
  kind: DataRootKind
  source: DataRootSource
  isPersonal: (rel: string) => boolean
  demoAvailable: boolean
  privateExists: boolean
  ownDataAvailable: boolean
}

const NOTHING_PERSONAL = (): boolean => false

/**
 * Resolve the data root for a repo. `configured` is config.json `dataPath`
 * ('demo' or absent). allowDemo is false: the demo is only ever an explicit
 * choice, never a silent fallback.
 */
export async function computeDataRoot(
  repoPath: string | null,
  configured: string | null,
  env: Record<string, string | undefined>,
): Promise<DataRootState> {
  if (!repoPath) {
    return {
      repoPath: null, root: null, kind: 'none', source: 'default', isPersonal: NOTHING_PERSONAL,
      demoAvailable: false, privateExists: false, ownDataAvailable: false,
    }
  }
  const exists = (rel: string) => fs.existsSync(path.join(repoPath, rel))
  const demoAvailable = exists('demo')
  const privateExists = exists('private')
  const legacyOwnData = exists('user') || exists('data')

  let root: string | null = null
  let kind: DataRootKind = 'none'
  let source: DataRootSource = 'default'
  let isPersonal: (rel: string) => boolean = NOTHING_PERSONAL
  try {
    const mod = await importRepoModule<DataRootModule>(repoPath, 'scripts/lib/data-root.mjs')
    let r = mod.resolveDataRoot({ repoRoot: repoPath, configured, env, allowDemo: false })
    // A saved demo choice whose folder has gone (a checkout without demo/)
    // must not strand the user on an empty read-only app.
    if (r.kind === 'demo' && !fs.existsSync(r.root) && configured === DEMO_DATA_PATH) {
      console.warn('[data-root] demo/ is missing; ignoring the saved demo choice')
      r = mod.resolveDataRoot({ repoRoot: repoPath, configured: null, env, allowDemo: false })
    }
    root = r.root
    kind = r.kind
    source = r.source
    isPersonal = (rel: string) => mod.isPersonalPath(rel)
  } catch (e) {
    console.error('[data-root] scripts/lib/data-root.mjs unavailable; using repo-relative paths:', e instanceof Error ? e.message : e)
  }
  return {
    repoPath, root, kind, source, isPersonal, demoAvailable, privateExists,
    ownDataAvailable: privateExists || kind === 'external' || legacyOwnData,
  }
}

export function toInfo(s: DataRootState): DataRootInfo {
  return {
    root: s.root,
    kind: s.kind,
    source: s.source,
    repoPath: s.repoPath,
    demoAvailable: s.demoAvailable,
    privateExists: s.privateExists,
    ownDataAvailable: s.ownDataAvailable,
  }
}

/** RootContext for the pure mappers; null while no repo is configured. */
export function rootContext(s: DataRootState): RootContext | null {
  if (!s.repoPath) return null
  return { repoPath: s.repoPath, root: s.root, kind: s.kind, isPersonal: s.isPersonal }
}

/** Did a recompute move the data somewhere else (cache/watcher/chat swap)? */
export function dataRootMoved(prev: DataRootState | null, next: DataRootState): boolean {
  if (!prev) return true
  return prev.repoPath !== next.repoPath || prev.root !== next.root || prev.kind !== next.kind
}

/**
 * Move `{userData}/chat` into the data root (planChatMigration decided it
 * should). Rename when possible; across volumes copy then remove the source.
 * Every file keeps mode 0600.
 */
export function moveChatFolder(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    fs.rmSync(from, { recursive: true, force: true })
  }
  for (const name of fs.readdirSync(to)) {
    const file = path.join(to, name)
    try { if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o600) } catch { /* best effort */ }
  }
}
