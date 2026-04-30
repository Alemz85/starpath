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
  /** Apply a navigate(view, databaseFilter) hop. Accepts either a bare
   *  company name (legacy: CmdK passes "Acme Corp" → becomes
   *  `company:Acme Corp`) or a tokenized query (`archetype:Backend
   *  Engineer`, `tier:T1`, `location:Berlin`, etc.) and uses it
   *  verbatim. Show-closed is forced on so the navigated-to filter
   *  always returns rows even when the user had closed listings hidden. */
  applyCommandKFilter: (input: string) => void
  reset: () => void
}

const TOKEN_PREFIX_RE = /^(company|role|archetype|tier|location|type|minscore|maxscore|liveness):/i

export const useDatabaseFilters = create<DatabaseFiltersState>((set) => ({
  filters:    EMPTY_FILTERS,
  query:      '',
  showClosed: false,
  setFilters:    (filters)    => set({ filters }),
  setQuery:      (query)      => set({ query }),
  setShowClosed: (showClosed) => set({ showClosed }),
  applyCommandKFilter: (input) => {
    const tokenized = TOKEN_PREFIX_RE.test(input) ? input : `company:${input}`
    set({
      filters: EMPTY_FILTERS,
      query:   tokenized,
      showClosed: true,
    })
  },
  reset: () => set({ filters: EMPTY_FILTERS, query: '', showClosed: false }),
}))
