// The chat runtime — one live generation, expressed as a pure reducer.
//
// Ported from Alke's chatRuntime.ts, with the I/O sliced off: everything here
// is string/object in, string/object out, so the transitions (and their byte
// caps) are unit-testable and identical on both sides of the IPC boundary.
// The Electron side (`electron/chat.ts`) owns the file handle, the throttled
// persist, and the child process; the renderer folds the same envelopes into
// its own copy of the snapshot so a stream never has to be re-fetched.
//
// Two invariants the rest of the subsystem leans on:
//   1. Every mutation emits exactly one envelope carrying a monotonically
//      increasing `sequence`. A renderer that mounts mid-generation pulls the
//      snapshot via `chat:state` and drops any envelope at or below the
//      snapshot's `lastSequence` — no duplicated text, no lost text.
//   2. The snapshot is byte-capped at every edge (partial answer, work log,
//      labels, details, error) so a runaway generation can never grow the
//      persisted file without bound.

import type {
  ChatPhase,
  ChatRuntimeEnvelope,
  ChatRuntimeSnapshot,
  ChatStreamEvent,
  ChatWorkLogEntry,
} from './types'
import { isLivePhase } from './types'

// ─── Byte caps ───────────────────────────────────────────────────────────────

/** Hard ceiling for the serialized snapshot — the persist layer refuses above it. */
export const MAX_RUNTIME_BYTES = 2 * 1024 * 1024
/** The streamed partial answer. Overflow drops the tail, never the head. */
export const MAX_ASSISTANT_TEXT_BYTES = 1024 * 1024
export const MAX_WORK_ENTRIES = 200
export const MAX_WORK_LOG_BYTES = 256 * 1024
export const MAX_WORK_LABEL_BYTES = 512
export const MAX_WORK_DETAIL_BYTES = 2 * 1024
export const MAX_ORIGINAL_MESSAGE_BYTES = 256 * 1024
export const MAX_ERROR_BYTES = 16 * 1024

// TextEncoder/TextDecoder (not Buffer) so this module stays usable verbatim in
// the renderer — the same reducer runs in both processes.
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder('utf-8')

export function utf8Length(value: string): number {
  return ENCODER.encode(value).length
}

/** Cut to `maxBytes` without leaving a half-decoded surrogate behind. */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = ENCODER.encode(value)
  if (bytes.length <= maxBytes) return value
  return DECODER.decode(bytes.subarray(0, maxBytes)).replace(/�$/u, '')
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type ChatRuntimeAction =
  | { type: 'begin'; generationId: string; sessionId: string; message: string }
  | { type: 'running' }
  | { type: 'text'; text: string }
  | { type: 'work'; kind: 'status' | 'tool'; label: string; detail?: string }
  | { type: 'resume-available'; available: boolean }
  | { type: 'stopping' }
  | { type: 'interrupted'; detail?: string }
  | { type: 'completed' }
  | { type: 'failed'; message: string }

export interface ChatRuntimeStep {
  snapshot: ChatRuntimeSnapshot
  /** null only for bookkeeping actions that carry no visible increment. */
  envelope: ChatRuntimeEnvelope | null
}

/** Status labels the renderer maps back onto phases when folding envelopes. */
export const STATUS_STARTING = 'Starting'
export const STATUS_WORKING = 'Working'
export const STATUS_STOPPING = 'Stopping'
export const STATUS_INTERRUPTED = 'Interrupted'
export const INTERRUPT_DETAIL = 'starpath closed before the reply finished.'

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Fold one action into the runtime. `snapshot` is null before the first
 * generation and after a delete; `now` is injected so tests are deterministic.
 * Throws when a `begin` collides with a live generation — the single-live-
 * generation rule is enforced here rather than at each call site.
 */
