// Chat session store — pure transforms over `{userData}/chat/sessions.json`.
//
// Sessions deliberately do NOT live in the SQLite cache: that cache is fully
// derivable from the repo's Markdown/TSV (frontend/ARCHITECTURE.md), and a
// conversation is not. Deleting cache.db must stay a safe, lossless operation,
// so chat state gets its own JSON file and the cache keeps its invariant.
//
// Every function here is (file, args) -> new file. `electron/chat.ts` owns the
// read/write; nothing in this module touches the filesystem.

import type {
  ChatMessage, ChatProposalDecision, ChatSession, ChatSessionMeta, ChatSessionsFile,
} from './types'
import { truncateUtf8, utf8Length } from './runtime'

/** Conversations kept on disk; the oldest fall off the end. */
export const MAX_SESSIONS = 50
/** Turns kept per conversation. The CLI's own `--resume` context is separate. */
export const MAX_MESSAGES_PER_SESSION = 200
export const MAX_MESSAGE_BYTES = 128 * 1024
export const MAX_TITLE_CHARS = 80
/** Ceiling for the whole serialized file; overflow evicts oldest sessions. */
export const MAX_SESSIONS_FILE_BYTES = 8 * 1024 * 1024
/** Proposal decisions kept per message — one per fence, bounded like the rest. */
export const MAX_DECISIONS_PER_MESSAGE = 20
export const MAX_DECISION_DETAIL_CHARS = 300
export const MAX_ID_CHARS = 200

export function emptySessionsFile(): ChatSessionsFile {
  return { version: 1, sessions: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One persisted decision, or null if the record is unusable. Stored decisions
 *  are only ever terminal — see `ChatProposalDecision`. */
function sanitizeDecision(value: unknown): ChatProposalDecision | null {
  if (!isRecord(value)) return null
  if (value.status !== 'applied' && value.status !== 'dismissed') return null
  if (typeof value.at !== 'string' || !value.at) return null
  const decision: ChatProposalDecision = { status: value.status, at: value.at }
  if (typeof value.detail === 'string' && value.detail) {
    decision.detail = value.detail.slice(0, MAX_DECISION_DETAIL_CHARS)
  }
  return decision
}

function sanitizeDecisions(value: unknown): Record<string, ChatProposalDecision> | undefined {
  if (!isRecord(value)) return undefined
  const entries: Array<[string, ChatProposalDecision]> = []
  for (const [blockId, raw] of Object.entries(value)) {
    if (!blockId || blockId.length > MAX_ID_CHARS) continue
    const decision = sanitizeDecision(raw)
    if (decision) entries.push([blockId, decision])
    if (entries.length >= MAX_DECISIONS_PER_MESSAGE) break
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function sanitizeMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null
  if (
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    typeof value.ts !== 'string'
  ) {
    return null
  }
  const message: ChatMessage = {
    role: value.role,
    content: truncateUtf8(value.content, MAX_MESSAGE_BYTES),
    ts: value.ts,
  }
  // `id` and `proposalDecisions` post-date the original file format, so their
  // absence is normal, not corruption — an older sessions.json loads unchanged.
  if (typeof value.id === 'string' && value.id && value.id.length <= MAX_ID_CHARS) {
    message.id = value.id
  }
  const decisions = sanitizeDecisions(value.proposalDecisions)
  if (decisions) message.proposalDecisions = decisions
  return message
}

function sanitizeSession(value: unknown): ChatSession | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' || !value.id ||
    typeof value.startedAt !== 'string' ||
    !Array.isArray(value.messages)
  ) {
    return null
  }
  const messages = value.messages
    .map(sanitizeMessage)
    .filter((m): m is ChatMessage => m !== null)
    .slice(-MAX_MESSAGES_PER_SESSION)
  return {
    id: value.id,
    startedAt: value.startedAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : value.startedAt,
    title: typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE_CHARS) : '',
    claudeSessionId:
      typeof value.claudeSessionId === 'string' && value.claudeSessionId
        ? value.claudeSessionId
        : null,
    messageCount: messages.length,
    messages,
  }
}

/**
 * Read the sessions file. Any corruption degrades to "no history" rather than
 * throwing — a bad JSON blob must not be able to break the Chat tab.
 */
export function parseSessionsFile(raw: string | null | undefined): ChatSessionsFile {
  if (!raw) return emptySessionsFile()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return emptySessionsFile()
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return emptySessionsFile()
  }
  const sessions = value.sessions
    .map(sanitizeSession)
    .filter((s): s is ChatSession => s !== null)
  return capSessions({ version: 1, sessions })
}

export function serializeSessionsFile(file: ChatSessionsFile): string {
  return JSON.stringify(file)
}

