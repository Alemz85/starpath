// Chat — the main process half of the conversational tab.
//
// This file is thin glue on purpose: the reducer, the session-store
// transforms, the CLI arg builder, and the stream interpretation are all pure
// modules under `src/lib/chat/` (compiled into this bundle via
// tsconfig.electron.json). What lives here is the part that genuinely needs
// the main process:
//
//   - ownership of the single live generation (a second `chat:send` while one
//     runs is rejected rather than queued — two `claude` children writing to
//     one transcript has no coherent reading),
//   - the child spawn / stream loop / kill,
//   - persistence to `{userData}/chat/{sessions,runtime}.json`,
//   - the `chat:*` IPC surface.
//
// Persistence is JSON, NOT the SQLite cache: that cache is fully derivable
// from the repo's Markdown/TSV and must stay that way (frontend/ARCHITECTURE.md),
// and a conversation is not derivable from anything.
//
// Reattach: the runtime snapshot is written through every transition (throttled
// for the high-frequency text/work ones), so a renderer that remounts — tab
// switch, reload, or a relaunch after a quit — calls `chat:state`, gets the
// partial answer plus the sequence it ended at, and keeps folding envelopes
// from there. A snapshot found still-live at startup has no child behind it
// any more, so it is restored as `interrupted` with its partial answer intact.

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { ipcMain, type BrowserWindow } from 'electron'
import type { ModelAlias } from '../src/types'
import type {
  ChatRuntimeEnvelope,
  ChatRuntimeSnapshot,
  ChatSessionsFile,
} from '../src/lib/chat/types'
import { isLivePhase } from '../src/lib/chat/types'
import {
  MAX_RUNTIME_BYTES,
  reduceRuntime,
  restoreRuntime,
  utf8Length,
  type ChatRuntimeAction,
} from '../src/lib/chat/runtime'
import {
  appendMessage,
  createSession,
  deleteSession,
  deriveTitle,
  emptySessionsFile,
  getSession,
  listSessions,
  parseSessionsFile,
  serializeSessionsFile,
  setClaudeSessionId,
} from '../src/lib/chat/sessions'
import { buildChatClaudeArgs } from '../src/lib/chat/args'
import {
  extractClaudeCliFailure,
  interpretChatEvent,
  newChatStreamState,
  splitStreamChunk,
} from '../src/lib/chat/stream'

const PERSIST_THROTTLE_MS = 200
const CHAT_EVENT_CHANNEL = 'chat:event'

export interface ChatDeps {
  /** `app.getPath('userData')`. */
  userDataDir: string
  /** Configured repo root — the spawn's cwd. null while onboarding. */
  getRepoPath: () => string | null
  getWindow: () => BrowserWindow | null
  /** PATH-augmented env used by every other spawn in main. */
  env: NodeJS.ProcessEnv
  /** Model alias for chat turns; undefined lets the CLI default apply. */
  getModel: () => ModelAlias | undefined
}

// ─── Persisted runtime ────────────────────────────────────────────────────────

class ChatRuntimeFile {
  private current: ChatRuntimeSnapshot | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly filePath: string) {}

  /** Read the last snapshot; a live one becomes `interrupted`. */
  restore(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8')
    } catch {
      return
    }
    if (utf8Length(raw) > MAX_RUNTIME_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const step = restoreRuntime(parsed, new Date().toISOString())
    if (!step) return
    this.current = step.snapshot
    this.flush()
  }

  snapshot(): ChatRuntimeSnapshot | null {
    return this.current ? structuredClone(this.current) : null
  }

  isLive(): boolean {
    return isLivePhase(this.current?.phase)
  }

  /** Reduce + persist. Terminal transitions write through immediately. */
  dispatch(action: ChatRuntimeAction): ChatRuntimeEnvelope | null {
    const step = reduceRuntime(this.current, action, new Date().toISOString())
    this.current = step.snapshot
    if (action.type === 'text' || action.type === 'work' || action.type === 'resume-available') {
      this.scheduleFlush()
    } else {
      this.flush()
    }
    return step.envelope
  }

  flush(): void {
    this.cancelScheduledFlush()
    if (!this.current) return
    const serialized = JSON.stringify(this.current)
    // The reducer's per-field caps keep this well under the ceiling; a blown
    // budget means a cap regressed, and dropping the write is better than
    // growing an unbounded file in the user's app data.
    if (utf8Length(serialized) > MAX_RUNTIME_BYTES) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, serialized, { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmp, this.filePath)
    } catch (e) {
      console.error('[chat] runtime persist failed:', e)
    }
  }

  clear(): void {
    this.cancelScheduledFlush()
    this.current = null
    try { fs.rmSync(this.filePath, { force: true }) } catch { /* already gone */ }
    try { fs.rmSync(`${this.filePath}.tmp`, { force: true }) } catch { /* already gone */ }
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, PERSIST_THROTTLE_MS)
    this.timer.unref?.()
  }

  private cancelScheduledFlush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