export function reduceRuntime(
  snapshot: ChatRuntimeSnapshot | null,
  action: ChatRuntimeAction,
  now: string,
): ChatRuntimeStep {
  if (action.type === 'begin') {
    if (isLivePhase(snapshot?.phase)) {
      throw new Error('A chat reply is already running.')
    }
    const fresh: ChatRuntimeSnapshot = {
      version: 1,
      generationId: action.generationId,
      sessionId: action.sessionId,
      originalMessage: truncateUtf8(action.message, MAX_ORIGINAL_MESSAGE_BYTES),
      startedAt: now,
      updatedAt: now,
      phase: 'starting',
      assistantText: '',
      workLog: [],
      error: null,
      resumeAvailable: false,
      lastSequence: 0,
    }
    return transition(fresh, 'starting', STATUS_STARTING, undefined, now)
  }

  if (!snapshot) throw new Error('No chat runtime is active.')
  const next: ChatRuntimeSnapshot = { ...snapshot, workLog: [...snapshot.workLog] }

  switch (action.type) {
    case 'running':
      return transition(next, 'running', STATUS_WORKING, undefined, now)

    case 'text': {
      if (next.phase === 'starting') next.phase = 'running'
      next.assistantText = truncateUtf8(next.assistantText + action.text, MAX_ASSISTANT_TEXT_BYTES)
      return emit(next, { kind: 'text', text: action.text }, now)
    }

    case 'work': {
      if (next.phase === 'starting') next.phase = 'running'
      const label = truncateUtf8(action.label, MAX_WORK_LABEL_BYTES)
      const detail = truncateUtf8(action.detail ?? '', MAX_WORK_DETAIL_BYTES)
      next.workLog = boundWorkLog([
        ...next.workLog,
        { sequence: next.lastSequence + 1, at: now, kind: action.kind, label, detail },
      ])
      return emit(
        next,
        action.kind === 'status'
          ? { kind: 'status', label, detail }
          : { kind: 'tool', name: label, detail },
        now,
      )
    }

    case 'resume-available':
      // Bookkeeping only — nothing for the renderer to render, so no envelope
      // (and no sequence burn that would desync a mid-flight reattach).
      next.resumeAvailable = action.available
      next.updatedAt = now
      return { snapshot: next, envelope: null }

    case 'stopping':
      return transition(next, 'stopping', STATUS_STOPPING, undefined, now)

    case 'interrupted':
      return transition(
        next, 'interrupted', STATUS_INTERRUPTED, action.detail ?? INTERRUPT_DETAIL, now,
      )

    case 'completed':
      next.phase = 'completed'
      next.error = null
      return emit(next, { kind: 'done' }, now)

    case 'failed': {
      next.phase = 'failed'
      next.error = truncateUtf8(action.message, MAX_ERROR_BYTES)
      return emit(next, { kind: 'error', message: next.error }, now)
    }
  }
}

/**
 * Phase change + its status line. The work entry is written on this side too —
 * the renderer folds every status envelope into its log, so skipping it here
 * would leave the two processes holding different work logs for the same
 * generation (and a reattach would silently rewrite what the user was reading).
 */
function transition(
  snapshot: ChatRuntimeSnapshot,
  phase: ChatPhase,
  label: string,
  detail: string | undefined,
  now: string,
): ChatRuntimeStep {
  const next: ChatRuntimeSnapshot = {
    ...snapshot,
    phase,
    workLog: boundWorkLog([
      ...snapshot.workLog,
      { sequence: snapshot.lastSequence + 1, at: now, kind: 'status', label, detail: detail ?? '' },
    ]),
  }
  return emit(next, { kind: 'status', label, detail }, now)
}

function emit(
  snapshot: ChatRuntimeSnapshot,
  event: ChatStreamEvent,
  now: string,
): ChatRuntimeStep {
  const sequence = snapshot.lastSequence + 1
  const next: ChatRuntimeSnapshot = { ...snapshot, lastSequence: sequence, updatedAt: now }
  return {
    snapshot: next,
    envelope: {
      generationId: next.generationId,
      sessionId: next.sessionId,
      sequence,
      event,
    },
  }
}

/** Trim the work log by count first, then by serialized size (oldest out). */
export function boundWorkLog(entries: ChatWorkLogEntry[]): ChatWorkLogEntry[] {
  const bounded = entries.slice(-MAX_WORK_ENTRIES)
  while (bounded.length > 0 && utf8Length(JSON.stringify(bounded)) > MAX_WORK_LOG_BYTES) {
    bounded.shift()
  }
  return bounded
}

// ─── Renderer-side folding ───────────────────────────────────────────────────

/**
 * Apply one pushed envelope to the renderer's copy of the snapshot. Returns
 * the snapshot unchanged when the envelope belongs to another generation or
 * is one the snapshot already contains — that ordering guard is what makes
 * "reattach via chat:state, then keep listening" safe without a replay buffer.
 */
