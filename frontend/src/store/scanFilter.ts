import { create } from 'zustand'

// Persists the cockpit's "Filtered Scan" company selection across tab
// switches so the user's dream-company shortlist doesn't reset every
// time they navigate away. The store ALSO tracks whether the dream-
// companies pre-selection has run this session — without that flag,
// every remount of CommandCenter would re-clobber the user's edits
// with the default dream-company set on each repaint.

interface ScanFilterState {
  selected: Set<string>
  /** True after the first time we've loaded portals.yml + profile.yml
   *  and applied the dream-companies pre-selection. Subsequent mounts
   *  don't re-apply (so user edits stick). Reset to false via
   *  `applyDreamDefaults()` to re-run the pre-selection on demand. */
  initialized: boolean
  toggle: (name: string) => void
  setSelected: (names: string[]) => void
  clear: () => void
  /** First-mount initializer — pre-selects the dream-company list.
   *  Idempotent: only runs the first time per session unless force=true. */
  applyDreamDefaults: (dreams: string[], force?: boolean) => void
}

export const useScanFilter = create<ScanFilterState>((set, get) => ({
  selected: new Set(),
  initialized: false,
  toggle: (name) => set(state => {
    const next = new Set(state.selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return { selected: next }
  }),
  setSelected: (names) => set({ selected: new Set(names) }),
  clear: () => set({ selected: new Set() }),
  applyDreamDefaults: (dreams, force = false) => {
    if (!force && get().initialized) return
    set({ selected: new Set(dreams), initialized: true })
  },
}))
