// Agent → user Messages: the shapes main hands the renderer
// (scripts/lib/messages-core.mjs folds data/agent-messages.jsonl) and the pure
// helpers the Messages view and the sidebar badge share.
//
// Messages are optional notes an agent leaves when it is stuck, found an
// important issue, or needs the user's OK before a change. The view lists the
// open ones newest first; resolving or dismissing appends to the file in main.

export type MessageSource = 'calibrate' | 'scheduler' | 'eval' | 'scan' | 'apply' | 'worker' | 'chat' | 'session'
export type MessageKind = 'approval' | 'alert' | 'suggestion' | 'fyi'
export type MessageStatus = 'open' | 'resolved' | 'dismissed'
export type MessageLinkKind = 'report' | 'application' | 'url' | 'file'

export interface MessageLink {
  kind: MessageLinkKind
  /** Repo-relative path (report, file), a URL, or an application key. */
  target: string
  label?: string
}

export interface MessageHistoryEntry {
  at: string
  status: MessageStatus
  note?: string
}

export interface AgentMessage {
  id: string
  created_at: string
  source: MessageSource
  kind: MessageKind
  title: string
  /** Markdown. */
  body: string
  links: MessageLink[]
  key?: string
  status: MessageStatus
  updated_at: string
  resolved_at: string | null
  resolution_note: string | null
  history: MessageHistoryEntry[]
}

export type MessageStatusResult =
  | { ok: true; changed: boolean; message: AgentMessage }
  | { ok: false; error: string; code: string | null }

export const KIND_LABEL: Record<MessageKind, string> = {
  approval:   'Needs your OK',
  alert:      'Alert',
  suggestion: 'Suggestion',
  fyi:        'FYI',
}

export const SOURCE_LABEL: Record<MessageSource, string> = {
  calibrate: 'Calibrate',
  scheduler: 'Weekly run',
  eval:      'Evaluation',
  scan:      'Scan',
  apply:     'CV & application',
  worker:    'Background task',
  chat:      'Chat',
  session:   'Claude session',
}

/** Kinds that ask the user to act: they put the accent on the sidebar badge. */
export const ACT_KINDS: ReadonlySet<MessageKind> = new Set(['approval', 'alert'])

const byCreatedDesc = (a: AgentMessage, b: AgentMessage) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)

/** Open messages newest first; closed ones most recently closed first. */
export function splitMessages(messages: readonly AgentMessage[]): { open: AgentMessage[]; closed: AgentMessage[] } {
  const open = messages.filter(m => m.status === 'open').sort(byCreatedDesc)
  const closed = messages.filter(m => m.status !== 'open').sort((a, b) =>
    (b.resolved_at ?? '').localeCompare(a.resolved_at ?? '') || b.id.localeCompare(a.id))
  return { open, closed }
}

/** The sidebar badge: open count, accented when any open message asks to act. */
export function messagesBadge(messages: readonly AgentMessage[]): { count: number; accent: boolean } {
  let count = 0
  let accent = false
  for (const m of messages) {
    if (m.status !== 'open') continue
    count++
    if (ACT_KINDS.has(m.kind)) accent = true
  }
  return { count, accent }
}

/** What a link reads as when it has no label of its own. */
export function linkLabel(link: MessageLink): string {
  if (link.label) return link.label
  if (link.kind === 'report') {
    const file = link.target.split('/').pop() ?? link.target
    return file.replace(/\.md$/i, '')
  }
  if (link.kind === 'url') {
    try { return new URL(link.target).hostname.replace(/^www\./, '') } catch { return link.target }
  }
  if (link.kind === 'application') return 'Application'
  return link.target
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const min = Math.round((now.getTime() - t) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d > 300 ? 'numeric' : undefined })
}
