import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  session,
} from 'electron'
import path from 'path'
import fs from 'fs'
import { FEATURE_IDS } from '../src/types'
import type { AppStatus } from '../src/types'
import https from 'https'
import http from 'http'
import { exec, spawn, ChildProcess, execFile } from 'child_process'
import { promisify } from 'util'
import {
  openDb, closeDb, shutdownDb, rebuildDb, startWatcher, restartWatcher,
  ensureSynced, resync,
  queryApplications, queryScouting, queryScoreHistory, queryPipeline,
  queryReports, queryApplicationsWithScores, queryTrends,
} from './db'
import { registerChat, killChatChild, setChatDir } from './chat'
import {
  computeDataRoot, dataRootMoved, importRepoModule, moveChatFolder, rootContext, toInfo,
  type DataRootState, type OverridesModule,
} from './dataRoot'
import {
  cacheSlugFor, chatDirFor, demoAllowsRun, demoSpawnRefusal, demoWriteRefusal,
  findRepoRoot, normalizeRel, personalBase, planChatMigration, resolveAppPath,
  spawnEnvFor, type ResolvedAppPath,
} from '../src/lib/dataRootMain'
import { DEMO_DATA_PATH, DEMO_READ_ONLY, DEMO_READ_ONLY_TOOLTIP } from '../src/lib/dataRoot'
import type {
  StatusAmendRequest, StatusAmendResult,
  StatusChangeRequest, StatusChangeResult, StatusHistoryQuery, StatusLogEntry,
} from '../src/lib/statusLog'
import type { ListingDates, ListingDatesMap } from '../src/lib/listingDates'

const execAsync = promisify(exec)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const serve = require('electron-serve')

// Electron inherits a stripped PATH — augment with common macOS locations so
// tools installed via Homebrew, nvm, or ~/.local/bin are always findable.
const SHELL_PATH = [
  process.env.PATH,
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  `${process.env.HOME}/.local/bin`,
].filter(Boolean).join(':')
const SHELL_ENV = { ...process.env, PATH: SHELL_PATH }

const isDev = process.env.NODE_ENV === 'development'
// Opt-in overrides for isolated runs (tests, README screenshots): a separate
// app-data folder so the real config, cache and chat are never touched, and a
// dev server on another port so a second instance can run beside the first.
if (process.env.STARPATH_USER_DATA) app.setPath('userData', process.env.STARPATH_USER_DATA)
const DEV_URL = process.env.STARPATH_DEV_URL || 'http://localhost:3000'
// Compiled main lives at dist-electron/electron/main.js; the Next.js static
// export lives at out/ (sibling of dist-electron at the project root, and at
// the asar root in production). Two ../ to climb out of dist-electron/electron/.
const loadURL = isDev ? null : serve({ directory: path.join(__dirname, '../../out') })

// ─── Config store ─────────────────────────────────────────────────────────────

const configPath = path.join(app.getPath('userData'), 'config.json')

interface AppConfig {
  repoPath?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
  tailoringComplete?: boolean
  models?: {
    pipeline:       'sonnet' | 'opus' | 'haiku'
    tailorCv:       'sonnet' | 'opus' | 'haiku'
    draftApp:       'sonnet' | 'opus' | 'haiku'
    interviewPrep:  'sonnet' | 'opus' | 'haiku'
    generateReport: 'sonnet' | 'opus' | 'haiku'
  }
  /** Per-user deactivation switches for optional UI surfaces (Settings ›
   *  General › Features). Partial: absent keys mean "feature active" —
   *  renderer merges over DEFAULT_FEATURE_PREFS. Keys mirror FEATURE_IDS in
   *  src/types (single source of truth; validated in app:set-features). */
  features?: Record<string, boolean>
  /** Where personal data is read from, passed to resolveDataRoot as its
   *  `configured` value: 'demo' while the user explores the fictional demo
   *  (read-only), absent for their own data (private/ by default). */
  dataPath?: string
}

function readConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AppConfig
  } catch {
    return {}
  }
}

