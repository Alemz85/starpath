// stream-json interpretation for the chat tab.
//
// `claude -p --output-format stream-json --verbose --include-partial-messages`
// writes one JSON event per line. The activity panel's humanizer
// (lib/spawnFormat.ts) turns those into log lines; chat needs something
// different — the assistant's prose has to stream into the transcript while
// tool activity stays out of it, condensed into a work-log line instead.
//
// So this module maps each event to zero or more *directives* the caller folds
// into the runtime, and reuses spawnFormat's `formatToolUse` for the tool
// label so "what does a Bash call look like" has exactly one definition in the
// app.

import { formatToolUse } from '../spawnFormat'

export type ChatStreamDirective =
  /** The CLI's own session id — store it, then `--resume` from it next turn. */
  | { kind: 'session'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'work'; entry: { kind: 'status' | 'tool'; label: string; detail: string } }

/** Per-generation dedup/one-shot state. Owned and mutated by the caller. */
export interface ChatStreamState {
  seenToolIds: Set<string>
  thinkingNoted: boolean
  /** Whether any assistant text has been emitted yet this generation. */
  textStarted: boolean
  /** Whether the emitted text currently ends with a newline. */
  endsWithNewline: boolean
}

export function newChatStreamState(): ChatStreamState {
  return { seenToolIds: new Set(), thinkingNoted: false, textStarted: false, endsWithNewline: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compact work-log label for one tool call. Built on spawnFormat's
 * `formatToolUse` (so paths, commands, and truncation match the activity
 * panel) with its `→ ` log prefix stripped — the work log has its own glyph.
 * Returns null for tools the humanizer deliberately drops (TodoWrite).
 */
export function chatToolLabel(name: string, input: Record<string, unknown>): string | null {
  const formatted = formatToolUse({ name, input })
  if (formatted == null) return null
  return formatted.replace(/^→\s*/, '') || name
}

/**
 * Read a user-facing failure that the CLI reports inside the JSON stream
 * rather than on stderr — without this, a refused or errored run surfaces as a
 * bare "exited with code 1". Ported from Alke's chatPolicy.extractClaudeCliFailure.
 */
export function extractClaudeCliFailure(event: unknown): string | null {
  if (!isRecord(event)) return null
  if (event.type === 'assistant' && typeof event.error === 'string') {
    const message = isRecord(event.message) ? event.message : null
    const content = Array.isArray(message?.content) ? message!.content : []
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim()
      ) {
        return block.text.trim()
      }
    }
  }
  if (event.type === 'result' && event.is_error === true && typeof event.result === 'string') {
    return event.result.trim() || null
  }
  return null
}

/** Map one parsed stream-json event to the directives it implies. */
export function interpretChatEvent(
  event: unknown,
  state: ChatStreamState,
): ChatStreamDirective[] {
  if (!isRecord(event)) return []

  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    return [{ kind: 'session', id: event.session_id }]
  }

  if (event.type === 'stream_event') {
    const inner = isRecord(event.event) ? event.event : null
    if (!inner) return []

    if (inner.type === 'content_block_start') {
      const block = isRecord(inner.content_block) ? inner.content_block : null
      if (block?.type === 'text' && state.textStarted && !state.endsWithNewline) {
        // A new text block after tool work — keep paragraphs apart so the
        // transcript doesn't run two thoughts together.
        return [emitText('\n\n', state)]
      }
      if (block?.type === 'thinking' && !state.thinkingNoted) {
        state.thinkingNoted = true
        return [{ kind: 'work', entry: { kind: 'status', label: 'Thinking it through', detail: '' } }]
      }
      return []
    }

    if (inner.type === 'content_block_delta') {
      const delta = isRecord(inner.delta) ? inner.delta : null
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        return [emitText(delta.text, state)]
      }
    }
    return []
  }

  if (event.type !== 'assistant') return []

  // Tool calls arrive on the non-partial `assistant` event. Text blocks on the
  // same event are skipped — `--include-partial-messages` already streamed
  // them, and re-emitting would double every answer.
  const message = isRecord(event.message) ? event.message : null
  const content = Array.isArray(message?.content) ? message!.content : []
  const directives: ChatStreamDirective[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    const toolId = typeof block.id === 'string' ? block.id : JSON.stringify(block)
    if (state.seenToolIds.has(toolId)) continue
    state.seenToolIds.add(toolId)
    const name = String(block.name ?? 'Tool')
    const input = isRecord(block.input) ? block.input : {}
    const label = chatToolLabel(name, input)
    if (!label) continue
    directives.push({ kind: 'work', entry: { kind: 'tool', label, detail: safeJson(input) } })
  }
  return directives
}

function emitText(text: string, state: ChatStreamState): ChatStreamDirective {
  state.textStarted = true
  state.endsWithNewline = text.endsWith('\n')
  return { kind: 'text', text }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/**
 * Split a raw stdout chunk into complete JSON lines against the carry-over
 * buffer from the previous chunk (the pipe can split a line mid-way).
 * Mirrors `humanizeJsonlChunk`'s buffering contract; unparseable lines are
 * dropped — the CLI can emit a half-written final line while being killed.
 */
export function splitStreamChunk(
  prevBuffer: string,
  chunk: string,
): { events: unknown[]; buffer: string } {
  const parts = (prevBuffer + chunk).split('\n')
  const buffer = parts.pop() ?? ''
  const events: unknown[] = []
  for (const raw of parts) {
    const parsed = parseStreamLine(raw)
    if (parsed !== null) events.push(parsed)
  }
  return { events, buffer }
}

export function parseStreamLine(raw: string): unknown | null {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
