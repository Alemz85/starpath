// Chat subsystem types — shared by the Electron main process (which owns the
// live generation) and the renderer (which reattaches to it).
//
// This module is deliberately dependency-free: `tsconfig.electron.json`
// compiles `src/lib/chat/**/*` into the CommonJS main bundle, so nothing here
// (or anywhere else under `src/lib/chat/`) may import React, zustand, or
// `@/lib/ipc`. Pure data + pure functions only.

/** Phase of the single live generation. Mirrors the Alke chat stack. */
export type ChatPhase =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'

/** Phases where a generation is still owned by a live child process. */
export const NONTERMINAL_PHASES: readonly ChatPhase[] = ['starting', 'running', 'stopping']

export function isLivePhase(phase: ChatPhase | undefined): boolean {
  return phase !== undefined && NONTERMINAL_PHASES.includes(phase)
}

/**
 * One increment of a generation, pushed to the renderer on `chat:event`.
 * Every envelope carries a monotonic `sequence` so a renderer that mounts
 * mid-generation can drop anything it already folded in from `chat:state`.
 */
export type ChatStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

export interface ChatRuntimeEnvelope {
  generationId: string
  sessionId: string
  sequence: number
  event: ChatStreamEvent
}

/** A single line in the compact work log (what the agent is doing right now). */
export interface ChatWorkLogEntry {
  sequence: number
  at: string
  kind: 'status' | 'tool'
  label: string
  detail: string
}

/**
 * The persisted live-generation snapshot (`{userData}/chat/runtime.json`).
 * Survives an app quit so a relaunch can show the partial answer that was on
 * screen instead of losing it — a generation still marked non-terminal on
 * restore is transitioned to `interrupted`.
 */
export interface ChatRuntimeSnapshot {
  version: 1
  generationId: string
  sessionId: string
  /** The user message that started this generation (used by retry). */
  originalMessage: string
  startedAt: string
  updatedAt: string
  phase: ChatPhase
  assistantText: string
  workLog: ChatWorkLogEntry[]
  error: string | null
  /** True once the CLI reported a session id we can `--resume` from. */
  resumeAvailable: boolean
  lastSequence: number
}

/**
 * What the user did with one proposal card (`lib/chat/proposals.ts`). Only
 * TERMINAL outcomes persist: a failed apply is transient state the card holds
 * in memory so Confirm can be retried, and writing it here would freeze a
 * recoverable error into the transcript forever.
 */
export type ChatProposalDecisionStatus = 'applied' | 'dismissed'

export interface ChatProposalDecision {
  status: ChatProposalDecisionStatus
  /** ISO timestamp, always stamped in the main process — never by the caller. */
  at: string
  /** Short human-readable trace of what was written. */
  detail?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  ts: string
  /**
   * Stable per-message id, assigned when the message is appended. Proposal
   * block ids are derived from it, which is what lets a Confirm/Dismiss
   * decision survive a restart. OPTIONAL because sessions persisted before
   * proposal cards existed have no id — those turns predate the fence contract
   * and so carry no proposals, but they must still load.
   */
  id?: string
  /** blockId → decision, for the proposal fences in this message. */
  proposalDecisions?: Record<string, ChatProposalDecision>
}

export interface ChatSessionMeta {
  id: string
  startedAt: string
  updatedAt: string
  title: string
  /** Claude CLI session id, captured from the stream's system/init event. */
  claudeSessionId: string | null
  messageCount: number
}

export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[]
}

/** Shape of `{userData}/chat/sessions.json`. */
export interface ChatSessionsFile {
  version: 1
  sessions: ChatSession[]
}