function writeConfig(data: AppConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRepoPath(): string | null {
  const cfg = readConfig()
  return cfg.repoPath ?? null
}

// Dev convenience: with no repo configured yet, use the checkout the app is
// running from (frontend/ sits inside it). Packaged builds keep the folder
// picker — an installed app has no checkout around it.
function adoptDevCheckout(): void {
  if (app.isPackaged) return
  const cfg = readConfig()
  if (cfg.repoPath) return
  const found = findRepoRoot([__dirname, app.getAppPath()], fs.existsSync)
  if (!found) return
  writeConfig({ ...cfg, repoPath: found })
  console.log(`[repo] no repo configured; using the checkout the app runs from: ${found}`)
}

// ─── Data root ────────────────────────────────────────────────────────────────
//
// Personal files (user/, data/, reports/, profiles/, …) are served from the
// data root that scripts/lib/data-root.mjs resolves: <repo>/private by
// default, <repo>/demo when the user chose the demo (config `dataPath`), or
// $STARPATH_DATA. Everything else stays repo-relative. The renderer keeps
// passing `data/applications.md`; resolveForRenderer maps it. Kind 'none'
// (no private root yet) keeps today's repo-relative behaviour.

let dataRoot: DataRootState | null = null
let dataRootPending: Promise<DataRootState> | null = null

async function getDataRoot(): Promise<DataRootState> {
  // Never answer mid-switch with the old root.
  if (dataRootPending) await dataRootPending.catch(() => undefined)
  if (dataRoot && dataRoot.repoPath === getRepoPath()) return dataRoot
  return refreshDataRoot()
}

/**
 * Recompute from config + env; applies the swap when the root moved. Runs
 * are serialised, and each one reads the config fresh — a refresh asked for
 * while another is in flight (set-repo-path then set-data-path) waits for
 * it and then sees the newer config, instead of sharing the stale result.
 */
function refreshDataRoot(): Promise<DataRootState> {
  const prior = dataRootPending
  const run = (async () => {
    if (prior) await prior.catch(() => undefined)
    const cfg = readConfig()
    const next = await computeDataRoot(cfg.repoPath ?? null, cfg.dataPath ?? null, process.env)
    const prev = dataRoot
    dataRoot = next
    if (dataRootMoved(prev, next)) applyDataRoot(prev, next)
    return next
  })()
  dataRootPending = run
  const settle = () => { if (dataRootPending === run) dataRootPending = null }
  run.then(settle, settle)
  return run
}

/** The folder holding data/ and reports/ for the cache, watcher and CLIs. */
function dataBase(s: DataRootState): string | null {
  return s.repoPath ? personalBase({ repoPath: s.repoPath, root: s.root, kind: s.kind }) : null
}

function spawnEnv(s: DataRootState | null): NodeJS.ProcessEnv {
  return s ? spawnEnvFor(SHELL_ENV, s) : SHELL_ENV
}

// The data moved (startup, demo on/off, private init, a new repo): point
// chat at its folder (moving the legacy one in once), swap the cache file
// and the watcher, and tell the renderer to reload everything.
function applyDataRoot(prev: DataRootState | null, next: DataRootState): void {
  const userDataDir = app.getPath('userData')
  const plan = planChatMigration({ kind: next.kind, root: next.root, userDataDir, exists: fs.existsSync })
  if (plan) {
    try {
      moveChatFolder(plan.from, plan.to)
      console.log(`[chat] moved conversations from ${plan.from} to ${plan.to}`)
    } catch (e) {
      console.error('[chat] could not move conversations into the data root:', e)
    }
  }
  setChatDir(chatDirFor({ kind: next.kind, root: next.root, userDataDir }))

  const base = dataBase(next)
  if (base) {
    try {
      openDb(userDataDir, cacheSlug(next))
      // Same slug can mean another folder (private ↔ external): force it.
      if (prev) resync(base); else ensureSynced(base)
      restartWatcher(base, watcherCallbacks)
    } catch (e) {
      console.error('[db] cache swap after a data-root change failed:', e)
    }
  }
  if (!prev) return
  console.log(`[data-root] ${prev.kind} → ${next.kind} (${next.root ?? 'no repo'})`)
  mainWindow?.webContents.send('db:changed', ALL_SOURCES)
  mainWindow?.webContents.send('data-root:changed', toInfo(next))
}

const ALL_SOURCES = ['applications', 'scouting', 'pipeline', 'score_history', 'reports']

/** Map a renderer path through the data root (null = refused/no repo). */
async function resolveForRenderer(input: string): Promise<{ r: ResolvedAppPath; s: DataRootState } | null> {
  const s = await getDataRoot()
  const ctx = rootContext(s)
  if (!ctx) return null
  const r = resolveAppPath(ctx, input)
  return r ? { r, s } : null
}

async function readPersonal(rel: string): Promise<string | null> {
  const hit = await resolveForRenderer(rel)
  if (!hit) return null
  try { return fs.readFileSync(hit.r.abs, 'utf-8') } catch { return null }
}

/** System-prompt file for a spawn: the private override (or composed copy)
 *  via scripts/lib/overrides.mjs; the repo default on any error. */
async function resolveSystemPrompt(rel: string): Promise<string> {
  const s = await getDataRoot()
  if (!s.repoPath) return rel
  const fallback = path.join(s.repoPath, rel)
  if (!s.root) return fallback
  try {
    const mod = await importRepoModule<OverridesModule>(s.repoPath, 'scripts/lib/overrides.mjs')
    const file = mod.materializeSystemFile({ repoRoot: s.repoPath, dataRoot: s.root, rel })
    return typeof file === 'string' && file ? file : fallback
  } catch (e) {
    console.error(`[prompt] could not resolve ${rel}; using the repo default:`, e)
    return fallback
  }
}

function validateString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`)
  return val
}

// ─── Profiles ─────────────────────────────────────────────────────────────────
//
// Multiple switchable search profiles (docs/superpowers/specs/2026-07-07-
// multi-profile-design.md). The single implementation of the guards and the
// symlink swap lives in scripts/profile.mjs — the handlers below shell out to
// it with --json and never re-derive that logic here. Only `profile:active`
// bypasses the CLI: profiles/active is a one-line file, read directly for
// speed.

// Slug contract from the spec; `active` is additionally reserved. Validated
// here as defense in depth (the renderer live-validates the same shape and
// the CLI enforces it again).
const PROFILE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

function validateSlug(val: unknown, name: string): string {
  const s = validateString(val, name)
  if (!PROFILE_SLUG_RE.test(s) || s === 'active') {
    throw new Error(`${name} must be a valid profile slug (lowercase letters, digits, hyphens; max 32 chars)`)
  }
  return s
}

// null = pre-migration layout (no profiles/active, or an unreadable/invalid
// one — the CLI-facing surfaces treat those the same and hide themselves).
// `base` is the data folder (profiles/ is personal: it lives in the data root).
function readActiveProfileSlug(base: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(base, 'profiles', 'active'), 'utf-8').trim()
    return PROFILE_SLUG_RE.test(raw) ? raw : null
  } catch {
    return null
  }
}

// The slug the SQLite cache file is keyed by — 'demo' for the demo dataset,
// else the active profile, or 'default' pre-migration (cache-default.db).
function cacheSlug(s: DataRootState): string {
  const base = dataBase(s)
  return cacheSlugFor(s.kind, s.kind !== 'demo' && base ? readActiveProfileSlug(base) : null)
}

const DEMO_REFUSAL = { ok: false, error: DEMO_READ_ONLY, message: DEMO_READ_ONLY_TOOLTIP }

interface ProfileCliResult {
  ok?: boolean
  error?: string
  message?: string
  guardFailures?: string[]
  [k: string]: unknown
}

// Shell out to one of the repo's JSON CLIs — execFile with an args array
// (never a shell string), cwd = repo root, PATH-augmented env. The CLIs print
// machine-readable JSON even on refusal (exit 1), so the exit code is ignored
// in favor of parsing stdout. A run that produced no parseable JSON (script
// missing, crash) maps to ok:false with the stderr tail as the message.
function runJsonCli(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  what: string,
  timeout = 60_000,
): Promise<ProfileCliResult> {
  return new Promise((resolve) => {
    execFile(
      'node', args,
      { cwd: repoPath, env, timeout },
      (_err, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout) as ProfileCliResult)
        } catch {
          const detail = (stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)
          resolve({ ok: false, error: 'cli', message: detail || `${what} produced no JSON` })
        }
      },
    )
  })
}

// The profile CLI operates on the data folder: --root <data root> (profiles/
// and the canonical symlinks live there), the repo itself on an un-migrated
// checkout. --json is always appended.
function runProfileCli(s: DataRootState, args: string[]): Promise<ProfileCliResult> {
  const base = dataBase(s)
  if (!s.repoPath || !base) return Promise.resolve({ ok: false, error: 'no-repo', message: 'no repository configured' })
  return runJsonCli(s.repoPath, ['scripts/profile.mjs', ...args, '--root', base, '--json'], spawnEnv(s), 'profile CLI')
}

async function checkClaudeInstalled(): Promise<boolean> {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/bin/claude',
  ]
  if (candidates.some(p => fs.existsSync(p))) return true
  try {
    await execAsync('which claude', { env: SHELL_ENV })
    return true
  } catch {
    return false
  }
}

interface ClaudeOAuth {
  expiresAt?: number
  refreshToken?: string
}

type AuthReason = 'expired' | 'logged-out'
interface AuthResult { authenticated: boolean; reason?: AuthReason }

// Locate claude-code's stored credentials. On macOS they live in the login
// keychain (NOT a file) under the "Claude Code-credentials" service; on other
// platforms they're written to one of the cred files below. Returns whether
// *any* creds exist plus the parsed OAuth blob when present (so we can check
// its expiry). Never throws.
async function readClaudeCreds(): Promise<{ found: boolean; oauth?: ClaudeOAuth }> {
  const home = process.env.HOME ?? ''
  const parse = (raw: string): Record<string, unknown> | null => {
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { env: SHELL_ENV, timeout: 4000 },
      )
      const creds = parse(stdout.trim())
      if (creds) return { found: true, oauth: creds.claudeAiOauth as ClaudeOAuth | undefined }
    } catch { /* not in keychain — fall through to files */ }
  }

  const credPaths = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
    path.join(home, '.config', '@anthropic-ai', 'claude-code', 'credentials.json'),
  ]
  for (const p of credPaths) {
    if (!fs.existsSync(p)) continue
    const creds = parse(fs.readFileSync(p, 'utf-8'))
    if (creds && (creds.access_token || creds.token || creds.api_key || creds.claudeAiOauth)) {
      return { found: true, oauth: creds.claudeAiOauth as ClaudeOAuth | undefined }
    }
  }
  return { found: false }
}

// Why this is more than an existence check: an OAuth access token that has
// *expired* still sits in the keychain, and `claude auth status` happily
// reports `loggedIn: true` for it — but every API call 401s. The only honest
// signal is `expiresAt`. We treat an expired token as authenticated ONLY when
// a non-empty refreshToken is present (the CLI silently refreshes on next
// use); an expired token with no refresh token is a dead session that needs
// a fresh login.
async function checkClaudeAuth(): Promise<AuthResult> {
  const { found, oauth } = await readClaudeCreds()

  if (found) {
    if (oauth && typeof oauth.expiresAt === 'number') {
      const expired = Date.now() >= oauth.expiresAt
      const canRefresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
      if (expired && !canRefresh) return { authenticated: false, reason: 'expired' }
      return { authenticated: true }
    }
    // Non-OAuth creds (API key etc.) — no expiry to introspect, trust them.
    return { authenticated: true }
  }

  // No creds on disk or in the keychain — ask the CLI directly.
  try {
    const { stdout, stderr } = await execAsync('claude auth status', { env: SHELL_ENV, timeout: 6000 })
    const out = (stdout + stderr).toLowerCase()
    if (out.includes('not logged') || out.includes('not authenticated') || out.includes('sign in')) {
      return { authenticated: false, reason: 'logged-out' }
    }
    if (out.includes('logged in') || out.includes('"loggedin": true') || out.includes('@') || out.includes('authenticated')) {
      return { authenticated: true }
    }
  } catch { /* command may not exist in older versions */ }

  return { authenticated: false, reason: 'logged-out' }
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  nativeTheme.themeSource = 'dark'

  const cfg = readConfig()
  const bounds = cfg.windowBounds ?? { width: 1280, height: 800 }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  })

  // Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev
            ? `default-src 'self' 'unsafe-inline' 'unsafe-eval' ${DEV_URL}; img-src 'self' data: https://logo.clearbit.com https://unavatar.io https://www.google.com https://t1.gstatic.com;`
            : "default-src 'self' 'unsafe-inline'; img-src 'self' data: https://logo.clearbit.com https://unavatar.io https://www.google.com https://t1.gstatic.com; connect-src 'none';",
        ],
      },
    })
  })

  // Block permission requests (microphone, camera, etc.) — not needed
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  // Persist window bounds on resize/move
  const saveBounds = () => {
    if (!mainWindow) return
    const b = mainWindow.getBounds()
    writeConfig({ ...readConfig(), windowBounds: b })
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  // An isolated run (STARPATH_USER_DATA: tests, screenshots) opens without
  // taking focus or switching Spaces, so it never pulls the user off their work.
  mainWindow.once('ready-to-show', () => {
    if (process.env.STARPATH_USER_DATA) mainWindow?.showInactive()
    else mainWindow?.show()
  })

  if (isDev) {
    mainWindow.loadURL(DEV_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    loadURL!(mainWindow)
  }

  // Intercept navigation — open external links in browser, not in app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ─── IPC: App config ──────────────────────────────────────────────────────────

ipcMain.handle('app:get-config', () => readConfig())

ipcMain.handle('app:set-repo-path', async (_e, repoPath: unknown) => {
  const p = validateString(repoPath, 'repoPath')
  writeConfig({ ...readConfig(), repoPath: p })
  await refreshDataRoot()
})

// ─── IPC: Data root ───────────────────────────────────────────────────────────

ipcMain.handle('app:data-root', async () => toInfo(await getDataRoot()))

// 'demo' → explore the fictional demo (read-only); null → back to own data.
// Recomputes, swaps cache/watcher/chat, and emits db:changed +
// data-root:changed when the data moved.
ipcMain.handle('app:set-data-path', async (_e, value: unknown) => {
  if (value !== DEMO_DATA_PATH && value !== null) throw new Error("dataPath must be 'demo' or null")
  const s = await getDataRoot()
  if (value === DEMO_DATA_PATH && !s.demoAvailable) throw new Error('This checkout has no demo/ folder')
  const cfg = readConfig()
  const next: AppConfig = { ...cfg }
  if (value === DEMO_DATA_PATH) next.dataPath = DEMO_DATA_PATH
  else delete next.dataPath
  writeConfig(next)
  return toInfo(await refreshDataRoot())
})

// `node scripts/private.mjs init --json`: create private/, move legacy
// folders in, link them, init the private git repo. The script owns all of
// that; main relays its JSON and then re-resolves the data root (which now
// finds private/).
ipcMain.handle('private:init', async () => {
  const repoPath = getRepoPath()
  if (!repoPath) return { ok: false, error: 'no-repo', message: 'Choose your career-ops folder first.' }
  // Plain env: a STARPATH_DATA aimed at the demo must not steer the init.
  const env: NodeJS.ProcessEnv = { ...SHELL_ENV }
  delete env.STARPATH_DATA
  const res = await runJsonCli(repoPath, ['scripts/private.mjs', 'init', '--json'], env, 'private init', 180_000)
  if (res.ok !== true) console.error('[private] init failed:', res.error, res.message)
  await refreshDataRoot()
  return res
})

// Absolute system-prompt file for `claude --append-system-prompt-file`:
// the user's private override or a composed copy (scripts/lib/overrides.mjs),
// the repo default otherwise or on any error.
ipcMain.handle('prompt:resolve', async (_e, rel: unknown) => {
  const r = normalizeRel(validateString(rel, 'rel'))
  if (!r) throw new Error('rel must be a repo-relative file path')
  return resolveSystemPrompt(r)
})

ipcMain.handle('app:set-onboarding-complete', (_e, value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('value must be boolean')
  const cfg = readConfig()
  // When completing onboarding for the first time, mark tailoring as needed
  const update: AppConfig = { ...cfg, onboardingComplete: value }
  if (value && cfg.tailoringComplete === undefined) update.tailoringComplete = false
  writeConfig(update)
})

ipcMain.handle('app:set-tailoring-complete', (_e, value: unknown) => {
  const v = value === undefined ? true : Boolean(value)
  writeConfig({ ...readConfig(), tailoringComplete: v })
})

ipcMain.handle('app:set-models', (_e, models: unknown) => {
  if (!models || typeof models !== 'object') throw new Error('models must be object')
  const m = models as Record<string, unknown>
  const validModel = (v: unknown): v is 'sonnet' | 'opus' | 'haiku' =>
    v === 'sonnet' || v === 'opus' || v === 'haiku'
  const fields = ['pipeline', 'tailorCv', 'draftApp', 'interviewPrep', 'generateReport'] as const
  for (const f of fields) {
    if (!validModel(m[f])) {
      throw new Error(`models.${f} must be one of sonnet | opus | haiku`)
    }
  }
  writeConfig({
    ...readConfig(),
    models: {
      pipeline:       m.pipeline       as 'sonnet' | 'opus' | 'haiku',
      tailorCv:       m.tailorCv       as 'sonnet' | 'opus' | 'haiku',
      draftApp:       m.draftApp       as 'sonnet' | 'opus' | 'haiku',
      interviewPrep:  m.interviewPrep  as 'sonnet' | 'opus' | 'haiku',
      generateReport: m.generateReport as 'sonnet' | 'opus' | 'haiku',
    },
  })
})

ipcMain.handle('app:set-features', (_e, features: unknown) => {
  if (!features || typeof features !== 'object') throw new Error('features must be object')
  const next: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(features as Record<string, unknown>)) {
    if (!FEATURE_IDS.includes(key as (typeof FEATURE_IDS)[number])) {
      throw new Error(`unknown feature "${key}"`)
    }
    if (typeof value !== 'boolean') throw new Error(`features.${key} must be boolean`)
    next[key] = value
  }
  writeConfig({ ...readConfig(), features: next })
})

ipcMain.handle('app:select-folder', async () => {
  if (!mainWindow) return null
  // Sheet dialog (attached to window titlebar) is reliable on macOS — never hides behind the window
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your career-ops folder',
    defaultPath: app.getPath('home'),
    properties: ['openDirectory'],
    message: 'Choose the career-ops folder (it must contain CLAUDE.md at its root)',
  })
  if (result.canceled || !result.filePaths[0]) return null
  const selected = result.filePaths[0]
  const valid = fs.existsSync(path.join(selected, 'CLAUDE.md'))
  return { path: selected, valid }
})

