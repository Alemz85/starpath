// Claude CLI invocation for the chat tab.
//
// Same shape as the app's other spawns (`claudeArgs` in lib/spawnFormat.ts,
// `claudeEvalArgs` in lib/evalSpawn.ts) — stream-json so the transcript can
// render live, `--dangerously-skip-permissions` because a headless spawn has
// no one to answer a tool prompt — plus the two flags chat specifically needs:
//
//   --include-partial-messages   token-level `stream_event` deltas, so the
//                                assistant's answer types out instead of
//                                landing in one block at the end.
//   --append-system-prompt-file  modes/chat.md — the conversational role,
//                                data map, and hard rules. Repo-relative
//                                because the spawn's cwd is the repo root
//                                (same convention as batch/batch-prompt.md).
//
// `--resume` carries the CLI-side conversation: the id arrives on the stream's
// system/init event, is stored on the session, and is passed back on every
// later turn so the agent keeps its own context instead of re-reading the
// pipeline from scratch each message.
//
// Deliberately NOT ported from Alke: its inline `--settings` sandbox/permission
// JSON. starpath's established spawn convention is skip-permissions with the
// repo as cwd; introducing a second, divergent permission model for one tab
// would leave two contradictory answers to "what may a spawn touch?".

import type { ModelAlias } from '@/types'
import { MODEL_IDS } from '@/lib/spawnFormat'

/** Repo-relative path to the chat agent's system prompt. */
export const CHAT_SYSTEM_PROMPT_FILE = 'modes/chat.md'

export interface ChatClaudeArgsOptions {
  /** CLI session id from a previous turn; omitted on the first message. */
  resumeId?: string | null
  /** Configured model alias; omitted lets the CLI default apply. */
  model?: ModelAlias | null
}

export function buildChatClaudeArgs(
  prompt: string,
  options: ChatClaudeArgsOptions = {},
): string[] {
  const args = [
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', CHAT_SYSTEM_PROMPT_FILE,
  ]
  // Alias resolved through MODEL_IDS at spawn time — the flag carries a pinned
  // full model ID, never the bare alias (same rule as every other spawn).
  if (options.model) args.push('--model', MODEL_IDS[options.model])
  if (options.resumeId) args.push('--resume', options.resumeId)
  args.push('-p', prompt)
  return args
}
