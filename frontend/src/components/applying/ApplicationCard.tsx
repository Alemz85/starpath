'use client'

import { useMemo, type ReactNode } from 'react'
import { CalendarClock, CalendarPlus, Pencil, Radar, ScrollText, X } from 'lucide-react'
import { useWriteGate } from '@/store/dataRoot'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { FilesStrip } from '@/components/shared/FilesStrip'
import { StatusDropdown } from '@/components/shared/ApplyAction'
import { WantEase } from '@/components/shared/WantEase'
import { Button, ScoreNumber, StatusChip } from '@/components/ui'
import { cn } from '@/lib/utils'
import { parseScoreCell } from '@/lib/scoreBands'
import { stagesFor, type RejectionInfo } from '@/lib/applyingBoard'
import type { DateCue, DateCueKind } from '@/lib/listingDates'
import type { AppStatus, ApplicationEntry } from '@/types'

// Which date a card's cue shows, by icon: closes, posted, first scanned.
const CUE_ICON: Record<DateCueKind, typeof CalendarClock> = {
  deadline: CalendarClock,
  posted:   CalendarPlus,
  scanned:  Radar,
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "14 Sep", with the year only when it isn't this year ("14 Sep 2025"). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return y === new Date().getFullYear() ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * One application as the Applying board shows it: logo, company and role,
 * Want · Ease, the date cue, the rejection line, and a footer with the stage,
 * files and report.
 *
 * The board passes every handler. Anywhere else (a chat card) leaves the
 * board-only ones out: no drag, no remove, no rejection edit, and the stage
 * reads as a chip instead of a dropdown when `onMove` is absent.
 */
export function ApplicationCard({
  app, cue, rejection, isDragging = false, onDragStart, onDragEnd, onMove, onEditRejection, onRemove, onViewReport,
  footer, className,
}: {
  app: ApplicationEntry
  cue: DateCue | null
  rejection: RejectionInfo | null
  isDragging?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onMove?: (to: AppStatus) => void
  onEditRejection?: () => void
  onRemove?: () => void
  onViewReport?: () => void
  /** Extra row under the card's footer (chat actions). */
  footer?: ReactNode
  className?: string
}) {
  // Demo mode: the card reads normally, but every action that writes (stage,
  // drag, remove, edit rejection) is disabled.
  const { canWrite, readOnlyTitle } = useWriteGate()
  const score = useMemo(() => parseScoreCell(app.score), [app.score])
  const draggable = canWrite && !!onDragStart

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart && ((e) => {
        // Native drag needs *some* dataTransfer payload to fire drop events
        // reliably across platforms — Electron on macOS otherwise silently
        // ignores the drop. The actual move target comes from React state.
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', `${app.company}|${app.role}`) } catch { /* noop */ }
        onDragStart()
      })}
      onDragEnd={onDragEnd}
      className={cn(
        'card group relative p-2.5 transition-colors duration-150 hover:border-border-strong',
        draggable && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        className,
      )}
    >
      {/* Remove — top-right, fades in on hover. Confirms before marking the
          row Discarded so the card can't disappear by accident. */}
      {onRemove && (
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
      )}
      <div className={cn('flex items-start gap-2', onRemove && 'pr-6')}>
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
          {onEditRejection && (
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
          )}
        </div>
      )}

      <div className="flex items-center gap-1 mt-2 -mb-0.5 -ml-2">
        {onMove ? (
          <StatusDropdown
            current={app.status}
            busy={false}
            onChange={onMove}
            size="xs"
            quiet
            statuses={stagesFor(app.status)}
            readOnlyTitle={readOnlyTitle}
          />
        ) : (
          <StatusChip status={app.status} className="ml-2" />
        )}
        <span className="flex-1" />
        <FilesStrip company={app.company} role={app.role} size="sm" />
        {onViewReport && (
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
        )}
      </div>

      {footer}
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
