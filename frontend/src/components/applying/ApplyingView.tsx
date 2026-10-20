'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useWriteGate } from '@/store/dataRoot'
import {
  Briefcase, X, ArrowRight, CalendarClock, CalendarPlus, Radar, Pencil, ScrollText,
} from 'lucide-react'
import { RunningInScanFooter } from '@/components/command-center/CommandCenter'
import { ClosedApplicationsPanel } from './ClosedApplicationsPanel'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { StatusDropdown } from '@/components/shared/ApplyAction'
import { WantEase } from '@/components/shared/WantEase'
import { ReportSlideOver } from '@/components/reports/ReportSlideOver'
import { orphanScoreEntry } from '@/components/reports/ReportsView'
import { Button, PageHeader, ScoreNumber, Stat, StatStrip } from '@/components/ui'
import { cn } from '@/lib/utils'
import { parseScoreCell } from '@/lib/scoreBands'
import {
  BOARD_STAGES, STATUS_GROUPS, groupByStatus, inferredRejectionLabel, rejectionInfo,
  rejectionStageOptions, type RejectionInfo,
} from '@/lib/applyingBoard'
import { dateCue, listingDateKey, type DateCue, type DateCueKind } from '@/lib/listingDates'
import type { AppStatus, ApplicationEntry, ScoreEntry } from '@/types'

// Status hue for the column-header dot. Literal classes so Tailwind's JIT
// sees them; mirrors STATUS_TONE in components/ui/chip (lifecycle state).
const STATUS_FILL: Record<AppStatus, string> = {
  Evaluated: 'bg-text-3',
  Applied:   'bg-accent',
  Responded: 'bg-accent',
  Interview: 'bg-warning',
  Offer:     'bg-success',
  Rejected:  'bg-danger',
  Discarded: 'bg-text-4',
  SKIP:      'bg-text-4',
}

// Which date a card's cue shows, by icon: closes, posted, first scanned.
const CUE_ICON: Record<DateCueKind, typeof CalendarClock> = {
  deadline: CalendarClock,
  posted:   CalendarPlus,
  scanned:  Radar,
}

const norm = (s: string) => s.trim().toLowerCase()

/** Today as YYYY-MM-DD (local), the latest date a rejection may carry. */
function todayIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14 Sep", with the year only when it isn't this year ("14 Sep 2025"). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return y === new Date().getFullYear() ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`
}

/** A rejection being recorded (move) or corrected (edit). */
interface RejectionDraft {
  app: ApplicationEntry
  mode: 'move' | 'edit'
  /** The status it was rejected from ('' when unknown). */
  from: string
  date: string
  stage: string
}

