'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useSpawnsStore, claudeArgs, type SpawnRecord } from '@/store/spawns'
import { useWriteGate } from '@/store/dataRoot'
import { ipc } from '@/lib/ipc'
import {
  Briefcase, AlertTriangle, Plus, FileText, Sparkles, GraduationCap, X, ArrowRight, ArrowUpRight, Bell, Loader2,
} from 'lucide-react'
import { RunningInScanFooter } from '@/components/command-center/CommandCenter'
import { ClosedApplicationsPanel } from './ClosedApplicationsPanel'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { Button, Chip, PageHeader, ScoreNumber, Stat, StatStrip, type ChipTone } from '@/components/ui'
import { cn, deadlineLabel, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import {
  STATUS_GROUPS, getSpawnId, groupByStatus, countActNow,
  cardAttention, stageProgress, nextStep,
  type CardAttention, type FollowUpState, type NextStep,
} from '@/lib/applyingBoard'
import type { AppStatus, ApplicationEntry } from '@/types'

// Status hue for the column-header dot and the funnel progress strip. Literal
// classes so Tailwind's JIT sees them; mirrors STATUS_COLORS (lifecycle state).
const STATUS_FILL: Record<AppStatus, string> = {
  Evaluated: 'bg-info',
  Applied:   'bg-accent',
  Responded: 'bg-accent',
  Interview: 'bg-warning',
  Offer:     'bg-success',
  Rejected:  'bg-danger',
  Discarded: 'bg-text-4',
  SKIP:      'bg-text-4',
}

// "7.79/10" → 7.79. Null when the cell holds no number.
function scoreValue(raw: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(raw ?? '')
  return m ? Number(m[1]) : null
}

export function ApplyingView() {
  const repoPath = useAppStore(s => s.repoPath)
  const models = useAppStore(s => s.models)
  const closedLaneEnabled = useAppStore(s => s.features.closedLane)
  const applications = useDataStore(s => s.applications)
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

  // Bucket into the five active stages, each column sorted by deadline
  // urgency. Pure logic lives in lib/applyingBoard (groupByStatus).
  const grouped = useMemo(() => groupByStatus(applications), [applications])

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

  // How many cards across the five active stages want action today — a fused
  // count of urgent deadlines AND overdue follow-up nudges. This is the single
  // number the user should read off the hero: "what do I touch right now?".
  // Recomputed once per data change; `cardAttention` is cheap and pure.
  const actNowCount = useMemo(
    () => STATUS_GROUPS.reduce((n, s) => n + countActNow(grouped[s] ?? []), 0),
    [grouped],
  )

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

  // Advance a card one stage up the funnel via the same status writeback the
  // drag-to-column path uses — the one-click target of a 'next step' of kind
  // 'advance'. No-ops on an unexpected null target.
  const handleAdvance = (a: ApplicationEntry, to: AppStatus | null) => {
    if (!to) return
    void setApplicationStatus(a.company, a.role, to)
  }

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
      <PageHeader
        title="Applying"
        meta={loaded ? (
          <>
            {activeCount} active
            {actNowCount > 0 ? (
              <>
                {' · '}
                <span className="text-danger font-medium">
                  {actNowCount} {actNowCount === 1 ? 'needs' : 'need'} action today
                </span>
              </>
            ) : activeCount > 0 ? (
              <>
                {' · '}
                <span className="text-success">All caught up</span>
              </>
            ) : null}
          </>
        ) : '…'}
      />

      <div className="flex-1 flex flex-col min-h-0 p-5 gap-4 overflow-hidden">
        {/* Funnel strip — Sent → Responded → Interviewing → Offers. The two
            in-flight stages take their lifecycle hue + dot when non-zero. */}
        {loaded ? (
          <StatStrip className="shrink-0">
            <Stat value={totalApplied}   label="Sent" />
            <Stat value={totalResponded} label="Responded" />
            <Stat
              value={totalInterviewing}
              label="Interviewing"
              tone={totalInterviewing > 0 ? 'warning' : 'default'}
              dot={totalInterviewing > 0}
            />
            <Stat
              value={totalOffers}
              label="Offers"
              tone={totalOffers > 0 ? 'success' : 'default'}
              dot={totalOffers > 0}
            />
          </StatStrip>
        ) : (
          <div className="shrink-0 flex divide-x divide-border-default" aria-hidden="true">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="space-y-2 px-5 first:pl-0">
                <div className="h-[22px] w-10 shimmer rounded" />
                <div className="h-3.5 w-20 shimmer rounded" />
              </div>
            ))}
          </div>
        )}

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
                  onAdvance={handleAdvance}
                  onRemove={handleRemove}
                  onViewReport={app => navigate('reports', `${app.company}|${app.role}`)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Closed-out applications (Rejected / Discarded) — collapsed strip so
            they stay auditable and reversible without cluttering the board.
            Deactivatable (Settings › General › Features); closed rows remain
            visible in Database and Pipeline either way. */}
        {closedLaneEnabled && (
          <ClosedApplicationsPanel apps={closedApps} onRestore={handleRestore} />
        )}

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
        className="w-[380px] rounded-xl bg-bg-base border border-border-default shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <CompanyLogo company={app.company} size={32} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 className="text-title text-text-1">Remove from Applying?</h3>
              <p className="text-label text-text-3 mt-1">
                <span className="font-medium text-text-2">{app.company}</span> — {app.role}
              </p>
            </div>
          </div>
          <p className="text-label text-text-3 mt-3">
            We'll mark this row Discarded in <code className="font-mono text-micro text-text-2 bg-bg-elevated px-1 py-0.5 rounded-sm">data/applications.md</code> and hide it from the kanban. The row stays in the file for audit — you can flip the status back any time.
          </p>
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 bg-bg-elevated/60 border-t border-border-default">
          <Button tone="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button tone="danger" size="sm" onClick={onConfirm}>
            Remove
          </Button>
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
        <Briefcase size={40} strokeWidth={1.5} className="mx-auto mb-3 text-text-4" aria-hidden />
        <h3 className="text-section text-text-1">No active applications yet</h3>
        <p className="text-label text-text-3 mt-1.5">
          When you Apply to a listing from the Database or a report, it lands here and moves
          through the stages — Evaluated to Offer — as you work it.
        </p>
        <Button
          tone="primary"
          onClick={onBrowse}
          trailing={<ArrowRight size={14} />}
          className="mt-4"
        >
          Browse the Database
        </Button>
        <p className="text-label text-text-4 mt-3">
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
  const { canWrite, readOnlyTitle } = useWriteGate()

  const addUrl = async () => {
    if (!newUrl.trim() || !repoPath || !canWrite) return
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
    <div className="card shrink-0 overflow-hidden">
      {/* Divider only shows when the list has content beneath. With an
          empty inbox the bottom rule used to float below the header with
          nothing under it — read as a stray line. */}
      <div className={cn(
        'flex items-center gap-3 px-3 h-10',
        pipeline.length > 0 && 'border-b border-border-default',
      )}>
        <span className="flex items-baseline gap-1.5 shrink-0">
          <span className="label">Inbox</span>
          <span className="text-label text-text-4 tabular-nums">{pipeline.length}</span>
        </span>
        <div className="flex-1 min-w-0 flex items-center justify-end gap-1.5">
          <input
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addUrl()}
            placeholder="Paste job URL…"
            disabled={!canWrite}
            title={readOnlyTitle}
            className="input input-sm max-w-sm min-w-0"
          />
          <Button
            tone="tinted"
            size="sm"
            onClick={addUrl}
            disabled={!newUrl.trim() || adding || !canWrite}
            title={readOnlyTitle}
            icon={<Plus size={13} />}
            className="shrink-0"
          >
            Add
          </Button>
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
              'flex items-center gap-2 text-label',
              p.isStale ? 'text-warning-text' : 'text-text-3',
            )}
          >
            {p.isStale && <AlertTriangle size={12} className="shrink-0" />}
            <span className="truncate font-mono">{p.url}</span>
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <Button
          tone="ghost"
          size="xs"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 -ml-2"
        >
          {expanded ? 'Show fewer' : `+ ${remaining} more`}
        </Button>
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
  onAdvance:  (a: ApplicationEntry, to: AppStatus | null) => void
  onRemove:   (a: ApplicationEntry) => void
  onViewReport: (a: ApplicationEntry) => void
}

