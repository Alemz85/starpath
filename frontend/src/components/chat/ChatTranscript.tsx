'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isLivePhase } from '@/lib/chat/types'
import type { ChatProposalDecision, ChatRuntimeSnapshot, ChatSession } from '@/lib/chat/types'
import { splitChatContent } from '@/lib/chat/proposals'
import type { ChatProposal } from '@/lib/chat/proposals'
import { EmptyState } from '@/components/shared/EmptyState'
import { ChatProposalCard, type ProposalLock } from './ChatProposalCard'

// Openers that are genuinely answerable from the repo's own data — each one
// maps to files the agent can read (pipeline, scouting tiers, deadlines) rather
// than to general career advice.
const SUGGESTIONS = [
  'What should I act on today, and why that first?',
  'Which of my tier-2 listings deserve a second look?',
  'Where is my pipeline thinnest right now?',
]

/** How the transcript talks to ChatView about proposal cards. The view owns
 *  the write (through the applications.md mutators) and the single-flight
 *  guard; the transcript only routes clicks and reads back state. */
export interface ProposalHandlers {
  /** The one decision in flight, or null. Single-flight across all cards. */
  busy: { blockId: string; kind: 'applying' | 'dismissing' } | null
  /** blockId → last transient failure, cleared on retry. */
  errors: Record<string, string>
  onConfirm(blockId: string, messageId: string, proposal: ChatProposal): void
  onDismiss(blockId: string, messageId: string): void
}

interface ChatTranscriptProps {
  session: ChatSession | null
  /** The live/last generation, only when it belongs to this conversation. */
  runtime: ChatRuntimeSnapshot | null
  /** True while any generation is running — cards stay locked until it lands. */
  generating: boolean
  proposals: ProposalHandlers
  onSuggestion(prompt: string): void
}

