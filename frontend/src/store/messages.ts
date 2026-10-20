import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { AgentMessage, MessageStatus, MessageStatusResult } from '@/lib/messages'

// Agent → user Messages, mirrored from data/agent-messages.jsonl by main.
// Loaded once by the sidebar (for the badge) and kept current by the
// `messages:changed` push and data-root / profile changes.

interface MessagesState {
  messages: AgentMessage[]
  loaded: boolean
  load: () => Promise<void>
  /** Resolve / dismiss / reopen. Null when outside Electron. Never throws. */
  setStatus: (id: string, status: MessageStatus, note?: string) => Promise<MessageStatusResult | null>
}

let inFlight: Promise<void> | null = null

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  loaded: false,

  load: async () => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const list = await ipc.messages.list()
        set({ messages: Array.isArray(list) ? list : [], loaded: true })
      } catch (e) {
        console.error('[messages] load failed:', e)
        set({ loaded: true })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },

  setStatus: async (id, status, note) => {
    let res: MessageStatusResult | null
    try {
      res = await ipc.messages.setStatus({ id, status, note })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: null }
    }
    if (res?.ok) {
      // Fold the answer in now; the file watch will confirm it shortly.
      set({ messages: get().messages.map(m => (m.id === res.message.id ? res.message : m)) })
    }
    return res
  },
}))

// ─── Live updates ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const subscribe = () => {
    if (!window.electron?.onMessagesChanged) return false
    const reload = () => { void useMessagesStore.getState().load() }
    ipc.messages.onChanged(reload)
    ipc.dataRoot.onChanged(reload)
    window.electron.onProfileChanged?.(reload)
    return true
  }
  if (!subscribe()) setTimeout(subscribe, 0)
}
