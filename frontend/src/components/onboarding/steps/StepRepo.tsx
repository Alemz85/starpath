'use client'

import { useState } from 'react'
import { FolderOpen, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useAppStore } from '@/store/app'

export function StepRepo({ onComplete }: { onComplete: () => void }) {
  const { setRepoPath } = useAppStore()
  const [status, setStatus] = useState<'idle' | 'loading' | 'validating' | 'invalid' | 'done' | 'error'>('idle')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')

  const applyResult = async (path: string, valid: boolean) => {
    if (!valid) { setStatus('invalid'); setSelectedPath(path); return }
    await setRepoPath(path)
    setSelectedPath(path)
    setStatus('done')
    setTimeout(onComplete, 500)
  }

  const handleSelect = async () => {
    setStatus('loading')
    try {
      const result = await ipc.selectFolder()
      if (!result) { setStatus('idle'); return } // user canceled
      await applyResult(result.path, result.valid)
    } catch {
      setStatus('error')
    }
  }

  const handleManualConfirm = async () => {
    const trimmed = manualPath.trim()
    if (!trimmed) return
    setStatus('validating')
    try {
      const result = await ipc.validatePath(trimmed)
      await applyResult(result.path, result.valid)
    } catch {
      setStatus('error')
    }
  }

  const busy = status === 'loading' || status === 'validating'
  const done = status === 'done'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-section text-text-1 mb-2">Select your career-ops folder</h2>
        <p className="text-body text-text-3">
          Point the app to the directory where you cloned the career-ops repo.
          The folder must contain a <code className="font-mono text-accent-text bg-bg-elevated px-1 rounded">CLAUDE.md</code> file at its root — <strong>not</strong> the <code className="font-mono text-accent-text bg-bg-elevated px-1 rounded">frontend/</code> subfolder.
        </p>
      </div>

      {/* Primary: folder picker */}
      <button
        onClick={handleSelect}
        disabled={busy || done}
        className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent/90 active:scale-95 disabled:opacity-60 text-white rounded-md transition-all font-medium text-body"
      >
        {status === 'loading'
          ? <Loader2 size={15} className="animate-spin" />
          : <FolderOpen size={15} />}
        {status === 'loading' ? 'Opening…' : 'Choose folder…'}
      </button>

      {/* Fallback: manual path input */}
      <div className="space-y-2">
        <p className="text-label text-text-3">Or paste the path directly:</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={manualPath}
            onChange={e => setManualPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleManualConfirm() }}
            placeholder="/Users/you/career-ops app"
            disabled={done}
            className="flex-1 px-3 py-2 bg-bg-elevated border border-border-default rounded-md text-body font-mono text-text-1 placeholder:text-text-4 focus:outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            onClick={handleManualConfirm}
            disabled={!manualPath.trim() || busy || done}
            className="px-3 py-2 bg-bg-elevated border border-border-default hover:border-accent text-text-2 rounded-md text-body transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {status === 'validating' ? <Loader2 size={14} className="animate-spin" /> : 'Confirm'}
          </button>
        </div>
      </div>

      {status === 'error' && (
        <div className="flex items-start gap-2 p-3 rounded-md border bg-danger/10 border-danger/30 text-danger text-body">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            Something went wrong. Try pasting the path manually above.
            If the picker never opens, check System Settings → Privacy &amp; Security → Files and Folders.
          </span>
        </div>
      )}

      {selectedPath && (
        <div className={`flex items-start gap-2 p-3 rounded-md border text-body ${
          done
            ? 'bg-success/10 border-success/30 text-success'
            : 'bg-danger/10 border-danger/30 text-danger'
        }`}>
          {done
            ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            : <AlertCircle size={15} className="mt-0.5 shrink-0" />}
          <div>
            <div className="font-mono text-label break-all">{selectedPath}</div>
            {status === 'invalid' && (
              <div className="mt-1 text-label">
                No <code className="font-mono">CLAUDE.md</code> found here. Select the root career-ops folder, not a subfolder like <code className="font-mono">frontend/</code>.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