ipcMain.handle('app:validate-path', (_e, folderPath: unknown) => {
  const p = validateString(folderPath, 'folderPath')
  const valid = fs.existsSync(path.join(p, 'CLAUDE.md'))
  return { path: p, valid }
})

// File picker for CV upload — used by the onboarding step that lets the
// user upload a PDF instead of pasting CV text. We hand the absolute path
// to the renderer; it then spawns Claude with `@<path> ...` to do the
// actual PDF→markdown conversion.
ipcMain.handle('app:select-cv-pdf', async () => {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload your CV (PDF)',
    defaultPath: app.getPath('home'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
    message: 'Pick a PDF — Claude will convert it to markdown and write user/cv.md.',
  })
  if (result.canceled || !result.filePaths[0]) return null
  return { path: result.filePaths[0] }
})

ipcMain.handle('app:open-external', (_e, url: unknown) => {
  const u = validateString(url, 'url')
  if (u.startsWith('http://') || u.startsWith('https://')) shell.openExternal(u)
})

// Reveal a file in the OS file manager (Finder / Explorer). Path is
// resolved like fs:read (data root for personal paths, confined either way)
// so a renderer can't escape it.
ipcMain.handle('app:reveal-file', async (_e, filePath: unknown) => {
  const rel = validateString(filePath, 'filePath')
  const hit = await resolveForRenderer(rel)
  if (!hit) return false
  try {
    shell.showItemInFolder(hit.r.abs)
    return true
  } catch {
    return false
  }
})

