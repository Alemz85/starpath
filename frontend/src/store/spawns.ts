/**
 * Global registry of running shell spawns.
 *
 * Owns one IPC subscription pair (output + done) at module load so output
 * keeps streaming into the right buffer even when no view is mounted.
 * Components read state via the Zustand selector — no component subscribes
 * to IPC directly anymore.
 */

import { create } from 'zustand'
import { ipc } from '@/lib/ipc'

const OUTPUT_CAP = 1000

export type SpawnStatus = 'running' | 'done' | 'error' | 'killed'

export interface SpawnRecord {
  id: string
  label: string
  status: SpawnStatus
  output: string[]
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Underlying executable — used by the activity panel to brand running
   *  Claude spawns with the Claude logo. Not all spawns are AI-driven. */
  tool: 'claude' | 'node' | 'shell'
}

// Suffix appended to every `claude -p` prompt so the model knows there's no
// human on the other end to confirm anything. Without this, Claude will often
// emit a "should I batch all 47 URLs?" question and exit cleanly when stdin
// is closed — which our activity panel can't distinguish from real success.
export const NON_INTERACTIVE_SUFFIX =
  ' — run end-to-end without asking for confirmations; batch and parallelize where possible; if you would normally pause to confirm, proceed with the default and continue working.'

/**
 * Build a prompt string + args for a non-interactive Claude spawn. Use this
 * for every `claude -p` invocation in the app — it appends the batch suffix,
 * adds `--dangerously-skip-permissions` so tool-permission prompts can't
 * silently hang the run, and asks Claude to emit JSONL events as it works
 * (parsed downstream in appendOutput so the activity panel shows live
 * progress instead of buffering everything until exit).
 */
export function claudeArgs(slashCommand: string): string[] {
  return [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '-p',
    slashCommand + NON_INTERACTIVE_SUFFIX,
  ]
}

// ─── JSONL humanizer for Claude stream-json output ──────────────────────────
//
// `claude -p --output-format stream-json` writes one JSON event per line.
// Each event is one of: {type: "system", ...}, {type: "assistant",
// message: {content: [...]}}, {type: "user", message: {content: [...]}},
// {type: "result", ...}. We surface only the "humanized" parts:
//   - assistant text blocks (Claude's prose)
//   - assistant tool_use blocks rendered as compact one-liners
//   - the final result event as a "✓ Done" / "× error" capstone
// system events and tool_result echoes are dropped — too noisy.
//
// Chunks from the stdout pipe may split a JSONL line mid-line, so we keep a
// per-spawn line buffer until we see the next \n.

const jsonlLineBuffer: Record<string, string> = {}

function humanizeJsonlLines(id: string, chunk: string): string[] {
  const buf = (jsonlLineBuffer[id] ?? '') + chunk
  const parts = buf.split('\n')
  jsonlLineBuffer[id] = parts.pop() ?? ''  // last item is incomplete
  const out: string[] = []
  for (const raw of parts) {
    if (!raw.trim()) continue
    const formatted = humanizeJsonlLine(raw)
    if (formatted == null) continue
    for (const line of formatted.split('\n')) {
      if (line.trim()) out.push(line)
    }
  }
  return out
}

interface JsonlAssistantBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface JsonlEvent {
  type?: string
  subtype?: string
  message?: { content?: JsonlAssistantBlock[] }
  result?: string
}

function humanizeJsonlLine(raw: string): string | null {
  let evt: JsonlEvent
  try {
    evt = JSON.parse(raw) as JsonlEvent
  } catch {
    return raw  // not valid JSON — surface verbatim so we never silently swallow
  }

  if (evt.type === 'system') return null
  if (evt.type === 'result') {
    return evt.subtype === 'success' ? '✓ Done' : `× ${evt.subtype ?? 'error'}`
  }
  if (evt.type === 'assistant' && evt.message?.content) {
    const parts: string[] = []
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      } else if (block.type === 'tool_use') {
        const line = formatToolUse(block)
        if (line) parts.push(line)
      }
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  // user (tool_result echoes) and unknown types — skip.
  return null
}

