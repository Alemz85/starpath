'use client'

import { useState } from 'react'
import { ChevronRight, RotateCcw } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { cn } from '@/lib/utils'
import { STATUS_COLORS, type ApplicationEntry } from '@/types'

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
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 h-9 hover:bg-bg-elevated transition-colors"
      >
        <ChevronRight size={13} className={cn('text-text-4 transition-transform duration-150', expanded && 'rotate-90')} />
        <span className="text-micro text-text-4 uppercase tracking-wider">Closed</span>
        <span className="text-micro font-mono text-text-3">{apps.length}</span>
        <span className="flex-1" />
        <span className="text-[10.5px] font-mono text-text-4">
          {rejected > 0 && <span className="text-danger/80">{rejected} rejected</span>}
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
  return (
    <div className="group flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-bg-elevated transition-colors">
      <CompanyLogo company={app.company} size={20} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="block text-[12px] text-text-2 truncate leading-tight">{app.company}</span>
        <span className="block text-[10.5px] text-text-4 truncate leading-tight">{app.role}</span>
      </div>
      <span className={cn('shrink-0 text-[10px] font-mono uppercase tracking-wide', STATUS_COLORS[app.status])}>
        {app.status}
      </span>
      <button
        onClick={onRestore}
        title="Restore to the board — sets the status back to Evaluated"
        className="shrink-0 inline-flex items-center gap-1 px-2 h-6 rounded-pill text-[10.5px] text-text-4 opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10 transition-all"
      >
        <RotateCcw size={10} />
        Restore
      </button>
    </div>
  )
}
