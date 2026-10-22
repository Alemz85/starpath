// Spawn formatting + diagnosis — the pure core behind store/spawns.ts.
//
// Extracted from the Zustand store so the highest-traffic background-process
// logic (it shapes every `claude -p` invocation and humanizes the stream-json
// every spawn emits) is testable in isolation, with zero zustand/ipc/window
// dependencies. The store imports these, owns the per-spawn line buffer + the
// SpawnRecord shape, and re-exports `claudeArgs` / `NON_INTERACTIVE_SUFFIX`
// for API stability (both are imported by call sites across the app).

import { parseResultUsage, formatCost, type SpawnUsage } from './usage'

// ─── Claude invocation ──────────────────────────────────────────────────────

export type ClaudeModel = 'sonnet' | 'opus' | 'haiku'

// Auto-latest model resolution. Every spawn passes the bare tier alias
// (`opus` / `sonnet` / `haiku`) and the Claude CLI resolves it to the newest
// model it knows in that tier — so spawns upgrade on their own when a new
// generation ships, as long as the CLI itself is kept up to date (an old CLI
// resolves the alias to an old model, and rejects model IDs newer than it).
//
// MODEL_PINS is the opt-out: set a tier to a full model ID to freeze it on that
// version. Empty by default — leave it that way unless a specific version is
// needed. batch/batch-runner.sh follows the same rule (MODEL="opus").
export const MODEL_PINS: Partial<Record<ClaudeModel, string>> = {}

/** The `--model` value for a tier: its pin if one is set, else the bare alias. */
export function modelArg(model: ClaudeModel): string {
  return MODEL_PINS[model] ?? model
}

// Suffix appended to every `claude -p` prompt so the model knows there's no
// human on the other end to confirm anything. Without this, Claude will often
// emit a "should I batch all 47 URLs?" question and exit cleanly when stdin
// is closed — which our activity panel can't distinguish from real success.
//
// The shell sentence is there from the first call: workers run least-privilege
// (dontAsk), and one that opened with `cd …; node scripts/x.mjs …; echo $?`
// was denied before it had read the rule in modes/_shared.md, then stopped.
export const NON_INTERACTIVE_SUFFIX =
  ' — run end-to-end without asking for confirmations; batch and parallelize where possible; if you would normally pause to confirm, proceed with the default and continue working.' +
  ' Shell: run each `node scripts/…` command alone, exactly as named, one per Bash call (no `cd`, no `;`/`&&`/`|` chains, no `echo $?`, no `>` redirects, no `mkdir`); read and search files with the Read, Grep and Glob tools, never `cat`, `sed`, `head` or `ls`.'

// ─── Worker kinds ───────────────────────────────────────────────────────────
//
// Every claude spawn runs least-privilege. The capability table lives in
// scripts/lib/worker-capabilities.mjs (shared with batch/batch-runner.sh);
// the renderer only names the kind with `--starpath-worker <kind>` and the
// main process (shell:spawn) replaces the marker with the derived
// --permission-mode / --tools / --allowedTools / --disallowedTools flags.
// main refuses a claude spawn without a known kind, and any argv that tries to
// widen permissions itself. WORKER_KINDS must list the table's kinds exactly
// (spawnFormat.test.ts compares them).

export const WORKER_FLAG = '--starpath-worker'

export const WORKER_KINDS = [
  'eval', 'eval-app', 'report', 'scan', 'apply-flow', 'positioning',
  'profile-sync', 'company-probe', 'cv-import', 'setup', 'chat',
] as const

export type WorkerKind = typeof WORKER_KINDS[number]

/**
 * Build a prompt string + args for a non-interactive Claude spawn. Use this
 * for every `claude -p` invocation in the app EXCEPT per-listing scouting
 * evaluations — those go through `claudeEvalArgs` in lib/evalSpawn.ts, which
 * adds `--append-system-prompt-file batch/batch-prompt.md` so eval workers
 * load the compact rubric bundle instead of the /career-ops skill router
 * (token-cost lever 3). This one appends the batch suffix, names the worker
 * `kind` (what the run may touch; see Worker kinds above), and asks Claude to
 * emit JSONL events as it works (parsed downstream in appendOutput so the
 * activity panel shows live progress instead of buffering everything until
 * exit).
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
 *
 * The alias goes through modelArg() — the bare alias (CLI resolves it to the
 * latest model in that tier) unless MODEL_PINS freezes it.
 */
