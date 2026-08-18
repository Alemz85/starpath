'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Square } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useDataStore } from '@/store/data'
import {
  findApplicationRowIndex, updateApplicationFields, updateApplicationStatus, upsertApplicationRow,
} from '@/lib/applicationsDoc'
import { applyEnvelope, mergeRuntime } from '@/lib/chat/runtime'
import { isLivePhase } from '@/lib/chat/types'
import type {
  ChatPhase, ChatRuntimeEnvelope, ChatRuntimeSnapshot, ChatSession, ChatSessionMeta,
} from '@/lib/chat/types'
import { describeProposal, tierForProposal } from '@/lib/chat/proposals'
import type { ChatProposal } from '@/lib/chat/proposals'
import { ChatSessionRail } from './ChatSessionRail'
import { ChatTranscript } from './ChatTranscript'
import { ChatComposer } from './ChatComposer'

const APPLICATIONS_PATH = 'data/applications.md'

/**
 * Apply one confirmed proposal to `data/applications.md`.
 *
 * This is deliberately NOT a new write path: it reads the file over the same
 * `fs:read`/`fs:write` IPC the store uses and transforms it with the same
 * `lib/applicationsDoc.ts` mutators behind the Apply button and the status
 * dropdown. So the tracker's invariants — one row per (company, role),
 * refresh-in-place instead of duplicate, the 9→10 column self-heal — hold for a
 * chat confirm exactly as they do for a click in the Database.
 *
 * Returns the line the card shows once applied.
 */
async function applyProposalToTracker(proposal: ChatProposal): Promise<string> {
  const raw = await ipc.readFile(APPLICATIONS_PATH) ?? ''

  if (proposal.kind === 'status') {
    // A status move needs a row to move. Saying so beats silently no-op'ing:
    // updateApplicationStatus returns the document unchanged either way.
    if (findApplicationRowIndex(raw.split('\n'), proposal.company, proposal.role) === -1) {
      throw new Error(`${proposal.company} — ${proposal.role} isn't in your applications yet.`)
    }
    const next = updateApplicationStatus(raw, proposal.company, proposal.role, proposal.status)
    if (next !== raw) await ipc.writeFile(APPLICATIONS_PATH, next)
    return describeProposal(proposal).appliedLabel
  }

  // Upsert first (creates the row, or refreshes score/report on an existing
  // one), then patch the cells upsert doesn't own. Both steps are no-ops when
  // nothing actually changes, so confirming twice can't duplicate a listing.
  const upserted = upsertApplicationRow(raw, {
    company: proposal.company,
    role: proposal.role,
    overall: proposal.scoreValue ?? 0,
    tier: tierForProposal(proposal),
  })
  const next = updateApplicationFields(upserted, proposal.company, proposal.role, {
    status: proposal.status,
    deadline: proposal.deadline,
    notes: proposal.notes,
  })
  if (next !== raw) await ipc.writeFile(APPLICATIONS_PATH, next)
  return describeProposal(proposal).appliedLabel
}

// Header chip copy per phase. "Working elsewhere" covers the case where a
// generation is live on a conversation the user has navigated away from —
// main owns one generation globally, so the state has to stay visible.
const PHASE_LABEL: Record<ChatPhase, string> = {
  starting:    'Starting',
  running:     'Working',
  stopping:    'Stopping',
  completed:   'Ready',
  failed:      'Needs attention',
  interrupted: 'Interrupted',
}

/**
 * Chat — talk to the job search.
 *
 * The agent is the local `claude` CLI running in the configured repo, so the
 * answers come from the same files every other tab reads (data/*, reports/**)
 * rather than from a summary this view assembled. Main owns the generation;
 * this view owns the presentation and reattaches on every mount:
 *
 *   mount → `chat:state` returns the live (or last) snapshot, including the
 *   sequence it had reached → every `chat:event` envelope past that sequence
 *   folds in via the same pure reducer the main process used to produce it.
 *
 * Which means: switching tabs mid-answer and coming back shows the answer
 * still streaming, and quitting mid-answer leaves an `interrupted` turn with
 * the partial text intact instead of a blank.
 */
