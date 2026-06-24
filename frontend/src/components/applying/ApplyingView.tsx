'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, claudeArgs, type SpawnRecord } from '@/store/spawns'
import { ipc } from '@/lib/ipc'
import {
  Briefcase, AlertTriangle, Plus, FileText, MessageSquare, GraduationCap, X, ArrowRight,
} from 'lucide-react'
import { RunningInScanFooter, HeroStatTile } from '@/components/command-center/CommandCenter'
import { ClosedApplicationsPanel } from './ClosedApplicationsPanel'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { cn, deadlineLabel, deadlineTime, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_COLORS, type AppStatus, type ApplicationEntry } from '@/types'

const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer']

function getSpawnId(prefix: string, app: ApplicationEntry): string {
  const cleanCompany = app.company.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const cleanRole = app.role.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `${prefix}-${cleanCompany}-${cleanRole}`
}

// Urgency bucket → sort rank (lower = more pressing, floats to the top of its
// column). 'none' (Rolling / no deadline) and 'missed' sink below live dates.
const URGENCY_RANK: Record<ReturnType<typeof deadlineUrgency>, number> = {
  urgent: 0, month: 1, upcoming: 2, none: 3, missed: 4,
}

// Order cards within a column so the nearest live deadline never sits buried
// under months-out rows: by urgency bucket first, then the actual date.
// Both helpers are the canonical, timezone-safe ones from lib/utils.
function compareByDeadline(a: ApplicationEntry, b: ApplicationEntry): number {
  const ra = URGENCY_RANK[deadlineUrgency(a.deadline)]
  const rb = URGENCY_RANK[deadlineUrgency(b.deadline)]
  if (ra !== rb) return ra - rb
  return deadlineTime(a.deadline) - deadlineTime(b.deadline)
}

