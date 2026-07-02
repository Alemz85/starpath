// Types + pure presentation logic for the Network view.
//
// The heavy lifting — parsing data/network.md / data/outreach.md, matching the
// roster against the pipeline, running the outreach-plan decision ladder — is
// NOT done here. The Electron main process composes the repo's own pure cores
// (scripts/lib/network-lens-core.mjs) and ships the finished overview over the
// `network:overview` IPC channel; these interfaces mirror that JSON shape, and
// the functions below are the small renderer-side joins/partitions the view
// needs on top of it. Pure, no I/O — tested with fictional fixtures in
// networkLens.test.ts.

// ─── The IPC shape (mirrors buildNetworkOverview's return) ───────────────────

/** Outreach-plan decision-ladder plays, most actionable first. */
export type PlayId =
  | 'reply-handoff'
  | 'nudge'
  | 'warm-direct'
  | 'warm-intro'
  | 'wait'
  | 'cold-search'

/** Cadence verdicts — same vocabulary as the Outreach board / Today cockpit. */
export type ThreadAction = 'nudge' | 'waiting' | 'cold' | 'done'

export interface NetworkContact {
  num: number
  name: string
  company: string
  companyKey: string
  title: string
  relationship: 'strong' | 'medium' | 'weak'
  degree: 1 | 2
  via: string
  lastContact: string
  notes: string
}

export interface RoleRef {
  role: string
  score: number
  source: 'application' | 'scouting'
}

export interface WarmPath {
  name: string
  title: string
  relationship: string
  degree: number
  via: string
  lastContact: string
  warmth: number
  leverage: 'manager' | 'peer' | 'recruiter' | 'neutral'
  /** Thread state when this person already has a logged outreach thread;
   *  null = untouched (which is what makes the path actionable). */
  thread: { action: string; touches: number | null; lastTouch: string | null } | null
}

export interface PlayTarget {
  name: string
  title: string | null
  leverage: string | null
  warmth: number | null
  degree: number | null
  via: string | null
}

export interface CompanyPath {
  company: string
  companyKey: string
  topRole: RoleRef | null
  roles: RoleRef[]
  play: PlayId
  target: PlayTarget | null
  reason: string
  channel: string | null
  cautions: string[]
  paths: WarmPath[]
  counts: { paths: number; untouched: number }
}

export interface NetworkGap {
  company: string
  companyKey: string
  topScore: number
  roles: RoleRef[]
}

export interface LatentLead {
  name: string
  company: string
  companyKey: string
  title: string
  relationship: string
  degree: number
  via: string
  lastContact: string
  warmth: number
  notes: string
}

export interface NetworkThread {
  company: string
  contact: string
  role: string
  title: string
  channel: string
  action: ThreadAction
  state: string
  leverage: string
  daysSince: number | null
  nextNudge: string | null
  touches: number | null
  lastTouch: string
  reason: string
}

export interface NetworkOverview {
  today: string | null
  roster: NetworkContact[]
  companies: CompanyPath[]
  gaps: NetworkGap[]
  latentLeads: LatentLead[]
  threads: NetworkThread[]
  counts: {
    contacts: number
    pipelineTargets: number
    companiesWithPath: number
    gaps: number
    latentLeads: number
    threads: number
    dueNudges: number
  }
}

// ─── Renderer-side helpers ───────────────────────────────────────────────────

/** The apply threshold from the score-interpretation ladder (modes/_shared.md
 *  § Score interpretation) — a gap only demands a referral hunt when the role
 *  is worth applying to. */
export const GAP_SCORE_THRESHOLD = 7.0

/** Split coverage gaps into the ones worth acting on (best role at/above the
 *  apply threshold) and the quiet rest. Order within each half is preserved
 *  (the core already ranks by topScore desc). */
export function partitionGaps(
  gaps: NetworkGap[],
  threshold: number = GAP_SCORE_THRESHOLD,
): { priority: NetworkGap[]; rest: NetworkGap[] } {
  const priority: NetworkGap[] = []
  const rest: NetworkGap[] = []
  for (const g of gaps) (g.topScore >= threshold ? priority : rest).push(g)
  return { priority, rest }
}

/** "1st°" / "2nd° via Ada Vega" / "2nd°" — the hop-count shorthand. */
export function degreeLabel(degree: number, via?: string | null): string {
  if (degree !== 2) return '1st°'
  const bridge = (via ?? '').trim()
  return bridge ? `2nd° via ${bridge}` : '2nd°'
}

/** A roster row joined with what the rest of the overview knows about it. */
export interface RosterRow {
  contact: NetworkContact
  /** True when the contact's company has ≥1 pipeline target (they're part of
   *  a warm path); false = latent lead (known person, untargeted company). */
  inPipeline: boolean
  /** The contact's own outreach thread, when one exists (matched on
   *  normalized company + name). */
  thread: NetworkThread | null
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Join the roster against the matched companies and the classified threads —
 *  one row per contact, so the roster table can show at a glance who is on a
 *  live path, who already has a thread, and who is a latent lead. Preserves
 *  the roster's on-disk order. */
export function buildRosterRows(overview: NetworkOverview): RosterRow[] {
  const pipelineKeys = new Set(overview.companies.map(c => c.companyKey))
  const threadByKey = new Map<string, NetworkThread>()
  for (const t of overview.threads) {
    threadByKey.set(`${norm(t.company)}|${norm(t.contact)}`, t)
  }
  return overview.roster.map(contact => ({
    contact,
    inPipeline: pipelineKeys.has(contact.companyKey),
    thread: threadByKey.get(`${norm(contact.company)}|${norm(contact.name)}`) ?? null,
  }))
}

/** True when there is genuinely nothing to show — no roster AND no threads
 *  (an outreach log can exist before the roster does). */
export function isNetworkEmpty(overview: NetworkOverview): boolean {
  return overview.roster.length === 0 && overview.threads.length === 0
}
