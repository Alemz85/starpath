'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isLivePhase } from '@/lib/chat/types'
import type { ChatRuntimeSnapshot, ChatSession } from '@/lib/chat/types'
import { EmptyState } from '@/components/shared/EmptyState'

// Openers that are genuinely answerable from the repo's own data — each one
// maps to files the agent can read (pipeline, scouting tiers, deadlines) rather
// than to general career advice.
const SUGGESTIONS = [
  'What should I act on today, and why that first?',
  'Which of my tier-2 listings deserve a second look?',
  'Where is my pipeline thinnest right now?',
]

interface ChatTranscriptProps {
  session: ChatSession | null
  /** The live/last generation, only when it belongs to this conversation. */
  runtime: ChatRuntimeSnapshot | null
  onSuggestion(prompt: string): void
}

export function ChatTranscript({ session, runtime, onSuggestion }: ChatTranscriptProps) {
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
                <AssistantTurn key={`${message.ts}-${index}`} content={message.content} />
              )
            ))}

            {showRuntimeTurn && runtime && (
              <div className="space-y-2">
                {showRuntimeText
                  ? <AssistantTurn content={runtime.assistantText} streaming={streaming} />
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
 */
function AssistantTurn({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="prose-report">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {streaming && (
        <span
          className="inline-block w-[2px] h-[14px] align-[-2px] bg-accent animate-pulse"
          aria-hidden
        />
      )}
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