export function ApplyingView() {
  const closedLaneEnabled = useAppStore(s => s.features.closedLane)
  const applications = useDataStore(s => s.applications)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const statusLog = useDataStore(s => s.statusLog)
  const listingDates = useDataStore(s => s.listingDates)
  const loaded = useDataStore(s => s.loaded)
  const setApplicationStatus = useDataStore(s => s.setApplicationStatus)
  const amendStatusEntry = useDataStore(s => s.amendStatusEntry)
  const navigate = useNavStore(s => s.navigate)

  // Track which card is currently being dragged so columns can highlight as
  // drop targets and so onDrop has the source info even if the dataTransfer
  // payload is missing (Electron's drag events occasionally drop the data).
  const [dragging, setDragging] = useState<{ company: string; role: string; from: AppStatus } | null>(null)
  // Pending discard — the styled confirm modal reads from this.
  const [pendingDiscard, setPendingDiscard] = useState<ApplicationEntry | null>(null)
  // A rejection being recorded or corrected (the date + stage dialog).
  const [rejection, setRejection] = useState<RejectionDraft | null>(null)
  // The application whose report is open in the slide-over, in place.
  const [reportFor, setReportFor] = useState<ApplicationEntry | null>(null)

  // Each rejected card's date and stage, read once per log change.
  const rejections = useMemo(() => {
    const out = new Map<ApplicationEntry, RejectionInfo>()
    for (const a of applications) {
      const info = rejectionInfo(statusLog, a)
      if (info) out.set(a, info)
    }
    return out
  }, [applications, statusLog])

  // Bucket into the board columns: live stages sorted by deadline, Rejected
  // newest first. Pure logic lives in lib/applyingBoard (groupByStatus).
  const grouped = useMemo(
    () => groupByStatus(applications, new Date(), a => rejections.get(a)?.date ?? null),
    [applications, rejections],
  )

  // Discarded rows fall outside the board — collect them for the collapsed
  // "Closed" strip below it so they stay visible and reversible.
  const closedApps = useMemo(() => applications.filter(a => a.status === 'Discarded'), [applications])

  // Cards on the board, live stages only — drives the empty state and meta.
  const activeCount = STATUS_GROUPS.reduce((n, s) => n + (s === 'Rejected' ? 0 : grouped[s]?.length ?? 0), 0)
  const boardCount = activeCount + (grouped.Rejected?.length ?? 0)

  const totalApplied      = grouped.Applied.length
  const totalResponded    = grouped.Responded.length
  const totalInterviewing = grouped.Interview.length
  const totalOffers       = grouped.Offer.length
  const totalRejected     = grouped.Rejected.length

  // The report slide-over needs the listing's evaluation: the latest
  // score-history row for the company + role, else a blank entry.
  const reportEntry: ScoreEntry | null = useMemo(() => {
    if (!reportFor) return null
    const c = norm(reportFor.company)
    const r = norm(reportFor.role)
    const latest = scoreHistory
      .filter(e => norm(e.company) === c && norm(e.role) === r)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    return latest ?? orphanScoreEntry({ path: '', company: reportFor.company, role: reportFor.role, tier: '', url: '' })
  }, [reportFor, scoreHistory])

  // Every status change from the board goes through here. Rejected opens the
  // date + stage dialog first; anything else is written straight away.
  const moveTo = (app: ApplicationEntry, to: AppStatus) => {
    if (to === app.status) return
    if (to === 'Rejected') {
      setRejection({ app, mode: 'move', from: app.status, date: todayIso(), stage: '' })
      return
    }
    void setApplicationStatus(app.company, app.role, to)
  }

  const editRejection = (app: ApplicationEntry) => {
    const info = rejections.get(app)
    setRejection({
      app, mode: 'edit',
      from: info?.from ?? '',
      date: info?.date ?? todayIso(),
      stage: info?.stage ?? '',
    })
  }

  // Resolves to an error message, or null once saved.
  const saveRejection = async (draft: RejectionDraft): Promise<string | null> => {
    const { app } = draft
    const result = draft.mode === 'move'
      ? await setApplicationStatus(app.company, app.role, 'Rejected', { date: draft.date, stage: draft.stage || undefined })
      : await amendStatusEntry(app.company, app.role, 'Rejected', { date: draft.date, stage: draft.stage })
    if (!result) return 'Demo data is read-only'
    return result.ok ? null : result.error
  }

  const handleDropOnColumn = (target: AppStatus) => {
    if (!dragging) return
    const app = applications.find(a => a.company === dragging.company && a.role === dragging.role)
    setDragging(null)
    if (app) moveTo(app, target)
  }

  const confirmDiscard = () => {
    if (!pendingDiscard) return
    void setApplicationStatus(pendingDiscard.company, pendingDiscard.role, 'Discarded')
    setPendingDiscard(null)
  }

  // Restore a closed-out row back onto the board. Evaluated is the board's
  // entry column, so the card reappears in the first lane.
  const handleRestore = (app: ApplicationEntry) =>
    void setApplicationStatus(app.company, app.role, 'Evaluated')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Applying" meta={loaded ? `${activeCount} active` : '…'} />

      <div className="flex-1 flex flex-col min-h-0 p-5 gap-4 overflow-hidden">
        {/* Where the applications stand: Sent → Responded → Interviewing →
            Offers, with Rejected set apart. Counts only; nothing to act on. */}
        {loaded ? (
          <StatStrip className="shrink-0">
            <Stat value={totalApplied}   label="Sent" />
            <Stat value={totalResponded} label="Responded" />
            <Stat
              value={totalInterviewing}
              label="Interviewing"
              tone={totalInterviewing > 0 ? 'warning' : 'default'}
            />
            <Stat
              value={totalOffers}
              label="Offers"
              tone={totalOffers > 0 ? 'success' : 'default'}
            />
            <Stat
              value={totalRejected}
              label="Rejected"
              tone={totalRejected > 0 ? 'danger' : 'default'}
            />
          </StatStrip>
        ) : (
          <div className="shrink-0 flex divide-x divide-border-default" aria-hidden="true">
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="space-y-2 px-5 first:pl-0">
                <div className="h-[22px] w-10 shimmer rounded" />
                <div className="h-3.5 w-20 shimmer rounded" />
              </div>
            ))}
          </div>
        )}

        {/* Kanban — fills the remaining space; columns share the width and
            scroll internally, the board scrolls sideways only when narrow. */}
        <div className="flex-1 min-h-[260px] overflow-x-auto -mx-1 px-1">
          {loaded && boardCount === 0 ? (
            <EmptyBoard onBrowse={() => navigate('database')} />
          ) : (
            <div className="flex gap-3 h-full" style={{ minWidth: STATUS_GROUPS.length * 232 - 12 }}>
              {STATUS_GROUPS.map(status => (
                <KanbanColumn
                  key={status}
                  status={status}
                  items={grouped[status] ?? []}
                  dragging={dragging}
                  onDragStart={(app) => setDragging({ company: app.company, role: app.role, from: status })}
                  onDragEnd={() => setDragging(null)}
                  onDropOnColumn={() => handleDropOnColumn(status)}
                  renderCard={(app, isDragging) => (
                    <ApplicationCard
                      key={`${app.num}-${app.company}-${app.role}`}
                      app={app}
                      cue={status === 'Rejected' ? null : dateCue(app, listingDates[listingDateKey(app.company, app.role)])}
                      rejection={rejections.get(app) ?? null}
                      isDragging={isDragging}
                      onDragStart={() => setDragging({ company: app.company, role: app.role, from: status })}
                      onDragEnd={() => setDragging(null)}
                      onMove={(to) => moveTo(app, to)}
                      onEditRejection={() => editRejection(app)}
                      onRemove={() => setPendingDiscard(app)}
                      onViewReport={() => setReportFor(app)}
                    />
                  )}
                />
              ))}
            </div>
          )}
        </div>

        {/* Discarded applications — a collapsed strip so they stay auditable
            and reversible without cluttering the board. Deactivatable
            (Settings › General › Features); they stay in the Database. */}
        {closedLaneEnabled && (
          <ClosedApplicationsPanel apps={closedApps} onRestore={handleRestore} />
        )}

        <RunningInScanFooter />
      </div>

      {pendingDiscard && (
        <DiscardConfirmModal
          app={pendingDiscard}
          onConfirm={confirmDiscard}
          onCancel={() => setPendingDiscard(null)}
        />
      )}

      {rejection && (
        <RejectionDialog
          draft={rejection}
          onSave={saveRejection}
          onClose={() => setRejection(null)}
        />
      )}

      {reportFor && reportEntry && (
        <ReportSlideOver
          company={reportFor.company}
          role={reportFor.role}
          scoreEntry={reportEntry}
          onClose={() => setReportFor(null)}
        />
      )}
    </div>
  )
}

