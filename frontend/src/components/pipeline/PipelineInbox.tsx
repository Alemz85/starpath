'use client'

import { useMemo } from 'react'
import { Inbox, ExternalLink, Sparkles, AlertCircle, Clock, Loader2, RotateCcw } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import {
  buildInbox, inboxStats, inboxSpawnId,
  type InboxItem, type InboxReason,
} from '@/lib/pipelineInbox'
import { type SpawnRecord } from '@/store/spawns'
import type { PipelineUrl, ApplicationEntry, ScoutingEntry } from '@/types'

// The Inbox is the Pipeline view's triage queue: every pending job URL in
// data/pipeline.md that hasn't been scored yet, ordered so the freshest unknown
// listings (the real work) float to the top. Each row offers the two
// lane-safe affordances — Evaluate (spawns the scouting pipeline on that one
// URL) and Open (the listing in the browser). Bucketing + ordering is pure
// (lib/pipelineInbox); this component only renders + wires the side effects.

const REASON_CHIP: Record<InboxReason, { label: string; cls: string }> = {
  new:       { label: 'New',     cls: 'text-accent bg-accent-soft' },
  known:     { label: 'Known',   cls: 'text-text-3 bg-bg-elevated' },
  evaluated: { label: 'Scored',  cls: 'text-text-4 bg-bg-elevated' },
  invalid:   { label: 'Invalid', cls: 'text-danger bg-danger/10' },
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
    <section className="flex min-h-0 flex-col rounded-lg border border-border-default bg-bg-base overflow-hidden">
      <header className="flex items-center gap-2.5 px-3.5 h-11 border-b border-border-default shrink-0">
        <Inbox size={15} className="text-accent" />
        <h2 className="text-[13px] font-semibold text-text-2">Inbox</h2>
        <span className="text-micro text-text-4 uppercase tracking-wider">to triage</span>
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
    <div className="flex items-center gap-1.5 text-[10.5px] font-mono">
      {stats.fresh > 0 && (
        <span className="text-accent" title="Fresh, unknown URLs awaiting a first look">
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
        <span className="text-danger/80" title="Malformed pipeline.md lines to clean up">
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
  const running = spawn?.status === 'running'
  const done = spawn?.status === 'done'
  const invalid = item.reason === 'invalid'

  return (
    <li className="group flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-bg-elevated transition-colors">
      {item.companyHint
        ? <CompanyLogo company={item.companyHint} size={22} className="shrink-0" />
        : <span className="shrink-0 grid place-items-center w-[22px] h-[22px] rounded-md bg-bg-panel text-text-4">
            <AlertCircle size={12} />
          </span>}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-text-2 truncate leading-tight">
            {item.companyHint ?? 'Unrecognized URL'}
          </span>
          {item.isStale && !invalid && (
            <span className="inline-flex items-center gap-0.5 text-[9.5px] text-text-4" title="Old posting — likely closed">
              <Clock size={9} /> stale
            </span>
          )}
        </div>
        <span className="block text-[10.5px] text-text-4 truncate leading-tight">
          {item.title
            ? <>{item.title} <span className="font-mono text-text-4/70">· {item.source}</span></>
            : <span className="font-mono">{item.source || item.url}</span>}
        </span>
      </div>

      {!invalid && (
        <span
          className={cn(
            'shrink-0 font-mono text-[10.5px] tabular-nums',
            item.triageScore >= 3 ? 'text-accent' : item.triageScore < 0 ? 'text-text-4' : 'text-text-3',
          )}
          title={`Triage score — ${item.scoreReasons.join('; ')}`}
        >
          {item.triageScore.toFixed(1)}
        </span>
      )}

      <span className={cn(
        'shrink-0 px-1.5 h-[18px] inline-flex items-center rounded-pill text-[9.5px] font-medium uppercase tracking-wide',
        chip.cls,
      )}>
        {chip.label}
      </span>

      <div className="shrink-0 flex items-center gap-1">
        {!invalid && (
          <button
            onClick={onEvaluate}
            disabled={running}
            title={running ? 'Evaluation running…' : done ? 'Re-evaluate this listing' : 'Score this listing through the scouting pipeline'}
            className={cn(
              'inline-flex items-center gap-1 px-2 h-6 rounded-pill text-[10.5px] transition-all',
              running
                ? 'text-accent bg-accent-soft cursor-default'
                : 'text-text-4 opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10',
            )}
          >
            {running
              ? <><Loader2 size={10} className="animate-spin" /> Scoring…</>
              : done
                ? <><RotateCcw size={10} /> Re-score</>
                : <><Sparkles size={10} /> Evaluate</>}
          </button>
        )}
        {!invalid && (
          <button
            onClick={() => ipc.openExternal(item.url)}
            title="Open the listing in your browser"
            className="inline-flex items-center justify-center w-6 h-6 rounded-pill text-text-4 opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10 transition-all"
          >
            <ExternalLink size={11} />
          </button>
        )}
      </div>
    </li>
  )
}

function EmptyInbox() {
  return (
    <div className="flex-1 grid place-items-center p-8">
      <div className="text-center max-w-[18rem]">
        <div className="mx-auto mb-3 grid place-items-center w-11 h-11 rounded-full bg-bg-panel">
          <Inbox size={18} className="text-text-4" />
        </div>
        <p className="text-[13px] text-text-2 font-medium">Inbox zero</p>
        <p className="mt-1 text-[11.5px] text-text-3 leading-snug">
          No pending URLs to triage. New listings land here from a scan or when you add one —
          evaluate them to send them down the pipeline.
        </p>
      </div>
    </div>
  )
}
