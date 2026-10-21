'use client'

import { useEffect, useRef } from 'react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useWriteGate } from '@/store/dataRoot'
import { livenessOf } from '@/lib/databaseRows'
import { resolveReport } from '@/lib/reportMatch'
import { reportPrompt, reportSpawnId } from '@/lib/reportSpawn'
import { useSpawnsStore } from '@/store/spawns'
import { ApplyAction } from './ApplyAction'
import { CompanyLogo } from './CompanyLogo'
import { FileText, ExternalLink, Sparkles, GraduationCap, X, FileOutput } from 'lucide-react'
import { MatchEase } from '@/components/shared/MatchEase'
import { VerdictChip } from '@/components/shared/EligibilityChip'
import { blockedReason, isBlocked, verdictOf } from '@/lib/scoreBands'
import { clsx } from 'clsx'
import { Button, Chip, type ChipTone } from '@/components/ui'
import type { ScoreEntry } from '@/types'

const POPOVER_WIDTH = 280

// Liveness → chip tone. Liveness is process state, so it may carry the
// semantic hues (live = green, going stale = amber, closed = muted).
const LIVENESS_CHIP: Record<'active' | 'stale' | 'closed', { tone: ChipTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  stale:  { tone: 'warning', label: 'Stale' },
  closed: { tone: 'muted',   label: 'Closed' },
}

interface Props {
  entry: ScoreEntry
  anchor: { x: number; y: number }
  onClose: () => void
  onViewReport: () => void
}

export function RowActionPopover({ entry, anchor, onClose, onViewReport }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Demo mode: reading (view report, open listing) stays; every action that
  // spawns work or writes a tracker is shown disabled with the reason.
  const { canWrite, readOnlyTitle } = useWriteGate()

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // Defer attaching the click handler so the same click that opened the
    // popover doesn't immediately close it.
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown)
    }, 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Position: anchor is the click coord. Clamp so the popover stays within
  // the viewport. Prefer below the click; flip up if not enough room.
  const vw = typeof window !== 'undefined' ? window.innerWidth  : 1440
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900
  const estHeight = 320
  const left = Math.min(Math.max(8, anchor.x - POPOVER_WIDTH / 2), vw - POPOVER_WIDTH - 8)
  const top  = anchor.y + estHeight + 12 > vh
    ? Math.max(8, anchor.y - estHeight - 12)
    : anchor.y + 12

  const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null
  // Resolve liveness through the SAME helper the table row uses (livenessOf),
  // which defaults to 'active' for listings absent from the scan-history map.
  // Reading the map directly used to return `undefined` for any listing whose
  // score-history role didn't string-match a scanned title (every manually-added
  // listing, e.g. one added via "+ Add listing"), and `undefined !== 'active'`
  // flipped Generate Report to the disabled "expired" state — even though the
  // table showed the very same row as active. Going through livenessOf makes the
  // popover and the table structurally unable to disagree.
  const liveness = useDataStore(s => livenessOf(entry, s.liveness))
  // Does a report file already exist for this entry? If so, hide the
  // Generate-report option — re-running it would just rewrite what's there.
  // Same resolver as the report panel (lib/reportMatch): tracker link, then
  // the file-name rule, so "… (Lyon)" finds "… Lyon.md".
  const hasReport = useDataStore(s =>
    resolveReport(s.reports, entry, [...s.scouting, ...s.applications]) != null,
  )

  // This listing's own report run, if one is going (other listings' runs don't matter).
  const reportRunning = useSpawnsStore(s => s.spawns[reportSpawnId(entry)]?.status === 'running')

  const live = liveness ? LIVENESS_CHIP[liveness] : undefined

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 rounded-xl border border-border-default bg-bg-base shadow-menu"
      style={{ left, top, width: POPOVER_WIDTH, animation: 'chip-appear 160ms ease both' }}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5 border-b border-border-default">
        <CompanyLogo company={entry.company} size={28} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight text-text-1 truncate" title={entry.company}>{entry.company}</div>
          <div className="text-label text-text-3 truncate" title={entry.role}>{entry.role}</div>
          {/* Wraps instead of squeezing: MatchEase never shrinks, so a fixed
              width let the liveness chip sit on top of the Ease number. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 mt-1.5">
            <VerdictChip verdict={verdictOf(entry)} />
            <MatchEase match={entry.match} ease={entry.ease} size="sm" blockedReason={isBlocked(entry) ? blockedReason(entry) : null} className="min-w-0 max-w-full" />
            {live && <Chip tone={live.tone}>{live.label}</Chip>}
          </div>
        </div>
        <Button
          tone="ghost"
          size="xs"
          iconOnly
          onClick={onClose}
          className="shrink-0 -mt-1 -mr-1"
          aria-label="Close"
          icon={<X size={13} aria-hidden />}
        />
      </div>

      {/* Apply + URL row — primary actions live here, side by side, so
          opening the listing's source page is one click away from Apply. */}
      <div className="px-3 py-2.5 border-b border-border-default flex items-center gap-2">
        <ApplyAction company={entry.company} role={entry.role} scoreEntry={entry} size="sm" />
        {url && (
          <Button
            tone="secondary"
            size="sm"
            icon={<ExternalLink size={13} aria-hidden />}
            onClick={() => { ipc.openExternal(url); onClose() }}
            title="Open job posting"
          >
            Open listing
          </Button>
        )}
      </div>

      {/* Action list */}
      <div className="p-1">
        <Item
          icon={FileText}
          label="View full report"
          onClick={() => { onViewReport(); onClose() }}
        />
        {/* Generate Report — only when (a) the listing is still live AND
            (b) no report already exists. Once a report is on disk, the
            "View full report" item above covers it; re-running would
            just rewrite the same file. */}
        {!hasReport && liveness === 'active' && (reportRunning ? (
          <ItemDisabled icon={FileOutput} label="Generating report…" tooltip="This listing's report is being written; see Activity" note="Running" />
        ) : canWrite ? (
          <Item
            icon={FileOutput}
            label="Generate report"
            onClick={() => { spawnReport(entry); onClose() }}
          />
        ) : (
          <ItemDisabled icon={FileOutput} label="Generate report" tooltip={readOnlyTitle ?? ''} note="Read-only" />
        ))}
        {!hasReport && liveness !== 'active' && (
          <ItemDisabled
            icon={FileOutput}
            label="Generate report"
            tooltip="Listing expired — report not available"
          />
        )}
        {canWrite ? (
          <>
            <Item
              icon={Sparkles}
              label="Tailor CV"
              onClick={() => { spawnPerListing('Tailor CV', 'modes/pdf.md', entry, 'tailorCv'); onClose() }}
            />
            <Item
              icon={GraduationCap}
              label="Prep application"
              onClick={() => { spawnPerListing('Prep Application', 'modes/interview-prep.md', entry, 'interviewPrep'); onClose() }}
            />
            <div className="my-1 mx-1 border-t border-border-default" />
            <Item
              icon={X}
              label="Mark not interested"
              tone="muted"
              onClick={async () => {
                // Tombstone the listing so it disappears from Database/Scouting
                // views. If it already exists in applications.md (post-apply),
                // discardListing also flips that row's status to SKIP so the
                // application record stays — see store/data.ts.
                await useDataStore.getState().discardListing(entry.company, entry.role)
                onClose()
              }}
            />
          </>
        ) : (
          <>
            <ItemDisabled icon={Sparkles} label="Tailor CV" tooltip={readOnlyTitle ?? ''} note="Read-only" />
            <ItemDisabled icon={GraduationCap} label="Prep application" tooltip={readOnlyTitle ?? ''} note="Read-only" />
            <div className="my-1 mx-1 border-t border-border-default" />
            <ItemDisabled icon={X} label="Mark not interested" tooltip={readOnlyTitle ?? ''} note="Read-only" />
          </>
        )}
      </div>
    </div>
  )
}

