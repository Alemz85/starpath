'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Lock, RotateCcw } from 'lucide-react'
import { useDataRootStore } from '@/store/dataRoot'
import { describePrivateInitFailure, type PrivateInitResult } from '@/lib/dataRoot'

// "Set up my own search" on a checkout with no private root yet: run
// `node scripts/private.mjs init --json` (through the private:init IPC) so
// every file the wizard writes to user/… lands in private/, the gitignored
// folder that is its own private git repo. Errors are shown verbatim with a
// retry; nothing in the wizard runs until this succeeds.
export function StepPrivateInit({
  onComplete,
  onBack,
}: {
  onComplete: () => void
  onBack?: () => void
}) {
  const initPrivate = useDataRootStore(s => s.initPrivate)
  const [state, setState] = useState<'running' | 'done' | 'error'>('running')
  const [result, setResult] = useState<PrivateInitResult | null>(null)
  const started = useRef(false)

  const run = async () => {
    setState('running')
    setResult(null)
    const res = await initPrivate()
    setResult(res)
    if (res.ok) {
      setState('done')
      setTimeout(onComplete, 900)
    } else {
      setState('error')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
    // run once on mount; retries go through the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const moved = Array.isArray(result?.moved) ? result!.moved.length : 0

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Making your private folder
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          Your CV, profile, trackers and reports live in{' '}
          <code className="font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">private/</code>{' '}
          inside this checkout. Git ignores it, and it has its own private
          history, so nothing personal reaches the public repo.
        </p>
      </div>

      <div className="rounded-lg border border-border-default bg-bg-elevated/60 p-4 flex items-start gap-3">
        <Lock size={18} className="text-accent shrink-0 mt-0.5" />
        <div className="flex-1 text-[12.5px] leading-relaxed text-text-3">
          The repo&apos;s <code className="font-mono">user/</code>, <code className="font-mono">data/</code> and{' '}
          <code className="font-mono">reports/</code> folders become links into it, so every tool keeps
          finding your files where it expects them.
        </div>
      </div>

      {state === 'running' && (
        <div className="flex items-center gap-2.5 text-[13px] text-text-2">
          <Loader2 size={15} className="animate-spin text-accent" />
          Creating private/ …
        </div>
      )}

      {state === 'done' && (
        <div className="flex items-start gap-2.5 p-3.5 rounded-lg border bg-success/10 border-success/30 text-success text-[12.5px]">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <div className="leading-relaxed">
            <div>Private folder ready{moved > 0 ? ` (${moved} existing ${moved === 1 ? 'folder' : 'folders'} moved in)` : ''}.</div>
            {typeof result?.privateRoot === 'string' && (
              <div className="font-mono break-all mt-0.5">{result.privateRoot}</div>
            )}
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="space-y-3">
          <div className="flex items-start gap-2.5 p-3.5 rounded-lg border bg-danger/10 border-danger/30 text-danger text-[12.5px]" role="alert">
            <AlertCircle size={15} className="mt-0.5 shrink-0" />
            <div className="leading-relaxed space-y-1">
              <div className="font-medium">The private folder could not be created.</div>
              {describePrivateInitFailure(result).map((line, i) => (
                <div key={i} className="break-words">{line}</div>
              ))}
              <div className="text-text-3">
                You can also run <code className="font-mono">npm run private -- init</code> in the repo and come back.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void run()}
              className="inline-flex items-center gap-2 px-4 h-9 bg-accent hover:bg-accent-hover text-white rounded-pill transition-all font-medium text-[13px] shadow-pill"
            >
              <RotateCcw size={14} />
              Try again
            </button>
            {onBack && (
              <button
                onClick={onBack}
                className="px-3 h-9 bg-bg-elevated border border-border-default hover:border-accent text-text-2 rounded-md text-[13px] transition-colors"
              >
                Back
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
