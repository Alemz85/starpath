'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { FolderOpen, Check, RefreshCw, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SettingsView() {
  const { repoPath, setRepoPath, currentMode, toggleMode, resetTailoring } = useAppStore()
  const { refresh } = useDataStore()
  const [profileYaml, setProfileYaml] = useState('')
  const [portalsYaml, setPortalsYaml] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'general' | 'profile' | 'portals'>('general')

  useEffect(() => {
    if (activeTab === 'profile') loadProfile()
    if (activeTab === 'portals') loadPortals()
  }, [activeTab])

  const loadProfile = async () => {
    const text = await ipc.readFile('user/profile.yml')
    setProfileYaml(text ?? '')
  }

  const loadPortals = async () => {
    const text = await ipc.readFile('user/portals.yml')
    setPortalsYaml(text ?? '')
  }

  const saveFile = async (path: string, content: string) => {
    setSaving(path)
    try {
      await ipc.writeFile(path, content)
      setSaved(path)
      setTimeout(() => setSaved(null), 2000)
    } finally {
      setSaving(null)
    }
  }

  const changeRepo = async () => {
    const result = await ipc.selectFolder()
    if (result?.valid) {
      setRepoPath(result.path)
      await refresh()
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="titlebar-drag h-11 shrink-0 border-b border-border-default" />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <h1 className="text-body text-text-1 font-medium">Settings</h1>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border-default bg-bg-chrome shrink-0">
        {(['general', 'profile', 'portals'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2 text-label border-b-2 transition-colors capitalize',
              activeTab === tab
                ? 'border-accent text-text-1'
                : 'border-transparent text-text-4 hover:text-text-2',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'general' && (
          <div className="space-y-6 max-w-lg">
            {/* Repo path */}
            <Section title="Repository" description="The local career-ops folder Claude reads and writes to.">
              <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 rounded-md border border-border-default bg-bg-elevated text-label text-text-3 font-mono truncate">
                  {repoPath ?? 'Not set'}
                </div>
                <button
                  onClick={changeRepo}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors shrink-0"
                >
                  <FolderOpen size={13} />
                  Change
                </button>
              </div>
            </Section>

            {/* Mode */}
            <Section title="Current mode" description="Controls how job descriptions are evaluated by default.">
              <div className="flex rounded-md overflow-hidden border border-border-default w-fit">
                {(['scouting', 'job-seeking'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => { if (currentMode !== mode) toggleMode() }}
                    className={cn(
                      'px-4 py-2 text-label transition-colors capitalize',
                      currentMode === mode ? 'bg-accent/20 text-accent-text' : 'text-text-4 hover:text-text-2',
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </Section>

            {/* Refresh data */}
            <Section title="Data" description="Reload all data files from disk.">
              <button
                onClick={() => refresh()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors"
              >
                <RefreshCw size={13} />
                Refresh data
              </button>
            </Section>

            {/* Re-tune workspace */}
            <Section title="Workspace tuning" description="Re-run Claude to regenerate keyword filters and candidate context from your CV and profile.">
              <button
                onClick={resetTailoring}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border-default text-label text-text-2 hover:bg-bg-elevated transition-colors"
              >
                <Sparkles size={13} />
                Re-tune workspace
              </button>
            </Section>
          </div>
        )}

        {activeTab === 'profile' && (
          <div className="space-y-4 max-w-2xl">
            <p className="text-label text-text-4">
              Edit <code className="text-accent text-micro bg-bg-elevated px-1 py-0.5 rounded">user/profile.yml</code> directly.
              This controls your name, targets, compensation, and the system's scoring behavior.
            </p>
            <textarea
              value={profileYaml}
              onChange={e => setProfileYaml(e.target.value)}
              className="w-full h-[calc(100vh-280px)] min-h-48 px-3 py-2 bg-bg-elevated border border-border-default rounded-md font-mono text-[12px] text-text-2 outline-none focus:border-accent/60 resize-none"
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => saveFile('user/profile.yml', profileYaml)}
                disabled={!!saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-accent/20 border border-accent/30 text-accent-text text-label hover:bg-accent/30 disabled:opacity-40 transition-colors"
              >
                {saved === 'user/profile.yml' ? <Check size={13} /> : null}
                {saving === 'user/profile.yml' ? 'Saving…' : saved === 'user/profile.yml' ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={loadProfile}
                className="px-3 py-2 rounded-md border border-border-default text-label text-text-4 hover:text-text-2 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        )}

        {activeTab === 'portals' && (
          <div className="space-y-4 max-w-2xl">
            <p className="text-label text-text-4">
              Edit <code className="text-accent text-micro bg-bg-elevated px-1 py-0.5 rounded">user/portals.yml</code> to configure companies and search keywords for the scanner.
            </p>
            <textarea
              value={portalsYaml}
              onChange={e => setPortalsYaml(e.target.value)}
              className="w-full h-[calc(100vh-280px)] min-h-48 px-3 py-2 bg-bg-elevated border border-border-default rounded-md font-mono text-[12px] text-text-2 outline-none focus:border-accent/60 resize-none"
              spellCheck={false}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => saveFile('user/portals.yml', portalsYaml)}
                disabled={!!saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-accent/20 border border-accent/30 text-accent-text text-label hover:bg-accent/30 disabled:opacity-40 transition-colors"
              >
                {saved === 'user/portals.yml' ? <Check size={13} /> : null}
                {saving === 'user/portals.yml' ? 'Saving…' : saved === 'user/portals.yml' ? 'Saved' : 'Save'}
              </button>
              <button
                onClick={loadPortals}
                className="px-3 py-2 rounded-md border border-border-default text-label text-text-4 hover:text-text-2 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2">
        <h3 className="text-label text-text-1 font-medium">{title}</h3>
        <p className="text-label text-text-4">{description}</p>
      </div>
      {children}
    </div>
  )
}
