import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { getCurrentMode, setCurrentMode } from '@/lib/parsers/yaml'

interface AppState {
  repoPath: string | null
  isOnboarded: boolean
  tailoringComplete: boolean
  currentMode: 'scouting' | 'job-seeking'
  claudeInstalled: boolean

  // Actions
  init: () => Promise<void>
  setRepoPath: (p: string) => Promise<void>
  setOnboardingComplete: () => Promise<void>
  setTailoringComplete: () => Promise<void>
  resetTailoring: () => Promise<void>
  toggleMode: () => Promise<void>
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

    let mode: 'scouting' | 'job-seeking' = 'scouting'
    if (cfg?.repoPath) {
      const profileRaw = await ipc.readFile('user/profile.yml')
      if (profileRaw) mode = getCurrentMode(profileRaw)
    }

    // Auto-complete onboarding if key files already exist in the repo.
    // Handles the case where the user points the app at an existing setup.
    let isOnboarded = cfg?.onboardingComplete === true
    if (!isOnboarded && cfg?.repoPath) {
      const [cv, profile, portals] = await Promise.all([
        ipc.readFile('user/cv.md'),
        ipc.readFile('user/profile.yml'),
        ipc.readFile('user/portals.yml'),
      ])
      const hasContent = (s: string | null, min = 100) => !!s && s.trim().length >= min
      if (hasContent(cv) && hasContent(profile, 50) && hasContent(portals, 50)) {
        await ipc.setOnboardingComplete(true)
        isOnboarded = true
      }
    }

    // tailoringComplete defaults to true for existing setups (cfg.tailoringComplete === undefined
    // means the user was already onboarded before this feature was added).
    const tailoringComplete = isOnboarded
      ? (cfg?.tailoringComplete ?? true)
      : (cfg?.tailoringComplete ?? false)

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

  toggleMode: async () => {
    const next = get().currentMode === 'scouting' ? 'job-seeking' : 'scouting'
    // Write to profile.yml
    const raw = await ipc.readFile('user/profile.yml')
    if (raw) {
      const updated = setCurrentMode(raw, next)
      await ipc.writeFile('user/profile.yml', updated)
    }
    set({ currentMode: next })
  },
}))
