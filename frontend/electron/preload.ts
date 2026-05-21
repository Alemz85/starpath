import { contextBridge, ipcRenderer } from 'electron'

// Typed API exposed to renderer via window.electron
const electronAPI = {
  // App config
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  setRepoPath: (p: string) => ipcRenderer.invoke('app:set-repo-path', p),
  setOnboardingComplete: (v: boolean) => ipcRenderer.invoke('app:set-onboarding-complete', v),
  setTailoringComplete: (v?: boolean) => ipcRenderer.invoke('app:set-tailoring-complete', v),
  setModels: (models: {
    pipeline: string; tailorCv: string; draftApp: string; interviewPrep: string; generateReport: string
  }) => ipcRenderer.invoke('app:set-models', models),
  selectFolder: () => ipcRenderer.invoke('app:select-folder'),
  selectCvPdf: () => ipcRenderer.invoke('app:select-cv-pdf'),
  validatePath: (p: string) => ipcRenderer.invoke('app:validate-path', p),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  revealFile: (filePath: string) => ipcRenderer.invoke('app:reveal-file', filePath),

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

  // SQLite-backed query layer (markdown/TSV remain canonical; this is a
  // derived cache rebuilt via the watcher). No raw SQL crosses the boundary —
  // higher-level queries only.
  dbApplications:           (f?: { tier?: string; status?: string; search?: string }) => ipcRenderer.invoke('db:applications', f),
  dbScouting:               (f?: { tier?: string; search?: string })                  => ipcRenderer.invoke('db:scouting', f),
  dbScoreHistory:           (f?: { since?: string; until?: string; company?: string; tier?: string }) => ipcRenderer.invoke('db:score-history', f),
  dbPipeline:               ()                                                         => ipcRenderer.invoke('db:pipeline'),
  dbReports:                (f?: { tier?: string; search?: string })                   => ipcRenderer.invoke('db:reports', f),
  dbApplicationsWithScores: ()                                                         => ipcRenderer.invoke('db:applications-with-scores'),
  dbTrends:                 ()                                                         => ipcRenderer.invoke('db:trends'),
  dbResync:                 ()                                                         => ipcRenderer.invoke('db:resync'),
  dbRebuild:                ()                                                         => ipcRenderer.invoke('db:rebuild'),
  onDbChanged:              (cb: (sources: string[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sources: string[]) => cb(sources)
    ipcRenderer.on('db:changed', listener)
    return () => ipcRenderer.removeListener('db:changed', listener)
  },

  // Shell (one-shot)
  run: (cmd: string, args: string[]) => ipcRenderer.invoke('shell:run', cmd, args),

  // Logo cache (fetched by main process, stored on disk)
  fetchLogo: (domain: string) => ipcRenderer.invoke('logo:fetch', domain),

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
