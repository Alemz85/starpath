import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { getCurrentMode, setCurrentMode, hasLegacyMode } from '@/lib/parsers/yaml'
import type { AppMode } from '@/types'

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

    // Auto-complete onboarding if key files already exist in the repo.
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