// Open a file with the system's default app (Preview for a tailored CV PDF,
// the editor for a prep doc). Same resolution and confinement as fs:read —
// the renderer never builds file:// URLs from the repo path, which would
// miss the data root.
ipcMain.handle('app:open-file', async (_e, filePath: unknown) => {
  const rel = validateString(filePath, 'filePath')
  const hit = await resolveForRenderer(rel)
  if (!hit || !fs.existsSync(hit.r.abs)) return false
  const err = await shell.openPath(hit.r.abs)
  return err === ''
})

// ─── IPC: Claude checks ───────────────────────────────────────────────────────

ipcMain.handle('app:check-claude', async () => {
  const installed = await checkClaudeInstalled()
  return { installed }
})

ipcMain.handle('app:check-claude-auth', async () => {
  return await checkClaudeAuth()
})

ipcMain.handle('app:run-claude-login', () => {
  // Spawn claude login directly — it opens the OAuth browser page without needing a terminal
  const proc = spawn('claude', ['login'], {
    env: SHELL_ENV,
    stdio: 'ignore',
    detached: false,
  })
  proc.unref()
})

// ─── IPC: File system ─────────────────────────────────────────────────────────

// Every fs:* path goes through resolveForRenderer: personal paths (data/,
// user/, reports/, profiles/, …) resolve under the data root, everything else
// under the repo, and both are confined to their base.

ipcMain.handle('fs:read', async (_e, filePath: unknown) => {
  const fp = validateString(filePath, 'filePath')
  return readPersonal(fp)
})

ipcMain.handle('fs:write', async (_e, filePath: unknown, content: unknown) => {
  const fp = validateString(filePath, 'filePath')
  const c = validateString(content, 'content')
  const hit = await resolveForRenderer(fp)
  if (!hit) throw new Error(getRepoPath() ? `Refusing to write outside the repository: ${fp}` : 'No repo path configured')
  // The demo is read-only: personal paths (and demo/, private/ by name)
  // are refused with the demo-read-only code the renderer recognises.
  const refusal = demoWriteRefusal(hit.s.kind, hit.r, hit.s.isPersonal)
  if (refusal) throw new Error(refusal)
  // The trackers are shared with the merge scripts and set-status.mjs: write
  // them under the same lock, atomically and through the profile link.
  if (TRACKER_FILES.has(hit.r.rel) && hit.s.repoPath) {
    await writeTrackerFile(hit.s.repoPath, hit.r.abs, c)
    return
  }
  fs.mkdirSync(path.dirname(hit.r.abs), { recursive: true })
  fs.writeFileSync(hit.r.abs, c, 'utf-8')
})

