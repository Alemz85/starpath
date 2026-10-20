// Claude CLI invocation for the chat tab.
//
// Same shape as the app's other spawns (`claudeArgs` in lib/spawnFormat.ts,
// `claudeEvalArgs` in lib/evalSpawn.ts) — stream-json so the transcript can
// render live, and the flags of worker kind `chat` (attended: acceptEdits with
// a deny list for destructive and outward actions; derived by
// scripts/lib/worker-capabilities.mjs in main and passed in as
// `permissionArgs`) — plus the two flags chat specifically needs:
//
//   --include-partial-messages   token-level `stream_event` deltas, so the
//                                assistant's answer types out instead of
//                                landing in one block at the end.
//   --append-system-prompt-file  modes/chat.md — the conversational role,
//                                data map, and hard rules. Main passes the
//                                resolved file (`systemPromptFile`: the
//                                user's private override or a composed copy,
//                                via scripts/lib/overrides.mjs); without one
//                                it stays repo-relative, which works because
//                                the spawn's cwd is the repo root.
//
// `--resume` carries the CLI-side conversation: the id arrives on the stream's
// system/init event, is stored on the session, and is passed back on every
// later turn so the agent keeps its own context instead of re-reading the
// pipeline from scratch each message.
//
// Permissions are not built here: every spawn's flags come from the one
// capability table, so "what may a spawn touch?" has one answer.

import type { ModelAlias } from '@/types'
// Relative, not '@/lib/spawnFormat': this file is compiled into the Electron
// main process by tsconfig.electron.json, whose `paths` alias typechecks but is
// never rewritten in the emitted CommonJS — an aliased VALUE import crashes the
// app at boot ("Cannot find module '@/lib/spawnFormat'"). `import type` aliases
// are fine (erased at compile).
import { modelArg } from '../spawnFormat'

/** Repo-relative path to the chat agent's system prompt. */
export const CHAT_SYSTEM_PROMPT_FILE = 'modes/chat.md'

export interface ChatClaudeArgsOptions {
  /** The `chat` worker kind's permission flags (required: no chat without). */
  permissionArgs: string[]
  /** CLI session id from a previous turn; omitted on the first message. */
  resumeId?: string | null
  /** Configured model alias; omitted lets the CLI default apply. */
  model?: ModelAlias | null
  /** Resolved system-prompt file (absolute); defaults to modes/chat.md. */
  systemPromptFile?: string | null
}

export function buildChatClaudeArgs(
  prompt: string,
  options: ChatClaudeArgsOptions,
): string[] {
  if (!options.permissionArgs.includes('--permission-mode')) {
    throw new Error('chat spawn needs its worker permission flags')
  }
  const args = [
    ...options.permissionArgs,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', options.systemPromptFile || CHAT_SYSTEM_PROMPT_FILE,
  ]
  // Same rule as every other spawn: modelArg() passes the bare alias (the CLI
  // resolves it to the latest model in that tier) unless MODEL_PINS freezes it.
  if (options.model) args.push('--model', modelArg(options.model))
  if (options.resumeId) args.push('--resume', options.resumeId)
  args.push('-p', prompt)
  return args
}
