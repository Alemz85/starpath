import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { ModelAlias, ModelPrefs } from '@/types'
import { DEFAULT_MODEL_PREFS } from '@/types'

// Returns true if the currently-pointed-at repo already has the four critical
// user files filled in to a meaningful degree. Used to bypass the onboarding
// wizard when the user opens an already-tuned workspace.
async function detectExistingSetup(): Promise<boolean> {
  const [cv, profile, portals] = await Promise.all([
    ipc.readFile('user/cv.md'),
    ipc.readFile('user/profile.yml'),
    ipc.readFile('user/portals.yml'),
  ])
  const hasContent = (s: string | null, min = 100) => !!s && s.trim().length >= min
  return hasContent(cv) && hasContent(profile, 50) && hasContent(portals, 50)
}

interface AppState {
  repoPath: string | null
  isOnboarded: boolean
  tailoringComplete: boolean
  claudeInstalled: boolean
  models: ModelPrefs

  // Claude auth health. `null` = session is good. A reason is set either at
  // launch (expired/lost token detected) or at runtime when a spawned
  // `claude -p` 401s mid-run. Drives the global AuthBanner.
  authError: AuthErrorReason | null
  reloginInProgress: boolean

  // Actions
  init: () => Promise<void>
  setRepoPath: (p: string) => Promise<void>
  setOnboardingComplete: () => Promise<void>
  setTailoringComplete: () => Promise<void>
  resetTailoring: () => Promise<void>
  setModel: (category: keyof ModelPrefs, model: ModelAlias) => Promise<void>
  recheckClaude: () => Promise<boolean>
  checkAuth: () => Promise<void>
  flagAuthError: (reason: AuthErrorReason) => void
  clearAuthError: () => void
  relogin: () => Promise<void>
}

export type AuthErrorReason = 'expired' | 'logged-out' | 'runtime-401'

const RELOGIN_POLL_INTERVAL = 2500
const RELOGIN_POLL_TIMEOUT = 5 * 60 * 1000

export const useAppStore = create<AppState>((set, get) => ({
  repoPath: null,
  isOnboarded: false,
  tailoringComplete: true,
  claudeInstalled: false,
  models: DEFAULT_MODEL_PREFS,
  authError: null,
  reloginInProgress: false,

  init: async () => {
    const cfg = await ipc.getConfig()
    const claudeCheck = await ipc.checkClaude()

    // Auto-flip both onboarding + tailoring flags whenever the repo on disk
    // is clearly already set up. Covers two paths:
    //   1. Fresh install — cfg empty, user files exist → bypass everything.
    //   2. Re-launch with stale cfg — e.g. userData persisted from a previous
    //      session that left tailoringComplete=false (the user walked through
    //      the wizard but the tailoring agent never finished). If the user
    //      files are present and substantive, the workspace IS tailored;
    //      no need to re-run the agent.
    let isOnboarded = cfg?.onboardingComplete === true
    let tailoringComplete = cfg?.tailoringComplete === true
    const repoIsTuned = !!cfg?.repoPath && await detectExistingSetup()
    if (repoIsTuned) {
      if (!isOnboarded) {
        await ipc.setOnboardingComplete(true)
        isOnboarded = true
      }
      if (!tailoringComplete) {
        await ipc.setTailoringComplete(true)
        tailoringComplete = true
      }
    }

    set({
      repoPath:        cfg?.repoPath ?? null,
      isOnboarded,
      tailoringComplete,
      claudeInstalled: claudeCheck?.installed ?? false,
      models:          cfg?.models ?? DEFAULT_MODEL_PREFS,
    })

    // Surface an expired/lost Claude session at launch — before the user
    // fires a scan and hits a 401 with no idea why. Fire-and-forget so it
    // never blocks the first paint.
    if (claudeCheck?.installed) void get().checkAuth()
  },

  setRepoPath: async (p: string) => {
    await ipc.setRepoPath(p)
    set({ repoPath: p })
    // If the user pointed the app at a repo that already has the four
    // critical user/* files filled in, skip the wizard outright. Same logic
    // as init() — but init() only runs once at launch (when repoPath was
    // still null), so we have to re-check here after the path is picked.
    if (!get().isOnboarded && await detectExistingSetup()) {
      await ipc.setOnboardingComplete(true)
      await ipc.setTailoringComplete(true)
      set({ isOnboarded: true, tailoringComplete: true })
    }
  },

  setOnboardingComplete: async () => {
    await ipc.setOnboardingComplete(true)
    set({ isOnboarded: true, tailoringComplete: false })
  },

  setTailoringComplete: async () => {
    await ipc.setTailoringComplete(true)
    set({ tailoringComplete: true })
  },

  resetTailoring: async () => {
    await ipc.setTailoringComplete(false)
    set({ tailoringComplete: false })
  },

  recheckClaude: async () => {
    const claudeCheck = await ipc.checkClaude()
    const installed = claudeCheck?.installed ?? false
    set({ claudeInstalled: installed })
    return installed
  },

  checkAuth: async () => {
    const res = await ipc.checkClaudeAuth()
    if (res?.authenticated) set({ authError: null })
    else set({ authError: res?.reason ?? 'logged-out' })
  },

  // Called by the spawns store the moment a `claude -p` run emits an
  // auth-failure signature. We don't clobber an in-flight re-login.
  flagAuthError: (reason) => {
    if (get().reloginInProgress) return
    set({ authError: reason })
  },

  clearAuthError: () => set({ authError: null }),

  relogin: async () => {
    if (get().reloginInProgress) return
    set({ reloginInProgress: true })
    await ipc.runClaudeLogin()
    // The OAuth browser flow lands a fresh token back in the keychain; poll
    // until checkClaudeAuth confirms it, then drop the banner.
    const started = Date.now()
    const poll = async () => {
      const res = await ipc.checkClaudeAuth()
      if (res?.authenticated) {
        set({ authError: null, reloginInProgress: false })
        return
      }
      if (Date.now() - started > RELOGIN_POLL_TIMEOUT) {
        set({ reloginInProgress: false })
        return
      }
      setTimeout(poll, RELOGIN_POLL_INTERVAL)
    }
    setTimeout(poll, RELOGIN_POLL_INTERVAL)
  },

  setModel: async (category, model) => {
    const next: ModelPrefs = { ...get().models, [category]: model }
    await ipc.setModels(next)
    set({ models: next })
  },
}))
