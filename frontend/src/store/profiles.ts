import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import {
  isValidProfileSlug, describeProfileFailure,
  type ProfileInfo, type ProfileMutationResult,
} from '@/lib/profiles'

// Switchable search profiles. This store mirrors `profile:list` and owns the
// switch/create actions every surface (sidebar switcher, CmdK, Settings)
// shares. On a pre-migration repo it holds an empty list and the surfaces
// hide themselves — no separate flag needed.

interface ProfilesState {
  active: string | null
  profiles: ProfileInfo[]
  loaded: boolean
  /** Slug of the profile a switch is in flight to; null when idle. Every
   *  switch control disables on this. */
  switching: string | null
  /** The last refused/failed switch — guard reasons verbatim. Rendered by
   *  the switcher popover and the Settings section; cleared on the next
   *  attempt or a success. */
  lastFailure: { slug: string; lines: string[] } | null

  load: () => Promise<void>
  switchTo: (slug: string) => Promise<ProfileMutationResult>
  createProfile: (opts: { slug: string; label?: string; from?: string }) => Promise<ProfileMutationResult>
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  active: null,
  profiles: [],
  loaded: false,
  switching: null,
  lastFailure: null,

  load: async () => {
    const res = await ipc.profile.list()
    set({
      active:   res?.active ?? null,
      profiles: res?.profiles ?? [],
      loaded:   true,
    })
  },

  switchTo: async (slug) => {
    if (get().switching) {
      return { ok: false, error: 'busy', message: 'a switch is already running' }
    }
    if (!isValidProfileSlug(slug)) {
      return { ok: false, error: 'invalid-slug', message: `invalid slug '${slug}'` }
    }
    set({ switching: slug, lastFailure: null })
    try {
      const res: ProfileMutationResult =
        (await ipc.profile.switch(slug)) ?? { ok: false, error: 'ipc', message: 'no response from main process' }
      if (res.ok) {
        await get().load()
        // Full reload — the canonical paths now hold the other profile's
        // data wholesale, so every view must refetch, not patch.
        await useDataStore.getState().refresh()
      } else {
        set({ lastFailure: { slug, lines: describeProfileFailure(res) } })
      }
      return res
    } finally {
      set({ switching: null })
    }
  },

  createProfile: async (opts) => {
    if (!isValidProfileSlug(opts.slug)) {
      return { ok: false, error: 'invalid-slug', message: `invalid slug '${opts.slug}'` }
    }
    const res: ProfileMutationResult =
      (await ipc.profile.create(opts)) ?? { ok: false, error: 'ipc', message: 'no response from main process' }
    if (res.ok) await get().load()
    return res
  },
}))

// ─── Live reload ──────────────────────────────────────────────────────────────
//
// Main broadcasts `profile:changed` after a successful switch, once the
// per-profile cache and watcher are swapped. The in-app switchTo path already
// reloads, so this mainly keeps a second window / late subscriber honest;
// refresh() is in-flight-coalesced so the double reload is harmless.

if (typeof window !== 'undefined') {
  const subscribe = () => {
    if (!window.electron?.onProfileChanged) return false
    ipc.profile.onChanged(() => {
      void useProfilesStore.getState().load()
      void useDataStore.getState().refresh()
    })
    return true
  }
  if (!subscribe()) {
    setTimeout(subscribe, 0)
  }
}
