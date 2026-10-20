'use client'

import { useState } from 'react'
import { ArrowLeftRight, Telescope } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app'
import { useDataRootStore } from '@/store/dataRoot'
import { isDemo, ownDataAction } from '@/lib/dataRoot'
import { OrbitalLoader } from '@/components/ui/orbital-loader'

// Persistent "Demo data · read-only" marker in the sidebar, in the slot the
// profile switcher uses (the demo has no profiles, so the two never show
// together). Same row anatomy as the switcher and the search field: a quiet
// nav-input surface, then one action — back to own data when it exists, or
// the "Set up my own search" wizard when it doesn't.
export function DemoBadge({ expanded }: { expanded: boolean }) {
  const info = useDataRootStore(s => s.info)
  const busy = useDataRootStore(s => s.busy)
  const leaveDemo = useAppStore(s => s.leaveDemo)
  const startOwnSetup = useAppStore(s => s.startOwnSetup)
  const [failure, setFailure] = useState<string | null>(null)

  if (!isDemo(info)) return null

  const action = ownDataAction(info)
  const actionLabel = 'Use my own data'
  const actionHint = action === 'leave-demo'
    ? 'Switch back to your own data'
    : 'No own data yet: opens "Set up my own search"'
  const run = async () => {
    setFailure(null)
    if (action === 'setup') { await startOwnSetup(); return }
    const res = await leaveDemo()
    if (!res.ok) setFailure(res.message ?? 'Could not switch back')
  }

  if (!expanded) {
    return (
      <div className="pt-2 px-2 flex justify-center">
        <button
          onClick={() => void run()}
          disabled={busy}
          title={`Demo data · read-only. ${actionLabel}: ${actionHint}`}
          aria-label={`Demo data, read-only. ${actionLabel}`}
          className="btn btn-sm btn-icon text-nav-accent hover:text-nav-strong hover:bg-nav-hover-bg"
        >
          {busy ? <OrbitalLoader size={16} rings={2} /> : <Telescope size={15} aria-hidden />}
        </button>
      </div>
    )
  }

  return (
    <div className="pt-2 px-3 space-y-0.5" role="status" aria-label="Demo data, read-only">
      <div
        className="flex items-center gap-2 px-2 h-8 rounded bg-nav-input-bg border border-nav-input-border"
        title="Fictional demo data. Nothing here can be changed."
      >
        <Telescope size={13} className="text-nav-accent shrink-0" aria-hidden />
        <span className="flex-1 min-w-0 truncate text-label text-nav-text">Demo data · read-only</span>
      </div>
      <button
        onClick={() => void run()}
        disabled={busy}
        title={actionHint}
        className={cn(
          'btn btn-sm w-full justify-start gap-2 px-2 text-nav-muted hover:text-nav-strong hover:bg-nav-hover-bg',
        )}
      >
        {busy ? <OrbitalLoader size={14} rings={2} /> : <ArrowLeftRight size={13} aria-hidden />}
        <span className="truncate">{actionLabel}</span>
      </button>
      {failure && <p className="px-2 text-label text-danger" role="alert">{failure}</p>}
    </div>
  )
}
