'use client'

import type { ChatBlock, ChatBlockTag, ProposalBlock } from '@/lib/chat/blocks'
import type { ChatProposal, StatusProposal } from '@/lib/chat/proposals'
import type { ChatProposalDecision } from '@/lib/chat/types'
import { ChatProposalCard, type ProposalLock } from '../ChatProposalCard'
import { StatusMoveCard } from './StatusMoveCard'
import {
  ApplicationBlockCard, CardSkeleton, CompanyBlockCard, DeadlinesBlockCard, ListingBlockCard,
  MessageBlockCard, ReportBlockCard, TopBlockCard,
} from './ReferenceCards'

/** How a proposal card reaches its decision state and its two buttons. */
export interface ProposalCardState {
  decision: ChatProposalDecision | null
  error: string | null
  busy: boolean
  applying: boolean
  lock: ProposalLock
  onConfirm(proposal: ChatProposal): void
  onDismiss(proposal: ChatProposal): void
}

/** One card in an assistant turn. Reference blocks read the store; proposal
 *  blocks take `state` (decision, lock, the two handlers). */
export function ChatBlockCard({ block, state }: { block: ChatBlock; state: ProposalCardState }) {
  switch (block.kind) {
    case 'apply':
    case 'status':
      return <ProposalCard block={block} state={state} />
    case 'application':
      return <ApplicationBlockCard company={block.company} role={block.role} label={block.label} />
    case 'listing':
      return <ListingBlockCard company={block.company} role={block.role} label={block.label} />
    case 'report':
      return <ReportBlockCard company={block.company} role={block.role} label={block.label} />
    case 'company':
      return <CompanyBlockCard company={block.company} label={block.label} />
    case 'deadlines':
      return <DeadlinesBlockCard days={block.days} label={block.label} />
    case 'top':
      return <TopBlockCard list={block.list} limit={block.limit} label={block.label} />
    case 'message':
      return <MessageBlockCard id={block.id} label={block.label} />
    default: {
      const exhaustive: never = block
      return exhaustive
    }
  }
}

function ProposalCard({ block, state }: { block: ProposalBlock; state: ProposalCardState }) {
  if (block.kind === 'status') {
    return (
      <StatusMoveCard
        proposal={block.proposal}
        decision={state.decision}
        error={state.error}
        busy={state.busy}
        applying={state.applying}
        lock={state.lock}
        onConfirm={(edited: StatusProposal) => state.onConfirm(edited)}
        onDismiss={() => state.onDismiss(block.proposal)}
      />
    )
  }
  return (
    <ChatProposalCard
      proposal={block.proposal}
      decision={state.decision}
      error={state.error}
      busy={state.busy}
      applying={state.applying}
      lock={state.lock}
      onConfirm={() => state.onConfirm(block.proposal)}
      onDismiss={() => state.onDismiss(block.proposal)}
    />
  )
}

const PENDING_LABEL: Partial<Record<ChatBlockTag, string>> = {
  'starpath:apply': 'Preparing a proposal…',
  'starpath:status': 'Preparing a status change…',
}

/** A card still arriving mid-stream. */
export function PendingBlockCard({ tag }: { tag: ChatBlockTag }) {
  return (
    <div className="max-w-[420px] space-y-1.5" aria-busy="true">
      <p className="text-label text-text-4">{PENDING_LABEL[tag] ?? 'Preparing a card…'}</p>
      <CardSkeleton height="h-16" />
    </div>
  )
}
