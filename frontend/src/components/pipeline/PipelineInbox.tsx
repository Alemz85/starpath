'use client'

import { useMemo } from 'react'
import { Inbox, ExternalLink, Sparkles, AlertCircle, Clock, Loader2, RotateCcw } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { Button, Chip, type ChipTone } from '@/components/ui'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import {
  buildInbox, inboxStats, inboxSpawnId,
  type InboxItem, type InboxReason,
} from '@/lib/pipelineInbox'
import { type SpawnRecord } from '@/store/spawns'
import { useWriteGate } from '@/store/dataRoot'
import type { PipelineUrl, ApplicationEntry, ScoutingEntry } from '@/types'

// The Inbox is the Pipeline view's triage queue: every pending job URL in
// data/pipeline.md that hasn't been scored yet, ordered so the freshest unknown
// listings (the real work) float to the top. Each row offers the two
// lane-safe affordances — Evaluate (spawns the scouting pipeline on that one
// URL) and Open (the listing in the browser). Bucketing + ordering is pure
// (lib/pipelineInbox); this component only renders + wires the side effects.

const REASON_CHIP: Record<InboxReason, { label: string; tone: ChipTone }> = {
  new:       { label: 'New',     tone: 'accent' },
  known:     { label: 'Known',   tone: 'neutral' },
  evaluated: { label: 'Scored',  tone: 'muted' },
  invalid:   { label: 'Invalid', tone: 'danger' },
}

export function PipelineInbox({
  pending, applications, scouting, spawns, onEvaluate,
}: {
  pending: PipelineUrl[]
  applications: ApplicationEntry[]
  scouting: ScoutingEntry[]
  spawns: Record<string, SpawnRecord>
  /** Launch the scouting pipeline for a single inbox URL. Wired to the spawn
   *  store by the parent so this stays presentational. */
  onEvaluate: (url: string) => void
}) {
  const items = useMemo(
    () => buildInbox(pending, applications, scouting),
    [pending, applications, scouting],
  )
  const stats = useMemo(() => inboxStats(items), [items])

  return (
    <section className="card flex min-h-0 flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-3 h-10 border-b border-border-default shrink-0">
        <h2 className="label">Inbox</h2>
        <span className="text-label text-text-4">to triage</span>
        <span className="flex-1" />
        <InboxCounts stats={stats} />
      </header>

      {items.length === 0 ? (
        <EmptyInbox />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {items.map((item) => (
            <InboxRow
              key={item.url}
              item={item}
              spawn={spawns[inboxSpawnId(item.url)]}
              onEvaluate={() => onEvaluate(item.url)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function InboxCounts({ stats }: { stats: ReturnType<typeof inboxStats> }) {
  if (stats.total === 0) return null
  return (
    <div className="flex items-center gap-1 text-label tabular-nums">
      {stats.fresh > 0 && (
        <span className="text-accent-text" title="Fresh, unknown URLs awaiting a first look">
          {stats.fresh} fresh
        </span>
      )}
      {stats.known > 0 && (
        <span className="text-text-4" title="URLs from a company you've already evaluated">
          · {stats.known} known
        </span>
      )}
      {stats.stale > 0 && (
        <span className="text-text-4" title="Old / likely-closed postings">
          · {stats.stale} stale
        </span>
      )}
      {stats.invalid > 0 && (
        <span className="text-danger" title="Malformed pipeline.md lines to clean up">
          · {stats.invalid} invalid
        </span>
      )}
    </div>
  )
}

function InboxRow({
  item, spawn, onEvaluate,
}: {
  item: InboxItem
  spawn: SpawnRecord | undefined
  onEvaluate: () => void
}) {
  const chip = REASON_CHIP[item.reason]
  const { canWrite, readOnlyTitle } = useWriteGate()
  const running = spawn?.status === 'running'
  const done = spawn?.status === 'done'
  const invalid = item.reason === 'invalid'

  return (
    <li className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-elevated transition-colors duration-150">
      {item.companyHint
        ? <CompanyLogo company={item.companyHint} size={20} className="shrink-0" />
        : <span className="shrink-0 grid place-items-center w-5 h-5 rounded bg-bg-panel text-text-4">
            <AlertCircle size={12} />
          </span>}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-label font-medium text-text-1 truncate">
            {item.companyHint ?? 'Unrecognized URL'}
          </span>
          {item.isStale && !invalid && (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-label text-text-4" title="Old posting — likely closed">
              <Clock size={12} /> Stale
            </span>
          )}
        </div>
        <span className="block text-label text-text-3 truncate">
          {item.title
            ? <>{item.title} <span className="font-mono text-text-4">· {item.source}</span></>
            : <span className="font-mono text-text-4">{item.source || item.url}</span>}
        </span>
      </div>

      {!invalid && (
        <span
          className={cn(
            'shrink-0 text-label tabular-nums',
            item.triageScore >= 3 ? 'text-accent-text font-medium' : item.triageScore < 0 ? 'text-text-4' : 'text-text-3',
          )}
          title={`Triage score — ${item.scoreReasons.join('; ')}`}
        >
          {item.triageScore.toFixed(1)}
        </span>
      )}

      <Chip tone={chip.tone} size="sm" className="shrink-0">{chip.label}</Chip>

      <div className="shrink-0 flex items-center gap-0.5">
        {!invalid && (
          <Button
            tone="tinted"
            size="xs"
            onClick={onEvaluate}
            disabled={running || !canWrite}
            title={readOnlyTitle ?? (running ? 'Evaluation running…' : done ? 'Re-evaluate this listing' : 'Score this listing through the scouting pipeline')}
            icon={running
              ? <Loader2 size={12} className="animate-spin" />
              : done ? <RotateCcw size={12} /> : <Sparkles size={12} />}
            className={cn(
              running
                // In flight: stays visible and undimmed; the click is inert.
                ? 'disabled:opacity-100 disabled:cursor-default'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            {running ? 'Scoring…' : done ? 'Re-score' : 'Evaluate'}
          </Button>
        )}
        {!invalid && (
          <Button
            tone="ghost"
            size="xs"
            iconOnly
            onClick={() => ipc.openExternal(item.url)}
            title="Open the listing in your browser"
            aria-label="Open the listing in your browser"
            icon={<ExternalLink size={12} />}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          />
        )}
      </div>
    </li>
  )
}

function EmptyInbox() {
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="text-center max-w-[18rem]">
        <Inbox size={24} strokeWidth={1.5} className="mx-auto mb-2.5 text-text-4" aria-hidden />
        <p className="text-section text-text-1">Inbox zero</p>
        <p className="mt-1 text-label text-text-3">
          No pending URLs to triage. New listings land here from a scan or when you add one —
          evaluate them to send them down the pipeline.
        </p>
      </div>
    </div>
  )
}
