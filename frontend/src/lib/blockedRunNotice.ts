// Backstop for a background run that hit its worker permissions: if the agent
// didn't already tell the user through Messages itself (the mode files ask it
// to), the app posts one alert so the block doesn't sit unseen in Activity.

import { PERMISSION_BLOCKED_PREFIX } from '@/lib/spawnFormat'
import { spawnSource, sourceLabel } from '@/lib/usage'

export interface BlockedRun {
  id: string
  label: string
  args: string[]
  output: string[]
}

/** The Messages source a spawn posts under (scripts/lib/messages-core.mjs SOURCES). */
export function messageSourceFor(args: string[]): string {
  const src = spawnSource(args)
  if (src === 'app:scan') return 'scan'
  if (src === 'app:evaluate') return 'eval'
  if (src === 'app:pdf' || src === 'app:apply' || src === 'app:interview-prep') return 'apply'
  return 'worker'
}

/** True when the run's own output shows it posted to Messages. */
export function agentPosted(output: string[]): boolean {
  return output.some(l => /messages\.mjs post\b|npm run messages\b.*\bpost\b/.test(l))
}

/**
 * `node` argv for `scripts/messages.mjs post`, or null when the run wasn't
 * blocked or the agent already posted. Keyed per run, so a repeat is a no-op.
 */
export function blockedRunNotice(run: BlockedRun): string[] | null {
  const blockedLine = run.output.find(l => l.startsWith(PERMISSION_BLOCKED_PREFIX))
  if (!blockedLine || agentPosted(run.output)) return null
  const what = blockedLine.slice(PERMISSION_BLOCKED_PREFIX.length).trim()
  const name = run.label || sourceLabel(spawnSource(run.args))
  const body = [
    `**${name}** stopped part of its work because its permissions refused a step:`,
    '',
    `> ${what || 'a tool call outside its permissions'}`,
    '',
    'Whatever came after that step was not done. Open **Activity** for the full log, and ask Claude to finish it or widen that worker\'s permissions (`scripts/lib/worker-capabilities.mjs`).',
  ].join('\n')
  return [
    'scripts/messages.mjs', 'post',
    '--source', messageSourceFor(run.args),
    '--kind', 'alert',
    '--title', `${name} was blocked by its permissions`,
    '--body', body,
    '--key', `blocked:${run.id}`,
  ]
}
