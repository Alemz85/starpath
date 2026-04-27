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
import https from 'https'
import http from 'http'
import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'

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
const loadURL = isDev ? null : serve({ directory: path.join(__dirname, '../out') })

// ─── Config store ─────────────────────────────────────────────────────────────

const configPath = path.join(app.getPath('userData'), 'config.json')

interface AppConfig {
  repoPath?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
  tailoringComplete?: boolean
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

function resolveRepoPath(filePath: string): string | null {
  const repoPath = getRepoPath()
  if (!repoPath) return null
  // Security: prevent path traversal
  const resolved = path.resolve(repoPath, filePath)
  if (!resolved.startsWith(path.resolve(repoPath))) return null
  return resolved
}

function validateString(val: unknown, name: string): string {
  if (typeof val !== 'string') throw new Error(`${name} must be a string`)
  return val
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

async function checkClaudeAuth(): Promise<boolean> {
  const home = process.env.HOME ?? ''

  // Fast path: check credential files claude-code writes after login
  const credPaths = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
    path.join(home, '.config', '@anthropic-ai', 'claude-code', 'credentials.json'),
  ]
  for (const p of credPaths) {
    if (fs.existsSync(p)) {
      try {
        const creds = JSON.parse(fs.readFileSync(p, 'utf-8'))
        if (creds?.access_token || creds?.token || creds?.api_key || creds?.claudeAiOauth) return true
      } catch { /* malformed, keep checking */ }
    }
  }

  // Fall back to CLI command
  try {
    const { stdout, stderr } = await execAsync('claude auth status', { env: SHELL_ENV, timeout: 6000 })
    const out = (stdout + stderr).toLowerCase()
    if (out.includes('not logged') || out.includes('not authenticated') || out.includes('sign in')) return false
    // Any successful response that mentions an account or "logged in" → authenticated
    if (out.includes('logged in') || out.includes('@') || out.includes('authenticated')) return true
  } catch { /* command may not exist in older versions */ }

  return false
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
    backgroundColor: '#0D0A1F',
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
            ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:3000; img-src 'self' data: https://logo.clearbit.com https://unavatar.io https://www.google.com https://t1.gstatic.com;"
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

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000')
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

ipcMain.handle('app:set-repo-path', (_e, repoPath: unknown) => {
  const p = validateString(repoPath, 'repoPath')
  writeConfig({ ...readConfig(), repoPath: p })
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

ipcMain.handle('app:open-external', (_e, url: unknown) => {
  const u = validateString(url, 'url')
  if (u.startsWith('http://') || u.startsWith('https://')) shell.openExternal(u)
})

// ─── IPC: Claude checks ───────────────────────────────────────────────────────

ipcMain.handle('app:check-claude', async () => {
  const installed = await checkClaudeInstalled()
  return { installed }
})

ipcMain.handle('app:check-claude-auth', async () => {
  const authenticated = await checkClaudeAuth()
  return { authenticated }
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

ipcMain.handle('fs:read', (_e, filePath: unknown) => {
  const fp = validateString(filePath, 'filePath')
  const full = resolveRepoPath(fp)
  if (!full) return null
  try { return fs.readFileSync(full, 'utf-8') } catch { return null }
})

ipcMain.handle('fs:write', (_e, filePath: unknown, content: unknown) => {
  const fp = validateString(filePath, 'filePath')
  const c = validateString(content, 'content')
  const full = resolveRepoPath(fp)
  if (!full) throw new Error('No repo path configured')
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, c, 'utf-8')
})

ipcMain.handle('fs:exists', (_e, filePath: unknown) => {
  const fp = validateString(filePath, 'filePath')
  const full = resolveRepoPath(fp)
  return full ? fs.existsSync(full) : false
})

ipcMain.handle('fs:list', (_e, dirPath: unknown) => {
  const dp = validateString(dirPath, 'dirPath')
  const full = resolveRepoPath(dp)
  if (!full || !fs.existsSync(full)) return []
  try { return fs.readdirSync(full) } catch { return [] }
})

ipcMain.handle('fs:list-recursive', (_e, dirPath: unknown, ext: unknown) => {
  const dp = validateString(dirPath, 'dirPath')
  const ex = validateString(ext, 'ext')
  const repoPath = getRepoPath()
  if (!repoPath) return []
  const full = path.join(repoPath, dp)
  if (!fs.existsSync(full)) return []
  const results: string[] = []
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fp)
      else if (entry.name.endsWith(ex)) results.push(path.relative(repoPath as string, fp))
    }
  }
  walk(full)
  return results
})

// ─── IPC: Shell (one-shot) ────────────────────────────────────────────────────

ipcMain.handle('shell:run', async (_e, cmd: unknown, args: unknown) => {
  const c = validateString(cmd, 'cmd')
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('args must be string[]')
  const repoPath = getRepoPath() ?? app.getPath('home')
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    exec([c, ...args as string[]].join(' '), { cwd: repoPath, env: SHELL_ENV }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err?.code ?? 0 })
    })
  })
})

// ─── IPC: Shell (streaming spawn) ─────────────────────────────────────────────

const spawnedProcesses = new Map<string, ChildProcess>()

ipcMain.handle('shell:spawn', (_e, id: unknown, cmd: unknown, args: unknown) => {
  const sid = validateString(id, 'id')
  const c = validateString(cmd, 'cmd')
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('args must be string[]')
  const repoPath = getRepoPath() ?? app.getPath('home')
  const proc = spawn(c, args as string[], { cwd: repoPath, shell: false, env: SHELL_ENV })
  spawnedProcesses.set(sid, proc)
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

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