ipcMain.handle('fs:exists', async (_e, filePath: unknown) => {
  const fp = validateString(filePath, 'filePath')
  const hit = await resolveForRenderer(fp)
  return hit ? fs.existsSync(hit.r.abs) : false
})

ipcMain.handle('fs:list', async (_e, dirPath: unknown) => {
  const dp = validateString(dirPath, 'dirPath')
  const hit = await resolveForRenderer(dp)
  if (!hit || !fs.existsSync(hit.r.abs)) return []
  try { return fs.readdirSync(hit.r.abs) } catch { return [] }
})

ipcMain.handle('fs:list-recursive', async (_e, dirPath: unknown, ext: unknown) => {
  const dp = validateString(dirPath, 'dirPath')
  const ex = validateString(ext, 'ext')
  // Same path-traversal guard as the other fs:* handlers — a renderer
  // passing '../..' must not be able to walk above its base.
  const hit = await resolveForRenderer(dp)
  if (!hit || !fs.existsSync(hit.r.abs)) return []
  // Results are relative to the folder the walk is confined to (data root
  // or repo), i.e. the same `reports/tier-1/…` form the renderer reads back.
  const base = hit.r.base
  const results: string[] = []
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fp)
      else if (entry.name.endsWith(ex)) results.push(path.relative(base, fp))
    }
  }
  walk(hit.r.abs)
  return results
})

// ─── IPC: Tracker writes ──────────────────────────────────────────────────────
//
// applications.md and scouting.md are rewritten by the merge scripts too, so
// the app writes them under the same directory lock (scripts/lib/dir-lock.mjs)
// and atomically through the profile link (scripts/lib/write-file-atomic.mjs).
// A status change is never a renderer-side rewrite: `tracker:set-status` runs
// the same code as `node scripts/set-status.mjs` (scripts/lib/status-ledger.mjs),
// which validates against templates/states.yml, rewrites the Status cell and
// appends the change to the status log in one locked step. Both modules are
// ESM in the repo, loaded through importRepoModule.

const TRACKER_FILES = new Set(['data/applications.md', 'data/scouting.md'])

interface DirLockModule {
  lockPathFor: (file: string) => string
  withLock: <T>(lockDir: string, fn: () => T | Promise<T>, opts?: { label?: string; timeoutMs?: number }) => Promise<T>
}
interface AtomicWriteModule {
  writeFileAtomic: (file: string, content: string) => string
}
interface StatusLedgerModule {
  setStatusAsync: (req: {
    appsFile: string; statesFile: string
    num?: number | null; company?: string; role?: string
    to: string; date?: string; stage?: string; note?: string; source: string
  }) => Promise<{ changed: boolean; to: string; date: string; entries: StatusLogEntry[] }>
  readHistory: (q: { appsFile: string; num?: number | null; company?: string | null; role?: string | null }) => StatusLogEntry[]
  amendStatusAsync: (req: {
    appsFile: string; statesFile: string
    num?: number | null; company?: string; role?: string
    to: string; date?: string; stage?: string; source: string
  }) => Promise<{ changed: boolean; entry: StatusLogEntry }>
}

async function writeTrackerFile(repoPath: string, abs: string, content: string): Promise<void> {
  const [lock, atomic] = await Promise.all([
    importRepoModule<DirLockModule>(repoPath, 'scripts/lib/dir-lock.mjs'),
    importRepoModule<AtomicWriteModule>(repoPath, 'scripts/lib/write-file-atomic.mjs'),
  ])
  await lock.withLock(lock.lockPathFor(abs), () => { atomic.writeFileAtomic(abs, content) }, { label: 'starpath app' })
}

function optString(v: unknown, name: string, max = 500): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v.slice(0, max)
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error('num must be a positive integer')
  return n
}

ipcMain.handle('tracker:set-status', async (_e, req: unknown): Promise<StatusChangeResult> => {
  try {
    if (!req || typeof req !== 'object') throw new Error('request must be an object')
    const r = req as Partial<StatusChangeRequest>
    const status = validateString(r.status, 'status')
    const source = r.source === 'chat' ? 'chat' : 'app'
    const hit = await resolveForRenderer('data/applications.md')
    if (!hit || !hit.s.repoPath) return { ok: false, error: 'No repo path configured', code: 'ENOREPO' }
    const refusal = demoWriteRefusal(hit.s.kind, hit.r, hit.s.isPersonal)
    if (refusal) return { ok: false, error: refusal, code: 'EDEMO' }
    const ledger = await importRepoModule<StatusLedgerModule>(hit.s.repoPath, 'scripts/lib/status-ledger.mjs')
    const out = await ledger.setStatusAsync({
      appsFile: hit.r.abs,
      statesFile: path.join(hit.s.repoPath, 'templates/states.yml'),
      num: optNum(r.num) ?? null,
      company: optString(r.company, 'company'),
      role: optString(r.role, 'role'),
      to: status,
      date: optString(r.date, 'date', 10),
      stage: optString(r.stage, 'stage', 200),
      note: optString(r.note, 'note'),
      source,
    })
    return { ok: true, changed: out.changed, to: out.to as AppStatus, date: out.date, entries: out.entries }
  } catch (e) {
    const err = e as Error & { code?: string }
    return { ok: false, error: err.message, code: err.code ?? null }
  }
})

// Correct a logged move (the date or stage of a rejection recorded late or
// backfilled with an approximate date). Same lock as a status change;
// applications.md is never touched, only the matching status-log row.
ipcMain.handle('tracker:amend-status', async (_e, req: unknown): Promise<StatusAmendResult> => {
  try {
    if (!req || typeof req !== 'object') throw new Error('request must be an object')
    const r = req as Partial<StatusAmendRequest>
    const status = validateString(r.status, 'status')
    const source = r.source === 'chat' ? 'chat' : 'app'
    const hit = await resolveForRenderer('data/applications.md')
    if (!hit || !hit.s.repoPath) return { ok: false, error: 'No repo path configured', code: 'ENOREPO' }
    const refusal = demoWriteRefusal(hit.s.kind, hit.r, hit.s.isPersonal)
    if (refusal) return { ok: false, error: refusal, code: 'EDEMO' }
    const ledger = await importRepoModule<StatusLedgerModule>(hit.s.repoPath, 'scripts/lib/status-ledger.mjs')
    if (typeof ledger.amendStatusAsync !== 'function') {
      return { ok: false, error: 'This checkout\'s scripts cannot correct a logged status yet', code: 'ENOTSUP' }
    }
    // A stage of '' clears it, so it is passed through as given (not optString).
    const stage = r.stage === undefined || r.stage === null ? undefined : String(r.stage).slice(0, 200)
    const out = await ledger.amendStatusAsync({
      appsFile: hit.r.abs,
      statesFile: path.join(hit.s.repoPath, 'templates/states.yml'),
      num: optNum(r.num) ?? null,
      company: optString(r.company, 'company'),
      role: optString(r.role, 'role'),
      to: status,
      date: optString(r.date, 'date', 10),
      stage,
      source,
    })
    return { ok: true, changed: out.changed, entry: out.entry }
  } catch (e) {
    const err = e as Error & { code?: string }
    return { ok: false, error: err.message, code: err.code ?? null }
  }
})

