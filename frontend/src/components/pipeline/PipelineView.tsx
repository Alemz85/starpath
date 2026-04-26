'use client'

import { useState, useMemo } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { Plus, AlertTriangle } from 'lucide-react'
import { cn, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_COLORS, type AppStatus, type ApplicationEntry } from '@/types'

export function PipelineView() {
  const { applications, pipeline, loaded, refresh } = useDataStore()
  const { repoPath } = useAppStore()
  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const statusGroups: AppStatus[] = ['Interview', 'Responded', 'Applied', 'Evaluated', 'Offer']

  const grouped = useMemo(() => {
    const map: Record<string, typeof applications> = {}
    for (const s of statusGroups) map[s] = []
    for (const app of applications) {
      if (app.status in map) map[app.status].push(app)
    }
    return map
  }, [applications])

  const addUrl = async () => {
    if (!newUrl.trim() || !repoPath) return
    setAdding(true)
    try {
      const pipelinePath = 'data/pipeline.md'
      const existing = await ipc.readFile(pipelinePath) ?? ''
      const line = `- ${newUrl.trim()}`
      const updated = existing.trimEnd() + '\n' + line + '\n'
      await ipc.writeFile(pipelinePath, updated)
      setNewUrl('')
      await refresh()
    } finally {
      setAdding(false)
    }
  }

  const totalActive = statusGroups.reduce((sum, s) => sum + (grouped[s]?.length ?? 0), 0)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="titlebar-drag h-11 shrink-0 border-b border-border-default" />

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <h1 className="text-body text-text-1 font-medium">Pipeline</h1>
        <span className="text-label text-text-4 font-mono">{loaded ? `${totalActive} active` : '…'}</span>
        <div className="flex-1" />
        {pipeline.length > 0 && (
          <span className="text-label text-text-4 font-mono">
            {pipeline.length} pending URL{pipeline.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Kanban board */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
          <div className="flex gap-3 h-full" style={{ minWidth: statusGroups.length * 220 }}>
            {statusGroups.map(status => (
              <KanbanColumn
                key={status}
                status={status}
                items={grouped[status] ?? []}
              />
            ))}
          </div>
        </div>

        {/* Right panel: pending URLs + add */}
        <div className="w-64 shrink-0 border-l border-border-default bg-bg-chrome flex flex-col">
          <div className="px-3 py-2 border-b border-border-default">
            <span className="text-micro text-text-4 uppercase">Inbox</span>
          </div>

          {/* Add URL */}
          <div className="px-3 py-2 border-b border-border-default">
            <div className="flex gap-1.5">
              <input
                value={newUrl}
                onChange={e => setNewUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addUrl()}
                placeholder="Paste job URL…"
                className="flex-1 min-w-0 px-2 py-1 bg-bg-elevated border border-border-default rounded text-label text-text-1 placeholder:text-text-4 outline-none focus:border-accent/60"
              />
              <button
                onClick={addUrl}
                disabled={!newUrl.trim() || adding}
                className="px-2 py-1 bg-accent/20 text-accent-text rounded border border-accent/30 text-label hover:bg-accent/30 disabled:opacity-40 transition-colors"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>

          {/* Pending list */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {pipeline.length === 0 ? (
              <p className="text-micro text-text-4 text-center py-6">No pending URLs</p>
            ) : (
              pipeline.map((p, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2 p-2 rounded-md bg-bg-elevated border transition-colors',
                    p.isStale ? 'border-warning/30' : 'border-border-default',
                  )}
                >
                  {p.isStale && <AlertTriangle size={10} className="text-warning shrink-0 mt-0.5" />}
                  <span className="text-label text-text-3 truncate flex-1 text-[11px] leading-tight">{p.url}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function KanbanColumn({ status, items }: { status: AppStatus; items: ApplicationEntry[] }) {
  const textColor = STATUS_COLORS[status]

  return (
    <div className="flex flex-col w-52 shrink-0 rounded-lg bg-bg-panel border border-border-default overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <span className={cn('text-micro font-medium uppercase', textColor)}>{status}</span>
        <span className="text-micro font-mono text-text-4">{items.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 ? (
          <p className="text-micro text-text-4 text-center py-4">Empty</p>
        ) : (
          items.map((app, i) => {
            const urgency = deadlineUrgency(app.deadline)
            const badge = urgencyBadge(urgency)
            return (
              <div
                key={i}
                className="p-2.5 rounded-md bg-bg-elevated border border-border-default hover:border-border-strong transition-colors"
              >
                <div className="text-label text-text-1 font-medium truncate">{app.company}</div>
                <div className="text-label text-text-3 truncate mt-0.5">{app.role}</div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-micro font-mono text-text-4">{app.score}</span>
                  {badge && (
                    <span className={cn('text-[10px] font-mono px-1 py-0.5 rounded border', badge.color)}>
                      {badge.label}
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
