// Spawn formatting + diagnosis — the pure core behind store/spawns.ts.
//
// Extracted from the Zustand store so the highest-traffic background-process
// logic (it shapes every `claude -p` invocation and humanizes the stream-json
// every spawn emits) is testable in isolation, with zero zustand/ipc/window
// dependencies. The store imports these, owns the per-spawn line buffer + the
// SpawnRecord shape, and re-exports `claudeArgs` / `NON_INTERACTIVE_SUFFIX`
// for API stability (both are imported by call sites across the app).

// ─── Claude invocation ──────────────────────────────────────────────────────

// Suffix appended to every `claude -p` prompt so the model knows there's no
// human on the other end to confirm anything. Without this, Claude will often
// emit a "should I batch all 47 URLs?" question and exit cleanly when stdin
// is closed — which our activity panel can't distinguish from real success.
export const NON_INTERACTIVE_SUFFIX =
  ' — run end-to-end without asking for confirmations; batch and parallelize where possible; if you would normally pause to confirm, proceed with the default and continue working.'

/**
 * Build a prompt string + args for a non-interactive Claude spawn. Use this
 * for every `claude -p` invocation in the app EXCEPT per-listing scouting
 * evaluations — those go through `claudeEvalArgs` in lib/evalSpawn.ts, which
 * adds `--append-system-prompt-file batch/batch-prompt.md` so eval workers
 * load the compact rubric bundle instead of the /career-ops skill router
 * (token-cost lever 3). This one appends the batch suffix,
 * adds `--dangerously-skip-permissions` so tool-permission prompts can't
 * silently hang the run, and asks Claude to emit JSONL events as it works
 * (parsed downstream in appendOutput so the activity panel shows live
 * progress instead of buffering everything until exit).
 *
 * `model` is explicit per call site — keeps the model decision close to the
 * action being fired. Convention:
 *   - Full Scan → hardcoded 'sonnet' (cheap tool-use; not user-configurable)
 *   - Everything else (3 pipeline buttons, Tailor CV, Draft, Prep,
 *     popover Generate Report) → read from user's ModelPrefs in the app
 *     store. Defaults to 'opus'. The cockpit Model chip writes to
 *     `pipeline`; Settings → Models writes to all five fields.
 * Pass undefined to omit the flag entirely and let the Claude CLI default
 * apply (used as a graceful fallback if a caller can't decide).
 */
export function claudeArgs(slashCommand: string, model?: 'sonnet' | 'opus' | 'haiku'): string[] {
  return [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    ...(model ? ['--model', model] : []),
    '-p',
    slashCommand + NON_INTERACTIVE_SUFFIX,
  ]
}

// ─── JSONL humanizer for Claude stream-json output ──────────────────────────
//
// `claude -p --output-format stream-json` writes one JSON event per line.
// Each event is one of: {type: "system", ...}, {type: "assistant",
// message: {content: [...]}}, {type: "user", message: {content: [...]}},
// {type: "result", ...}. We surface only the "humanized" parts:
//   - assistant text blocks (Claude's prose)
//   - assistant tool_use blocks rendered as compact one-liners
//   - the final result event as a "✓ Done" / "× error" capstone
// system events and tool_result echoes are dropped — too noisy.

