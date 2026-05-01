import { create } from 'zustand'
import { useConfigDirty } from './configDirty'

export type ViewId =
  | 'scouting'
  | 'applying'
  | 'database'
  | 'reports'
  | 'trends'
  | 'scan'
  | 'config'
  | 'settings'
  | 'profile'

interface NavState {
  view: ViewId
  databaseFilter: string
  /** When the user tries to leave a view with unsaved changes, the
   *  destination is captured here and AppShell renders the
   *  UnsavedChangesModal. `null` means no pending nav. */
  pendingView: ViewId | null
  pendingDatabaseFilter: string
  navigate: (view: ViewId, databaseFilter?: string) => void
  /** Called by the modal's "Save" / "Discard" handlers after the dirty
   *  state has been resolved — performs the actual view swap. */
  confirmPendingNavigate: () => void
  /** Called by the modal's Cancel — drops the pending intent. */
  cancelPendingNavigate: () => void
}

// Views that should be gated behind the unsaved-changes modal when
// they're the *origin* (current) view AND the destination is different.
// Configuration is currently the only view with form-dirty tracking
// (via useConfigDirty); add other views here as their dirty stores land.
const GATED_ORIGINS: ReadonlySet<ViewId> = new Set(['config'])

export const useNavStore = create<NavState>((set, get) => ({
  view: 'scouting',
  databaseFilter: '',
  pendingView: null,
  pendingDatabaseFilter: '',
  navigate: (view, databaseFilter = '') => {
    const state = get()
    if (state.view === view) return

    // Gate: if the user is leaving a dirty origin, capture the intent
    // and let AppShell render the modal. The modal's Save/Discard paths
    // call confirmPendingNavigate to actually swap the view.
    if (GATED_ORIGINS.has(state.view) && state.view === 'config' && useConfigDirty.getState().isAnyDirty()) {
      set({ pendingView: view, pendingDatabaseFilter: databaseFilter })
      return
    }

    set({ view, databaseFilter, pendingView: null, pendingDatabaseFilter: '' })
  },
  confirmPendingNavigate: () => {
    const state = get()
    if (!state.pendingView) return
    set({
      view: state.pendingView,
      databaseFilter: state.pendingDatabaseFilter,
      pendingView: null,
      pendingDatabaseFilter: '',
    })
  },
  cancelPendingNavigate: () => set({ pendingView: null, pendingDatabaseFilter: '' }),
}))