ipcMain.handle('tracker:status-history', async (_e, query: unknown): Promise<StatusLogEntry[]> => {
  const q = (query && typeof query === 'object' ? query : {}) as StatusHistoryQuery
  const hit = await resolveForRenderer('data/applications.md')
  if (!hit || !hit.s.repoPath) return []
  try {
    const ledger = await importRepoModule<StatusLedgerModule>(hit.s.repoPath, 'scripts/lib/status-ledger.mjs')
    return ledger.readHistory({
      appsFile: hit.r.abs,
      num: optNum(q.num) ?? null,
      company: optString(q.company, 'company') ?? null,
      role: optString(q.role, 'role') ?? null,
    })
  } catch (e) {
    console.error('[tracker] status history failed:', e)
    return []
  }
})

// ─── IPC: Listing dates ──────────────────────────────────────────────────────
//
// Deadline, posting date and first-scan date per listing, from
// data/scan-history.tsv through the repo's own join (`indexListingDates` in
// scripts/lib/merge-staging-core.mjs: canonical URL, then company + role).
// The renderer sends one query per listing it shows and gets back a map keyed
// by the query's `key`; unknown listings are absent. The index is rebuilt only
// when the file changes. Any failure (older scripts, unreadable file) is an
// empty map: the cards and the chart fall back to the dates they already have.

interface MergeStagingModule {
  indexListingDates: (text: string) => (q: { url?: string; company?: string; role?: string }) => ListingDates | null
}

let listingDatesIndex: { abs: string; mtimeMs: number; lookup: ReturnType<MergeStagingModule['indexListingDates']> } | null = null

ipcMain.handle('listings:dates', async (_e, queries: unknown): Promise<ListingDatesMap> => {
  if (!Array.isArray(queries)) return {}
  const hit = await resolveForRenderer('data/scan-history.tsv')
  if (!hit || !hit.s.repoPath) return {}
  try {
    const stat = fs.statSync(hit.r.abs)
    if (!listingDatesIndex || listingDatesIndex.abs !== hit.r.abs || listingDatesIndex.mtimeMs !== stat.mtimeMs) {
      const core = await importRepoModule<MergeStagingModule>(hit.s.repoPath, 'scripts/lib/merge-staging-core.mjs')
      if (typeof core.indexListingDates !== 'function') return {}
      listingDatesIndex = { abs: hit.r.abs, mtimeMs: stat.mtimeMs, lookup: core.indexListingDates(fs.readFileSync(hit.r.abs, 'utf-8')) }
    }
    const out: ListingDatesMap = {}
    for (const q of queries.slice(0, 20_000)) {
      if (!q || typeof q !== 'object') continue
      const { key, url, company, role } = q as Record<string, unknown>
      if (typeof key !== 'string' || !key) continue
      const found = listingDatesIndex.lookup({
        url: typeof url === 'string' ? url : undefined,
        company: typeof company === 'string' ? company : undefined,
        role: typeof role === 'string' ? role : undefined,
      })
      if (found) out[key] = { deadline: found.deadline ?? null, postedDate: found.postedDate ?? null, firstSeen: found.firstSeen ?? null }
    }
    return out
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[listings] dates failed:', e)
    return {}
  }
})

// ─── IPC: Shell (one-shot) ────────────────────────────────────────────────────
//
// Spawned scripts get STARPATH_DATA when the data root is the demo or an
// external folder (scripts resolve their data through dataRootFor). In demo
// mode only the read-only digests run; anything else could write.

ipcMain.handle('shell:run', async (_e, cmd: unknown, args: unknown) => {
  const c = validateString(cmd, 'cmd')
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('args must be string[]')
  // claude workers go through shell:spawn, where their permissions are derived.
  if (c === 'claude') return { stdout: '', stderr: 'claude runs only as a streaming worker (shell:spawn)', code: 1 }
  const s = await getDataRoot()
  if (s.kind === 'demo' && !demoAllowsRun(c, args as string[])) {
    return { stdout: '', stderr: demoSpawnRefusal(s.kind) ?? '', code: 1 }
  }
  const repoPath = getRepoPath() ?? app.getPath('home')
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile(c, args as string[], { cwd: repoPath, env: spawnEnv(s) }, (err, stdout, stderr) => {
      const code = typeof err?.code === 'number' ? err.code : (err ? 1 : 0)
      resolve({ stdout, stderr, code })
    })
  })
})

// ─── IPC: Shell (streaming spawn) ─────────────────────────────────────────────

const spawnedProcesses = new Map<string, ChildProcess>()

// Every claude worker runs least-privilege. The renderer names the worker kind
// with `--starpath-worker <kind>`; this swaps it for the flags derived from
// scripts/lib/worker-capabilities.mjs (the same table batch-runner.sh uses).
// A claude spawn with no kind, an unknown one, or its own permission flags is
// refused: it runs least-privilege or not at all.
interface WorkerCapabilitiesModule {
  expandWorkerArgs: (args: string[], opts?: { tmpdirs?: string[]; cwds?: string[] }) => string[]
  workerPermissionArgs: (kind: string, opts?: { tmpdirs?: string[]; cwds?: string[] }) => string[]
  osTmpdirs: () => string[]
  osCwds: (dir?: string) => string[]
}

function workerCapabilities(repoPath: string): Promise<WorkerCapabilitiesModule> {
  return importRepoModule<WorkerCapabilitiesModule>(repoPath, 'scripts/lib/worker-capabilities.mjs')
}

