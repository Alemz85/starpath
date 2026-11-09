// Prompt-cache flag for eval spawns (token-cost lever 4), added by the main
// process at spawn time. Pure, so the "only when the CLI knows it" rule is tested.

export const CACHE_FLAG = '--exclude-dynamic-system-prompt-sections'

/**
 * Add the prompt-cache flag to an eval worker's argv when the installed CLI
 * knows it (`claude --help` lists it). An unknown flag fails the spawn, so an
 * older CLI, or a help text that could not be read, leaves argv untouched.
 * Only spawns that pass a system-prompt file (the compact eval bundle) get it.
 */
export function withCacheFlag(argv: string[], helpText: string | null | undefined): string[] {
  if (!helpText || !helpText.includes(CACHE_FLAG)) return argv
  if (!argv.includes('--append-system-prompt-file') || argv.includes(CACHE_FLAG)) return argv
  return [CACHE_FLAG, ...argv]
}