function KanbanColumn({ status, items, spawns, dragging, onDragStart, onDragEnd, onDropOnColumn, onTailorCV, onDraftApp, onPrepInt, onAdvance, onRemove, onViewReport }: ColumnProps) {
  const [hover, setHover] = useState(false)
  // How many cards in THIS column want action today — drives the header pip so
  // a collapsed/scrolled column still signals "there's something pressing in
  // here" without the user opening it.
  const columnActNow = useMemo(() => countActNow(items), [items])
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
        'rounded-lg bg-bg-panel/50 border border-border-default/60 flex flex-col w-60 shrink-0 overflow-hidden h-full transition-colors duration-150',
        isDropTarget && hover && 'border-accent/60 bg-accent/[0.04]',
      )}
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border-default bg-bg-elevated/60 shrink-0">
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_FILL[status])} aria-hidden />
        <span className="text-label font-medium text-text-2">{status}</span>
        <span className="text-label text-text-4 tabular-nums">{items.length}</span>
        {columnActNow > 0 && (
          <Chip
            tone="danger"
            size="sm"
            icon={<Bell size={10} className="shrink-0" />}
            className="ml-auto"
            title={`${columnActNow} ${columnActNow === 1 ? 'card needs' : 'cards need'} action today`}
          >
            {columnActNow}
          </Chip>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 ? (
          <div className={cn(
            'rounded border border-dashed py-5 text-center transition-colors duration-150',
            isDropTarget && hover ? 'border-accent/40 bg-accent/[0.05]' : 'border-border-default',
          )}>
            <p className="text-label text-text-4">{isDropTarget && hover ? 'Drop here' : 'Empty'}</p>
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
                onAdvance={(to) => onAdvance(app, to)}
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

function ApplicationCard({ app, spawns, isDragging, onDragStart, onDragEnd, onTailorCV, onDraftApp, onPrepInt, onAdvance, onRemove, onViewReport }: {
  app: ApplicationEntry
  spawns: Record<string, SpawnRecord>
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onTailorCV: () => void
  onDraftApp: () => void
  onPrepInt:  () => void
  onAdvance:  (to: AppStatus | null) => void
  onRemove:   () => void
  onViewReport: () => void
}) {
  const urgency = deadlineUrgency(app.deadline)
  const badge = urgencyBadge(urgency)
  // Demo mode: the card reads normally, but every action that writes or
  // spawns (status moves, remove, tailor/draft/prep) is disabled.
  const { canWrite, readOnlyTitle } = useWriteGate()

  // Fused attention verdict (deadline clock + follow-up cadence). Drives the
  // card's border hue and the follow-up nudge chip. Memoised so the per-frame
  // drag re-renders don't recompute the date math.
  const attention = useMemo<CardAttention>(() => cardAttention(app), [app])
  const followUp = attention.followUp

  // The single recommended next move for this card, and how far it's travelled
  // down the funnel. Both pure (lib/applyingBoard); memoised so drag re-renders
  // don't re-derive. nextStep folds status + the two clocks into one concrete,
  // one-click action; stageProgress drives the journey strip.
  const step = useMemo<NextStep>(() => nextStep(app), [app])
  const progress = useMemo(() => stageProgress(app.status), [app.status])

  const tailorSpawnId = getSpawnId('app-tailor-cv', app)
  const draftSpawnId = getSpawnId('app-draft', app)
  const prepSpawnId = getSpawnId('app-interview', app)

  const tailorRunning = spawns[tailorSpawnId]?.status === 'running'
  const draftRunning  = spawns[draftSpawnId]?.status === 'running'
  const prepRunning   = spawns[prepSpawnId]?.status === 'running'

  // Whether the recommended step's underlying spawn is already in flight — so
  // the primary button can reflect a running action rather than re-launch it.
  const stepRunning =
    step.kind === 'tailor-cv' ? tailorRunning :
    step.kind === 'draft'     ? draftRunning  :
    step.kind === 'prep'      ? prepRunning   : false

  // Bind the recommended step to the affordance that performs it. 'advance'
  // writes the status back (same path as drag-to-column); the spawn kinds reuse
  // the existing per-card launchers; 'review' opens the report.
  const runStep = () => {
    switch (step.kind) {
      case 'advance':   onAdvance(step.toStage); break
      case 'tailor-cv': onTailorCV(); break
      case 'draft':     onDraftApp(); break
      case 'prep':      onPrepInt(); break
      case 'review':    onViewReport(); break
    }
  }

  return (
    <div
      draggable={canWrite}
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
        'card group relative p-2.5 transition-colors duration-150 cursor-grab active:cursor-grabbing',
        // The border carries the attention hue so a pressing card is legible
        // at a glance down a dense column. Calm cards keep the hairline.
        attention.level === 'act-now' ? 'border-danger/30 hover:border-danger/50'
          : attention.level === 'soon' ? 'border-warning/30 hover:border-warning/50'
          : 'hover:border-border-strong',
        isDragging && 'opacity-40',
      )}
    >
      {/* Remove button — top-right, fades in on hover. Confirms before
          marking the row Discarded so the card can't disappear by accident. */}
      <Button
        tone="ghost"
        size="xs"
        iconOnly
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!canWrite}
        title={readOnlyTitle ?? 'Remove from applying batch'}
        aria-label="Remove from applying batch"
        icon={<X size={12} />}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
      />
      <div className="flex items-start gap-2 pr-6">
        <CompanyLogo company={app.company} size={24} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-1 truncate leading-tight">
            {app.company}
          </div>
          <div className="text-label text-text-3 truncate mt-0.5">{app.role}</div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 gap-2">
        <ScoreNumber value={scoreValue(app.score)} size="sm" />
        <div className="flex items-center gap-1.5 min-w-0">
          <FollowUpChip state={followUp} />
          {badge && (
            <Chip
              tone={badge.color.replace('chip-', '') as ChipTone}
              size="sm"
              title={app.deadline}
            >
              {deadlineLabel(app.deadline) ?? badge.label}
            </Chip>
          )}
          <FilesStrip company={app.company} role={app.role} size="sm" />
        </div>
      </div>

      {/* Funnel progress strip — five segments tracing Evaluated → Offer.
          Cleared segments fill in the status hue; the rest stay hairline.
          Gives the card's *journey* at a glance, the context the status word
          alone can't ("Interview" tells you where, not how far it came). */}
      <StageProgressStrip cleared={progress.cleared} total={progress.total} status={app.status} />

      {/* Recommended next move — the single highest-value action for this card,
          one click. Tone tracks the pressure (danger = urgent close/overdue,
          tinted = the natural next step). The icon row below keeps every
          action reachable. */}
      <NextStepButton step={step} running={stepRunning} onClick={runStep} readOnlyTitle={step.kind === 'review' ? undefined : readOnlyTitle} />

      <div className="flex items-center gap-0.5 mt-1.5 -mb-0.5 h-6">
        <CardAction label="Tailor CV" icon={<Sparkles size={12} />}      running={tailorRunning} onClick={onTailorCV} active={step.kind === 'tailor-cv'} readOnlyTitle={readOnlyTitle} />
        <CardAction label="Draft application" icon={<FileText size={12} />}  running={draftRunning}  onClick={onDraftApp} active={step.kind === 'draft'} readOnlyTitle={readOnlyTitle} />
        <CardAction label="Prep application"  icon={<GraduationCap size={12} />} running={prepRunning} onClick={onPrepInt}  active={step.kind === 'prep'} readOnlyTitle={readOnlyTitle} />
        <Button
          tone="ghost"
          size="xs"
          onClick={(e) => { e.stopPropagation(); onViewReport() }}
          onPointerDown={(e) => e.stopPropagation()}
          className="ml-auto"
        >
          Report
        </Button>
      </div>
    </div>
  )
}