ipcMain.handle('shell:spawn', async (_e, id: unknown, cmd: unknown, args: unknown) => {
  const sid = validateString(id, 'id')
  const c = validateString(cmd, 'cmd')
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('args must be string[]')
  let argv = args as string[]
  if (c === 'claude') {
    try {
      const repo = getRepoPath() ?? ''
      const caps = await workerCapabilities(repo)
      argv = caps.expandWorkerArgs(argv, { tmpdirs: caps.osTmpdirs(), cwds: caps.osCwds(repo) })
    } catch (e) {
      mainWindow?.webContents.send('shell:output', sid, `❌ Refused: ${e instanceof Error ? e.message : String(e)}\n`)
      mainWindow?.webContents.send('shell:done', sid, 1)
      return
    }
  }
  const s = await getDataRoot()
  // Streaming spawns are work (scans, evaluations, tailoring): the demo
  // refuses them the same way a failed spawn reports, so the Activity panel
  // shows why instead of hanging.
  const refusal = demoSpawnRefusal(s.kind)
  if (refusal) {
    mainWindow?.webContents.send('shell:output', sid, `${DEMO_READ_ONLY_TOOLTIP}: this action is disabled while the demo is shown.\n`)
    mainWindow?.webContents.send('shell:done', sid, 1)
    return
  }
  const repoPath = getRepoPath() ?? app.getPath('home')
  // stdio: ['ignore', 'pipe', 'pipe'] closes stdin entirely — without this,
  // `claude -p` waits 3s for stdin and emits a warning before proceeding.
  const proc = spawn(c, argv, {
    cwd: repoPath,
    shell: false,
    env: spawnEnv(s),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawnedProcesses.set(sid, proc)
  proc.on('error', (err: Error) => {
    mainWindow?.webContents.send('shell:output', sid, `❌ Spawn error: ${err.message}`)
    mainWindow?.webContents.send('shell:done', sid, -1)
    spawnedProcesses.delete(sid)
  })
  proc.stdout?.on('data', (chunk: Buffer) => {
    mainWindow?.webContents.send('shell:output', sid, chunk.toString())
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    mainWindow?.webContents.send('shell:output', sid, chunk.toString())
  })
  proc.on('close', (code: number | null) => {
    mainWindow?.webContents.send('shell:done', sid, code ?? 0)
    spawnedProcesses.delete(sid)
  })
})

ipcMain.handle('shell:kill', (_e, id: unknown) => {
  const sid = validateString(id, 'id')
  spawnedProcesses.get(sid)?.kill()
  spawnedProcesses.delete(sid)
})

// ─── IPC: Logo cache ─────────────────────────────────────────────────────────

function fetchToBuffer(url: string): Promise<{ buf: Buffer; mime: string } | null> {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        resolve(fetchToBuffer(res.headers.location))
        return
      }
      if (res.statusCode !== 200) { resolve(null); return }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const mime = (res.headers['content-type'] ?? 'image/png').split(';')[0].trim()
        resolve(buf.length > 200 ? { buf, mime } : null)
      })
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

ipcMain.handle('logo:fetch', async (_e, domain: unknown) => {
  const d = validateString(domain, 'domain')
  // The demo's companies are fictional; their guessed domains belong to real
  // brands, so the demo shows initials and makes no logo requests at all.
  if ((await getDataRoot()).kind === 'demo') return null
  const safeName = d.replace(/[^a-z0-9.-]/gi, '_')

  const cacheDir = path.join(app.getPath('userData'), 'logo-cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cachePath = path.join(cacheDir, `${safeName}.b64`)

  // Return from disk cache if present
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf-8')
  }

  // Try sources in order — main process is not subject to renderer CSP
  const sources = [
    `https://logo.clearbit.com/${d}`,
    `https://unavatar.io/${d}`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
  ]

  for (const url of sources) {
    const result = await fetchToBuffer(url)
    if (result) {
      const dataUrl = `data:${result.mime};base64,${result.buf.toString('base64')}`
      fs.writeFileSync(cachePath, dataUrl, 'utf-8')
      return dataUrl
    }
  }

  return null
})

// ─── IPC: SQLite cache ────────────────────────────────────────────────────────
//
// Markdown/TSV files in the repo remain canonical. SQLite is a derived index
// rebuilt from them, kept in sync via mtime checks + a chokidar watcher.
// Schema bumps drop and rebuild — see electron/db/schema.ts.

const watcherCallbacks = {
  onChanged: (sources: string[]) => mainWindow?.webContents.send('db:changed', sources),
}

async function ensureDbReady(): Promise<boolean> {
  const s = await getDataRoot()
  const base = dataBase(s)
  if (!base) return false
  // Keyed by the active profile (or 'demo') — openDb closes and reopens
  // (dropping the watcher) if the slug changed since the last call, so even
  // an out-of-band CLI switch converges on the right cache at the next query.
  openDb(app.getPath('userData'), cacheSlug(s))
  ensureSynced(base)
  startWatcher(base, watcherCallbacks)
  return true
}

ipcMain.handle('db:applications', async (_e, filters: unknown) => {
  if (!await ensureDbReady()) return []
  return queryApplications((filters ?? {}) as Parameters<typeof queryApplications>[0])
})

ipcMain.handle('db:scouting', async (_e, filters: unknown) => {
  if (!await ensureDbReady()) return []
  return queryScouting((filters ?? {}) as Parameters<typeof queryScouting>[0])
})

ipcMain.handle('db:score-history', async (_e, filters: unknown) => {
  if (!await ensureDbReady()) return []
  return queryScoreHistory((filters ?? {}) as Parameters<typeof queryScoreHistory>[0])
})

ipcMain.handle('db:pipeline', async () => {
  if (!await ensureDbReady()) return []
  return queryPipeline()
})

ipcMain.handle('db:reports', async (_e, filters: unknown) => {
  if (!await ensureDbReady()) return []
  return queryReports((filters ?? {}) as Parameters<typeof queryReports>[0])
})

ipcMain.handle('db:applications-with-scores', async () => {
  if (!await ensureDbReady()) return []
  return queryApplicationsWithScores()
})

ipcMain.handle('db:trends', async () => {
  if (!await ensureDbReady()) return { byDate: [], byArchetype: [], tierDistribution: [], verdictDistribution: [], eligibilityDistribution: [] }
  return queryTrends()
})

ipcMain.handle('db:resync', async () => {
  const s = await getDataRoot()
  const base = dataBase(s)
  if (!base) return null
  openDb(app.getPath('userData'), cacheSlug(s))
  return resync(base)
})

ipcMain.handle('db:rebuild', async () => {
  const s = await getDataRoot()
  const base = dataBase(s)
  if (!base) return null
  rebuildDb(app.getPath('userData'), cacheSlug(s))
  return ensureSynced(base)
})

// ─── IPC: Profiles ────────────────────────────────────────────────────────────

// The demo has no profiles: list is empty (every profile surface hides) and
// switch/create are refused. Otherwise the CLI runs against the data folder.

ipcMain.handle('profile:list', async () => {
  const s = await getDataRoot()
  const base = dataBase(s)
  // Pre-migration, demo, or no repo yet: report "no profiles" without
  // spawning node — the renderer hides every profile surface on this shape.
  if (!base || s.kind === 'demo' || !fs.existsSync(path.join(base, 'profiles'))) {
    return { active: null, profiles: [] }
  }
  const res = await runProfileCli(s, ['list'])
  if (Array.isArray(res.profiles)) return res
  // profiles/ exists but the CLI couldn't answer (script missing, crash) —
  // degrade to the hidden state rather than surfacing a broken switcher.
  console.error('[profile] list failed:', res)
  return { active: null, profiles: [] }
})

ipcMain.handle('profile:active', async () => {
  const s = await getDataRoot()
  const base = dataBase(s)
  return { active: base && s.kind !== 'demo' ? readActiveProfileSlug(base) : null }
})

