import { create } from 'zustand'

export type ViewId = 'home' | 'database' | 'reports' | 'pipeline' | 'trends' | 'scan' | 'settings'

interface NavState {
  view: ViewId
  databaseFilter: string
  navigate: (view: ViewId, databaseFilter?: string) => void
}

export const useNavStore = create<NavState>((set) => ({
  view: 'home',
  databaseFilter: '',
  navigate: (view, databaseFilter = '') => set({ view, databaseFilter }),
}))