export function ApplyingView() {
  const repoPath = useAppStore(s => s.repoPath)
  const models = useAppStore(s => s.models)
  const applications = useDataStore(s => s.applications)
  const pipeline = useDataStore(s => s.pipeline)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const setApplicationStatus = useDataStore(s => s.setApplicationStatus)
  const spawns = useSpawnsStore(s => s.spawns)
  const start = useSpawnsStore(s => s.start)
  const kill = useSpawnsStore(s => s.kill)
  const clear = useSpawnsStore(s => s.clear)
  const navigate = useNavStore(s => s.navigate)

  // Track which card is currently being dragged so columns can highlight as
  // drop targets and so onDrop has the source info even if the dataTransfer
  // payload is missing (Electron's drag events occasionally drop the data).
  const [dragging, setDragging] = useState<{ company: string; role: string; from: AppStatus } | null>(null)
  // Pending discard — the styled confirm modal reads from this and the
  // user clicks confirm/cancel from the modal itself rather than getting
  // an OS-level window.confirm() that doesn't match the app design.
  const [pendingDiscard, setPendingDiscard] = useState<ApplicationEntry | null>(null)

  // Refresh data store whenever a per-card spawn finishes — newly-generated
  // CV files / status writebacks should propagate to FilesStrip and the
  // Kanban without manual refresh.
  const finishedSpawnIds = useMemo(() => {
    return Object.entries(spawns)
      .filter(([id, record]) => {
        const isAppSpawn = id.startsWith('app-tailor-cv') || id.startsWith('app-draft') || id.startsWith('app-interview')
        const isFinished = record.status === 'done' || record.status === 'error' || record.status === 'killed'
        return isAppSpawn && isFinished
      })
      .map(([id]) => id)
      .join(',')
  }, [spawns])

  useEffect(() => {
    if (finishedSpawnIds) {
      void refresh()
    }
  }, [finishedSpawnIds, refresh])

  const grouped = useMemo(() => {
    const map: Record<string, ApplicationEntry[]> = {}
    for (const s of STATUS_GROUPS) map[s] = []
    for (const a of applications) {
      if (a.status in map) map[a.status].push(a)
    }
    // Sort each column so the most pressing deadline rises to the top.
    for (const s of STATUS_GROUPS) map[s].sort(compareByDeadline)
    return map
  }, [applications])

  // Rejected + Discarded fall outside the five active kanban stages — collect
  // them for the collapsed "Closed" strip below the board so they stay
  // visible and reversible instead of silently disappearing.
  const closedApps = useMemo(
    () => applications.filter(a => a.status === 'Rejected' || a.status === 'Discarded'),
    [applications],
  )

  // Cards across all five active stages — drives the board's empty state.
  // Note: SKIP / Rejected / Discarded rows are intentionally NOT here (SKIP
  // never enters the board; the closed two live in the Closed strip), so a
  // user whose only rows are SKIP correctly sees the get-started guidance.
  const activeCount = STATUS_GROUPS.reduce((n, s) => n + (grouped[s]?.length ?? 0), 0)

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

  const handleTailorCV = (a: ApplicationEntry) => launch(getSpawnId('app-tailor-cv', a), 'Tailor CV',         a, 'modes/pdf.md',            models.tailorCv)
  const handleDraftApp = (a: ApplicationEntry) => launch(getSpawnId('app-draft', a),     'Draft Application', a, 'modes/apply.md',          models.draftApp)
  const handlePrepInt  = (a: ApplicationEntry) => launch(getSpawnId('app-interview', a), 'Prep Application', a, 'modes/interview-prep.md', models.interviewPrep)

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

  // Restore a closed-out row back onto the board. Evaluated is the board's
  // entry column, so the card reappears in the first lane.
  const handleRestore = (app: ApplicationEntry) =>
    void setApplicationStatus(app.company, app.role, 'Evaluated' as AppStatus)

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
        {/* Editorial hero — display title + 4-column funnel strip
            (Sent → Responded → Interviewing → Offers). Hairline
            dividers, no card frames. Interviewing and Offers get
            accent + pulsing dot so the in-flight stages stand out. */}
        <div className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos">
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            <h1 className="text-display-2 text-text-1">Applying</h1>
            {loaded && urgentCount > 0 && (
              <span className="text-label text-danger font-medium">
                {urgentCount} urgent {urgentCount === 1 ? 'deadline' : 'deadlines'}
              </span>
            )}
          </div>

          {loaded ? (
            <div className="grid grid-cols-4 divide-x divide-border-default/50">
              <HeroStatTile value={totalApplied}      label="Sent"          sub="applications" />
              <HeroStatTile value={totalResponded}    label="Responded"     sub="replies received" />
              <HeroStatTile
                value={totalInterviewing}
                label="Interviewing"
                sub="active processes"
                accent={totalInterviewing > 0 ? 'text-warning' : undefined}
                highlightDot={totalInterviewing > 0 ? 'bg-warning' : undefined}
              />
              <HeroStatTile
                value={totalOffers}
                label="Offers"
                sub="received"
                accent={totalOffers > 0 ? 'text-success' : undefined}
                highlightDot={totalOffers > 0 ? 'bg-success' : undefined}
              />
            </div>
          ) : (
            <div className="h-14 shimmer rounded-lg" />
          )}
        </div>

        {/* Inbox — pending URLs */}
        <InboxPanel repoPath={repoPath} />

        {/* Kanban — fills the remaining vertical space, columns scroll
            internally. Wider/taller than before, this is now the main canvas
            of the Applying tab. When there's nothing on the board yet, the
            five empty columns read as "broken/loading" — swap in get-started
            guidance instead. */}
        <div className="flex-1 min-h-[260px] overflow-x-auto -mx-1 px-1">
          {loaded && activeCount === 0 ? (
            <EmptyBoard onBrowse={() => navigate('database')} />
          ) : (
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
          )}
        </div>

        {/* Closed-out applications (Rejected / Discarded) — collapsed strip so
            they stay auditable and reversible without cluttering the board. */}
        <ClosedApplicationsPanel apps={closedApps} onRestore={handleRestore} />

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

// ─── Empty board ─────────────────────────────────────────────────────────────

// Shown when no application sits in any of the five active stages. Replaces
// the row of empty columns (which reads as broken) with a short, accurate
// account of how rows get here — the Apply action lives on Database rows and
// report slide-overs — plus the inbox path for a brand-new lead.
function EmptyBoard({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center px-6">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent/10 mb-4">
          <Briefcase size={20} className="text-accent" />
        </span>
        <h3 className="text-[15px] font-semibold text-text-1">No active applications yet</h3>
        <p className="text-[12.5px] text-text-3 leading-relaxed mt-1.5">
          When you Apply to a listing from the Database or a report, it lands here and moves
          through the stages — Evaluated to Offer — as you work it.
        </p>
        <button
          onClick={onBrowse}
          className="inline-flex items-center gap-1.5 mt-4 pl-3.5 pr-3 h-9 bg-accent hover:bg-accent-hover active:scale-[0.98] text-white rounded-pill text-[13px] font-medium transition-all shadow-pill hover:shadow-pill-hover"
        >
          Browse the Database
          <ArrowRight size={14} />
        </button>
        <p className="text-[11px] text-text-4 mt-3">
          or paste a job URL in the inbox above to start a new lead
        </p>
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
  
  const tailorSpawnId = getSpawnId('app-tailor-cv', app)
  const draftSpawnId = getSpawnId('app-draft', app)
  const prepSpawnId = getSpawnId('app-interview', app)

  const tailorRunning = spawns[tailorSpawnId]?.status === 'running'
  const draftRunning  = spawns[draftSpawnId]?.status === 'running'
  const prepRunning   = spawns[prepSpawnId]?.status === 'running'

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
            <span
              className={cn('text-[10px] font-mono px-1 py-0.5 rounded border', badge.color)}
              title={app.deadline}
            >
              {deadlineLabel(app.deadline) ?? badge.label}
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