ipcMain.handle('profile:switch', async (_e, slug: unknown) => {
  const sl = validateSlug(slug, 'slug')
  const s = await getDataRoot()
  const base = dataBase(s)
  if (!base) return { ok: false, error: 'no-repo', message: 'no repository configured' }
  if (s.kind === 'demo') return DEMO_REFUSAL
  const res = await runProfileCli(s, ['switch', sl])
  if (res.ok === true) {
    // The canonical paths now point into the new profile: swap to its cache
    // file (openDb closes the old one), mirror it from disk, and restart the
    // watcher — chokidar resolved the old symlink targets at watch time.
    try {
      openDb(app.getPath('userData'), sl)
      ensureSynced(base)
      restartWatcher(base, watcherCallbacks)
    } catch (e) {
      console.error('[profile] cache swap after switch failed:', e)
    }
    // Existing data-refresh channel first (the data store re-pulls on it),
    // then the profile-specific event for the switcher/list surfaces.
    mainWindow?.webContents.send('db:changed', ALL_SOURCES)
    mainWindow?.webContents.send('profile:changed', sl)
  }
  return res
})

ipcMain.handle('profile:create', async (_e, opts: unknown) => {
  if (!opts || typeof opts !== 'object') throw new Error('opts must be object')
  const o = opts as Record<string, unknown>
  const slug = validateSlug(o.slug, 'slug')
  const s = await getDataRoot()
  if (!dataBase(s)) return { ok: false, error: 'no-repo', message: 'no repository configured' }
  if (s.kind === 'demo') return DEMO_REFUSAL
  const args = ['create', slug]
  if (o.from !== undefined && o.from !== null && o.from !== '') {
    args.push('--from', validateSlug(o.from, 'from'))
  }
  if (o.label !== undefined && o.label !== null && o.label !== '') {
    const label = validateString(o.label, 'label').trim().slice(0, 80)
    if (label) args.push('--label', label)
  }
  return runProfileCli(s, args)
})

// ─── IPC: Network lens ────────────────────────────────────────────────────────
//
// The Network view composes the repo's own pure cores (scripts/lib/
// network-lens-core.mjs — the same modules `npm run network`, `npm run
// outreach-plan`, and the daily brief use) instead of re-implementing the
// roster / pipeline / cadence parsing in the renderer. The cores are ESM;
// this main bundle is compiled to CommonJS, so they load through
// importRepoModule (electron/dataRoot.ts: a real dynamic import() that tsc
// cannot down-compile to require(), cached per file, retried after a failure).
//
// Markdown stays canonical: this handler reads the files fresh on every call
// and derives everything in-memory — nothing network-related is persisted.

interface NetworkLensModule {
  buildNetworkOverview: (input: {
    networkRaw: string | null
    applicationsRaw: string | null
    scoutingRaw: string | null
    outreachRaw: string | null
    today: string
  }) => unknown
}

ipcMain.handle('network:overview', async () => {
  const repoPath = getRepoPath()
  if (!repoPath) return null
  try {
    // Code from the repo, data through the data root (readPersonal).
    const lens = await importRepoModule<NetworkLensModule>(repoPath, 'scripts/lib/network-lens-core.mjs')
    const [networkRaw, applicationsRaw, scoutingRaw, outreachRaw] = await Promise.all([
      readPersonal('data/network.md'),
      readPersonal('data/applications.md'),
      readPersonal('data/scouting.md'),
      readPersonal('data/outreach.md'),
    ])
    return lens.buildNetworkOverview({
      networkRaw, applicationsRaw, scoutingRaw, outreachRaw,
      today: new Date().toISOString().slice(0, 10),
    })
  } catch (e) {
    // Older repos without the lens core (or a genuinely broken file) must not
    // crash the app — the view renders its "lens unavailable" line on null.
    console.error('[network] overview failed:', e)
    return null
  }
})

// ─── IPC: Chat ────────────────────────────────────────────────────────────────
//
// The conversational tab. Everything about it (single live generation, spawn +
// stream loop, persisted runtime, `chat:*` handlers) lives in electron/chat.ts;
// main only hands it the pieces it owns — the configured repo path (the
// spawn's cwd), the window to push envelopes at, the spawn env, the resolved
// system prompt, and the demo refusal. Chat state persists as JSON in the
// folder applyDataRoot points it at (<data root>/chat for private/external,
// {userData}/chat-demo for the demo, {userData}/chat before a private root
// exists), never in the SQLite cache — that cache stays fully derivable from
// the Markdown/TSV.
registerChat({
  getRepoPath,
  getPermissionArgs: async () => {
    const repo = getRepoPath() ?? ''
    const caps = await workerCapabilities(repo)
    return caps.workerPermissionArgs('chat', { tmpdirs: caps.osTmpdirs(), cwds: caps.osCwds(repo) })
  },
  getWindow: () => mainWindow,
  getEnv: () => spawnEnv(dataRoot),
  getModel: () => readConfig().models?.pipeline,
  resolveSystemPrompt,
  refuseSend: async () => demoSpawnRefusal((await getDataRoot()).kind),
})

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  adoptDevCheckout()
  // Resolve the data root before the window exists, so the first renderer
  // call already sees the right folder (and chat has moved, if it had to).
  try { await refreshDataRoot() } catch (e) { console.error('[data-root] init failed:', e) }
  createWindow()
  // Best-effort initial sync. Failures here shouldn't block the UI; the
  // first db:* call will retry. Guarded so onboarding (no repoPath yet)
  // doesn't crash.
  try { await ensureDbReady() } catch (e) { console.error('[db] init failed:', e) }
})

app.on('window-all-closed', () => {
  closeDb()
  if (process.platform !== 'darwin') app.quit()
})

// Graceful shutdown on quit (Cmd+Q / app.quit). The chokidar watcher uses the
// native fsevents module on macOS; if the process exits while it's still
// alive, fse_instance_destroy aborts (SIGABRT — the "quit unexpectedly"
// dialog) during runtime teardown. So on the first quit request we cancel the
// default quit, kill any running child processes, tear down the watcher + db
// (awaited), then exit hard once cleanup is actually done.
let isCleaningUp = false
app.on('before-quit', async (event) => {
  if (isCleaningUp) return
  event.preventDefault()
  isCleaningUp = true
  for (const proc of spawnedProcesses.values()) {
    try { proc.kill() } catch { /* already gone */ }
  }
  spawnedProcesses.clear()
  // The chat child is tracked separately (electron/chat.ts owns it) — killing
  // it here also flushes the interrupted runtime so the next launch can show
  // the partial reply instead of losing it.
  try { killChatChild() } catch (e) { console.error('[shutdown] chat cleanup failed:', e) }
  try {
    await shutdownDb()
  } catch (e) {
    console.error('[shutdown] cleanup failed:', e)
  }
  app.exit(0)
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