/** Enforce the count cap, the per-session message cap, then the byte cap. */
export function capSessions(file: ChatSessionsFile): ChatSessionsFile {
  let sessions = file.sessions
    .map((session) => {
      const messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION)
      return messages.length === session.messages.length
        ? { ...session, messageCount: messages.length }
        : { ...session, messages, messageCount: messages.length }
    })
    .slice(-MAX_SESSIONS)

  while (
    sessions.length > 1 &&
    utf8Length(JSON.stringify({ version: 1, sessions })) > MAX_SESSIONS_FILE_BYTES
  ) {
    sessions = sessions.slice(1)
  }
  return { version: 1, sessions }
}

/** First line of the opening message, trimmed to a rail-sized label. */
export function deriveTitle(message: string): string {
  const line = message.trim().split('\n').find((l) => l.trim()) ?? ''
  const clean = line.trim().replace(/\s+/g, ' ')
  if (!clean) return 'New chat'
  return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS - 1)}…` : clean
}

export function createSession(
  file: ChatSessionsFile,
  input: { id: string; now: string; title?: string },
): { file: ChatSessionsFile; session: ChatSession } {
  const session: ChatSession = {
    id: input.id,
    startedAt: input.now,
    updatedAt: input.now,
    title: (input.title ?? 'New chat').slice(0, MAX_TITLE_CHARS),
    claudeSessionId: null,
    messageCount: 0,
    messages: [],
  }
  return {
    file: capSessions({ version: 1, sessions: [...file.sessions, session] }),
    session,
  }
}

export function getSession(file: ChatSessionsFile, id: string): ChatSession | null {
  return file.sessions.find((session) => session.id === id) ?? null
}

/** Newest first — the order the session rail renders. */
export function listSessions(file: ChatSessionsFile): ChatSessionMeta[] {
  return [...file.sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ messages: _messages, ...meta }) => meta)
}

function mapSession(
  file: ChatSessionsFile,
  id: string,
  fn: (session: ChatSession) => ChatSession,
): ChatSessionsFile {
  let touched = false
  const sessions = file.sessions.map((session) => {
    if (session.id !== id) return session
    touched = true
    return fn(session)
  })
  return touched ? capSessions({ version: 1, sessions }) : file
}

export function appendMessage(
  file: ChatSessionsFile,
  id: string,
  message: ChatMessage,
): ChatSessionsFile {
  const capped: ChatMessage = {
    ...message,
    content: truncateUtf8(message.content, MAX_MESSAGE_BYTES),
  }
  return mapSession(file, id, (session) => {
    const messages = [...session.messages, capped].slice(-MAX_MESSAGES_PER_SESSION)
    // The first user message names the conversation — an untitled or
    // still-default session adopts it so the rail stops saying "New chat".
    const title =
      capped.role === 'user' && (!session.title || session.title === 'New chat')
        ? deriveTitle(capped.content)
        : session.title
    return {
      ...session,
      title,
      updatedAt: capped.ts,
      messages,
      messageCount: messages.length,
    }
  })
}

export function setClaudeSessionId(
  file: ChatSessionsFile,
  id: string,
  claudeSessionId: string,
): ChatSessionsFile {
  // The init event repeats on every resumed turn — a no-op has to be a real
  // no-op so the caller's write-on-change stays a write-on-change.
  const session = getSession(file, id)
  if (!session || session.claudeSessionId === claudeSessionId) return file
  return mapSession(file, id, (s) => ({ ...s, claudeSessionId }))
}

/**
 * Record what the user did with one proposal card.
 *
 * The decision is stored ON THE MESSAGE that produced the fence, located by
 * `messageId`, so it is evicted together with that message and can never
 * outlive the card it describes. Unknown session or message → the file comes
 * back untouched (the caller reports a miss rather than writing a decision that
 * belongs nowhere).
 *
 * Deliberately does NOT bump `updatedAt`: confirming a card is not a new turn,
 * and re-sorting the session rail on a Confirm click would be a surprise.
 */
export function setProposalDecision(
  file: ChatSessionsFile,
  sessionId: string,
  messageId: string,
  blockId: string,
  decision: ChatProposalDecision,
): ChatSessionsFile {
  const session = getSession(file, sessionId)
  if (!session) return file
  const target = session.messages.find(m => m.id === messageId)
  if (!target) return file
  if (!blockId || blockId.length > MAX_ID_CHARS) return file

  const existing = target.proposalDecisions ?? {}
  // A decision is final. Re-deciding an already-decided block is a no-op, so a
  // duplicate IPC (a double click that raced the re-render) can't rewrite an
  // "applied" card into "dismissed".
  if (existing[blockId]) return file
  if (Object.keys(existing).length >= MAX_DECISIONS_PER_MESSAGE) return file

  const merged = { ...existing, [blockId]: decision }
  return mapSession(file, sessionId, s => ({
    ...s,
    messages: s.messages.map(m =>
      m.id === messageId ? { ...m, proposalDecisions: merged } : m),
  }))
}

export function deleteSession(file: ChatSessionsFile, id: string): ChatSessionsFile {
  const sessions = file.sessions.filter((session) => session.id !== id)
  return sessions.length === file.sessions.length ? file : { version: 1, sessions }
}
