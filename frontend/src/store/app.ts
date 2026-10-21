import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { FeatureId, FeaturePrefs, ModelAlias, ModelPrefs } from '@/types'
import { DEFAULT_FEATURE_PREFS, DEFAULT_MODEL_PREFS } from '@/types'
import { isDemo, type OnboardingIntent } from '@/lib/dataRoot'
import { useDataRootStore } from './dataRoot'

// Returns true if the currently-pointed-at repo already has the four critical
// user files filled in to a meaningful degree. Used to bypass the onboarding
// wizard when the user opens an already-tuned workspace. Never asked while
// the demo is shown: its fictional user/ files would read as "set up".
async function detectExistingSetup(): Promise<boolean> {
  if (isDemo(useDataRootStore.getState().info)) return false
  const [cv, profile, portals] = await Promise.all([
    ipc.readFile('user/cv.md'),
    ipc.readFile('user/profile.yml'),
    ipc.readFile('user/portals.yml'),
  ])
  const hasContent = (s: string | null, min = 100) => !!s && s.trim().length >= min
  return hasContent(cv) && hasContent(profile, 50) && hasContent(portals, 50)
}

interface AppState {
  /** False until init() has read the config: the launch gate shows nothing
   *  instead of guessing (lib/dataRoot.ts → launchView). */
  initialized: boolean
  repoPath: string | null
  isOnboarded: boolean
  tailoringComplete: boolean
  claudeInstalled: boolean
  models: ModelPrefs
  features: FeaturePrefs

  // Claude auth health. `null` = session is good. A reason is set either at
  // launch (expired/lost token detected) or at runtime when a spawned
  // `claude -p` 401s mid-run. Drives the global AuthBanner.
  authError: AuthErrorReason | null
  reloginInProgress: boolean

  /** Onboarding opens on the demo/own choice ('choose') or straight on the
   *  wizard ('own' — the user asked for their own data from the demo). */
  onboardingIntent: OnboardingIntent
  /** Shows onboarding even when the config says it's done ("Use my own
   *  data" from the demo with no own data yet). Cleared on completion. */
  forceOnboarding: boolean

  // Actions
  init: () => Promise<void>
  /** Re-run the "already set up?" check after the data root moved. */
  refreshSetup: () => Promise<void>
  /** Leave the demo for the "Set up my own search" wizard. */
  startOwnSetup: () => Promise<void>
  /** Leave the demo for own data that already exists. */
  leaveDemo: () => Promise<{ ok: boolean; message?: string }>
  setRepoPath: (p: string) => Promise<void>
  setOnboardingComplete: () => Promise<void>
  setTailoringComplete: () => Promise<void>
  resetTailoring: () => Promise<void>
  setModel: (category: keyof ModelPrefs, model: ModelAlias) => Promise<void>
  setFeature: (id: FeatureId, enabled: boolean) => Promise<void>
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
  initialized: false,
  repoPath: null,
  isOnboarded: false,
  tailoringComplete: true,
  claudeInstalled: false,
  models: DEFAULT_MODEL_PREFS,
  features: DEFAULT_FEATURE_PREFS,
  authError: null,
  reloginInProgress: false,
  onboardingIntent: 'choose',
  forceOnboarding: false,

  init: async () => {
    // Data root first: the setup check below must know whether it is
    // looking at the demo.
    await useDataRootStore.getState().load()
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
      initialized:     true,
      repoPath:        cfg?.repoPath ?? null,
      isOnboarded,
      tailoringComplete,
      claudeInstalled: claudeCheck?.installed ?? false,
      models:          cfg?.models ?? DEFAULT_MODEL_PREFS,
      // Partial on disk — absent keys fall back to "active" so a config
      // written before a feature existed never hides the new surface.
      features:        { ...DEFAULT_FEATURE_PREFS, ...cfg?.features },
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

  refreshSetup: async () => {
    if (!get().repoPath || get().isOnboarded) return
    if (await detectExistingSetup()) {
      await ipc.setOnboardingComplete(true)
      await ipc.setTailoringComplete(true)
      set({ isOnboarded: true, tailoringComplete: true })
    }
  },

  startOwnSetup: async () => {
    set({ onboardingIntent: 'own', forceOnboarding: true })
    await useDataRootStore.getState().setDemo(false)
  },

  leaveDemo: async () => {
    // Should onboarding still be due for the own data, skip the choice
    // screen: the user just said which data they want.
    set({ onboardingIntent: 'own' })
    const res = await useDataRootStore.getState().setDemo(false)
    if (res.ok) await get().refreshSetup()
    return res
  },

  setOnboardingComplete: async () => {
    await ipc.setOnboardingComplete(true)
    set({ isOnboarded: true, tailoringComplete: false, forceOnboarding: false, onboardingIntent: 'choose' })
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

  setFeature: async (id, enabled) => {
    const next: FeaturePrefs = { ...get().features, [id]: enabled }
    await ipc.setFeatures(next)
    set({ features: next })
  },
}))