function formatToolUse(block: JsonlAssistantBlock): string | null {
  const name = String(block.name ?? 'Tool')
  const input = (block.input ?? {}) as Record<string, unknown>
  if (name === 'TodoWrite') return null  // purely internal scheduling, not interesting

  const get = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = get('file_path') || get('path')
      return path ? `→ ${name} ${path}` : `→ ${name}`
    }
    case 'Bash':
      return `→ Bash: ${truncate(get('command'), 80)}`
    case 'Glob':
    case 'Grep': {
      const pat = get('pattern') || get('path')
      return `→ ${name} ${truncate(pat, 80)}`
    }
    case 'WebFetch':
      return `→ WebFetch ${truncate(get('url'), 80)}`
    case 'WebSearch':
      return `→ WebSearch ${truncate(get('query'), 80)}`
    default: {
      // Browser/Playwright/MCP/Agent tools — show name + first stringy input
      // value if compact, else just the tool name.
      const firstVal = Object.values(input).find(v => typeof v === 'string') as string | undefined
      return firstVal ? `→ ${name} ${truncate(firstVal, 80)}` : `→ ${name}`
    }
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

interface SpawnsState {
  spawns: Record<string, SpawnRecord>
  start:        (id: string, label: string, cmd: string, args: string[]) => void
  appendOutput: (id: string, chunk: string) => void
  finish:       (id: string, exitCode: number) => void
  kill:         (id: string) => void
  clear:        (id: string) => void
}

export const useSpawnsStore = create<SpawnsState>((set, get) => ({
  spawns: {},

  start: (id, label, cmd, args) => {
    const tool: SpawnRecord['tool'] =
      cmd === 'claude' ? 'claude' :
      cmd === 'node'   ? 'node'   : 'shell'
    set(state => ({
      spawns: {
        ...state.spawns,
        [id]: {
          id,
          label,
          status: 'running',
          output: [],
          startedAt: Date.now(),
          tool,
        },
      },
    }))
    ipc.spawn(id, cmd, args)
  },

  appendOutput: (id, chunk) => {
    const cur = get().spawns[id]
    if (!cur) return
    // Claude spawns produce JSONL — parse + humanize before appending so the
    // panel shows readable progress instead of raw `{"type":"assistant",…}`.
    // node/shell spawns pass through verbatim (already plain text).
    const linesToAppend = cur.tool === 'claude'
      ? humanizeJsonlLines(id, chunk)
      : [chunk]
    if (linesToAppend.length === 0) return
    set(state => {
      const rec = state.spawns[id]
      if (!rec) return state
      const merged = [...rec.output, ...linesToAppend]
      const capped = merged.length > OUTPUT_CAP
        ? merged.slice(merged.length - OUTPUT_CAP)
        : merged
      return { spawns: { ...state.spawns, [id]: { ...rec, output: capped } } }
    })
  },

  finish: (id, exitCode) => {
    set(state => {
      const rec = state.spawns[id]
      if (!rec) return state
      const status: SpawnStatus = rec.status === 'killed'
        ? 'killed'
        : exitCode === 0 ? 'done' : 'error'
      return { spawns: { ...state.spawns, [id]: { ...rec, status, exitCode, endedAt: Date.now() } } }
    })
  },

  kill: (id) => {
    set(state => {
      const rec = state.spawns[id]
      if (!rec) return state
      return { spawns: { ...state.spawns, [id]: { ...rec, status: 'killed' } } }
    })
    ipc.kill(id)
  },

  clear: (id) => {
    delete jsonlLineBuffer[id]
    set(state => {
      const next = { ...state.spawns }
      delete next[id]
      return { spawns: next }
    })
  },
}))

// Helpers (selectors). These are functions, not hooks — components call them
// inline OR pass into useSpawnsStore(selector).
export const isAnyRunning = (state: SpawnsState): boolean =>
  Object.values(state.spawns).some(s => s.status === 'running')

export const getSpawn = (id: string) =>
  (state: SpawnsState): SpawnRecord | undefined => state.spawns[id]

// ─── Module-level IPC bridge ────────────────────────────────────────────────
// Wired once at module load. Survives view mount/unmount.

let bridged = false
function ensureBridge() {
  if (bridged) return
  if (typeof window === 'undefined') return  // SSR — defer
  bridged = true
  ipc.onSpawnOutput((id, chunk) => {
    useSpawnsStore.getState().appendOutput(id, chunk)
  })
  ipc.onSpawnDone((id, code) => {
    useSpawnsStore.getState().finish(id, code)
  })
}
ensureBridge()
