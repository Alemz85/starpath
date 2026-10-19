'use client'

import { useMemo } from 'react'
import { ExternalLink, ArrowRight } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { Button, Chip, ScoreNumber, type ChipTone } from '@/components/ui'
import { ipc } from '@/lib/ipc'
import { cn, deadlineLabel, deadlineUrgency, urgencyBadge } from '@/lib/utils'
import { STATUS_GROUPS, groupByStatus, nextStage } from '@/lib/applyingBoard'
import type { AppStatus, ApplicationEntry } from '@/types'

// The status board is the Pipeline view's second half: a compact, columnar read
// of where every active application stands (Evaluated → Offer). It deliberately
// stays lighter than the Applying cockpit — no per-card CV/draft/prep spawns —
// because its job here is orientation ("what's where?") plus one-click stage
// advance via the same applications.md status writeback the rest of the app
// uses. Bucketing + ordering is pure (lib/applyingBoard.groupByStatus); the
// view passes in the writeback handler.

// Column-header dot: the status' own semantic hue (lifecycle state).
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

// "8.1/10" → 8.1. Null when the cell holds no number.
function scoreValue(raw: string): number | null {
  const m = /(\d+(?:\.\d+)?)/.exec(raw ?? '')
  return m ? Number(m[1]) : null
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
      <section className="card flex-1 grid place-items-center p-10">
        <div className="text-center max-w-[20rem]">
          <p className="text-section text-text-1">No active applications yet</p>
          <p className="mt-1.5 text-label text-text-3">
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
    <div className="card flex flex-col w-60 shrink-0 overflow-hidden">
      <header className="flex items-center gap-2 px-3 h-9 border-b border-border-default bg-bg-elevated/60 shrink-0">
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', COLUMN_ACCENT[status])} aria-hidden />
        <span className="text-label font-medium text-text-2">{status}</span>
        <span className="text-label text-text-4 tabular-nums">{cards.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-2">
        {cards.length === 0
          ? (
            <div className="rounded border border-dashed border-border-default py-5 text-center">
              <p className="text-label text-text-4">Empty</p>
            </div>
          )
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
  // No urgency bucket → a quiet, borderless read of the date.
  const deadlineTone: ChipTone = badge ? (badge.color.replace('chip-', '') as ChipTone) : 'plain'

  return (
    <div className="card group p-2.5 transition-colors duration-150 hover:border-border-strong">
      <div className="flex items-start gap-2">
        <CompanyLogo company={card.company} size={20} className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text-1 truncate leading-tight">{card.company}</span>
          <span className="block text-label text-text-3 truncate mt-0.5">{card.role}</span>
        </div>
        {reportUrl && (
          <Button
            tone="ghost"
            size="xs"
            iconOnly
            onClick={() => ipc.openExternal(reportUrl)}
            title="Open the listing"
            aria-label="Open the listing"
            icon={<ExternalLink size={12} />}
            className="shrink-0 -mt-0.5 -mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          />
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5 min-h-6">
        {card.score && <ScoreNumber value={scoreValue(card.score)} size="sm" denominator />}
        {dl && <Chip tone={deadlineTone} size="sm" title={card.deadline}>{dl}</Chip>}
        <span className="flex-1" />
        {advanceTo && (
          <Button
            tone="ghost"
            size="xs"
            onClick={() => onAdvance(card, advanceTo)}
            title={`Advance to ${advanceTo}`}
            trailing={<ArrowRight size={12} />}
            className="-mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            {advanceTo}
          </Button>
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
