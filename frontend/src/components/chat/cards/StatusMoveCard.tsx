'use client'

import { useMemo, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useWriteGate } from '@/store/dataRoot'
import { cn } from '@/lib/utils'
import { inferredRejectionLabel, rejectionStageOptions } from '@/lib/applyingBoard'
import { MAX_FIELD_CHARS, describeProposal } from '@/lib/chat/proposals'
import type { StatusProposal } from '@/lib/chat/proposals'
import { moveQuestion } from '@/lib/chat/blocks'
import type { ChatProposalDecision } from '@/lib/chat/types'
import { Button, Chip, StatusChip } from '@/components/ui'
import { LOCK_HINT, ResolvedChip, type ProposalLock } from '../ChatProposalCard'
import { LiveApplicationCard } from './ReferenceCards'
import { findApplication, todayIso } from './cardData'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A proposed status move, shown on the application it moves: the live Applying
 * card, the question ("Move to Rejected?"), and the date and stage pre-filled
 * from what the user said — editable, because the agent's reading of "last
 * Tuesday" can be off by a day. Confirm applies it through ChatView, which
 * calls `tracker:set-status` with the date and stage, so it lands in the
 * status log like a move on the board.
 */
export function StatusMoveCard({
  proposal, decision, error, busy, applying, lock, onConfirm, onDismiss,
}: {
  proposal: StatusProposal
  decision: ChatProposalDecision | null
  error: string | null
  busy: boolean
  applying: boolean
  lock: ProposalLock
  /** Called with the proposal as edited on the card. */
  onConfirm(edited: StatusProposal): void
  onDismiss(): void
}) {
  const loaded = useDataStore(s => s.loaded)
  const applications = useDataStore(s => s.applications)
  const { canWrite, readOnlyTitle } = useWriteGate()
  const app = useMemo(
    () => findApplication(applications, proposal.company, proposal.role),
    [applications, proposal.company, proposal.role],
  )

  const today = todayIso()
  const [date, setDate] = useState(proposal.date ?? today)
  const [stage, setStage] = useState(proposal.stage ?? '')
  const dateOk = ISO_DATE_RE.test(date) && date <= today

  const rejecting = proposal.status === 'Rejected'
  const from = app?.status ?? ''
  const stageOptions = useMemo(() => {
    if (!rejecting) return []
    const list = rejectionStageOptions(from)
    return proposal.stage && !list.includes(proposal.stage) ? [proposal.stage, ...list] : list
  }, [rejecting, from, proposal.stage])

  const resolved = decision !== null
  // Already there (the board, the CLI or an earlier card moved it): nothing to
  // confirm. Only while the card is open — a confirmed card keeps its chip.
  const alreadyThere = !resolved && !!app && app.status === proposal.status
  const missing = loaded && !app
  const disabled = busy || lock !== null || !canWrite

  const confirm = () => {
    if (!dateOk) return
    const edited: StatusProposal = { ...proposal, date }
    const trimmed = stage.trim().replace(/\s+/g, ' ')
    if (trimmed) edited.stage = trimmed
    else delete edited.stage
    onConfirm(edited)
  }

  return (
    <div className={cn('card p-3 max-w-[420px] transition-colors duration-150 ease-quart', decision?.status === 'applied' && 'border-success/30')}>
      <div className="flex items-center gap-2">
        <p className={cn('text-section flex-1 min-w-0 truncate', resolved ? 'text-text-3' : 'text-text-1')}>
          {moveQuestion(proposal.status)}
        </p>
        {app && app.status !== proposal.status && (
          <span className="shrink-0 flex items-center gap-1 text-label text-text-4">
            <StatusChip status={app.status} />
            <span aria-hidden>→</span>
            <StatusChip status={proposal.status} />
          </span>
        )}
      </div>

      <div className="mt-2 rounded-lg bg-bg-panel/50 border border-border-default/60 p-2">
        <LiveApplicationCard company={proposal.company} role={proposal.role} />
      </div>

      {!resolved && !alreadyThere && !missing && (
        <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
          <label htmlFor={`${proposal.company}-${proposal.role}-date`} className="label">Date</label>
          <div>
            <input
              id={`${proposal.company}-${proposal.role}-date`}
              type="date"
              value={date}
              max={today}
              required
              disabled={disabled}
              onChange={e => setDate(e.target.value)}
              className="input input-sm w-40"
            />
            {!dateOk && <span className="ml-2 text-label text-danger">Not a past date.</span>}
          </div>

          <span className="label self-start pt-1.5">Stage</span>
          <div className="min-w-0">
            <input
              type="text"
              value={stage}
              maxLength={MAX_FIELD_CHARS}
              disabled={disabled}
              onChange={e => setStage(e.target.value)}
              placeholder={rejecting ? inferredRejectionLabel(from) : 'Optional'}
              aria-label="Stage"
              className="input input-sm w-full"
            />
            {stageOptions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5" role="group" aria-label="Pick a stage">
                {stageOptions.map(o => (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={stage === o}
                    disabled={disabled}
                    onClick={() => setStage(s => (s === o ? '' : o))}
                    className={cn(
                      'chip transition-colors duration-150 hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      stage === o && 'chip-accent',
                    )}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-3">
        {resolved ? (
          <ResolvedChip decision={decision} appliedLabel={describeProposal(proposal).appliedLabel} />
        ) : alreadyThere ? (
          <Chip tone="muted" size="md" icon={<Check size={12} aria-hidden />}>Already {proposal.status}</Chip>
        ) : (
          <>
            {error && <p role="alert" className="mb-2 text-label text-danger">{error}</p>}
            {missing && (
              <p className="mb-2 text-label text-text-3">
                Not in your applications, so there is nothing to move.
              </p>
            )}
            <div className="flex items-center gap-2">
              {!missing && (
                <Button
                  tone="primary"
                  size="sm"
                  onClick={confirm}
                  disabled={disabled || !dateOk}
                  loading={applying}
                  title={readOnlyTitle ?? undefined}
                  icon={error ? <RotateCcw size={12} aria-hidden /> : <Check size={12} aria-hidden />}
                >
                  {applying ? 'Moving…' : error ? 'Retry' : `Move to ${proposal.status}`}
                </Button>
              )}
              <Button tone="ghost" size="sm" onClick={onDismiss} disabled={busy || lock !== null}>
                Dismiss
              </Button>
              {lock && !busy && <span className="text-label text-text-4">{LOCK_HINT[lock]}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
