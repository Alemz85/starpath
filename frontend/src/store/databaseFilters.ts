import { create } from 'zustand'
import { type FacetFilters, EMPTY_FILTERS } from '@/components/shared/FacetSidebar'

// Persists the Database tab's filter UI across tab switches. Without
// this, switching to Reports / Trends / etc and back resets the user's
// chip selections and search query — the user explicitly flagged that
// as a friction point.
//
// Lives in a small Zustand store rather than lifting state to AppShell
// so DatabaseView and the FacetSidebar stay decoupled from the layout.

interface DatabaseFiltersState {
  filters: FacetFilters
  query: string
  showClosed: boolean
  setFilters: (f: FacetFilters) => void
  setQuery: (q: string) => void
  setShowClosed: (b: boolean) => void
  /** Apply a CmdK navigate(view, databaseFilter) hop. Sets the search
   *  query to `company:{name}` and clears the chip filters so the user
   *  immediately sees just that company's rows. */
  applyCommandKFilter: (companyName: string) => void
  reset: () => void
}

export const useDatabaseFilters = create<DatabaseFiltersState>((set) => ({
  filters:    EMPTY_FILTERS,
  query:      '',
  showClosed: false,
  setFilters:    (filters)    => set({ filters }),
  setQuery:      (query)      => set({ query }),
  setShowClosed: (showClosed) => set({ showClosed }),
  applyCommandKFilter: (name) => set({
    filters: EMPTY_FILTERS,
    query:   `company:${name}`,
  }),
  reset: () => set({ filters: EMPTY_FILTERS, query: '', showClosed: false }),
}))
