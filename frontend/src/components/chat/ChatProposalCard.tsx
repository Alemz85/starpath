'use client'

import { Check, ExternalLink, FilePlus2, Loader2, RotateCcw, Tag } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ipc } from '@/lib/ipc'
import { describeProposal } from '@/lib/chat/proposals'
import type { ChatProposal } from '@/lib/chat/proposals'
import type { ChatProposalDecision } from '@/lib/chat/types'

/** Why Confirm is unavailable, when it is. Null means the card is actionable. */
export type ProposalLock = 'streaming' | 'unpersisted' | null

const LOCK_HINT: Record<Exclude<ProposalLock, null>, string> = {
  streaming: 'Available when the reply finishes.',
  // Covers both an in-flight turn not yet written to the session file and an
  // interrupted one that never will be — either way there is no saved message
  // to record the decision against.
  unpersisted: "This turn wasn't saved, so it can't be confirmed.",
}

interface ChatProposalCardProps {
  proposal: ChatProposal
  /** Persisted outcome, or null while the card is still open. */
  decision: ChatProposalDecision | null
  /** Transient failure from the last Confirm — never persisted, so Confirm
   *  stays available as a retry. */
  error: string | null
  /** A decision on THIS card is in flight — both buttons are held. */
  busy: boolean
  /** …and it is specifically the apply, which is the slow one worth a spinner. */
  applying: boolean
  lock: ProposalLock
  onConfirm(): void
  onDismiss(): void
}

/**
 * One write the chat agent is proposing, shown as a card the user confirms.
 *
 * The card never writes anything itself — Confirm calls back into ChatView,
 * which routes through the same `lib/applicationsDoc.ts` mutators the Apply
 * button and the status dropdown use. This component owns presentation only,
 * and its wording comes from `describeProposal` so it stays unit-testable.
 */
export function ChatProposalCard({
  proposal, decision, error, busy, applying, lock, onConfirm, onDismiss,
}: ChatProposalCardProps) {
  const summary = describeProposal(proposal)
  const Icon = proposal.kind === 'apply' ? FilePlus2 : Tag
  const resolved = decision !== null
  const disabled = busy || lock !== null

  return (
    <div
      className={cn(
        'rounded-md border bg-bg-base px-3.5 py-3 transition-colors duration-200 ease-quart',
        decision?.status === 'applied'
          ? 'border-success/30'
          : resolved
            ? 'border-border-default'
            : 'border-border-strong shadow-subtle',
      )}
    >
      <div className="flex items-center gap-1.5 text-micro uppercase tracking-wider text-text-4">
        <Icon size={11} className="shrink-0" aria-hidden />
        {summary.kindLabel}
      </div>

      <p className={cn('mt-1 text-body font-medium', resolved ? 'text-text-3' : 'text-text-1')}>
        {summary.subject}
      </p>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {summary.changes.map(change => (
          <div key={change.label} className="flex items-baseline gap-1.5 min-w-0">
            <dt className="text-micro text-text-4 shrink-0">{change.label}</dt>
            <dd className="text-label text-text-2 truncate" title={change.value}>{change.value}</dd>
          </div>
        ))}
      </dl>

      {proposal.kind === 'apply' && proposal.url && (
        <button
          type="button"
          onClick={() => void ipc.openExternal(proposal.url!)}
          className="mt-2 inline-flex items-center gap-1 max-w-full text-label text-text-3 hover:text-accent-text transition-colors duration-200 ease-quart"
        >
          <ExternalLink size={11} className="shrink-0" aria-hidden />
          <span className="truncate">{proposal.url}</span>
        </button>
      )}

      <div className="mt-3">
        {resolved ? (
          <ResolvedChip decision={decision} appliedLabel={summary.appliedLabel} />
        ) : (
          <>
            {error && (
              <p role="alert" className="mb-2 text-label text-danger">{error}</p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onConfirm}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-pill border-2 border-accent/40 bg-accent/10 px-3 py-1 text-[12px] text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 ease-quart"
              >
                {applying
                  ? <Loader2 size={12} className="animate-spin" aria-hidden />
                  : error
                    ? <RotateCcw size={12} aria-hidden />
                    : <Check size={12} aria-hidden />}
                {applying ? 'Applying…' : error ? 'Retry' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={disabled}
                className="rounded-pill border border-border-strong px-3 py-1 text-[12px] text-text-3 hover:bg-bg-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 ease-quart"
              >
                Dismiss
              </button>
              {lock && !busy && (
                <span className="text-label text-text-4">{LOCK_HINT[lock]}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function formatDecidedAt(at: string): string | null {
  const parsed = new Date(at)
  return Number.isNaN(parsed.getTime()) ? null : TIME.format(parsed)
}

function ResolvedChip({ decision, appliedLabel }: {
  decision: ChatProposalDecision
  appliedLabel: string
}) {
  const applied = decision.status === 'applied'
  const at = formatDecidedAt(decision.at)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-micro',
        applied
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border-default bg-bg-elevated text-text-3',
      )}
    >
      {applied && <Check size={11} aria-hidden />}
      {applied ? appliedLabel : 'Dismissed'}
      {at && <span className="text-text-4 tabular-nums">· {at}</span>}
    </span>
  )
}