// ─── Rejection dialog ───────────────────────────────────────────────────────
// Asks only for the date (today by default, past dates allowed). The stage is
// inferred from the status it was rejected from and shown; one-click chips
// refine it, stored as the log row's `stage`. In edit mode the same dialog
// corrects an already-recorded rejection (only the status log changes).

function RejectionDialog({ draft, onSave, onClose }: {
  draft: RejectionDraft
  onSave: (d: RejectionDraft) => Promise<string | null>
  onClose: () => void
}) {
  const [date, setDate] = useState(draft.date)
  const [stage, setStage] = useState(draft.stage)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = todayIso()
  const options = useMemo(() => {
    const list = rejectionStageOptions(draft.from)
    // A stage set elsewhere (CLI, an older chip) stays pickable.
    return draft.stage && !list.includes(draft.stage) ? [draft.stage, ...list] : list
  }, [draft.from, draft.stage])
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today
  const unchanged = draft.mode === 'edit' && date === draft.date && stage === draft.stage

  const save = async () => {
    if (!dateOk || saving || unchanged) return
    setSaving(true)
    setError(null)
    const err = await onSave({ ...draft, date, stage })
    setSaving(false)
    if (err) setError(err)
    else onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const inferred = draft.from
    ? `${inferredRejectionLabel(draft.from)} (from ${draft.from})`
    : inferredRejectionLabel('')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/[0.32] backdrop-blur-[3px]"
      onClick={onClose}
      style={{ animation: 'chip-appear 160ms ease both' }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="rejection-title"
        onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); void save() }}
        className="w-[420px] rounded-xl bg-bg-base border border-border-default shadow-lift overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 space-y-4">
          <div className="flex items-start gap-3">
            <CompanyLogo company={draft.app.company} size={32} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 id="rejection-title" className="text-title text-text-1">
                {draft.mode === 'move' ? 'Mark as rejected' : 'Edit rejection'}
              </h3>
              <p className="text-label text-text-3 mt-1 truncate">
                <span className="font-medium text-text-2">{draft.app.company}</span> — {draft.app.role}
              </p>
            </div>
          </div>

          <label className="block">
            <span className="label block">Date</span>
            <input
              type="date"
              value={date}
              max={today}
              required
              autoFocus
              onChange={e => setDate(e.target.value)}
              className="input mt-1 w-44"
            />
            {!dateOk && date !== '' && (
              <span className="block text-label text-danger mt-1">The date can't be in the future.</span>
            )}
          </label>

          <div>
            <span className="label block">Stage</span>
            <p className="text-body text-text-2 mt-1">{stage || inferred}</p>
            <div className="flex flex-wrap gap-1.5 mt-2" role="group" aria-label="Refine the stage">
              {options.map(o => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={stage === o}
                  onClick={() => setStage(s => (s === o ? '' : o))}
                  className={cn(
                    'chip chip-md transition-colors duration-150 hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    stage === o && 'chip-accent',
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
            <p className="text-micro text-text-4 mt-2">
              Optional. With none picked, the stage is the one it was rejected from.
            </p>
          </div>

          {error && <p className="text-label text-danger">{error}</p>}
        </div>
        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-border-default">
          <Button tone="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            tone="primary"
            size="sm"
            type="submit"
            loading={saving}
            disabled={!dateOk || unchanged}
          >
            {draft.mode === 'move' ? 'Mark rejected' : 'Save'}
          </Button>
        </div>
      </form>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/[0.32] backdrop-blur-[3px]"
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
        <div className="px-5 py-3 flex items-center justify-end gap-2 border-t border-border-default">
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

// Shown when no application sits on the board. Replaces the row of empty
// columns (which reads as broken) with a short account of how rows get here:
// the Apply action on Database rows and report slide-overs.
function EmptyBoard({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-sm text-center px-6">
        <Briefcase size={40} strokeWidth={1.5} className="mx-auto mb-3 text-text-4" aria-hidden />
        <h3 className="text-section text-text-1">No applications yet</h3>
        <p className="text-label text-text-3 mt-1.5">
          When you Apply to a listing from the Database or a report, it lands here. Set its
          stage on the card as it moves, from Evaluated to Offer or Rejected.
        </p>
        <Button
          tone="primary"
          onClick={onBrowse}
          trailing={<ArrowRight size={14} />}
          className="mt-4"
        >
          Browse the Database
        </Button>
      </div>
    </div>
  )
}

// ─── Kanban ─────────────────────────────────────────────────────────────────

interface ColumnProps {
  status: AppStatus
  items: ApplicationEntry[]
  dragging: { company: string; role: string; from: AppStatus } | null
  onDragStart: (a: ApplicationEntry) => void
  onDragEnd: () => void
  onDropOnColumn: () => void
  renderCard: (a: ApplicationEntry, isDragging: boolean) => ReactNode
}

function KanbanColumn({ status, items, dragging, onDropOnColumn, renderCard }: ColumnProps) {
  const [hover, setHover] = useState(false)
  // Drop is meaningful only when something's being dragged AND it isn't
  // already in this column.
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
      aria-label={`${status}: ${items.length}`}
      className={cn(
        'rounded-lg bg-bg-panel/50 border border-border-default/60 flex flex-col flex-1 min-w-[220px] overflow-hidden h-full transition-colors duration-150',
        isDropTarget && hover && 'border-accent/60 bg-accent/[0.04]',
      )}
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border-default/60 shrink-0">
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_FILL[status])} aria-hidden />
        <span className="text-label font-medium text-text-2">{status}</span>
        <span className="text-label text-text-4 tabular-nums">{items.length}</span>
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
          items.map(app => renderCard(
            app,
            dragging?.company === app.company && dragging?.role === app.role,
          ))
        )}
      </div>
    </div>
  )
}

