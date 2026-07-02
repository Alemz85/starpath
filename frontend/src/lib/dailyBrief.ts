// Daily-brief bridge — pure parsing/shaping for the cockpit's brief panel.
//
// The math lives in the repo's `scripts/lib/daily-brief-core.mjs` (ranked
// sections, cross-section globalPriority, the single "do this first" pick).
// The renderer NEVER re-implements any of it: the Electron main process runs
// `node scripts/daily-brief.mjs --json` (via the existing shell:run channel,
// cwd = repoPath) and this module only
//
//   1. parses/validates the JSON that comes back (`parseBriefJson`),
//   2. trims it to a glanceable display model — top action + the top few
//      items per section, empty sections dropped (`buildBriefDisplay`),
//   3. maps each item onto an existing navigation/action target
//      (`briefItemTarget`) — open the listing URL, or jump to the tab that
//      owns the underlying data. No new flows.
//
// Everything here is a pure function of its inputs — no IPC, no zustand, no
// DOM — so it's unit-testable with plain fixtures.

/* ─── Brief JSON shape (mirror of assembleBrief() in daily-brief-core.mjs) ── */

export type BriefSectionId =
  | 'followups' | 'deadlines' | 'outreach' | 'warmpaths'
  | 'newhits' | 'triage' | 'headsup' | 'insight'

export interface BriefItem {
  key: string
  label: string
  sub: string
  urgency: number
  sortKey: number
  meta: Record<string, unknown>
}

export interface BriefSection {
  id: BriefSectionId
  title: string
  kind: 'action' | 'insight'
  items: BriefItem[]
}

export interface BriefTopAction {
  section: BriefSectionId
  sectionTitle: string
  item: BriefItem
}

export interface DailyBrief {
  asOf: string | null
  period: 'daily' | 'weekly'
  sections: BriefSection[]
  counts: Record<string, number>
  totalActions: number
  topAction: BriefTopAction | null
  pipelineHealth: { active: number; evaluated: number; inboxCount: number } | null
}

/* ─── Parsing ──────────────────────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toItem(raw: unknown): BriefItem | null {
  if (!isRecord(raw) || typeof raw.label !== 'string' || raw.label.length === 0) return null
  return {
    key: typeof raw.key === 'string' ? raw.key : raw.label,
    label: raw.label,
    sub: typeof raw.sub === 'string' ? raw.sub : '',
    urgency: typeof raw.urgency === 'number' ? raw.urgency : 0,
    sortKey: typeof raw.sortKey === 'number' ? raw.sortKey : 0,
    meta: isRecord(raw.meta) ? raw.meta : {},
  }
}

/**
 * Parse the stdout of `scripts/daily-brief.mjs --json` into a typed brief.
 * Tolerant: malformed JSON, a non-object payload, or a missing `sections`
 * array all return null (the panel then renders nothing — never filler).
 * Unknown/malformed items inside a section are dropped, not fatal.
 */
export function parseBriefJson(raw: string | null | undefined): DailyBrief | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!isRecord(parsed) || !Array.isArray(parsed.sections)) return null

  const sections: BriefSection[] = []
  for (const s of parsed.sections) {
    if (!isRecord(s) || typeof s.id !== 'string' || !Array.isArray(s.items)) continue
    const kind = s.kind === 'insight' ? 'insight' : 'action'
    sections.push({
      id: s.id as BriefSectionId,
      title: typeof s.title === 'string' ? s.title : s.id,
      kind,
      items: s.items.map(toItem).filter((it): it is BriefItem => it !== null),
    })
  }

  let topAction: BriefTopAction | null = null
  if (isRecord(parsed.topAction)) {
    const ta = parsed.topAction
    const item = toItem(ta.item)
    if (item && typeof ta.section === 'string') {
      topAction = {
        section: ta.section as BriefSectionId,
        sectionTitle: typeof ta.sectionTitle === 'string' ? ta.sectionTitle : '',
        item,
      }
    }
  }

  let pipelineHealth: DailyBrief['pipelineHealth'] = null
  if (isRecord(parsed.pipelineHealth)) {
    const ph = parsed.pipelineHealth
    pipelineHealth = {
      active: typeof ph.active === 'number' ? ph.active : 0,
      evaluated: typeof ph.evaluated === 'number' ? ph.evaluated : 0,
      inboxCount: typeof ph.inboxCount === 'number' ? ph.inboxCount : 0,
    }
  }

  return {
    asOf: typeof parsed.asOf === 'string' ? parsed.asOf : null,
    period: parsed.period === 'weekly' ? 'weekly' : 'daily',
    sections,
    counts: isRecord(parsed.counts)
      ? Object.fromEntries(Object.entries(parsed.counts).filter(([, v]) => typeof v === 'number')) as Record<string, number>
      : {},
    totalActions: typeof parsed.totalActions === 'number' ? parsed.totalActions : 0,
    topAction,
    pipelineHealth,
  }
}

