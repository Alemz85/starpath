'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, claudeArgs, type SpawnRecord } from '@/store/spawns'
import { ipc } from '@/lib/ipc'
import {
  Briefcase, AlertTriangle, Plus, FileText, MessageSquare, GraduationCap, X,
} from 'lucide-react'
import { StatCard } from '@/components/command-center/StatCard'
import { RunningInScanFooter } from '@/components/command-center/CommandCenter'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { cn, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_COLORS, type AppStatus, type ApplicationEntry } from '@/types'

const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer']

const PER_APP_TAILOR_CV = 'app-tailor-cv'
const PER_APP_DRAFT_APP = 'app-draft'
const PER_APP_INTERVIEW = 'app-interview'

export function ApplyingView() {
  const { repoPath } = useAppStore()
  const models = useAppStore(s => s.models)
  const { applications, pipeline, loaded, refresh } = useDataStore()
  const setApplicationStatus = useDataStore(s => s.setApplicationStatus)
  const { spawns, start, kill, clear } = useSpawnsStore()
  const navigate = useNavStore(s => s.navigate)
  // Track which card is currently being dragged so columns can highlight as
  // drop targets and so onDrop has the source info even if the dataTransfer
  // payload is missing (Electron's drag events occasionally drop the data).
  const [dragging, setDragging] = useState<{ company: string; role: string; from: AppStatus } | null>(null)
  // Pending discard — the styled confirm modal reads from this and the
  // user clicks confirm/cancel from the modal itself rather than getting
  // an OS-level window.confirm() that doesn't match the app design.
  const [pendingDiscard, setPendingDiscard] = useState<ApplicationEntry | null>(null)

  const tailor = spawns[PER_APP_TAILOR_CV]
  const draft  = spawns[PER_APP_DRAFT_APP]
  const prep   = spawns[PER_APP_INTERVIEW]

  // Refresh data store whenever a per-card spawn finishes — newly-generated
  // CV files / status writebacks should propagate to FilesStrip and the
  // Kanban without manual refresh.
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

  const totalApplied      = applications.filter(a => a.status === 'Applied').length
  const totalResponded    = applications.filter(a => a.status === 'Responded').length
  const totalInterviewing = applications.filter(a => a.status === 'Interview').length
  const totalOffers       = applications.filter(a => a.status === 'Offer').length
  const urgentCount       = applications.filter(a => deadlineUrgency(a.deadline) === 'urgent').length

  const launch = (id: string, label: string, app: ApplicationEntry, modeFile: string, model: 'sonnet' | 'opus' | 'haiku') => {
    if (spawns[id]?.status === 'running') { kill(id); return }
    if (spawns[id]) clear(id)
    const mode = modeFile.replace(/^modes\//, '').replace(/\.md$/, '')
    const slash = `/career-ops ${mode} for ${app.company} — ${app.role}`
    start(id, `${label}: ${app.company}`, 'claude', claudeArgs(slash, model))
  }

  const handleTailorCV = (a: ApplicationEntry) => launch(PER_APP_TAILOR_CV, 'Tailor CV',         a, 'modes/pdf.md',            models.tailorCv)
  const handleDraftApp = (a: ApplicationEntry) => launch(PER_APP_DRAFT_APP, 'Draft Application', a, 'modes/apply.md',          models.draftApp)
  const handlePrepInt  = (a: ApplicationEntry) => launch(PER_APP_INTERVIEW, 'Prep Interview',    a, 'modes/interview-prep.md', models.interviewPrep)

  const handleDropOnColumn = (target: AppStatus) => {
    if (!dragging) return
    if (dragging.from === target) { setDragging(null); return }
    void setApplicationStatus(dragging.company, dragging.role, target)
    setDragging(null)
  }

  const handleRemove = (app: ApplicationEntry) => setPendingDiscard(app)
  const confirmDiscard = () => {
    if (!pendingDiscard) return
    void setApplicationStatus(pendingDiscard.company, pendingDiscard.role, 'Discarded' as AppStatus)
    setPendingDiscard(null)
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Applying</h1>
        <span className="text-label text-text-4 font-mono">
          {loaded ? `${applications.length} active` : '…'}
        </span>
        <div className="flex-1" />
        {pipeline.length > 0 && (
          <span className="text-label text-text-4 font-mono">
            {pipeline.length} pending
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-6 gap-5 overflow-hidden min-h-0">
        {/* Hero */}
        <div className="shrink-0 galaxy-bg rounded-lg p-6 border border-border-default">
          <div className="flex items-center gap-3">
            <Briefcase size={20} className="text-accent" />
            <div>
              <h1 className="text-page text-text-1 mb-1">Applying</h1>
              <p className="text-body text-text-3">
                {loaded
                  ? `${applications.length} active · ${totalInterviewing} interviewing · ${totalOffers} offers`
                  : 'Loading data…'}
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="shrink-0 grid grid-cols-3 gap-3 lg:grid-cols-5">
          <StatCard label="Applied"          value={loaded ? String(totalApplied)      : '—'} icon={Briefcase} loading={!loaded} />
          <StatCard label="Responded"        value={loaded ? String(totalResponded)    : '—'} icon={MessageSquare} accent="text-accent" loading={!loaded} />
          <StatCard label="Interviewing"     value={loaded ? String(totalInterviewing) : '—'} icon={GraduationCap} accent="text-warning" loading={!loaded} />
          <StatCard label="Offers"           value={loaded ? String(totalOffers)       : '—'} icon={FileText} accent="text-success" loading={!loaded} />
          <StatCard label="Urgent deadlines" value={loaded ? String(urgentCount)       : '—'} icon={AlertTriangle} accent={urgentCount > 0 ? 'text-danger' : undefined} loading={!loaded} />
        </div>

        {/* Inbox — pending URLs */}
        <InboxPanel repoPath={repoPath} />

        {/* Kanban — fills the remaining vertical space, columns scroll
            internally. Wider/taller than before, this is now the main canvas
            of the Applying tab. */}
        <div className="flex-1 min-h-[260px] overflow-x-auto -mx-1 px-1">
          <div className="flex gap-3 h-full" style={{ minWidth: STATUS_GROUPS.length * 240 }}>
            {STATUS_GROUPS.map(status => (
              <KanbanColumn
                key={status}
                status={status}
                items={grouped[status] ?? []}
                spawns={spawns}
                dragging={dragging}
                onDragStart={(app) => setDragging({ company: app.company, role: app.role, from: status })}
                onDragEnd={() => setDragging(null)}
                onDropOnColumn={() => handleDropOnColumn(status)}
                onTailorCV={handleTailorCV}
                onDraftApp={handleDraftApp}
                onPrepInt={handlePrepInt}
                onRemove={handleRemove}
                onViewReport={app => navigate('reports', `${app.company}|${app.role}`)}
              />
            ))}
          </div>
        </div>

        {/* No inline activity panel — live logs live exclusively on the
            Scan tab. The footer pings the user there when anything is
            running. */}
        <RunningInScanFooter />
      </div>

      {pendingDiscard && (
        <DiscardConfirmModal
          app={pendingDiscard}
          onConfirm={confirmDiscard}
          onCancel={() => setPendingDiscard(null)}
        />
      )}
    </div>
  )
}

// ─── Discard confirm modal ──────────────────────────────────────────────────

function DiscardConfirmModal({ app, onConfirm, onCancel }: {
  app: ApplicationEntry
  onConfirm: () => void
  onCancel: () => void
}) {
  // Esc cancels; Enter confirms — keyboard parity with the system dialog
  // we replaced. Click outside to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter')  onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onCancel}
      style={{ animation: 'chip-appear 160ms ease both' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[380px] rounded-xl bg-bg-panel border border-border-strong shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-start gap-3">
            <CompanyLogo company={app.company} size={36} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold text-text-1 leading-tight">Remove from Applying?</h3>
              <p className="text-[12.5px] text-text-3 mt-1.5 leading-relaxed">
                <span className="font-medium text-text-2">{app.company}</span> — {app.role}
              </p>
            </div>
          </div>
          <p className="text-[12px] text-text-4 leading-relaxed mt-3.5">
            We'll mark this row Discarded in <code className="text-accent/80 bg-bg-elevated px-1 py-0.5 rounded text-[10.5px]">data/applications.md</code> and hide it from the kanban. The row stays in the file for audit — you can flip the status back any time.
          </p>
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 bg-bg-chrome border-t border-border-default">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-label text-text-2 rounded-md hover:bg-bg-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-label text-danger bg-danger/10 border border-danger/30 rounded-md hover:bg-danger/15 transition-colors font-medium"
          >
            Remove
          </button>
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
    <div className="shrink-0 rounded-lg border border-border-default bg-bg-panel overflow-hidden">
      {/* Divider only shows when the list has content beneath. With an
          empty inbox the bottom rule used to float below the header with
          nothing under it — read as a stray line. */}
      <div className={cn(
        'flex items-center justify-between px-3 h-9',
        pipeline.length > 0 && 'border-b border-border-default',
      )}>
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
        <InboxList items={pipeline} />
      )}
    </div>
  )
}

// Show only the first few pending URLs inline. Anything beyond the cap stays
// available behind a "show all" toggle — the full list is rarely worth the
// vertical space, and the count in the header conveys the bigger picture.
function InboxList({ items }: { items: import('@/types').PipelineUrl[] }) {
  const PREVIEW = 5
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, PREVIEW)
  const remaining = items.length - PREVIEW
  return (
    <div className="px-3 py-2">
      <div className={cn('space-y-1', expanded && 'max-h-48 overflow-y-auto')}>
        {visible.map((p, i) => (
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
      {remaining > 0 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-1.5 text-[10.5px] text-text-4 hover:text-accent transition-colors"
        >
          {expanded ? 'Show fewer' : `+ ${remaining} more`}
        </button>
      )}
    </div>
  )
}

// ─── Kanban ─────────────────────────────────────────────────────────────────

interface ColumnProps {
  status: AppStatus
  items: ApplicationEntry[]
  spawns: Record<string, SpawnRecord>
  dragging: { company: string; role: string; from: AppStatus } | null
  onDragStart: (a: ApplicationEntry) => void
  onDragEnd: () => void
  onDropOnColumn: () => void
  onTailorCV: (a: ApplicationEntry) => void
  onDraftApp: (a: ApplicationEntry) => void
  onPrepInt:  (a: ApplicationEntry) => void
  onRemove:   (a: ApplicationEntry) => void
  onViewReport: (a: ApplicationEntry) => void
}

function KanbanColumn({ status, items, spawns, dragging, onDragStart, onDragEnd, onDropOnColumn, onTailorCV, onDraftApp, onPrepInt, onRemove, onViewReport }: ColumnProps) {
  const textColor = STATUS_COLORS[status]
  const [hover, setHover] = useState(false)
  // Drop is meaningful only when something's being dragged AND it isn't
  // already in this column. Empty-column hover state stays even if the same
  // card is dragged over its own column — we just won't act on it.
  const isDropTarget = dragging != null && dragging.from !== status
  return (
    <div
      onDragOver={(e) => {
        if (!dragging) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!hover) setHover(true)
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setHover(false)
        onDropOnColumn()
      }}
      className={cn(
        'flex flex-col w-60 shrink-0 rounded-lg bg-bg-panel border overflow-hidden h-full transition-colors',
        isDropTarget && hover ? 'border-accent/60 bg-accent/[0.04]' : 'border-border-default',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default bg-bg-chrome shrink-0">
        <span className={cn('text-micro font-medium uppercase tracking-wider', textColor)}>{status}</span>
        <span className="text-micro font-mono text-text-4">{items.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 ? (
          <div className={cn(
            'rounded-md py-5 text-center transition-colors',
            isDropTarget && hover ? 'border-2 border-dashed border-accent/40 bg-accent/[0.05]' : 'galaxy-bg',
          )}>
            <p className="text-micro text-text-4">{isDropTarget && hover ? 'Drop here' : 'Empty'}</p>
          </div>
        ) : (
          items.map((app, i) => {
            const isDragging = dragging?.company === app.company && dragging?.role === app.role
            return (
              <ApplicationCard
                key={i}
                app={app}
                spawns={spawns}
                isDragging={isDragging}
                onDragStart={() => onDragStart(app)}
                onDragEnd={onDragEnd}
                onTailorCV={() => onTailorCV(app)}
                onDraftApp={() => onDraftApp(app)}
                onPrepInt={() => onPrepInt(app)}
                onRemove={() => onRemove(app)}
                onViewReport={() => onViewReport(app)}
              />
            )
          })
        )}
      </div>
    </div>
  )
}

function ApplicationCard({ app, spawns, isDragging, onDragStart, onDragEnd, onTailorCV, onDraftApp, onPrepInt, onRemove, onViewReport }: {
  app: ApplicationEntry
  spawns: Record<string, SpawnRecord>
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onTailorCV: () => void
  onDraftApp: () => void
  onPrepInt:  () => void
  onRemove:   () => void
  onViewReport: () => void
}) {
  const urgency = deadlineUrgency(app.deadline)
  const badge = urgencyBadge(urgency)
  const tailorRunning = spawns[PER_APP_TAILOR_CV]?.status === 'running' && spawns[PER_APP_TAILOR_CV]?.label.includes(app.company)
  const draftRunning  = spawns[PER_APP_DRAFT_APP]?.status === 'running' && spawns[PER_APP_DRAFT_APP]?.label.includes(app.company)
  const prepRunning   = spawns[PER_APP_INTERVIEW]?.status === 'running' && spawns[PER_APP_INTERVIEW]?.label.includes(app.company)

  return (
    <div
      draggable
      onDragStart={(e) => {
        // Native drag needs *some* dataTransfer payload to fire drop events
        // reliably across platforms — Electron on macOS otherwise silently
        // ignores the drop. The actual move target comes from React state.
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', `${app.company}|${app.role}`) } catch { /* noop */ }
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative p-2.5 rounded-md bg-bg-elevated border border-border-default hover:border-border-strong transition-colors cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
    >
      {/* Remove button — top-right, fades in on hover. Confirms before
          marking the row Discarded so the card can't disappear by accident. */}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Remove from applying batch"
        aria-label="Remove from applying batch"
        className="absolute top-1 right-1 p-1 rounded text-text-4 opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all"
      >
        <X size={11} />
      </button>
      <div className="flex items-start gap-2 pr-5">
        <CompanyLogo company={app.company} size={24} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-1 font-medium truncate leading-tight block">
            {app.company}
          </div>
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
