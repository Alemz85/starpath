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
 * for every `claude -p` invocation in the app — it appends the batch suffix
 * and adds `--dangerously-skip-permissions` so tool-permission prompts can't
 * silently hang the run.
 */
export function claudeArgs(slashCommand: string): string[] {
  return ['--dangerously-skip-permissions', '-p', slashCommand + NON_INTERACTIVE_SUFFIX]
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
    set(state => {
      const rec = state.spawns[id]
      if (!rec) return state
      const next = rec.output.length >= OUTPUT_CAP
        ? [...rec.output.slice(rec.output.length - OUTPUT_CAP + 1), chunk]
        : [...rec.output, chunk]
      return { spawns: { ...state.spawns, [id]: { ...rec, output: next } } }
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