// ─── Module state ─────────────────────────────────────────────────────────────

interface ActiveChat {
  sessionId: string
  generationId: string
  child: ChildProcess
  /** Set by chat:stop — a SIGTERM'd run completes rather than fails. */
  stopped: boolean
}

let deps: ChatDeps | null = null
let runtime: ChatRuntimeFile | null = null
let sessionsPath = ''
let active: ActiveChat | null = null

function requireDeps(): ChatDeps {
  if (!deps) throw new Error('chat IPC is not registered')
  return deps
}

// ─── Sessions file ────────────────────────────────────────────────────────────

function readSessions(): ChatSessionsFile {
  try {
    return parseSessionsFile(fs.readFileSync(sessionsPath, 'utf-8'))
  } catch {
    return emptySessionsFile()
  }
}

function writeSessions(file: ChatSessionsFile): void {
  try {
    fs.mkdirSync(path.dirname(sessionsPath), { recursive: true })
    const tmp = `${sessionsPath}.tmp`
    fs.writeFileSync(tmp, serializeSessionsFile(file), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, sessionsPath)
  } catch (e) {
    console.error('[chat] sessions persist failed:', e)
  }
}

// ─── Envelope plumbing ────────────────────────────────────────────────────────

function emit(envelope: ChatRuntimeEnvelope | null): void {
  if (!envelope) return
  const window = deps?.getWindow()
  if (window && !window.isDestroyed()) window.webContents.send(CHAT_EVENT_CHANNEL, envelope)
}

function dispatch(action: ChatRuntimeAction): void {
  if (!runtime) return
  emit(runtime.dispatch(action))
}

// ─── Send ─────────────────────────────────────────────────────────────────────

