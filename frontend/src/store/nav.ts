import { create } from 'zustand'
import { useConfigDirty } from './configDirty'

export type ViewId =
  | 'today'
  | 'scouting'
  | 'applying'
  | 'outreach'
  | 'offers'
  | 'database'
  | 'reports'
  | 'trends'
  | 'scan'
  | 'config'
  | 'settings'
  | 'profile'
  | 'company'

// Display labels for each view — used by AppShell's nav-guard modal copy,
// the error-boundary label, and the Company view's "back to …" affordance.
// Keep in sync with the Sidebar's NavItem labels.
export const VIEW_LABELS: Record<ViewId, string> = {
  today:    'Today',
  scouting: 'Scouting',
  applying: 'Applying',
  outreach: 'Outreach',
  offers:   'Offers',
  database: 'Database',
  reports:  'Reports',
  trends:   'Trends',
  scan:     'Activity',
  config:   'Configuration',
  settings: 'Settings',
  profile:  'Profile',
  company:  'Company',
}

interface NavState {
  view: ViewId
  databaseFilter: string
  /** Slug of the company whose dossier is showing when `view === 'company'`.
   *  Empty for every other view. */
  companySlug: string
  /** The view the user was on when they opened a company dossier, so the
   *  Company view's back button returns there instead of resetting to the
   *  default tab. Preserved across company→company hops. */
  companyReturnView: ViewId
  /** When the user tries to leave a view with unsaved changes, the
   *  destination is captured here and AppShell renders the
   *  UnsavedChangesModal. `null` means no pending nav. */
  pendingView: ViewId | null
  pendingDatabaseFilter: string
  pendingCompanySlug: string
  navigate: (view: ViewId, databaseFilter?: string, companySlug?: string) => void
  /** Called by the modal's "Save" / "Discard" handlers after the dirty
   *  state has been resolved — performs the actual view swap. */
  confirmPendingNavigate: () => void
  /** Called by the modal's Cancel — drops the pending intent. */
  cancelPendingNavigate: () => void
}

// Views that should be gated behind the unsaved-changes modal when
// they're the *origin* (current) view AND the destination is different.
// Both Configuration and Profile host editable forms; both write their
// dirty state into useConfigDirty (the Profile main tab embeds the same
// ProfileEditPanel that the Configuration → Identity sub-tab uses, and
// it registers under the 'identity' key).
const GATED_ORIGINS: ReadonlySet<ViewId> = new Set(['config', 'profile'])

// Where the Company back button lands when a dossier was opened without an
// in-app origin worth returning to (e.g. a future deep link).
const DEFAULT_COMPANY_RETURN: ViewId = 'database'

// The origin to remember for the Company back button. Company→company hops
// keep the original origin; entering from any other view records that view.
function nextReturnView(currentView: ViewId, destination: ViewId, prevReturn: ViewId): ViewId {
  if (destination !== 'company') return prevReturn
  return currentView === 'company' ? prevReturn : currentView
}

export const useNavStore = create<NavState>((set, get) => ({
  view: 'scouting',
  databaseFilter: '',
  companySlug: '',
  companyReturnView: DEFAULT_COMPANY_RETURN,
  pendingView: null,
  pendingDatabaseFilter: '',
  pendingCompanySlug: '',
  navigate: (view, databaseFilter = '', companySlug = '') => {
    const state = get()
    // Company→company hops change the slug while the view stays 'company',
    // so they must NOT early-return on view alone. Every other same-view,
    // same-slug nav is a genuine no-op.
    if (state.view === view && state.companySlug === companySlug) return

    // Gate: if the user is leaving a dirty origin, capture the intent
    // and let AppShell render the modal. The modal's Save/Discard paths
    // call confirmPendingNavigate to actually swap the view.
    if (GATED_ORIGINS.has(state.view) && useConfigDirty.getState().isAnyDirty()) {
      set({
        pendingView: view,
        pendingDatabaseFilter: databaseFilter,
        pendingCompanySlug: companySlug,
      })
      return
    }

    set({
      view,
      databaseFilter,
      companySlug,
      companyReturnView: nextReturnView(state.view, view, state.companyReturnView),
      pendingView: null,
      pendingDatabaseFilter: '',
      pendingCompanySlug: '',
    })
  },
  confirmPendingNavigate: () => {
    const state = get()
    if (!state.pendingView) return
    set({
      view: state.pendingView,
      databaseFilter: state.pendingDatabaseFilter,
      companySlug: state.pendingCompanySlug,
      companyReturnView: nextReturnView(state.view, state.pendingView, state.companyReturnView),
      pendingView: null,
      pendingDatabaseFilter: '',
      pendingCompanySlug: '',
    })
  },
  cancelPendingNavigate: () =>
    set({ pendingView: null, pendingDatabaseFilter: '', pendingCompanySlug: '' }),
}))