export interface JsonlAssistantBlock {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface JsonlUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

export interface JsonlEvent {
  type?: string
  subtype?: string
  message?: { content?: JsonlAssistantBlock[] }
  result?: string
  duration_ms?: number
  num_turns?: number
  usage?: JsonlUsage
}

export interface HumanizeChunkResult {
  /** Complete, humanized lines ready to append to the spawn's output. */
  lines: string[]
  /** Trailing partial line carried over to prepend to the next chunk. */
  buffer: string
}

// Humanize a raw stdout chunk against the carry-over buffer from the previous
// chunk. Chunks from the pipe may split a JSONL line mid-line, so the trailing
// incomplete line is returned in `buffer` for the caller to feed back in next
// time. Pure: the caller (the store) owns the per-spawn buffer map; this just
// does string-in, lines-out so the split-line stitching is assertable.
export function humanizeJsonlChunk(prevBuffer: string, chunk: string): HumanizeChunkResult {
  const parts = (prevBuffer + chunk).split('\n')
  const buffer = parts.pop() ?? ''  // last item is incomplete — carry it over
  const lines: string[] = []
  for (const raw of parts) {
    if (!raw.trim()) continue
    const formatted = humanizeJsonlLine(raw)
    if (formatted == null) continue
    for (const line of formatted.split('\n')) {
      if (line.trim()) lines.push(line)
    }
  }
  return { lines, buffer }
}

export function humanizeJsonlLine(raw: string): string | null {
  let evt: JsonlEvent
  try {
    evt = JSON.parse(raw) as JsonlEvent
  } catch {
    return raw  // not valid JSON — surface verbatim so we never silently swallow
  }

  if (evt.type === 'system') return null
  if (evt.type === 'result') {
    const capstone = evt.subtype === 'success' ? '✓ Done' : `× ${evt.subtype ?? 'error'}`
    const stats = formatResultStats(evt)
    return stats ? `${capstone} — ${stats}` : capstone
  }
  if (evt.type === 'assistant' && evt.message?.content) {
    const parts: string[] = []
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      } else if (block.type === 'tool_use') {
        const line = formatToolUse(block)
        if (line) parts.push(line)
      }
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  // user (tool_result echoes) and unknown types — skip.
  return null
}

// Compact "how much did this spawn cost" tail for the result capstone, e.g.
// "3m 04s · 41 turns · 356.2k in (87% cached) / 5.4k out". Token visibility in
// the activity panel is the user-facing half of the token-cost measurement
// work (the batch runner logs the same numbers to batch/logs/usage.tsv).
// Returns null when the event carries no stats (older CLI versions).
export function formatResultStats(evt: JsonlEvent): string | null {
  const parts: string[] = []
  if (typeof evt.duration_ms === 'number' && evt.duration_ms >= 0) {
    parts.push(formatDuration(evt.duration_ms))
  }
  if (typeof evt.num_turns === 'number' && evt.num_turns > 0) {
    parts.push(`${evt.num_turns} turns`)
  }
  const u = evt.usage
  if (u) {
    const inTotal = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const out = u.output_tokens ?? 0
    if (inTotal > 0 || out > 0) {
      const cached = u.cache_read_input_tokens ?? 0
      const cachedPct = inTotal > 0 && cached > 0 ? ` (${Math.round((cached / inTotal) * 100)}% cached)` : ''
      parts.push(`${formatTokens(inTotal)} in${cachedPct} / ${formatTokens(out)} out`)
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec}s`
  return `${min}m ${String(sec).padStart(2, '0')}s`
}

export function formatToolUse(block: JsonlAssistantBlock): string | null {
  const name = String(block.name ?? 'Tool')
  const input = (block.input ?? {}) as Record<string, unknown>
  if (name === 'TodoWrite') return null  // purely internal scheduling, not interesting

  const get = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = get('file_path') || get('path')
      return path ? `→ ${name} ${path}` : `→ ${name}`
    }
    case 'Bash':
      return `→ Bash: ${truncate(get('command'), 80)}`
    case 'Glob':
    case 'Grep': {
      const pat = get('pattern') || get('path')
      return `→ ${name} ${truncate(pat, 80)}`
    }
    case 'WebFetch':
      return `→ WebFetch ${truncate(get('url'), 80)}`
    case 'WebSearch':
      return `→ WebSearch ${truncate(get('query'), 80)}`
    default: {
      // Browser/Playwright/MCP/Agent tools — show name + first stringy input
      // value if compact, else just the tool name.
      const firstVal = Object.values(input).find(v => typeof v === 'string') as string | undefined
      return firstVal ? `→ ${name} ${truncate(firstVal, 80)}` : `→ ${name}`
    }
  }
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

// ─── Failure diagnosis ──────────────────────────────────────────────────────
// Turn a failed run's raw output into a one-line, human-actionable cause so the
// activity panel doesn't make the user scroll a log to figure out what broke.

// Auth-failure signatures Claude prints when its token is dead. Deliberately
// specific phrases — a bare `401` would false-positive on job-search content
// like "401(k)". Matched against raw claude-spawn output to raise the global
// re-login banner the moment a run dies on auth instead of letting it read as
// a generic error.
export const AUTH_FAILURE_RE =
  /oauth token has expired|authentication_error|invalid bearer token|invalid x-api-key|invalid api key|please run \/login|401 unauthorized|unauthorized[^a-z0-9]{0,12}401/i

// Does this text carry an auth-death signature? Operates on already-joined
// output (or a single raw chunk) so both the store's live chunk-watch and the
// finished-record check share one definition.
export function isAuthFailureText(text: string): boolean {
  return AUTH_FAILURE_RE.test(text)
}

// First matching, human-actionable cause for a failed run's output, or null
// when no signal stands out (the panel then falls back to the exit code).
// Order matters: auth is the most specific + most common, then the rest.
export function diagnoseFailureText(text: string): string | null {
  if (AUTH_FAILURE_RE.test(text)) return 'Claude session expired — sign in again to retry.'
  if (/rate limit|\b429\b|overloaded|too many requests/i.test(text)) return 'Claude is rate-limited right now — wait a moment, then retry.'
  if (/\benoent\b|no such file|command not found|cannot find/i.test(text)) return 'A file or command was missing on this machine.'
  if (/\beacces\b|permission denied|not permitted/i.test(text)) return 'Permission was denied while running the task.'
  if (/\benotfound\b|\beconnrefused\b|\betimedout\b|getaddrinfo|fetch failed|socket hang up|network error|timed out/i.test(text)) return 'Network error — check your connection, then retry.'
  return null  // no specific signal — the panel falls back to the exit code
}