function sendMessage(
  sessionId: unknown,
  message: unknown,
): { sessionId: string; generationId: string } {
  const d = requireDeps()
  const store = runtime!
  if (active || store.isLive()) throw new Error('A chat reply is already running.')
  if (typeof message !== 'string') throw new Error('message must be text')
  const prompt = message.trim()
  if (!prompt) throw new Error('message cannot be empty')
  if (sessionId !== null && sessionId !== undefined && typeof sessionId !== 'string') {
    throw new Error('sessionId must be a string or null')
  }
  const repoPath = d.getRepoPath()
  if (!repoPath) throw new Error('No repository is configured yet.')

  const now = new Date().toISOString()
  let file = readSessions()
  let session = typeof sessionId === 'string' ? getSession(file, sessionId) : null
  if (!session) {
    const created = createSession(file, {
      id: randomUUID(),
      now,
      title: deriveTitle(prompt),
    })
    file = created.file
    session = created.session
  }

  // The user's turn is persisted before the spawn: if the CLI dies on launch
  // the transcript still shows what was asked.
  file = appendMessage(file, session.id, { role: 'user', content: prompt, ts: now })
  writeSessions(file)

  dispatch({ type: 'begin', generationId: randomUUID(), sessionId: session.id, message: prompt })
  const snapshot = store.snapshot()
  const generationId = snapshot?.generationId ?? ''
  if (session.claudeSessionId) dispatch({ type: 'resume-available', available: true })

  const args = buildChatClaudeArgs(prompt, {
    resumeId: session.claudeSessionId,
    model: d.getModel() ?? null,
  })
  // stdio ['ignore','pipe','pipe'] closes stdin — same reason as shell:spawn:
  // `claude -p` otherwise waits on stdin before it starts.
  let child: ChildProcess
  try {
    child = spawn('claude', args, {
      cwd: repoPath,
      shell: false,
      env: d.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    // A synchronous spawn failure would otherwise strand the runtime in
    // `starting` and block every later send.
    dispatch({
      type: 'failed',
      message: `failed to start the claude CLI: ${e instanceof Error ? e.message : String(e)}`,
    })
    throw e
  }
  active = { sessionId: session.id, generationId, child, stopped: false }
  dispatch({ type: 'running' })

  const streamState = newChatStreamState()
  let assistantText = ''
  let buffer = ''
  let stderr = ''
  let spawnError: string | null = null
  let cliFailure: string | null = null
  const sessionRowId = session.id

  const handleEvent = (event: unknown): void => {
    cliFailure = extractClaudeCliFailure(event) ?? cliFailure
    for (const directive of interpretChatEvent(event, streamState)) {
      if (directive.kind === 'session') {
        writeSessions(setClaudeSessionId(readSessions(), sessionRowId, directive.id))
        dispatch({ type: 'resume-available', available: true })
      } else if (directive.kind === 'text') {
        assistantText += directive.text
        dispatch({ type: 'text', text: directive.text })
      } else {
        dispatch({
          type: 'work',
          kind: directive.entry.kind,
          label: directive.entry.label,
          detail: directive.entry.detail,
        })
      }
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const result = splitStreamChunk(buffer, chunk.toString())
    buffer = result.buffer
    for (const event of result.events) handleEvent(event)
  })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('error', (err: Error) => {
    spawnError = `failed to start the claude CLI: ${err.message}`
  })
  child.on('close', (code: number | null) => {
    const trailing = splitStreamChunk(buffer, '\n')
    for (const event of trailing.events) handleEvent(event)
    const stopped = active?.generationId === generationId && active.stopped
    if (active?.generationId === generationId) active = null

    if (assistantText.trim()) {
      writeSessions(appendMessage(readSessions(), sessionRowId, {
        role: 'assistant',
        content: assistantText,
        ts: new Date().toISOString(),
      }))
    }

    if (code === 0 || stopped) {
      dispatch({ type: 'completed' })
    } else {
      const detail =
        spawnError ||
        cliFailure ||
        stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) ||
        `the claude CLI exited with code ${code}`
      dispatch({ type: 'failed', message: detail })
    }
  })

  return { sessionId: session.id, generationId }
}

function stopMessage(sessionId: unknown): boolean {
  if (!active || typeof sessionId !== 'string' || active.sessionId !== sessionId) return false
  active.stopped = true
  dispatch({ type: 'stopping' })
  return active.child.kill('SIGTERM')
}

/**
 * Quit cleanup — called from main's before-quit alongside the other child-
 * process kills. The in-flight generation is marked interrupted and written
 * through, so the next launch can show the partial answer instead of losing it.
 */
export function killChatChild(): void {
  if (active) {
    if (runtime?.isLive()) runtime.dispatch({ type: 'interrupted' })
    try { active.child.kill('SIGTERM') } catch { /* already gone */ }
    active = null
  }
  runtime?.flush()
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

export function registerChat(dependencies: ChatDeps): void {
  deps = dependencies
  const chatDir = path.join(dependencies.userDataDir, 'chat')
  sessionsPath = path.join(chatDir, 'sessions.json')
  runtime = new ChatRuntimeFile(path.join(chatDir, 'runtime.json'))
  runtime.restore()

  ipcMain.handle('chat:send', (_e, sessionId: unknown, message: unknown) =>
    sendMessage(sessionId, message))

  ipcMain.handle('chat:stop', (_e, sessionId: unknown) => stopMessage(sessionId))

  ipcMain.handle('chat:state', () => runtime?.snapshot() ?? null)

  ipcMain.handle('chat:sessions', () => listSessions(readSessions()))

  ipcMain.handle('chat:session-get', (_e, id: unknown) => {
    if (typeof id !== 'string') return null
    return getSession(readSessions(), id)
  })

  ipcMain.handle('chat:session-new', () => {
    const { file, session } = createSession(readSessions(), {
      id: randomUUID(),
      now: new Date().toISOString(),
    })
    writeSessions(file)
    const { messages: _messages, ...meta } = session
    return meta
  })

  ipcMain.handle('chat:session-delete', (_e, id: unknown) => {
    if (typeof id !== 'string') return false
    if (active?.sessionId === id) {
      throw new Error('Cannot delete a conversation while its reply is running.')
    }
    writeSessions(deleteSession(readSessions(), id))
    if (runtime?.snapshot()?.sessionId === id) runtime.clear()
    return true
  })
}
