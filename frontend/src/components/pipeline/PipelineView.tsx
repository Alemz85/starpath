'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, type SpawnRecord } from '@/store/spawns'
import { ipc } from '@/lib/ipc'
import { AlertTriangle, Plus } from 'lucide-react'
import { ActivityPanel, pickVisible } from '@/components/command-center/CommandCenter'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { cn, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_COLORS, type AppStatus, type ApplicationEntry } from '@/types'

const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer']

const PER_APP_TAILOR_CV = 'app-tailor-cv'
const PER_APP_DRAFT_APP = 'app-draft'
const PER_APP_INTERVIEW = 'app-interview'

export function PipelineView() {
  const { repoPath } = useAppStore()
  const { applications, pipeline, loaded, refresh } = useDataStore()
  const { spawns, start, kill, clear } = useSpawnsStore()
  const navigate = useNavStore(s => s.navigate)

  const tailor = spawns[PER_APP_TAILOR_CV]
  const draft  = spawns[PER_APP_DRAFT_APP]
  const prep   = spawns[PER_APP_INTERVIEW]
  const visible = pickVisible(tailor, draft, prep)

  // Refresh the data store when a spawn finishes (e.g., a generated PDF
  // updates the applications.md PDF column → FilesStrip should re-check).
  useEffect(() => {
    if (tailor?.status === 'done' || tailor?.status === 'error' || tailor?.status === 'killed') refresh()
  }, [tailor?.status, refresh])
  useEffect(() => {
    if (draft?.status === 'done' || draft?.status === 'error' || draft?.status === 'killed') refresh()
  }, [draft?.status, refresh])
  useEffect(() => {
    if (prep?.status === 'done' || prep?.status === 'error' || prep?.status === 'killed') refresh()
  }, [prep?.status, refresh])

  const grouped = useMemo(() => {
    const map: Record<string, ApplicationEntry[]> = {}
    for (const s of STATUS_GROUPS) map[s] = []
    for (const a of applications) {
      if (a.status in map) map[a.status].push(a)
    }
    return map
  }, [applications])

  const launch = (id: string, label: string, app: ApplicationEntry, modeFile: string) => {
    if (spawns[id]?.status === 'running') { kill(id); return }
    if (spawns[id]) clear(id)
    const mode = modeFile.replace(/^modes\//, '').replace(/\.md$/, '')
    const prompt = `/career-ops ${mode} for ${app.company} — ${app.role}`
    start(id, `${label}: ${app.company}`, 'claude', ['-p', prompt])
  }

  const handleTailorCV = (a: ApplicationEntry) => launch(PER_APP_TAILOR_CV, 'Tailor CV',         a, 'modes/pdf.md')
  const handleDraftApp = (a: ApplicationEntry) => launch(PER_APP_DRAFT_APP, 'Draft Application', a, 'modes/apply.md')
  const handlePrepInt  = (a: ApplicationEntry) => launch(PER_APP_INTERVIEW, 'Prep Interview',    a, 'modes/interview-prep.md')

  const totalActive = STATUS_GROUPS.reduce((sum, s) => sum + (grouped[s]?.length ?? 0), 0)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Pipeline</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${totalActive} active` : '…'}
        </span>
        <div className="flex-1" />
        {pipeline.length > 0 && (
          <span className="text-label text-text-4 font-mono">
            {pipeline.length} pending
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col px-6 pt-5 pb-6 gap-4 overflow-hidden min-h-0">
        {/* Inbox */}
        <InboxPanel repoPath={repoPath} />

        {/* Kanban */}
        <div className="shrink-0 overflow-x-auto -mx-1 px-1">
          <div className="flex gap-3" style={{ minWidth: STATUS_GROUPS.length * 240 }}>
            {STATUS_GROUPS.map(status => (
              <KanbanColumn
                key={status}
                status={status}
                items={grouped[status] ?? []}
                spawns={spawns}
                onTailorCV={handleTailorCV}
                onDraftApp={handleDraftApp}
                onPrepInt={handlePrepInt}
                onViewReport={app => navigate('reports', `${app.company}|${app.role}`)}
              />
            ))}
          </div>
        </div>

        {/* Activity panel — shared */}
        <div className="flex-1 min-h-0 flex flex-col">
          <ActivityPanel record={visible} />
        </div>
      </div>
    </div>
  )
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

function InboxPanel({ repoPath }: { repoPath: string | null }) {
  const pipeline = useDataStore(s => s.pipeline)
  const refresh = useDataStore(s => s.refresh)
  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const addUrl = async () => {
    if (!newUrl.trim() || !repoPath) return
    setAdding(true)
    try {
      const path = 'data/pipeline.md'
      const existing = await ipc.readFile(path) ?? ''
      const updated = existing.trimEnd() + '\n- ' + newUrl.trim() + '\n'
      await ipc.writeFile(path, updated)
      setNewUrl('')
      await refresh()
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel">
      <div className="flex items-center justify-between px-3 h-9 border-b border-border-default">
        <span className="text-micro text-text-4 uppercase flex items-center gap-1.5">
          <span>Inbox</span>
          <span className="font-mono text-text-3">{pipeline.length}</span>
        </span>
        <div className="flex items-center gap-1.5">
          <input
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addUrl()}
            placeholder="Paste job URL…"
            className="w-72 px-2 py-1 bg-bg-base border border-border-default rounded text-label text-text-1 placeholder:text-text-4 outline-none focus:border-accent/60"
          />
          <button
            onClick={addUrl}
            disabled={!newUrl.trim() || adding}
            className="flex items-center gap-1 px-2 py-1 bg-accent/15 text-accent border border-accent/40 rounded text-label hover:bg-accent/25 disabled:opacity-40 transition-colors"
          >
            <Plus size={11} />
            Add
          </button>
        </div>
      </div>
      {pipeline.length > 0 && (
        <div className="px-3 py-2 max-h-24 overflow-y-auto space-y-1">
          {pipeline.map((p, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-2 text-[11px] leading-snug',
                p.isStale ? 'text-warning' : 'text-text-3',
              )}
            >
              {p.isStale && <AlertTriangle size={9} className="shrink-0" />}
              <span className="truncate font-mono">{p.url}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Kanban ─────────────────────────────────────────────────────────────────

interface ColumnProps {
  status: AppStatus
  items: ApplicationEntry[]
  spawns: Record<string, SpawnRecord>
  onTailorCV: (a: ApplicationEntry) => void
  onDraftApp: (a: ApplicationEntry) => void
  onPrepInt:  (a: ApplicationEntry) => void
  onViewReport: (a: ApplicationEntry) => void
}

function KanbanColumn({ status, items, spawns, onTailorCV, onDraftApp, onPrepInt, onViewReport }: ColumnProps) {
  const textColor = STATUS_COLORS[status]
  return (
    <div className="flex flex-col w-60 shrink-0 rounded-lg bg-bg-panel border border-border-default overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <span className={cn('text-micro font-medium uppercase tracking-wider', textColor)}>{status}</span>
        <span className="text-micro font-mono text-text-4">{items.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[140px] max-h-[320px]">
        {items.length === 0 ? (
          <div className="galaxy-bg rounded-md py-5 text-center">
            <p className="text-micro text-text-4">Empty</p>
          </div>
        ) : (
          items.map((app, i) => (
            <ApplicationCard
              key={i}
              app={app}
              spawns={spawns}
              onTailorCV={() => onTailorCV(app)}
              onDraftApp={() => onDraftApp(app)}
              onPrepInt={() => onPrepInt(app)}
              onViewReport={() => onViewReport(app)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ApplicationCard({ app, spawns, onTailorCV, onDraftApp, onPrepInt, onViewReport }: {
  app: ApplicationEntry
  spawns: Record<string, SpawnRecord>
  onTailorCV: () => void
  onDraftApp: () => void
  onPrepInt:  () => void
  onViewReport: () => void
}) {
  const urgency = deadlineUrgency(app.deadline)
  const badge = urgencyBadge(urgency)
  const tailorRunning = spawns[PER_APP_TAILOR_CV]?.status === 'running' && spawns[PER_APP_TAILOR_CV]?.label.includes(app.company)
  const draftRunning  = spawns[PER_APP_DRAFT_APP]?.status === 'running' && spawns[PER_APP_DRAFT_APP]?.label.includes(app.company)
  const prepRunning   = spawns[PER_APP_INTERVIEW]?.status === 'running' && spawns[PER_APP_INTERVIEW]?.label.includes(app.company)

  return (
    <div className="p-2.5 rounded-md bg-bg-elevated border border-border-default hover:border-border-strong transition-colors">
      <div className="flex items-start gap-2">
        <CompanyLogo company={app.company} size={24} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-1 font-medium truncate leading-tight">{app.company}</div>
          <div className="text-[11px] text-text-3 truncate leading-tight mt-0.5">{app.role}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 gap-2">
        <span className="text-[10px] font-mono text-text-4 tabular-nums">{app.score}</span>
        <div className="flex items-center gap-1.5">
          {badge && (
            <span className={cn('text-[10px] font-mono px-1 py-0.5 rounded border', badge.color)}>
              {badge.label}
            </span>
          )}
          <FilesStrip company={app.company} role={app.role} size="sm" />
        </div>
      </div>
      <div className="flex items-center gap-1 mt-2 -mb-0.5">
        <CardAction label="Tailor CV" running={tailorRunning} onClick={onTailorCV} />
        <CardAction label="Draft"     running={draftRunning}  onClick={onDraftApp} />
        <CardAction label="Prep"      running={prepRunning}   onClick={onPrepInt} />
        <CardAction label="Report"    running={false}         onClick={onViewReport} />
      </div>
    </div>
  )
}

function CardAction({ label, running, onClick }: { label: string; running: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 px-1.5 py-1 rounded text-[10px] leading-none border transition-colors text-center',
        running
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-border-default text-text-3 hover:text-accent hover:border-accent/40 hover:bg-accent/5',
      )}
    >
      {running ? '…' : label}
    </button>
  )
}
