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
import { useAppStore } from './app'
import {
  claudeArgs,
  NON_INTERACTIVE_SUFFIX,
  humanizeJsonlChunk,
  isAuthFailureText,
  diagnoseFailureText,
} from '@/lib/spawnFormat'

// Re-exported for API stability — call sites across the app import these from
// '@/store/spawns'. The implementations now live in lib/spawnFormat.ts so the
// pure formatting/diagnosis core is testable without zustand/ipc/window.
export { claudeArgs, NON_INTERACTIVE_SUFFIX }

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
  /** Command + args captured at start so a failed run can be retried
   *  verbatim from the activity panel without the originating view. */
  cmd: string
  args: string[]
  /** Set once the user has seen this failure (visited the Activity tab).
   *  Drives the sidebar's "N failed" badge so a run that dies in the
   *  background gets noticed, then stops nagging once acknowledged. */
  acked?: boolean
}

// Per-spawn carry-over buffer for split JSONL lines. The pure humanizer
// (humanizeJsonlChunk in lib/spawnFormat) is fed the previous buffer and
// returns the leftover partial line; the store owns the id→buffer map and
// clears it on start/clear so a re-run never inherits a stale half-line.
const jsonlLineBuffer: Record<string, string> = {}

function humanizeJsonlLines(id: string, chunk: string): string[] {
  const { lines, buffer } = humanizeJsonlChunk(jsonlLineBuffer[id] ?? '', chunk)
  jsonlLineBuffer[id] = buffer
  return lines
}

interface SpawnsState {
  spawns: Record<string, SpawnRecord>
  start:        (id: string, label: string, cmd: string, args: string[]) => void
  retry:        (id: string) => void
  appendOutput: (id: string, chunk: string) => void
  finish:       (id: string, exitCode: number) => void
  kill:         (id: string) => void
  clear:        (id: string) => void
  acknowledgeFailures: () => void
}

export const useSpawnsStore = create<SpawnsState>((set, get) => ({
  spawns: {},

  start: (id, label, cmd, args) => {
    const tool: SpawnRecord['tool'] =
      cmd === 'claude' ? 'claude' :
      cmd === 'node'   ? 'node'   : 'shell'
    delete jsonlLineBuffer[id]  // clear any stale partial line from a prior run of this id
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
          cmd,
          args,
        },
      },
    }))
    ipc.spawn(id, cmd, args)
  },

  // Re-fire a finished spawn with its captured cmd/args, reusing the same id.
  // Reusing the id means views that key off a fixed id (e.g. the Full Scan
  // button) light back up automatically, and the activity panel swaps the
  // failed record for the fresh running one in place.
  retry: (id) => {
    const rec = get().spawns[id]
    if (!rec || rec.status === 'running') return
    get().start(id, rec.label, rec.cmd, rec.args)
  },

  appendOutput: (id, chunk) => {
    const cur = get().spawns[id]
    if (!cur) return
    // Watch claude runs for an auth death and raise the global re-login
    // banner. Checked on the raw chunk before humanizing — the 401 arrives
    // as a plain-text error line, not a JSONL event.
    if (cur.tool === 'claude' && isAuthFailureText(chunk)) {
      useAppStore.getState().flagAuthError('runtime-401')
    }
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

  // Mark every currently-failed run as seen. Called when the user opens the
  // Activity tab — clears the sidebar failure badge without losing the rows.
  acknowledgeFailures: () => {
    set(state => {
      let changed = false
      const next: Record<string, SpawnRecord> = {}
      for (const [id, rec] of Object.entries(state.spawns)) {
        if (rec.status === 'error' && !rec.acked) { next[id] = { ...rec, acked: true }; changed = true }
        else next[id] = rec
      }
      return changed ? { spawns: next } : state
    })
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

// Count of failed runs the user hasn't seen yet — drives the sidebar badge.
export const unackedFailureCount = (state: SpawnsState): number =>
  Object.values(state.spawns).filter(s => s.status === 'error' && !s.acked).length

// ─── Failure diagnosis ──────────────────────────────────────────────────────
// Turn a failed run's raw output into a one-line, human-actionable cause so the
// activity panel doesn't make the user scroll a log to figure out what broke.

export function isAuthFailure(rec: SpawnRecord): boolean {
  return rec.status === 'error' && isAuthFailureText(rec.output.join('\n'))
}

export function diagnoseFailure(rec: SpawnRecord): string | null {
  if (rec.status !== 'error') return null
  return diagnoseFailureText(rec.output.join('\n'))
}

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