export function ChatView() {
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [session, setSession] = useState<ChatSession | null>(null)
  const [runtime, setRuntime] = useState<ChatRuntimeSnapshot | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // Proposal cards: one decision at a time (single-flight across every card),
  // plus per-block transient errors that are deliberately NOT persisted so
  // Confirm stays available as a retry.
  const [proposalBusy, setProposalBusy] =
    useState<{ blockId: string; kind: 'applying' | 'dismissing' } | null>(null)
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>({})

  // Mirrors `runtime` for the event listener, which is registered once and
  // must not close over a stale snapshot.
  const runtimeRef = useRef<ChatRuntimeSnapshot | null>(null)
  runtimeRef.current = runtime

  const refreshRuntime = useCallback(async () => {
    const fetched = await ipc.chat.state()
    setRuntime(prev => mergeRuntime(prev, fetched))
    return fetched
  }, [])

  const refreshSessions = useCallback(async () => {
    const list = await ipc.chat.sessions()
    setSessions(list ?? [])
    return list ?? []
  }, [])

  const loadSession = useCallback(async (id: string | null) => {
    if (!id) { setSession(null); return }
    setSession(await ipc.chat.get(id))
  }, [])

  // Mount: reattach to whatever main is holding, and default the selection to
  // the conversation that generation belongs to.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [snapshot, list] = await Promise.all([ipc.chat.state(), ipc.chat.sessions()])
      if (cancelled) return
      setRuntime(prev => mergeRuntime(prev, snapshot))
      setSessions(list ?? [])
      const fallback = snapshot?.sessionId ?? list?.[0]?.id ?? null
      setSelectedId(prev => prev ?? fallback)
    })()
    return () => { cancelled = true }
  }, [])

  // Live envelopes. An envelope for a generation this view hasn't seen means
  // the snapshot is behind (a send that resolved after the first push), so we
  // re-pull rather than dropping the increment.
  useEffect(() => {
    const unsubscribe = ipc.chat.onEvent((envelope: ChatRuntimeEnvelope) => {
      const current = runtimeRef.current
      if (!current || current.generationId !== envelope.generationId) {
        void refreshRuntime()
        return
      }
      setRuntime(prev => applyEnvelope(prev, envelope, new Date().toISOString()))
      if (envelope.event.kind === 'done' || envelope.event.kind === 'error') {
        void refreshSessions()
        void loadSession(envelope.sessionId)
      }
    })
    return () => { if (typeof unsubscribe === 'function') unsubscribe() }
  }, [loadSession, refreshRuntime, refreshSessions])

  useEffect(() => { void loadSession(selectedId) }, [selectedId, loadSession])

  const live = isLivePhase(runtime?.phase)
  const runtimeIsHere = !!runtime && runtime.sessionId === selectedId

  const send = useCallback(async (text?: string) => {
    const message = (text ?? draft).trim()
    if (!message || sending || live) return
    setSending(true)
    setNotice(null)
    try {
      const result = await ipc.chat.send(selectedId, message)
      setDraft('')
      setSelectedId(result.sessionId)
      await Promise.all([refreshRuntime(), refreshSessions(), loadSession(result.sessionId)])
    } catch (e) {
      setNotice(readIpcError(e))
    } finally {
      setSending(false)
    }
  }, [draft, live, loadSession, refreshRuntime, refreshSessions, selectedId, sending])

  const stop = useCallback(async () => {
    if (!runtime || !live) return
    try {
      await ipc.chat.stop(runtime.sessionId)
    } catch (e) {
      setNotice(readIpcError(e))
    }
  }, [live, runtime])

  const newChat = useCallback(async () => {
    setNotice(null)
    try {
      const created = await ipc.chat.create()
      await refreshSessions()
      setSelectedId(created?.id ?? null)
      setDraft('')
    } catch (e) {
      setNotice(readIpcError(e))
    }
  }, [refreshSessions])

  // Confirm: write the tracker first, and only record the decision once the
  // write succeeded. Doing it in that order means a failed write leaves the
  // card open for a retry rather than marking it applied with nothing on disk.
  const confirmProposal = useCallback(async (
    blockId: string, messageId: string, proposal: ChatProposal,
  ) => {
    if (proposalBusy) return  // single-flight
    setProposalBusy({ blockId, kind: 'applying' })
    setProposalErrors(prev => {
      if (!(blockId in prev)) return prev
      const { [blockId]: _cleared, ...rest } = prev
      return rest
    })
    try {
      const detail = await applyProposalToTracker(proposal)
      // Only now record the decision. If this throws, the row is already
      // written — and a retry re-runs an idempotent upsert, so the worst case
      // is a card that still says "pending" over a tracker that is correct.
      const updated = await ipc.chat.recordDecision(
        session?.id ?? selectedId ?? '', messageId, blockId, { status: 'applied', detail },
      )
      if (updated) setSession(updated)
      // The tracker moved — bring the rest of the app (Database, Pipeline,
      // Applying) back in sync. The chokidar watcher would get there too; this
      // just makes it immediate.
      await useDataStore.getState().refresh()
    } catch (e) {
      setProposalErrors(prev => ({ ...prev, [blockId]: readIpcError(e) }))
    } finally {
      setProposalBusy(null)
    }
  }, [proposalBusy, selectedId, session?.id])

  const dismissProposal = useCallback(async (blockId: string, messageId: string) => {
    if (proposalBusy) return
    setProposalBusy({ blockId, kind: 'dismissing' })
    try {
      const updated = await ipc.chat.recordDecision(
        session?.id ?? selectedId ?? '', messageId, blockId, { status: 'dismissed' },
      )
      if (updated) setSession(updated)
    } catch (e) {
      setProposalErrors(prev => ({ ...prev, [blockId]: readIpcError(e) }))
    } finally {
      setProposalBusy(null)
    }
  }, [proposalBusy, selectedId, session?.id])

  const proposalHandlers = useMemo(() => ({
    busy: proposalBusy,
    errors: proposalErrors,
    onConfirm: (blockId: string, messageId: string, proposal: ChatProposal) =>
      void confirmProposal(blockId, messageId, proposal),
    onDismiss: (blockId: string, messageId: string) =>
      void dismissProposal(blockId, messageId),
  }), [confirmProposal, dismissProposal, proposalBusy, proposalErrors])

  const removeSession = useCallback(async (id: string) => {
    try {
      await ipc.chat.remove(id)
    } catch (e) {
      setNotice(readIpcError(e))
      return
    }
    const list = await refreshSessions()
    if (selectedId === id) setSelectedId(list[0]?.id ?? null)
    await refreshRuntime()
  }, [refreshRuntime, refreshSessions, selectedId])

  // A brand-new empty conversation is already the "new chat" — offering the
  // button again would just stack empty rows in the rail.
  const selectedMeta = sessions.find(s => s.id === selectedId) ?? null
  const canCreate = !live && (selectedMeta ? selectedMeta.messageCount > 0 : sessions.length > 0)
  const statusLabel = live && !runtimeIsHere
    ? 'Working elsewhere'
    : runtime && runtimeIsHere ? PHASE_LABEL[runtime.phase] : 'Ready'

  return (
    <div className="flex flex-col h-full overflow-hidden" role="region" aria-label="Chat">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium flex items-center gap-2">
          <MessageSquare size={14} className="text-accent" aria-hidden />
          Chat
        </h1>
        <span
          className={cn(
            'text-micro font-mono px-2 py-0.5 rounded-pill border',
            live
              ? 'text-accent border-accent/40 bg-accent/10'
              : runtime?.phase === 'failed' && runtimeIsHere
                ? 'text-danger border-danger/40 bg-danger/10'
                : 'text-text-4 border-border-default bg-bg-elevated',
          )}
        >
          {statusLabel}
        </span>
        {live && (
          <button
            type="button"
            onClick={() => void stop()}
            className="titlebar-no-drag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-border-strong text-label text-text-2 hover:bg-bg-elevated transition-colors duration-200 ease-quart"
          >
            <Square size={10} className="fill-current" aria-hidden />
            Stop
          </button>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        <ChatSessionRail
          sessions={sessions}
          selectedId={selectedId}
          liveSessionId={live ? runtime?.sessionId ?? null : null}
          canCreate={canCreate}
          onSelect={setSelectedId}
          onCreate={() => void newChat()}
          onDelete={(id) => void removeSession(id)}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <ChatTranscript
            session={session}
            runtime={runtimeIsHere ? runtime : null}
            generating={live}
            proposals={proposalHandlers}
            onSuggestion={(prompt) => void send(prompt)}
          />

          {notice && (
            <div
              role="alert"
              className="mx-6 mb-2 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-danger/30 bg-danger/10 text-label text-danger"
            >
              <span className="min-w-0 truncate" title={notice}>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="shrink-0 text-text-3 hover:text-text-1 transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}

          <ChatComposer
            value={draft}
            disabled={live || sending}
            onChange={setDraft}
            onSend={() => void send()}
          />
        </div>
      </div>
    </div>
  )
}

// Electron wraps a handler rejection as "Error invoking remote method 'x':
// Error: real message" — the user only needs the real message.
function readIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const match = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/)
  return (match?.[1] ?? raw).trim() || 'Something went wrong.'
}
