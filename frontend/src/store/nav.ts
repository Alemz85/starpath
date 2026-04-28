import { create } from 'zustand'

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
  navigate: (view: ViewId, databaseFilter?: string) => void
}

export const useNavStore = create<NavState>((set) => ({
  view: 'scouting',
  databaseFilter: '',
  navigate: (view, databaseFilter = '') => set({ view, databaseFilter }),
}))
