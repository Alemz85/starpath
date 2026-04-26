import { contextBridge, ipcRenderer } from 'electron'

// Typed API exposed to renderer via window.electron
const electronAPI = {
  // App config
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  setRepoPath: (p: string) => ipcRenderer.invoke('app:set-repo-path', p),
  setOnboardingComplete: (v: boolean) => ipcRenderer.invoke('app:set-onboarding-complete', v),
  setTailoringComplete: (v?: boolean) => ipcRenderer.invoke('app:set-tailoring-complete', v),
  selectFolder: () => ipcRenderer.invoke('app:select-folder'),
  validatePath: (p: string) => ipcRenderer.invoke('app:validate-path', p),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),

  // Claude checks
  checkClaude: () => ipcRenderer.invoke('app:check-claude'),
  checkClaudeAuth: () => ipcRenderer.invoke('app:check-claude-auth'),
  runClaudeLogin: () => ipcRenderer.invoke('app:run-claude-login'),

  // File system
  readFile: (path: string) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:write', path, content),
  fileExists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  listDir: (path: string) => ipcRenderer.invoke('fs:list', path),
  listRecursive: (dir: string, ext: string) => ipcRenderer.invoke('fs:list-recursive', dir, ext),

  // Shell (one-shot)
  run: (cmd: string, args: string[]) => ipcRenderer.invoke('shell:run', cmd, args),

  // Shell (streaming)
  spawn: (id: string, cmd: string, args: string[]) => ipcRenderer.invoke('shell:spawn', id, cmd, args),
  kill: (id: string) => ipcRenderer.invoke('shell:kill', id),
  onSpawnOutput: (cb: (id: string, chunk: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string, chunk: string) => cb(id, chunk)
    ipcRenderer.on('shell:output', listener)
    return () => ipcRenderer.removeListener('shell:output', listener)
  },
  onSpawnDone: (cb: (id: string, code: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, id: string, code: number) => cb(id, code)
    ipcRenderer.on('shell:done', listener)
    return () => ipcRenderer.removeListener('shell:done', listener)
  },
}

contextBridge.exposeInMainWorld('electron', electronAPI)

// Type augmentation for window.electron
export type ElectronAPI = typeof electronAPI
