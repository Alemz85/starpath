// Typed wrapper around window.electron (set by Electron preload)
// Falls back gracefully in browser/dev-without-electron context.

import type { ElectronAPI } from '../../electron/preload'

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

function api(): ElectronAPI {
  if (typeof window !== 'undefined' && window.electron) return window.electron
  // In Next.js SSR or plain browser context — return stubs that resolve to null
  const stub = () => Promise.resolve(null)
  return new Proxy({} as ElectronAPI, { get: () => stub })
}

export const ipc = {
  // App config
  getConfig:            ()                     => api().getConfig(),
  setRepoPath:          (p: string)             => api().setRepoPath(p),
  setOnboardingComplete:(v: boolean)            => api().setOnboardingComplete(v),
  setTailoringComplete: (v?: boolean)           => api().setTailoringComplete(v),
  selectFolder:         ()                     => api().selectFolder() as Promise<{ path: string; valid: boolean } | null>,
  validatePath:         (p: string)             => api().validatePath(p) as Promise<{ path: string; valid: boolean }>,
  openExternal:         (url: string)           => api().openExternal(url),

  // Claude
  checkClaude:          ()                     => api().checkClaude() as Promise<{ installed: boolean }>,
  checkClaudeAuth:      ()                     => api().checkClaudeAuth() as Promise<{ authenticated: boolean }>,
  runClaudeLogin:       ()                     => api().runClaudeLogin(),

  // File system
  readFile:             (path: string)          => api().readFile(path) as Promise<string | null>,
  writeFile:            (path: string, c: string) => api().writeFile(path, c),
  fileExists:           (path: string)          => api().fileExists(path) as Promise<boolean>,
  listDir:              (path: string)          => api().listDir(path) as Promise<string[]>,
  listRecursive:        (dir: string, ext: string) => api().listRecursive(dir, ext) as Promise<string[]>,

  // Shell
  run:                  (cmd: string, args: string[]) => api().run(cmd, args) as Promise<{ stdout: string; stderr: string; code: number }>,
  spawn:                (id: string, cmd: string, args: string[]) => api().spawn(id, cmd, args),
  kill:                 (id: string)            => api().kill(id),
  onSpawnOutput:        (cb: (id: string, chunk: string) => void) => api().onSpawnOutput(cb),
  onSpawnDone:          (cb: (id: string, code: number) => void)  => api().onSpawnDone(cb),
}