export function ChatTranscript({
  session, runtime, generating, proposals, onSuggestion,
}: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followOutput = useRef(true)

  const messages = session?.messages ?? []
  const streaming = isLivePhase(runtime?.phase)
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')

  // Once a finished generation has been folded into the session file, the
  // runtime turn would render the same answer twice. Prefix rather than
  // equality: the session store's per-message cap is tighter than the
  // runtime's partial-answer cap, so a very long answer persists truncated.
  const alreadyPersisted =
    !!runtime?.assistantText &&
    !!lastAssistant?.content &&
    runtime.assistantText.startsWith(lastAssistant.content)
  const showRuntimeText = !!runtime?.assistantText && !alreadyPersisted
  const showRuntimeTurn = !!runtime && (
    showRuntimeText ||
    streaming ||
    runtime.phase === 'interrupted' ||
    runtime.phase === 'failed'
  )

  useEffect(() => {
    followOutput.current = true
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [session?.id])

  useEffect(() => {
    if (!followOutput.current) return
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [messages.length, runtime?.assistantText, runtime?.lastSequence])

  const empty = messages.length === 0 && !showRuntimeTurn

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-6 py-6"
      onScroll={(event) => {
        const el = event.currentTarget
        followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      }}
    >
      <div className="mx-auto w-full max-w-[720px] space-y-5">
        {empty ? (
          <div className="pt-10">
            <EmptyState
              title="Ask about your search."
              hint="Answers are read live from your own pipeline, reports, and trackers — not from a summary."
            />
            <div className="mt-6 flex flex-col items-center gap-2">
              {SUGGESTIONS.map(prompt => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSuggestion(prompt)}
                  className="suggestion-chip inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border-strong text-text-3 text-label hover:border-accent/50 hover:text-accent-text hover:bg-accent/10 active:scale-95 transition-all duration-150"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              message.role === 'user' ? (
                <UserTurn key={`${message.ts}-${index}`} content={message.content} />
              ) : (
                <AssistantTurn
                  key={`${message.ts}-${index}`}
                  content={message.content}
                  messageId={message.id ?? null}
                  decisions={message.proposalDecisions}
                  // A persisted turn is actionable unless a generation is
                  // running — one write at a time, same rule as the composer.
                  lock={generating ? 'streaming' : null}
                  proposals={proposals}
                />
              )
            ))}

            {showRuntimeTurn && runtime && (
              <div className="space-y-2">
                {showRuntimeText
                  ? (
                    <AssistantTurn
                      content={runtime.assistantText}
                      streaming={streaming}
                      // The live turn isn't in the session file yet, so there
                      // is no message to record a decision against. It re-renders
                      // as a persisted turn (with working buttons) the moment
                      // the generation lands.
                      messageId={null}
                      lock={streaming ? 'streaming' : 'unpersisted'}
                      proposals={proposals}
                    />
                  )
                  : streaming
                    ? <p className="text-label text-text-3">Reading your pipeline…</p>
                    : null}
                <WorkLog runtime={runtime} />
                {runtime.phase === 'interrupted' && (
                  <p className="text-label text-text-3">
                    Reply interrupted — the partial answer above is what completed.
                  </p>
                )}
                {runtime.phase === 'failed' && runtime.error && (
                  <p role="alert" className="text-label text-danger">{runtime.error}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function UserTurn({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] px-3.5 py-2.5 rounded-lg bg-accent/10 border border-accent/20 text-body text-text-2 whitespace-pre-wrap selectable">
        {content}
      </div>
    </div>
  )
}

/**
 * Assistant markdown uses the app's existing report-prose renderer
 * (ReactMarkdown + remark-gfm + `.prose-report`, the same pairing
 * ReportSlideOver and ReportsView use) — one markdown treatment app-wide, and
 * no new dependency.
 *
 * `starpath:apply` / `starpath:status` fences are lifted out of the prose and
 * rendered as Confirm cards (`lib/chat/proposals.ts`). Anything that doesn't
 * validate stays in the markdown and draws as an ordinary code block, so a
 * malformed proposal degrades to exactly what it looked like before cards
 * existed — never a half-card.
 */
function AssistantTurn({
  content, streaming = false, messageId = null, decisions, lock = null, proposals,
}: {
  content: string
  streaming?: boolean
  messageId?: string | null
  decisions?: Record<string, ChatProposalDecision>
  lock?: ProposalLock
  proposals?: ProposalHandlers
}) {
  // A turn with no persisted id can't carry a decision, so its blocks get a
  // throwaway namespace — they render, but Confirm is locked (see `lock`).
  const segments = useMemo(
    () => splitChatContent(content, messageId ?? 'live', streaming),
    [content, messageId, streaming],
  )
  const lastIndex = segments.length - 1

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        if (segment.kind === 'markdown') {
          return (
            <div key={`md-${index}`} className="prose-report">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.text}</ReactMarkdown>
              {streaming && index === lastIndex && (
                <span
                  className="inline-block w-[2px] h-[14px] align-[-2px] bg-accent animate-pulse"
                  aria-hidden
                />
              )}
            </div>
          )
        }
        return (
          <ChatProposalCard
            key={segment.id}
            proposal={segment.proposal}
            decision={decisions?.[segment.id] ?? null}
            error={proposals?.errors[segment.id] ?? null}
            busy={proposals?.busy?.blockId === segment.id}
            applying={
              proposals?.busy?.blockId === segment.id && proposals.busy.kind === 'applying'
            }
            lock={messageId ? lock : (lock ?? 'unpersisted')}
            onConfirm={() => {
              if (messageId) proposals?.onConfirm(segment.id, messageId, segment.proposal)
            }}
            onDismiss={() => {
              if (messageId) proposals?.onDismiss(segment.id, messageId)
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * Compact work log — one line saying what the agent is doing, expandable into
 * the full trail. Tool labels come from `chatToolLabel`, which wraps the same
 * `formatToolUse` the Activity panel uses, so a Bash call reads identically in
 * both places.
 */
function WorkLog({ runtime }: { runtime: ChatRuntimeSnapshot }) {
  const [open, setOpen] = useState(false)
  const entries = runtime.workLog
  if (entries.length === 0) return null
  const latest = entries[entries.length - 1]

  return (
    <div className="text-label text-text-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 max-w-full hover:text-text-2 transition-colors duration-200 ease-quart"
      >
        <Terminal size={11} className="shrink-0" aria-hidden />
        <span className="truncate font-mono">{latest.label}</span>
        <span className="shrink-0 text-text-4 tabular-nums">{entries.length}</span>
        <ChevronRight
          size={11}
          className={cn('shrink-0 transition-transform duration-200 ease-quart', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open && (
        <ol className="mt-1.5 pl-4 space-y-1 border-l border-border-default">
          {entries.map(entry => (
            <li key={`${entry.sequence}-${entry.label}`} className="font-mono truncate" title={entry.detail || entry.label}>
              {entry.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