export function claudeArgs(slashCommand: string, model: ClaudeModel | undefined, kind: WorkerKind): string[] {
  return [
    WORKER_FLAG, kind,
    '--output-format', 'stream-json',
    '--verbose',
    ...(model ? ['--model', modelArg(model)] : []),
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

export interface JsonlPermissionDenial {
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export interface JsonlEvent {
  type?: string
  subtype?: string
  is_error?: boolean
  permission_denials?: JsonlPermissionDenial[]
  message?: { content?: JsonlAssistantBlock[] }
  result?: string
  duration_ms?: number
  num_turns?: number
  usage?: JsonlUsage
  total_cost_usd?: number
}

export interface HumanizeChunkResult {
  /** Complete, humanized lines ready to append to the spawn's output. */
  lines: string[]
  /** Trailing partial line carried over to prepend to the next chunk. */
  buffer: string
  /** Usage from the final `result` event when this chunk carried it. */
  usage?: SpawnUsage
  /** How the run ended, from the final `result` event when this chunk carried it. */
  result?: RunResult
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
  let usage: SpawnUsage | undefined
  let result: RunResult | undefined
  for (const raw of parts) {
    if (!raw.trim()) continue
    usage = parseResultUsage(raw) ?? usage
    result = parseRunResult(raw) ?? result
    const formatted = humanizeJsonlLine(raw)
    if (formatted == null) continue
    for (const line of formatted.split('\n')) {
      if (line.trim()) lines.push(line)
    }
  }
  return { lines, buffer, ...(usage ? { usage } : {}), ...(result ? { result } : {}) }
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
    const { ok, denied } = runResultOf(evt)
    if (denied.length > 0 && !ok) return `${PERMISSION_BLOCKED_PREFIX} ${denied.slice(0, 3).join('; ')}`
    const capstone = denied.length > 0 ? DONE_WITH_WARNINGS
      : evt.subtype === 'success' ? '✓ Done' : `× ${evt.subtype ?? 'error'}`
    const stats = formatResultStats(evt)
    const last = stats ? `${capstone} — ${stats}` : capstone
    // A run that recovered still lists every call it was refused, above the capstone.
    return denied.length > 0 ? `${PERMISSION_REFUSED_PREFIX} ${denied.join('; ')}\n${last}` : last
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

// A worker that hit its permissions and then ended in error, or reported its
// own run as failed, was stopped by them: the capstone line starts with this
// prefix and the store marks the run failed (Blocked).
export const PERMISSION_BLOCKED_PREFIX = '× Blocked by worker permissions —'

// A worker whose call was refused but which went on to finish its job (a
// harmless read-only check denied, then the scan completed): the refused calls
// are listed on a line with this prefix, the capstone reads DONE_WITH_WARNINGS,
// and the store marks the run done with warnings, not failed.
export const PERMISSION_REFUSED_PREFIX = '⚠ Refused by worker permissions —'
export const DONE_WITH_WARNINGS = '✓ Done with warnings'

/** How a claude run ended, read from its final `result` event. */
export interface RunResult {
  /** The CLI says success (`subtype: 'success'`, `is_error: false`) and the
   *  worker's own final JSON, if any, does not say `"status": "failed"`. */
  ok: boolean
  /** Calls the CLI refused (`permission_denials`), humanized. */
  denied: string[]
}

/**
 * The worker's own verdict on its run: the last `"status"` in the result text
 * (the final JSON summary, batch/batch-prompt.md), as
 * scripts/lib/batch-usage.mjs › extractReported reads it. null when absent.
 */
export function reportedStatus(resultText: unknown): 'completed' | 'failed' | 'skipped_duplicate' | null {
  if (typeof resultText !== 'string') return null
  const all = [...resultText.matchAll(/"status"\s*:\s*"(completed|failed|skipped_duplicate)"/g)]
  return all.length > 0 ? (all[all.length - 1][1] as 'completed' | 'failed' | 'skipped_duplicate') : null
}

/** Fail closed: anything but an explicit success with `is_error: false` is not ok. */
export function runResultOf(evt: JsonlEvent): RunResult {
  const ok = evt.subtype === 'success' && evt.is_error === false && reportedStatus(evt.result) !== 'failed'
  return { ok, denied: permissionDenials(evt) }
}

/** RunResult from one raw JSONL line, or null when it is not a result event. */
export function parseRunResult(raw: string): RunResult | null {
  let evt: JsonlEvent
  try { evt = JSON.parse(raw) as JsonlEvent } catch { return null }
  return evt && evt.type === 'result' ? runResultOf(evt) : null
}

export type FinishedStatus = 'done' | 'error' | 'killed'

/**
 * The status a spawn ends with, and the refused calls to show as warnings.
 * Pure: the store's `finish` calls it.
 *   - stopped by the user → killed; a non-zero exit → error.
 *   - a claude run whose calls were refused: done with warnings when its
 *     result was a success and the worker didn't report failure, else error
 *     (Blocked). A run with no result event but a Blocked line also fails.
 */
export function decideFinishStatus(rec: {
  tool: string
  status: string
  output: string[]
  result?: RunResult
}, exitCode: number): { status: FinishedStatus; warnings?: string[] } {
  if (rec.status === 'killed') return { status: 'killed' }
  if (exitCode !== 0) return { status: 'error' }
  if (rec.tool !== 'claude') return { status: 'done' }
  if (rec.result) {
    if (rec.result.denied.length === 0) return { status: 'done' }
    return rec.result.ok ? { status: 'done', warnings: rec.result.denied } : { status: 'error' }
  }
  return rec.output.some(l => l.startsWith(PERMISSION_BLOCKED_PREFIX)) ? { status: 'error' } : { status: 'done' }
}

/** `["Bash: rm x", "Write: /abs/file"]` from a result event; [] when none. */
export function permissionDenials(evt: JsonlEvent): string[] {
  const list = Array.isArray(evt.permission_denials) ? evt.permission_denials : []
  return list.map(d => {
    const input = (d?.tool_input ?? {}) as Record<string, unknown>
    const what = [input.command, input.file_path, input.url, input.query, input.pattern]
      .find((v): v is string => typeof v === 'string')
    const name = String(d?.tool_name ?? 'tool')
    return what ? `${name}: ${truncate(what, 120)}` : name
  })
}

// Compact "how much did this spawn cost" tail for the result capstone, e.g.
// "3m 04s · 41 turns · 356.2k in (87% cached) / 5.4k out · $0.42". Token visibility in
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
  if (typeof evt.total_cost_usd === 'number' && evt.total_cost_usd > 0) parts.push(formatCost(evt.total_cost_usd))
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
  if (text.includes(PERMISSION_BLOCKED_PREFIX)) return 'The run tried something outside its permissions and was stopped — see its last line.'
  if (AUTH_FAILURE_RE.test(text)) return 'Claude session expired — sign in again to retry.'
  if (/rate limit|\b429\b|overloaded|too many requests/i.test(text)) return 'Claude is rate-limited right now — wait a moment, then retry.'
  if (/\benoent\b|no such file|command not found|cannot find/i.test(text)) return 'A file or command was missing on this machine.'
  if (/\beacces\b|permission denied|not permitted/i.test(text)) return 'Permission was denied while running the task.'
  if (/\benotfound\b|\beconnrefused\b|\betimedout\b|getaddrinfo|fetch failed|socket hang up|network error|timed out/i.test(text)) return 'Network error — check your connection, then retry.'
  return null  // no specific signal — the panel falls back to the exit code
}
