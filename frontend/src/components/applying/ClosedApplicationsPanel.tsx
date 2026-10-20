'use client'

import { useState } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { Button, StatusChip } from '@/components/ui'
import { cn } from '@/lib/utils'
import type { ApplicationEntry } from '@/types'
import { useWriteGate } from '@/store/dataRoot'

// Closed-out applications (Rejected + Discarded) live OUTSIDE the kanban's
// five active stages. Without this strip they'd vanish from the board
// entirely — no closure on a rejection, and no way to undo an accidental
// discard. Collapsed by default so the active pipeline stays the focus;
// Restore drops a row back to Evaluated and it re-enters the board.
export function ClosedApplicationsPanel({
  apps, onRestore,
}: {
  apps: ApplicationEntry[]
  onRestore: (app: ApplicationEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (apps.length === 0) return null

  const rejected  = apps.filter(a => a.status === 'Rejected').length
  const discarded = apps.filter(a => a.status === 'Discarded').length

  return (
    <div className="card shrink-0 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 h-9 hover:bg-bg-elevated transition-colors duration-150 focus-visible:outline-none focus-visible:bg-bg-elevated"
      >
        <ChevronRight size={14} className={cn('text-text-4 transition-transform duration-150', expanded && 'rotate-90')} />
        <span className="label">Closed · {apps.length}</span>
        <span className="flex-1" />
        <span className="text-label text-text-4">
          {rejected > 0 && <span>{rejected} rejected</span>}
          {rejected > 0 && discarded > 0 && <span> · </span>}
          {discarded > 0 && <span>{discarded} discarded</span>}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border-default max-h-44 overflow-y-auto p-1.5 space-y-0.5">
          {apps.map((app, i) => (
            <ClosedRow key={`${app.company}-${app.role}-${i}`} app={app} onRestore={() => onRestore(app)} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClosedRow({ app, onRestore }: { app: ApplicationEntry; onRestore: () => void }) {
  const { canWrite, readOnlyTitle } = useWriteGate()
  return (
    <div className="group flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors duration-150">
      <CompanyLogo company={app.company} size={20} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block text-label font-medium text-text-2 truncate">{app.company}</span>
        <span className="block text-label text-text-4 truncate">{app.role}</span>
      </div>
      <StatusChip status={app.status} className="shrink-0" />
      <Button
        tone="ghost"
        size="xs"
        onClick={onRestore}
        disabled={!canWrite}
        title={readOnlyTitle ?? 'Restore to the board — sets the status back to Evaluated'}
        icon={<RotateCcw size={12} />}
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      >
        Restore
      </Button>
    </div>
  )
}
