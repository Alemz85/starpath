'use client'

import { useState } from 'react'
import { FolderOpen, CheckCircle2, AlertCircle, Loader2, FolderTree } from 'lucide-react'
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
      if (!result) { setStatus('idle'); return }
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
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Pick the career-ops folder on your Mac
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          starpath reads and writes your job-search data directly in this
          folder — nothing leaves your machine. The repo is a normal git
          checkout you can edit by hand.
        </p>
      </div>

      {/* "What this folder needs" hint */}
      <div className="rounded-lg border border-border-default bg-bg-elevated/60 p-4 flex items-start gap-3">
        <FolderTree size={18} className="text-accent shrink-0 mt-0.5" />
        <div className="flex-1 text-[12.5px] leading-relaxed">
          <p className="text-text-2 font-medium mb-1">Pick the root folder</p>
          <p className="text-text-3">
            The one that contains a{' '}
            <code className="font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">CLAUDE.md</code>{' '}
            file at its top level — not the{' '}
            <code className="font-mono text-text-4 bg-bg-base px-1.5 py-0.5 rounded">frontend/</code>{' '}
            subfolder.
          </p>
        </div>
      </div>

      {/* Primary: folder picker */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSelect}
          disabled={busy || done}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50 text-white rounded-pill transition-all font-medium text-[14px] shadow-pill hover:shadow-pill-hover"
        >
          {status === 'loading'
            ? <Loader2 size={15} className="animate-spin" />
            : <FolderOpen size={15} />}
          {status === 'loading' ? 'Opening…' : 'Choose folder…'}
        </button>
        <span className="text-[11.5px] text-text-4">or paste the path below</span>
      </div>

      {/* Manual path input */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={manualPath}
            onChange={e => setManualPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleManualConfirm() }}
            placeholder="/Users/you/career-ops"
            disabled={done}
            className="flex-1 px-3 h-9 bg-bg-elevated border border-border-default rounded-md text-[13px] font-mono text-text-1 placeholder:text-text-4 focus:outline-none focus:border-accent disabled:opacity-50 transition-colors"
          />
          <button
            onClick={handleManualConfirm}
            disabled={!manualPath.trim() || busy || done}
            className="px-3 h-9 bg-bg-elevated border border-border-default hover:border-accent text-text-2 rounded-md text-[13px] transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {status === 'validating' ? <Loader2 size={14} className="animate-spin" /> : 'Confirm'}
          </button>
        </div>
      </div>

      {status === 'error' && (
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg border bg-danger/10 border-danger/30 text-danger text-[12.5px]">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">
            Something went wrong. Try pasting the path manually above.
            If the picker never opens, check System Settings → Privacy &amp; Security → Files and Folders.
          </span>
        </div>
      )}

      {selectedPath && (
        <div className={`flex items-start gap-2.5 p-3.5 rounded-lg border text-[12.5px] ${
          done
            ? 'bg-success/10 border-success/30 text-success'
            : 'bg-danger/10 border-danger/30 text-danger'
        }`}>
          {done
            ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
          <div className="leading-relaxed">
            <div className="font-mono break-all">{selectedPath}</div>
            {status === 'invalid' && (
              <div className="mt-1 text-[12px]">
                No <code className="font-mono">CLAUDE.md</code> found here. Pick the root career-ops folder, not a subfolder like <code className="font-mono">frontend/</code>.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
