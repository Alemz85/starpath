import { create } from 'zustand'
import { useConfigDirty } from './configDirty'

export type ViewId =
  | 'today'
  | 'chat'
  | 'scouting'
  | 'applying'
  | 'outreach'
  | 'offers'
  | 'database'
  | 'reports'
  | 'trends'
  | 'pipeline'
  | 'scan'
  | 'settings'
  | 'profile'
  | 'company'

// Display labels for each view — used by AppShell's nav-guard modal copy,
// the error-boundary label, and the Company view's "back to …" affordance.
// Keep in sync with the Sidebar's NavItem labels.
export const VIEW_LABELS: Record<ViewId, string> = {
  today:    'Today',
  chat:     'Chat',
  scouting: 'Scouting',
  applying: 'Applying',
  outreach: 'Outreach',
  offers:   'Offers',
  database: 'Database',
  reports:  'Reports',
  trends:   'Trends',
  pipeline: 'Pipeline',
  scan:     'Activity',
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
  /** Sub-tab request for views that host internal tabs (Outreach's
   *  board/network, Trends' landscape/scoretrend, Settings' sections).
   *  One-shot payload like databaseFilter: set by navigate(), consumed by
   *  the destination view's tab-sync effect, and reset to '' by the next
   *  navigate() that doesn't pass one. */
  viewTab: string
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
  pendingViewTab: string
  navigate: (view: ViewId, databaseFilter?: string, companySlug?: string, viewTab?: string) => void
  /** Called by the modal's "Save" / "Discard" handlers after the dirty
   *  state has been resolved — performs the actual view swap. */
  confirmPendingNavigate: () => void
  /** Called by the modal's Cancel — drops the pending intent. */
  cancelPendingNavigate: () => void
}

// Views that should be gated behind the unsaved-changes modal when
// they're the *origin* (current) view AND the destination is different.
// Settings hosts the editable user-data forms (Identity / Target Roles /
// Portals sub-tabs); their dirty state lives in useConfigDirty.
const GATED_ORIGINS: ReadonlySet<ViewId> = new Set(['settings'])

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
  viewTab: '',
  companyReturnView: DEFAULT_COMPANY_RETURN,
  pendingView: null,
  pendingDatabaseFilter: '',
  pendingCompanySlug: '',
  pendingViewTab: '',
  navigate: (view, databaseFilter = '', companySlug = '', viewTab = '') => {
    const state = get()
    // Same-view navs are no-ops UNLESS they carry a fresh payload — a
    // company→company hop, a new database filter, or a sub-tab request
    // while already on the view must still go through so the destination's
    // sync effects fire. An empty payload means "no request", so a
    // redundant sidebar click never wipes the active filter or sub-tab.
    const payloadChanged =
      (databaseFilter !== '' && databaseFilter !== state.databaseFilter) ||
      (viewTab !== '' && viewTab !== state.viewTab)
    if (state.view === view && state.companySlug === companySlug && !payloadChanged) return

    // Gate: if the user is leaving a dirty origin for a DIFFERENT view,
    // capture the intent and let AppShell render the modal. The modal's
    // Save/Discard paths call confirmPendingNavigate to actually swap the
    // view. Same-view navs (a sub-tab hop inside Settings) fall through to
    // the view's own intra-tab modal instead.
    if (GATED_ORIGINS.has(state.view) && view !== state.view && useConfigDirty.getState().isAnyDirty()) {
      set({
        pendingView: view,
        pendingDatabaseFilter: databaseFilter,
        pendingCompanySlug: companySlug,
        pendingViewTab: viewTab,
      })
      return
    }

    set({
      view,
      databaseFilter,
      companySlug,
      viewTab,
      companyReturnView: nextReturnView(state.view, view, state.companyReturnView),
      pendingView: null,
      pendingDatabaseFilter: '',
      pendingCompanySlug: '',
      pendingViewTab: '',
    })
  },
  confirmPendingNavigate: () => {
    const state = get()
    if (!state.pendingView) return
    set({
      view: state.pendingView,
      databaseFilter: state.pendingDatabaseFilter,
      companySlug: state.pendingCompanySlug,
      viewTab: state.pendingViewTab,
      companyReturnView: nextReturnView(state.view, state.pendingView, state.companyReturnView),
      pendingView: null,
      pendingDatabaseFilter: '',
      pendingCompanySlug: '',
      pendingViewTab: '',
    })
  },
  cancelPendingNavigate: () =>
    set({ pendingView: null, pendingDatabaseFilter: '', pendingCompanySlug: '', pendingViewTab: '' }),
}))