// ─── Funnel progress strip ──────────────────────────────────────────────────
// Five thin segments tracing the funnel (Evaluated → Applied → Responded →
// Interview → Offer). The first `cleared` segments fill in the card's status
// hue; the rest stay a faint hairline. Quiet by design — it reads as a progress
// meter, not a control, so it never competes with the next-step button.
function StageProgressStrip({ cleared, total, status }: { cleared: number; total: number; status: AppStatus }) {
  // Offer (complete) fills success-green; every other live stage fills with the
  // status' own hue so the strip agrees with the column header dot.
  const fill = status === 'Offer' ? 'bg-success' : STATUS_FILL[status]
  return (
    <div
      className="flex items-center gap-0.5 mt-2"
      role="img"
      aria-label={`Stage ${Math.max(cleared, 0)} of ${total}: ${status}`}
      title={`${status} — stage ${Math.max(cleared, 0)} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-[3px] flex-1 rounded-full transition-colors',
            i < cleared ? fill : 'bg-border-default',
          )}
        />
      ))}
    </div>
  )
}

// ─── Next-step button ───────────────────────────────────────────────────────
// The card's recommended one-click action (see lib/applyingBoard.nextStep).
// Full-width so the eye lands on it first; danger when the step is urgent,
// tinted otherwise. An 'advance' step shows a ↗ to signal it bumps the stage;
// a launch step that's already in flight shows the stop tone.
function NextStepButton({ step, running, onClick, readOnlyTitle }: { step: NextStep; running: boolean; onClick: () => void; readOnlyTitle?: string }) {
  const tone = running ? 'stop' : step.tone === 'urgent' ? 'danger' : 'tinted'
  return (
    <Button
      tone={tone}
      size="sm"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={!!readOnlyTitle}
      title={readOnlyTitle ?? (step.reason || step.label)}
      aria-label={step.reason || step.label}
      trailing={!running && step.kind === 'advance' ? <ArrowUpRight size={12} className="shrink-0" /> : undefined}
      className="w-full mt-2"
    >
      {running ? 'Running…' : step.label}
    </Button>
  )
}

// Follow-up nudge chip — only shows when a card has an actionable cadence
// (due-soon / overdue). A waiting or no-cadence card stays silent so the chip
// reads as "act on this", not decoration. Amber when it comes due, red once
// overdue — matching the card border's hue scale. The Bell + the
// `state.reason` tooltip tell the user exactly what nudge is owed.
function FollowUpChip({ state }: { state: FollowUpState }) {
  if (state.kind !== 'overdue' && state.kind !== 'due-soon') return null
  const overdue = state.kind === 'overdue'
  const label = overdue
    ? (state.dueInDays != null ? `${-state.dueInDays}d late` : 'Overdue')
    : (state.dueInDays === 0 ? 'Today' : 'Soon')
  return (
    <Chip
      tone={overdue ? 'danger' : 'warning'}
      size="sm"
      icon={<Bell size={10} className="shrink-0" />}
      title={state.reason}
    >
      {label}
    </Chip>
  )
}

// Icon-only per-card action. Running → stop tone with a spinner (a click kills
// the spawn). When this action is already the recommended next step (shown
// above as the full-width button), the icon takes the accent text colour to
// mark it as "that one" without competing for the eye.
function CardAction({ label, icon, running, onClick, active = false, readOnlyTitle }: { label: string; icon: ReactNode; running: boolean; onClick: () => void; active?: boolean; readOnlyTitle?: string }) {
  return (
    <Button
      tone={running ? 'stop' : 'ghost'}
      size="xs"
      iconOnly
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={!!readOnlyTitle}
      title={readOnlyTitle ? `${label}: ${readOnlyTitle}` : running ? `Stop: ${label}` : label}
      aria-label={running ? `Stop: ${label}` : label}
      icon={running ? <Loader2 size={12} className="animate-spin" /> : icon}
      className={cn(!running && active && 'text-accent-text')}
    />
  )
}