function ApplicationCard({
  app, cue, rejection, isDragging, onDragStart, onDragEnd, onMove, onEditRejection, onRemove, onViewReport,
}: {
  app: ApplicationEntry
  cue: DateCue | null
  rejection: RejectionInfo | null
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: AppStatus) => void
  onEditRejection: () => void
  onRemove: () => void
  onViewReport: () => void
}) {
  // Demo mode: the card reads normally, but every action that writes (stage,
  // drag, remove, edit rejection) is disabled.
  const { canWrite, readOnlyTitle } = useWriteGate()
  const score = useMemo(() => parseScoreCell(app.score), [app.score])

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
        'card group relative p-2.5 transition-colors duration-150 hover:border-border-strong',
        canWrite && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
      )}
    >
      {/* Remove — top-right, fades in on hover. Confirms before marking the
          row Discarded so the card can't disappear by accident. */}
      <Button
        tone="ghost"
        size="xs"
        iconOnly
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        onPointerDown={(e) => e.stopPropagation()}
        disabled={!canWrite}
        title={readOnlyTitle ?? 'Remove from Applying'}
        aria-label="Remove from Applying"
        icon={<X size={12} />}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"
      />
      <div className="flex items-start gap-2 pr-6">
        <CompanyLogo company={app.company} size={24} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-text-1 truncate leading-tight" title={app.company}>
            {app.company}
          </div>
          <div className="text-label text-text-3 truncate mt-0.5" title={app.role}>{app.role}</div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-2 gap-2 min-h-5">
        {score && 'want' in score
          ? <WantEase want={score.want} ease={score.ease} size="sm" decimals={1} />
          : <ScoreNumber value={score && 'legacy' in score ? score.legacy : null} size="sm" />}
        {cue && <DateCueLabel cue={cue} emphasize={app.status === 'Evaluated'} />}
      </div>

      {rejection && (
        <div className="flex items-center gap-1 mt-1.5 min-w-0">
          <p className="text-label text-text-3 truncate flex-1 min-w-0" title={rejection.date ? `Rejected on ${rejection.date}, ${rejection.label}` : `Rejected, date not recorded, ${rejection.label}`}>
            {rejection.date ? shortDate(rejection.date) : 'No date'} · {rejection.label}
          </p>
          <Button
            tone="ghost"
            size="xs"
            iconOnly
            onClick={(e) => { e.stopPropagation(); onEditRejection() }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!canWrite}
            title={readOnlyTitle ?? 'Edit the rejection date or stage'}
            aria-label="Edit the rejection date or stage"
            icon={<Pencil size={12} />}
            className="shrink-0"
          />
        </div>
      )}

      <div className="flex items-center gap-1 mt-2 -mb-0.5 -ml-2">
        <StatusDropdown
          current={app.status}
          busy={false}
          onChange={onMove}
          size="xs"
          quiet
          statuses={BOARD_STAGES}
          readOnlyTitle={readOnlyTitle}
        />
        <span className="flex-1" />
        <FilesStrip company={app.company} role={app.role} size="sm" />
        <Button
          tone="ghost"
          size="xs"
          iconOnly
          onClick={(e) => { e.stopPropagation(); onViewReport() }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Open the report"
          aria-label="Open the report"
          icon={<ScrollText size={13} />}
          className="-mr-1"
        />
      </div>
    </div>
  )
}

// The card's one date: a small icon says which (closes / posted / first
// scanned), the label says how far ("12d"), the tooltip says the rest. Only a
// deadline within a week takes a colour, and only on a card not yet sent.
function DateCueLabel({ cue, emphasize }: { cue: DateCue; emphasize: boolean }) {
  const Icon = CUE_ICON[cue.kind]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-label tabular-nums shrink-0',
        cue.soon && emphasize ? 'text-warning-text' : 'text-text-3',
      )}
      title={cue.title}
      aria-label={cue.title}
    >
      <Icon size={12} className="shrink-0" aria-hidden />
      {cue.label}
    </span>
  )
}
