// Tiny zustand store toggling the global Add Listing modal. The modal
// itself lives in AppShell so it can be triggered from anywhere — the
// Scouting tab CTA, the CmdK command, future deep links — without
// prop-drilling open/close state through the tree.

import { create } from 'zustand'

interface AddListingState {
  open: boolean
  /** Optional URL to pre-fill on open (e.g. from CmdK with a value). */
  prefillUrl: string | null
  show: (prefillUrl?: string) => void
  hide: () => void
}

export const useAddListingStore = create<AddListingState>((set) => ({
  open: false,
  prefillUrl: null,
  show: (prefillUrl) => set({ open: true, prefillUrl: prefillUrl ?? null }),
  hide: () => set({ open: false, prefillUrl: null }),
}))