/* ─── Display model ────────────────────────────────────────────────────────── */

export interface BriefDisplaySection {
  id: BriefSectionId
  title: string
  items: BriefItem[]
  /** How many ranked items were trimmed for scannability ("+N more"). */
  hiddenCount: number
}

export interface BriefInsight {
  sectionId: BriefSectionId
  item: BriefItem
}

export interface BriefDisplay {
  asOf: string | null
  totalActions: number
  topAction: BriefTopAction | null
  /** Action sections with ≥1 item left after the top action is lifted out. */
  sections: BriefDisplaySection[]
  /** Flattened insight-kind items (heads-up + standing positioning note). */
  insights: BriefInsight[]
  /** True when there is genuinely nothing to show — callers render nothing. */
  isEmpty: boolean
}

/**
 * Trim a full brief to the glanceable cockpit model:
 *  - the "do this first" pick is lifted out of its section (never shown twice),
 *  - each remaining action section keeps its top `maxPerSection` items
 *    (the core already ranked them) and reports how many were trimmed,
 *  - empty sections disappear entirely,
 *  - insight-kind sections flatten into quiet one-line notes.
 */
export function buildBriefDisplay(
  brief: DailyBrief,
  { maxPerSection = 3 }: { maxPerSection?: number } = {},
): BriefDisplay {
  const top = brief.topAction
  const sections: BriefDisplaySection[] = []
  const insights: BriefInsight[] = []

  for (const s of brief.sections) {
    if (s.items.length === 0) continue
    if (s.kind === 'insight') {
      for (const item of s.items) insights.push({ sectionId: s.id, item })
      continue
    }
    // Lift the top action out of its own section so it isn't listed twice.
    const items = top && top.section === s.id
      ? s.items.filter(it => it.key !== top.item.key)
      : s.items
    if (items.length === 0) continue
    sections.push({
      id: s.id,
      title: s.title,
      items: items.slice(0, maxPerSection),
      hiddenCount: Math.max(0, items.length - maxPerSection),
    })
  }

  return {
    asOf: brief.asOf,
    totalActions: brief.totalActions,
    topAction: top,
    sections,
    insights,
    isEmpty: !top && sections.length === 0 && insights.length === 0,
  }
}

/* ─── Item → existing navigation/action target ─────────────────────────────── */

export type BriefTarget =
  | { type: 'url'; url: string }
  | { type: 'view'; view: 'applying' | 'outreach' | 'database'; filter?: string }

/** "Acme Corp — Strategy Analyst" → "Acme Corp" (labels are core-built). */
export function briefLabelCompany(label: string): string {
  return label.split(' — ')[0]?.trim() ?? label
}

/**
 * Map a brief item onto the cheapest existing affordance:
 *  - anything carrying a listing URL opens it externally (newhits, triage),
 *  - follow-ups + application deadlines live on the Applying board,
 *  - scouting deadlines live in the Database (pre-filtered to the company),
 *  - outreach nudges + warm paths live on the Outreach tab.
 * Insight notes return null — they're prose, not actions.
 */
export function briefItemTarget(sectionId: BriefSectionId, item: BriefItem): BriefTarget | null {
  const url = item.meta.url
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return { type: 'url', url }

  switch (sectionId) {
    case 'followups':
      return { type: 'view', view: 'applying' }
    case 'deadlines':
      return item.meta.source === 'scouting'
        ? { type: 'view', view: 'database', filter: briefLabelCompany(item.label) }
        : { type: 'view', view: 'applying' }
    case 'outreach':
    case 'warmpaths':
      return { type: 'view', view: 'outreach' }
    case 'newhits':
    case 'triage':
      // No URL on the item (rare) — nowhere cheap to send the user.
      return null
    default:
      return null
  }
}

/** Short verb label for a target, used on the top-action CTA. */
export function briefTargetLabel(target: BriefTarget | null): string | null {
  if (!target) return null
  if (target.type === 'url') return 'Open listing'
  switch (target.view) {
    case 'applying': return 'Open Applying'
    case 'outreach': return 'Open Outreach'
    case 'database': return 'Open Database'
  }
}
