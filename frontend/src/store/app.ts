import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { getCurrentMode, setCurrentMode, hasLegacyMode } from '@/lib/parsers/yaml'
import type { AppMode } from '@/types'

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
  currentMode: AppMode
  claudeInstalled: boolean

  // Actions
  init: () => Promise<void>
  setRepoPath: (p: string) => Promise<void>
  setOnboardingComplete: () => Promise<void>
  setTailoringComplete: () => Promise<void>
  resetTailoring: () => Promise<void>
  setMode: (mode: AppMode) => Promise<void>
  recheckClaude: () => Promise<boolean>
}

export const useAppStore = create<AppState>((set, get) => ({
  repoPath: null,
  isOnboarded: false,
  tailoringComplete: true,
  currentMode: 'scouting',
  claudeInstalled: false,

  init: async () => {
    const cfg = await ipc.getConfig()
    const claudeCheck = await ipc.checkClaude()

    let mode: AppMode = 'scouting'
    if (cfg?.repoPath) {
      const profileRaw = await ipc.readFile('user/profile.yml')
      if (profileRaw) {
        mode = getCurrentMode(profileRaw)
        // One-shot migration: if profile.yml still has the legacy `job-seeking`
        // value, rewrite it to `applying` on first launch. After this, no more
        // backward-compat handling is needed in code.
        if (hasLegacyMode(profileRaw)) {
          await ipc.writeFile('user/profile.yml', setCurrentMode(profileRaw, 'applying'))
        }
      }
    }

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
      repoPath:          cfg?.repoPath ?? null,
      isOnboarded,
      tailoringComplete,
      currentMode:       mode,
      claudeInstalled:   claudeCheck?.installed ?? false,
    })
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

  setMode: async (mode: AppMode) => {
    if (get().currentMode === mode) return
    const raw = await ipc.readFile('user/profile.yml')
    if (raw) {
      const updated = setCurrentMode(raw, mode)
      await ipc.writeFile('user/profile.yml', updated)
    }
    set({ currentMode: mode })
  },
}))
