'use client'

import { useMemo } from 'react'
import { ExternalLink, ChevronRight } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ipc } from '@/lib/ipc'
import { cn, deadlineLabel, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_GROUPS, groupByStatus, nextStage } from '@/lib/applyingBoard'
import { STATUS_COLORS, type AppStatus, type ApplicationEntry } from '@/types'

// The status board is the Pipeline view's second half: a compact, columnar read
// of where every active application stands (Evaluated → Offer). It deliberately
// stays lighter than the Applying cockpit — no per-card CV/draft/prep spawns —
// because its job here is orientation ("what's where?") plus one-click stage
// advance via the same applications.md status writeback the rest of the app
// uses. Bucketing + ordering is pure (lib/applyingBoard.groupByStatus); the
// view passes in the writeback handler.

const COLUMN_ACCENT: Record<AppStatus, string> = {
  Evaluated: 'bg-info',
  Applied:   'bg-accent',
  Responded: 'bg-accent',
  Interview: 'bg-warning',
  Offer:     'bg-success',
  Rejected:  'bg-text-4',
  Discarded: 'bg-text-4',
  SKIP:      'bg-text-4',
}

export function PipelineBoard({
  applications, onAdvance,
}: {
  applications: ApplicationEntry[]
  /** Move a card to the next funnel stage via the status writeback. */
  onAdvance: (app: ApplicationEntry, to: AppStatus) => void
}) {
  const grouped = useMemo(() => groupByStatus(applications), [applications])
  const activeCount = STATUS_GROUPS.reduce((n, s) => n + (grouped[s]?.length ?? 0), 0)

  if (activeCount === 0) {
    return (
      <section className="flex-1 grid place-items-center rounded-lg border border-border-default bg-bg-base p-10">
        <div className="text-center max-w-[20rem]">
          <p className="text-[13px] text-text-2 font-medium">No active applications yet</p>
          <p className="mt-1 text-[11.5px] text-text-3 leading-snug">
            Once you apply to a listing it appears here, moving across the stages from
            Evaluated through to Offer as you progress.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="min-h-0 flex-1 overflow-x-auto">
      <div className="flex gap-3 min-w-max h-full pb-1">
        {STATUS_GROUPS.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            cards={grouped[status] ?? []}
            onAdvance={onAdvance}
          />
        ))}
      </div>
    </section>
  )
}

function BoardColumn({
  status, cards, onAdvance,
}: {
  status: AppStatus
  cards: ApplicationEntry[]
  onAdvance: (app: ApplicationEntry, to: AppStatus) => void
}) {
  return (
    <div className="flex flex-col w-[15rem] shrink-0 rounded-lg bg-bg-panel/60 border border-border-default overflow-hidden">
      <header className="flex items-center gap-2 px-2.5 h-9 border-b border-border-default shrink-0">
        <span className={cn('w-1.5 h-1.5 rounded-full', COLUMN_ACCENT[status])} />
        <span className="text-[11px] font-semibold text-text-2 uppercase tracking-wide">{status}</span>
        <span className="text-[10.5px] font-mono text-text-4">{cards.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-1.5">
        {cards.length === 0
          ? <p className="px-2 py-3 text-[10.5px] text-text-4 text-center">—</p>
          : cards.map((card, i) => (
              <BoardCard
                key={`${card.company}-${card.role}-${i}`}
                card={card}
                onAdvance={onAdvance}
              />
            ))}
      </div>
    </div>
  )
}

function BoardCard({
  card, onAdvance,
}: {
  card: ApplicationEntry
  onAdvance: (app: ApplicationEntry, to: AppStatus) => void
}) {
  const advanceTo = nextStage(card.status)
  const dl = deadlineLabel(card.deadline)
  const urgency = deadlineUrgency(card.deadline)
  const badge = urgencyBadge(urgency)
  const reportUrl = reportListingUrl(card)

  return (
    <div className="group rounded-md border border-border-default bg-bg-base px-2 py-2 hover:border-border-strong transition-colors">
      <div className="flex items-start gap-2">
        <CompanyLogo company={card.company} size={20} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <span className="block text-[11.5px] text-text-2 font-medium truncate leading-tight">{card.company}</span>
          <span className="block text-[10px] text-text-4 truncate leading-tight">{card.role}</span>
        </div>
        {reportUrl && (
          <button
            onClick={() => ipc.openExternal(reportUrl)}
            title="Open the listing"
            className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-pill text-text-4 opacity-0 group-hover:opacity-100 hover:text-accent transition-all"
          >
            <ExternalLink size={10} />
          </button>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        {card.score && (
          <span className={cn('text-[10px] font-mono', STATUS_COLORS[card.status])}>{card.score}</span>
        )}
        {dl && (
          <span className={cn('text-[9.5px] font-mono px-1 rounded border', badge?.color ?? 'text-text-4 border-transparent')}>{dl}</span>
        )}
        <span className="flex-1" />
        {advanceTo && (
          <button
            onClick={() => onAdvance(card, advanceTo)}
            title={`Advance to ${advanceTo}`}
            className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded-pill text-[9.5px] text-text-4 opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-accent/10 transition-all"
          >
            {advanceTo}
            <ChevronRight size={9} />
          </button>
        )}
      </div>
    </div>
  )
}

// Best-effort listing URL for a card. The application row doesn't carry the
// raw URL, but the report path embeds the company/role; we fall back to the
// report's on-disk path only when it's an http(s) link (some legacy rows store
// a URL directly in the report cell). Returns null when there's nothing
// openable so the affordance hides rather than dead-clicks.
function reportListingUrl(card: ApplicationEntry): string | null {
  const m = /\((https?:\/\/[^)]+)\)/.exec(card.report)
  return m ? m[1] : null
}
