import { useMemo } from 'react'
import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import {
  writeGate, DEMO_DATA_PATH,
  type DataRootInfo, type PrivateInitResult, type WriteGate,
} from '@/lib/dataRoot'

// Where personal data is served from right now (private/, the demo, an
// external folder), as main resolved it. One store so every surface — the
// layout gate, the demo badge, Settings › Data, and the write gate on every
// action — agrees. main broadcasts `data-root:changed` after any switch.

interface DataRootState {
  info: DataRootInfo | null
  loaded: boolean
  /** A demo on/off switch or private init is in flight. */
  busy: boolean
  load: () => Promise<DataRootInfo | null>
  /** true → show the demo (read-only); false → back to own data. */
  setDemo: (on: boolean) => Promise<{ ok: boolean; message?: string }>
  /** Create private/ (`node scripts/private.mjs init --json`). */
  initPrivate: () => Promise<PrivateInitResult>
}

export const useDataRootStore = create<DataRootState>((set, get) => ({
  info: null,
  loaded: false,
  busy: false,

  load: async () => {
    const info = await ipc.dataRoot.info().catch(() => null)
    set({ info: info ?? null, loaded: true })
    return info ?? null
  },

  setDemo: async (on) => {
    if (get().busy) return { ok: false, message: 'A switch is already running' }
    set({ busy: true })
    try {
      const info = await ipc.dataRoot.setDataPath(on ? DEMO_DATA_PATH : null)
      if (info) set({ info })
      // Leaving the demo can be overruled by STARPATH_DATA=demo in the app's
      // environment; say so instead of pretending it worked.
      if (!on && info?.kind === 'demo') {
        return { ok: false, message: 'STARPATH_DATA pins the demo for this launch' }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    } finally {
      set({ busy: false })
    }
  },

  initPrivate: async () => {
    set({ busy: true })
    try {
      const res = await ipc.dataRoot.initPrivate()
      await get().load()
      return res ?? { ok: false, error: 'ipc', message: 'No response from the app.' }
    } catch (e) {
      return { ok: false, error: 'ipc', message: e instanceof Error ? e.message : String(e) }
    } finally {
      set({ busy: false })
    }
  },
}))

/**
 * The write gate for components: `canWrite` false in demo mode, with the
 * "Demo data is read-only" tooltip for the disabled control.
 */
export function useWriteGate(): WriteGate {
  const info = useDataRootStore(s => s.info)
  return useMemo(() => writeGate(info), [info])
}

/** Same gate for stores and event handlers (outside React render). */
export function canWriteNow(): boolean {
  return writeGate(useDataRootStore.getState().info).canWrite
}

// ─── Live updates ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const subscribe = () => {
    if (!window.electron?.onDataRootChanged) return false
    ipc.dataRoot.onChanged(info => useDataRootStore.setState({ info, loaded: true }))
    return true
  }
  if (!subscribe()) setTimeout(subscribe, 0)
}
