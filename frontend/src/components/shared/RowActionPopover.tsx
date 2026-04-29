'use client'

import { useEffect, useRef } from 'react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { ApplyAction } from './ApplyAction'
import { CompanyLogo } from './CompanyLogo'
import { FileText, ExternalLink, Sparkles, GraduationCap, X, FileOutput } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ScoreEntry, AppStatus } from '@/types'

const POPOVER_WIDTH = 280

interface Props {
  entry: ScoreEntry
  anchor: { x: number; y: number }
  onClose: () => void
  onViewReport: () => void
}

export function RowActionPopover({ entry, anchor, onClose, onViewReport }: Props) {
  const ref = useRef<HTMLDivElement>(null)

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
  const livenessKey = `${entry.company.trim().toLowerCase()}|${entry.role.trim().toLowerCase()}`
  const liveness = useDataStore(s => s.liveness[livenessKey])
  // Does a report file already exist for this entry? If so, hide the
  // Generate-report option — re-running it would just rewrite what's there.
  const hasReport = useDataStore(s => s.reports).some(r =>
    r.company.trim().toLowerCase() === entry.company.trim().toLowerCase() &&
    r.role.trim().toLowerCase() === entry.role.trim().toLowerCase()
  )

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 rounded-lg border border-border-strong bg-bg-base shadow-lift overflow-hidden"
      style={{ left, top, width: POPOVER_WIDTH, animation: 'chip-appear 160ms ease both' }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-3 py-2.5 border-b border-border-default">
        <CompanyLogo company={entry.company} size={26} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-label text-text-1 font-medium truncate">{entry.company}</div>
          <div className="text-[11px] text-text-3 truncate">{entry.role}</div>
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-text-4 font-mono">
            <span>{entry.tier === 'T2-high' ? 'T2+' : entry.tier}</span>
            {entry.overall > 0 && <><span>·</span><span>{entry.overall.toFixed(1)}/10</span></>}
            {liveness && <><span>·</span><span className={cn(
              liveness === 'active' ? 'text-success' :
              liveness === 'stale'  ? 'text-warning' : 'text-text-4',
            )}>{liveness}</span></>}
          </div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 p-1 -mt-0.5 -mr-1 rounded text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </div>

      {/* Apply + URL row — primary actions live here, side by side, so
          opening the listing's source page is one click away from Apply. */}
      <div className="px-3 py-2.5 border-b border-border-default flex items-center gap-2">
        <ApplyAction company={entry.company} role={entry.role} scoreEntry={entry} size="sm" />
        {url && (
          <button
            onClick={() => { ipc.openExternal(url); onClose() }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[11.5px] transition-colors"
            title="Open job posting"
          >
            <ExternalLink size={11} />
            URL
          </button>
        )}
      </div>

      {/* Action list */}
      <div className="py-1">
        <Item
          icon={FileText}
          label="View full report"
          onClick={() => { onViewReport(); onClose() }}
        />
        {/* Generate Report — only when (a) the listing is still live AND
            (b) no report already exists. Once a report is on disk, the
            "View full report" item above covers it; re-running would
            just rewrite the same file. */}
        {!hasReport && liveness === 'active' && (
          <Item
            icon={FileOutput}
            label="Generate report"
            onClick={() => { spawnReport(entry); onClose() }}
          />
        )}
        {!hasReport && liveness !== 'active' && (
          <ItemDisabled
            icon={FileOutput}
            label="Generate report"
            tooltip="Listing expired — report not available"
          />
        )}
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
        <div className="my-1 border-t border-border-default" />
        <Item
          icon={X}
          label="Mark not interested"
          tone="muted"
          onClick={async () => {
            await useDataStore.getState().promoteToApplication({
              company: entry.company,
              role: entry.role,
              overall: entry.overall,
              tier: entry.tier,
            })
            await useDataStore.getState().setApplicationStatus(entry.company, entry.role, 'SKIP' as AppStatus)
            onClose()
          }}
        />
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
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors',
        tone === 'muted' ? 'text-text-4 hover:text-danger hover:bg-danger/5' : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
      )}
    >
      <Icon size={13} className="shrink-0 opacity-80" />
      <span className="truncate">{label}</span>
    </button>
  )
}

function ItemDisabled({
  icon: Icon, label, tooltip,
}: {
  icon: React.ElementType
  label: string
  tooltip: string
}) {
  return (
    <div
      title={tooltip}
      aria-disabled="true"
      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left text-text-4 opacity-50 cursor-not-allowed select-none"
    >
      <Icon size={13} className="shrink-0 opacity-70" />
      <span className="truncate">{label}</span>
      <span className="ml-auto text-[10px] text-text-4 italic shrink-0">expired</span>
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
      start(id, `${label}: ${entry.company}`, 'claude', claudeArgs(slash, model))
    },
  )
}

function spawnReport(entry: ScoreEntry) {
  Promise.all([import('@/store/spawns'), import('@/store/app')]).then(
    ([{ useSpawnsStore, claudeArgs }, { useAppStore }]) => {
      const id = 'popover-generate-report'
      const { spawns, start, clear } = useSpawnsStore.getState()
      if (spawns[id]?.status === 'running') return
      if (spawns[id]) clear(id)
      // Run the unified evaluation mode (`modes/scouting.md`) and write
      // the per-listing report file. Use the source URL when available so
      // the mode can re-fetch the JD; otherwise fall back to a
      // company+role prompt pulled from the existing data/scouting.md row.
      const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : null
      const slash = url
        ? `/career-ops scouting ${url} — write the per-listing report under reports/tier-N/{Company} - {Role}.md following the Tier-1 deep template in modes/scouting.md § "Full Report Format". Reuse the existing data/scouting.md row's score if present.`
        : `/career-ops scouting for ${entry.company} — ${entry.role} — write the per-listing report under reports/tier-N/ following the Tier-1 deep template in modes/scouting.md. The listing already exists in data/scouting.md; reuse its score.`
      const model = useAppStore.getState().models.generateReport
      start(id, `Generate Report: ${entry.company}`, 'claude', claudeArgs(slash, model))
    },
  )
}