function Item({
  icon: Icon, label, onClick, tone = 'default',
}: {
  icon: React.ElementType
  label: string
  onClick: () => void
  tone?: 'default' | 'muted'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'group w-full h-8 flex items-center gap-2.5 px-2 rounded text-body text-left transition-colors duration-150',
        'focus-visible:bg-bg-elevated',
        tone === 'muted'
          ? 'text-text-3 hover:text-danger hover:bg-danger/5'
          : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
      )}
    >
      <Icon
        size={14}
        className={clsx('shrink-0', tone === 'muted' ? 'text-current' : 'text-text-3 group-hover:text-text-2')}
        aria-hidden
      />
      <span className="truncate">{label}</span>
    </button>
  )
}

function ItemDisabled({
  icon: Icon, label, tooltip, note = 'Listing expired',
}: {
  icon: React.ElementType
  label: string
  tooltip: string
  /** Right-aligned reason; defaults to the expired-listing case. */
  note?: string
}) {
  return (
    <div
      title={tooltip}
      aria-disabled="true"
      className="w-full h-8 flex items-center gap-2.5 px-2 rounded text-body text-left text-text-4 cursor-not-allowed select-none"
    >
      <Icon size={14} className="shrink-0 text-text-4" aria-hidden />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-label text-text-4 shrink-0">{note}</span>
    </div>
  )
}

function spawnPerListing(
  label: string,
  modeFile: string,
  entry: ScoreEntry,
  category: 'tailorCv' | 'draftApp' | 'interviewPrep',
) {
  // Lazy imports avoid circular deps with the spawn + app stores. The
  // category looks up the user's per-feature model preference at the
  // moment of click, so a Settings change is picked up immediately.
  Promise.all([import('@/store/spawns'), import('@/store/app')]).then(
    ([{ useSpawnsStore, claudeArgs }, { useAppStore }]) => {
      const id = `popover-${modeFile.replace(/[^\w]+/g, '-')}`
      const { spawns, start, clear } = useSpawnsStore.getState()
      if (spawns[id]?.status === 'running') return
      if (spawns[id]) clear(id)
      const mode = modeFile.replace(/^modes\//, '').replace(/\.md$/, '')
      const slash = `/career-ops ${mode} for ${entry.company} — ${entry.role}`
      const model = useAppStore.getState().models[category]
      start(id, `${label}: ${entry.company}`, 'claude', claudeArgs(slash, model, 'apply-flow'))
    },
  )
}

function spawnReport(entry: ScoreEntry) {
  Promise.all([import('@/store/spawns'), import('@/store/app')]).then(
    ([{ useSpawnsStore, claudeArgs }, { useAppStore }]) => {
      // One spawn per listing (lib/reportSpawn): other listings' reports keep
      // running; only this listing's own run blocks a second click.
      const id = reportSpawnId(entry)
      const { spawns, start, clear } = useSpawnsStore.getState()
      if (spawns[id]?.status === 'running') return
      if (spawns[id]) clear(id)
      const model = useAppStore.getState().models.generateReport
      start(id, `Generate Report: ${entry.company} — ${entry.role}`, 'claude', claudeArgs(reportPrompt(entry), model, 'eval-app'))
    },
  )
}