export function applyEnvelope(
  snapshot: ChatRuntimeSnapshot | null,
  envelope: ChatRuntimeEnvelope,
  now: string,
): ChatRuntimeSnapshot | null {
  if (
    !snapshot ||
    snapshot.generationId !== envelope.generationId ||
    snapshot.sessionId !== envelope.sessionId ||
    envelope.sequence <= snapshot.lastSequence
  ) {
    return snapshot
  }

  const next: ChatRuntimeSnapshot = {
    ...snapshot,
    workLog: [...snapshot.workLog],
    updatedAt: now,
    lastSequence: envelope.sequence,
  }
  const event = envelope.event

  if (event.kind === 'text') {
    if (next.phase === 'starting') next.phase = 'running'
    next.assistantText = truncateUtf8(next.assistantText + event.text, MAX_ASSISTANT_TEXT_BYTES)
    return next
  }

  if (event.kind === 'status' || event.kind === 'tool') {
    const label = event.kind === 'status' ? event.label : event.name
    next.workLog = boundWorkLog([
      ...next.workLog,
      {
        sequence: envelope.sequence,
        at: now,
        kind: event.kind,
        label,
        detail: event.detail ?? '',
      },
    ])
    if (event.kind === 'status') {
      if (label === STATUS_STARTING) next.phase = 'starting'
      else if (label === STATUS_STOPPING) next.phase = 'stopping'
      else if (label === STATUS_INTERRUPTED) next.phase = 'interrupted'
      else if (next.phase === 'starting') next.phase = 'running'
    } else if (next.phase === 'starting') {
      next.phase = 'running'
    }
    return next
  }

  if (event.kind === 'done') {
    next.phase = 'completed'
    next.error = null
    return next
  }

  next.phase = 'failed'
  next.error = event.message
  return next
}

/**
 * Newer wins, unless the local copy is strictly ahead of the pushed one for
 * the same generation (a `chat:state` reply that raced past a live envelope).
 */
export function mergeRuntime(
  local: ChatRuntimeSnapshot | null,
  fetched: ChatRuntimeSnapshot | null,
): ChatRuntimeSnapshot | null {
  if (
    local &&
    fetched &&
    local.generationId === fetched.generationId &&
    local.lastSequence > fetched.lastSequence
  ) {
    return local
  }
  return fetched
}

// ─── Restore ─────────────────────────────────────────────────────────────────

const PHASES = new Set<ChatPhase>([
  'starting', 'running', 'stopping', 'completed', 'failed', 'interrupted',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeWorkEntry(value: unknown): ChatWorkLogEntry | null {
  if (!isRecord(value)) return null
  if (
    typeof value.sequence !== 'number' ||
    !Number.isInteger(value.sequence) ||
    typeof value.at !== 'string' ||
    (value.kind !== 'status' && value.kind !== 'tool') ||
    typeof value.label !== 'string' ||
    typeof value.detail !== 'string'
  ) {
    return null
  }
  return {
    sequence: value.sequence,
    at: value.at,
    kind: value.kind,
    label: truncateUtf8(value.label, MAX_WORK_LABEL_BYTES),
    detail: truncateUtf8(value.detail, MAX_WORK_DETAIL_BYTES),
  }
}

/**
 * Validate + re-cap a snapshot read from disk. Anything malformed returns
 * null (the chat starts clean) rather than throwing — a corrupt runtime file
 * must never be able to stop the app from launching.
 */
export function parseRuntimeSnapshot(value: unknown): ChatRuntimeSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (
    typeof value.generationId !== 'string' || !value.generationId ||
    typeof value.sessionId !== 'string' || !value.sessionId ||
    typeof value.originalMessage !== 'string' ||
    typeof value.startedAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !PHASES.has(value.phase as ChatPhase) ||
    typeof value.assistantText !== 'string' ||
    (value.error !== null && typeof value.error !== 'string') ||
    typeof value.resumeAvailable !== 'boolean' ||
    typeof value.lastSequence !== 'number' ||
    !Number.isInteger(value.lastSequence) ||
    value.lastSequence < 0 ||
    !Array.isArray(value.workLog)
  ) {
    return null
  }

  const workLog = value.workLog.map(sanitizeWorkEntry)
  if (workLog.some((entry) => entry === null)) return null

  return {
    version: 1,
    generationId: value.generationId,
    sessionId: value.sessionId,
    originalMessage: truncateUtf8(value.originalMessage, MAX_ORIGINAL_MESSAGE_BYTES),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    phase: value.phase as ChatPhase,
    assistantText: truncateUtf8(value.assistantText, MAX_ASSISTANT_TEXT_BYTES),
    workLog: boundWorkLog(workLog as ChatWorkLogEntry[]),
    error: typeof value.error === 'string' ? truncateUtf8(value.error, MAX_ERROR_BYTES) : null,
    resumeAvailable: value.resumeAvailable,
    lastSequence: value.lastSequence,
  }
}

/**
 * Restore for reattach after a relaunch: a snapshot still marked live has no
 * child process behind it any more, so it lands in `interrupted` with the
 * partial answer and completed work preserved.
 */
export function restoreRuntime(value: unknown, now: string): ChatRuntimeStep | null {
  const parsed = parseRuntimeSnapshot(value)
  if (!parsed) return null
  if (!isLivePhase(parsed.phase)) return { snapshot: parsed, envelope: null }
  return reduceRuntime(parsed, { type: 'interrupted' }, now)
}
