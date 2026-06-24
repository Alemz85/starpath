// Pure board logic for the Applying cockpit: which Kanban column a card lands
// in (groupByStatus) and how cards stack within it (compareByDeadline).
// Extracted from ApplyingView so the bucketing + ordering is unit-testable
// without mounting the view. The timezone-safe deadline *primitives* it builds
// on (deadlineUrgency, deadlineTime) live in lib/utils — this module only owns
// the board-specific composition. Clock-dependent fns take an injectable `now`.

import { deadlineUrgency, deadlineTime } from '@/lib/utils'
import type { AppStatus, ApplicationEntry } from '@/types'

// The five active Kanban stages, in board order. Rejected / Discarded fall to
// the "Closed" strip and SKIP never enters the board — none appear here.
export const STATUS_GROUPS: AppStatus[] = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer']

// Urgency bucket → sort rank (lower = more pressing, floats to the top of its
// column). 'none' (Rolling / no deadline) and 'missed' sink below live dates.
export const URGENCY_RANK: Record<ReturnType<typeof deadlineUrgency>, number> = {
  urgent: 0, month: 1, upcoming: 2, none: 3, missed: 4,
}

// Order cards within a column so the nearest live deadline never sits buried
// under months-out rows: by urgency bucket first, then the actual date.
export function compareByDeadline(a: ApplicationEntry, b: ApplicationEntry, now: Date = new Date()): number {
  const ra = URGENCY_RANK[deadlineUrgency(a.deadline, now)]
  const rb = URGENCY_RANK[deadlineUrgency(b.deadline, now)]
  if (ra !== rb) return ra - rb
  return deadlineTime(a.deadline) - deadlineTime(b.deadline)
}

// Bucket applications into the five active stages, each column sorted by
// compareByDeadline. Statuses outside STATUS_GROUPS (SKIP / Rejected /
// Discarded) are dropped — they don't belong on the board.
export function groupByStatus(
  applications: ApplicationEntry[],
  now: Date = new Date(),
): Record<AppStatus, ApplicationEntry[]> {
  const map = {} as Record<AppStatus, ApplicationEntry[]>
  for (const s of STATUS_GROUPS) map[s] = []
  for (const a of applications) {
    if (a.status in map) map[a.status].push(a)
  }
  for (const s of STATUS_GROUPS) map[s].sort((x, y) => compareByDeadline(x, y, now))
  return map
}

// Deterministic spawn id for a per-card action (Tailor CV / Draft / Prep), so
// re-clicking the same card's action targets the same in-flight spawn.
export function getSpawnId(prefix: string, app: ApplicationEntry): string {
  const cleanCompany = app.company.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const cleanRole = app.role.toLowerCase().replace(/[^a-z0-9]/g, '-')
  return `${prefix}-${cleanCompany}-${cleanRole}`
}
