import { create } from 'zustand'

// Tracks which form sections inside Configuration have unsaved changes
// AND holds their save handlers so the ConfigurationView can do "save and
// switch" in one click without each tab having to know about the others.
//
// Each tab can host multiple sections (RolesTab has primary roles + dream
// companies + target locations; PortalsTab has keywords + companies +
// lang_blocklist). To avoid one section's "I'm clean" effect overwriting
// another section's "I'm dirty" flag, we key by source id: each section
// declares a stable id and toggles its own membership in the per-tab set.
//
// The save handlers are stored in the same place — registered by each
// section on mount, called by `saveAll(tab)` when the user clicks
// "Save and switch" on the unsaved-changes modal.

export type ConfigTab = 'identity' | 'roles' | 'portals'

interface ConfigDirtyState {
  identity: Set<string>
  roles:    Set<string>
  portals:  Set<string>
  saveHandlers: Map<string, () => Promise<void>>
  setDirty: (tab: ConfigTab, source: string, dirty: boolean) => void
  registerSaveHandler: (source: string, handler: (() => Promise<void>) | null) => void
  saveAll:  (tab: ConfigTab) => Promise<void>
  /** Save every dirty tab (used by AppShell's cross-view nav guard). */
  saveAllDirty: () => Promise<void>
  isDirty:  (tab: ConfigTab) => boolean
  /** True when ANY tab has unsaved changes (used by the nav-guard gate). */
  isAnyDirty: () => boolean
  resetAll: () => void
}

export const useConfigDirty = create<ConfigDirtyState>((set, get) => ({
  identity: new Set(),
  roles:    new Set(),
  portals:  new Set(),
  saveHandlers: new Map(),
  setDirty: (tab, source, dirty) => set(state => {
    const cur = state[tab]
    const has = cur.has(source)
    if (has === dirty) return state
    const next = new Set(cur)
    if (dirty) next.add(source)
    else next.delete(source)
    return { ...state, [tab]: next }
  }),
  registerSaveHandler: (source, handler) => set(state => {
    const next = new Map(state.saveHandlers)
    if (handler) next.set(source, handler)
    else next.delete(source)
    return { ...state, saveHandlers: next }
  }),
  saveAll: async (tab) => {
    const state = get()
    // Snapshot the dirty list — saves clear individual sources from the
    // set, and we don't want the iteration to get confused by that.
    const dirtySources = Array.from(state[tab])
    // Dedup by handler reference. PortalsTab registers a single
    // handleSave under three sourceIds (keywords / lang / raw); without
    // this dedup, saveAll would call it three times.
    const unique = new Set<() => Promise<void>>()
    for (const source of dirtySources) {
      const handler = state.saveHandlers.get(source)
      if (handler) unique.add(handler)
    }
    for (const handler of unique) {
      await handler()
    }
  },
  saveAllDirty: async () => {
    // Iterate the three tabs; saveAll on a clean tab is a no-op (its
    // dirty-source set is empty and the handler loop short-circuits).
    await get().saveAll('identity')
    await get().saveAll('roles')
    await get().saveAll('portals')
  },
  isDirty: (tab) => get()[tab].size > 0,
  isAnyDirty: () => {
    const s = get()
    return s.identity.size + s.roles.size + s.portals.size > 0
  },
  resetAll: () => set({ identity: new Set(), roles: new Set(), portals: new Set() }),
}))
