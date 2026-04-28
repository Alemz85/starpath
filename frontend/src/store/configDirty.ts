import { create } from 'zustand'

// Tracks which form sections inside Configuration have unsaved changes.
// Each tab can host multiple sections (RolesTab has primary roles + dream
// companies + target locations; PortalsTab has keywords + companies +
// lang_blocklist). To avoid one section's "I'm clean" effect overwriting
// another section's "I'm dirty" flag, we key by source id: each section
// declares a stable id and toggles its own membership in the per-tab set.

export type ConfigTab = 'identity' | 'roles' | 'portals'

interface ConfigDirtyState {
  identity: Set<string>
  roles:    Set<string>
  portals:  Set<string>
  setDirty: (tab: ConfigTab, source: string, dirty: boolean) => void
  isDirty:  (tab: ConfigTab) => boolean
  resetAll: () => void
}

export const useConfigDirty = create<ConfigDirtyState>((set, get) => ({
  identity: new Set(),
  roles:    new Set(),
  portals:  new Set(),
  setDirty: (tab, source, dirty) => set(state => {
    const cur = state[tab]
    const has = cur.has(source)
    if (has === dirty) return state
    const next = new Set(cur)
    if (dirty) next.add(source)
    else next.delete(source)
    return { ...state, [tab]: next }
  }),
  isDirty: (tab) => get()[tab].size > 0,
  resetAll: () => set({ identity: new Set(), roles: new Set(), portals: new Set() }),
}))
