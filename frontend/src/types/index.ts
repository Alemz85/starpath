// ─── App config ───────────────────────────────────────────────────────────────

export type ModelAlias = 'sonnet' | 'opus' | 'haiku'

export interface ModelPrefs {
  /** The 3 pipeline buttons in the Scouting cockpit (Filter to Database,
   *  Generate Top Reports, Generate All Reports). Editable both in Settings
   *  and inline via the cockpit Model chip — they read/write the same field. */
  pipeline: ModelAlias
  /** Tailor CV per-listing action (modes/pdf.md). Settings-only. */
  tailorCv: ModelAlias
  /** Draft Application per-listing action (modes/apply.md). Settings-only. */
  draftApp: ModelAlias
  /** Prep Application per-listing action (modes/interview-prep.md). Settings-only. */
  interviewPrep: ModelAlias
  /** Generate Report from the database popover / slide-over. Settings-only. */
  generateReport: ModelAlias
  // NOTE: Full Scan is intentionally NOT in this struct — it's hardcoded to
  // 'sonnet' at the call site (cheap tool-use; user shouldn't be paying Opus
  // rates for a portal scan that just hits Greenhouse/Ashby APIs).
}

export const DEFAULT_MODEL_PREFS: ModelPrefs = {
  pipeline:       'opus',
  tailorCv:       'opus',
  draftApp:       'opus',
  interviewPrep:  'opus',
  generateReport: 'opus',
}

// Optional UI surfaces that can be deactivated per user (Settings › General ›
// Features). Deactivating hides the surface everywhere (sidebar, sub-tabs,
// CmdK, panels, columns) — the code stays, so flipping the switch brings it
// back without a rebuild. Data files and CLIs are unaffected either way.
export const FEATURE_IDS = [
  /** Today tab — the cross-pipeline "What's next?" landing cockpit. */
  'todayView',
  /** Outreach tab, including its Network sub-tab (warm-outreach lens). */
  'outreachView',
  /** Offers tab — weighted offer-comparison view. */
  'offersView',
  /** Trends › Score Trend sub-tab (re-evaluation trajectory). */
  'scoreTrendTab',
  /** Daily-brief digest panel embedded in the Scouting cockpit. */
  'dailyBriefPanel',
  /** Peers column in the Database table + peer-context card in the report slide-over. */
  'peerContext',
  /** Closed-applications (rejected/discarded) lane on the Applying view. */
  'closedLane',
] as const

export type FeatureId = (typeof FEATURE_IDS)[number]

export type FeaturePrefs = Record<FeatureId, boolean>

// System default is everything ON — deactivation is a per-user choice stored
// in the app config, never baked into the code.
export const DEFAULT_FEATURE_PREFS: FeaturePrefs = {
  todayView:       true,
  outreachView:    true,
  offersView:      true,
  scoreTrendTab:   true,
  dailyBriefPanel: true,
  peerContext:     true,
  closedLane:      true,
}

export interface AppConfig {
  repoPath?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
  tailoringComplete?: boolean
  models?: ModelPrefs
  features?: Partial<FeaturePrefs>
}

// ─── Scoring v2 vocabulary (docs/scoring-v2.md) ──────────────────────────────

/** Eligibility gate (spec §1): a gate, not a score. `red` = Blocked. */
export type Eligibility = 'green' | 'amber' | 'red'

/** The six eligibility checks (spec §1.2). Readers still tolerate an unknown
 *  check key from a newer engine — labels go through `eligibilityCheckLabel`
 *  (lib/scoreBands), which falls back to a humanised key. */
export const ELIGIBILITY_CHECKS = ['start_date', 'duration', 'graduation', 'language', 'work_auth', 'other'] as const
export type EligibilityCheckKey = (typeof ELIGIBILITY_CHECKS)[number]

/** One non-green check, as stored in score-history `eligibility_flags`
 *  (`check:status:reason`, `;`-joined) or parsed from a report's
 *  `## Eligibility` table. `question` only comes from the report body. */
export interface EligibilityFlag {
  check: string
  status: Eligibility
  reason: string
  question?: string
}

/** Verdict cell of the Want × Ease grid (spec §4). */
export type Verdict = 'go' | 'stretch' | 'growth' | 'solid' | 'thin' | 'skip' | 'blocked'

// ─── Score history (data/score-history.tsv) ───────────────────────────────────

/** One v2 score-history row (spec §8.1, 29 columns, parsed by header name).
 *  Every numeric column is `null` when its cell is empty — blocked (red) rows
 *  carry no dimensions, no Want, no Ease and no Priority. Never coerce a null
 *  to 0: a 0 reads as a real (terrible) score. */
export interface ScoreEntry {
  date: string
  archetype: string
  // Ease dimensions (1–10, high = easier)
  skills_match: number | null
  experience_bar: number | null
  competition: number | null
  ease: number | null
  // Want motivators (1–10)
  growth_mobility: number | null
  optionality_exit: number | null
  brand_value: number | null
  role_content: number | null
  // Want hygiene factors (1–10)
  best_cities: number | null
  salary_adj_city: number | null
  work_life_balance: number | null
  want: number | null
  /** round(sqrt(want × ease), 2) — a sort key only, never a headline (§5). */
  priority: number | null
  /** null only for a malformed row with no eligibility cell. */
  eligibility: Eligibility | null
  /** Raw `eligibility_flags` cell — `check:status:reason;…`, empty when green.
   *  Parse with `parseEligibilityFlags` (lib/scoreBands). */
  eligibility_flags: string
  /** Verdict key; derived from the grid when the cell is empty. */
  verdict: Verdict | null
  best_fit_roles: string
  mode: 'scouting' | 'oferta'
  company: string
  role: string
  tier: 'T1' | 'T2' | 'T3' | 'T4' | string
  source: string
  location: string
  employment_type: string
  duration: string
  salary_raw: string
  /** The listing URL — the stable join key between score_history and
   *  reports_index. */
  url: string
  /** Sibling entities sharing the same (company, role-canonical) but a
   *  different city — populated by the Database grouping pass when the
   *  row is being rendered as a group's primary. Each sibling is a
   *  fully-populated ScoreEntry (the latest evaluation for that entity).
   *  Includes both active and historical siblings; the renderer
   *  classifies them by joining against the liveness map. Undefined
   *  for rows not in a sibling group. */
  siblings?: ScoreEntry[]
  /** Liveness state of THIS row — derived once during the grouping
   *  pass (using the same default-to-active rule as the liveness
   *  filter) so the historical-row greying in OffersTable doesn't
   *  need to re-derive on every render. */
  livenessState?: 'active' | 'stale' | 'closed'
}

// ─── Scouting tracker (data/scouting.md) ─────────────────────────────────────

export type ScoutingTier = 'T1' | 'T2' | 'T3' | 'T4'

/** One row of the 12-column v2 scouting table (spec §8.2). */
export interface ScoutingEntry {
  num: number
  date: string
  company: string
  role: string
  /** Want score; null when blocked (`—`). */
  want: number | null
  /** Ease score; null when blocked (`—`). */
  ease: number | null
  tier: ScoutingTier
  /** Gate status from the Eligibility cell; null when the cell is empty. */
  eligibility: Eligibility | null
  /** Reason text after `amber:` / `red:` (empty for green). */
  eligibilityReason: string
  report: string       // markdown link or "—"
  deadline: string
  promotionHint: string
  notes: string
  /** Stable identity slug — `slug(company)::roleCanonical::cityKey`.
   *  Computed at sync time via lib/entityId.ts. Equal across all rows
   *  belonging to the same persistent entity. */
  entityId: string
  /** Full city list for multi-city listings (one URL, multiple cities
   *  named in the JD). Empty array for single-city — read the row's
   *  primary city from score_history.location instead. */
  cities: string[]
}

// ─── Applications tracker (data/applications.md) ──────────────────────────────

export type AppStatus =
  | 'Evaluated'
  | 'Applied'
  | 'Responded'
  | 'Interview'
  | 'Offer'
  | 'Rejected'
  | 'Discarded'
  | 'SKIP'

export interface ApplicationEntry {
  num: number
  date: string
  company: string
  role: string
  score: string
  status: AppStatus
  pdf: boolean
  deadline: string
  report: string
  notes: string
  /** See ScoutingEntry.entityId — same identity scheme. */
  entityId: string
  /** See ScoutingEntry.cities. */
  cities: string[]
}

// ─── Pipeline (data/pipeline.md) ──────────────────────────────────────────────

export interface PipelineUrl {
  url: string
  addedDate?: string
  isStale: boolean
  /** Company name from the scanner-written pipeline line, when present. */
  company?: string
  /** Role title from the scanner-written pipeline line, when present. */
  title?: string
  /** The scanner's zero-token relevance score for this posting, when present. */
  relevance?: number
  /** Human-readable reasons trail behind the relevance score. */
  relevanceNote?: string
}

// ─── Report file ──────────────────────────────────────────────────────────────

export interface ReportFile {
  path: string          // relative path from repo root, e.g. reports/tier-1/Amazon - BA Intern.md
  company: string
  role: string
  tier: string
  /** Listing URL parsed from the report's `**URL:**` header by the cache
   *  sync. Used as the stable join key against score-history rows whose
   *  role string drifted (filename sanitization, multi-city
   *  disambiguation). Empty string for legacy reports without the URL line. */
  url: string
}

// ─── Profile config (user/profile.yml) ─────────────────────────────────────

export interface ProfileConfig {
  candidate: {
    full_name: string
    email: string
    phone?: string
    location?: string
    linkedin?: string
    portfolio_url?: string
    github?: string
  }
  target_roles?: {
    primary?: string[]
    archetypes?: Array<{ name: string; level?: string; fit?: string }>
  }
  narrative?: {
    headline?: string
    exit_story?: string
    superpowers?: string[]
    proof_points?: Array<{ name: string; url?: string; hero_metric?: string }>
  }
  compensation?: {
    target_range?: string
    currency?: string
    minimum?: string
    location_flexibility?: string
  }
  location?: {
    country?: string
    city?: string
    timezone?: string
    visa_status?: string
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

export type TierKey = 'T1' | 'T2' | 'T3' | 'T4'

export const TIER_LABELS: Record<TierKey, string> = {
  'T1': 'T1',
  'T2': 'T2',
  'T3': 'T3',
  'T4': 'T4',
}

// Consistent fill + border opacity across tiers so the active-state highlight
// reads the same regardless of which tier is selected. Earlier values varied
// (T1 /20, T2-3 /15, T4 /10) which made T1 chips pop and T4 chips look
// half-disabled. Verdict chips reuse these through VERDICT_TIER
// (lib/scoreBands) — a verdict never gets a colour of its own.
export const TIER_COLORS: Record<TierKey, { bg: string; text: string; border: string }> = {
  'T1':     { bg: 'bg-tier-1/15',       text: 'text-tier-1',       border: 'border-tier-1/35' },
  'T2':     { bg: 'bg-tier-2/15',       text: 'text-tier-2',       border: 'border-tier-2/35' },
  'T3':     { bg: 'bg-tier-3/15',       text: 'text-tier-3',       border: 'border-tier-3/35' },
  'T4':     { bg: 'bg-tier-4/15',       text: 'text-tier-4',       border: 'border-tier-4/35' },
}

// Eligibility chip classes (DESIGN-meta § Tier and Status Sections): the
// semantic success / warning / danger tokens over their documented BG tints
// (Positive BG 0.12, Warning BG 0.15, Error BG 0.12). green = eligible,
// amber = check first, red = blocked. Same text-on-tint pattern as the
// existing semantic badges (ApplyAction, TodayView).
export const ELIGIBILITY_COLORS: Record<Eligibility, { bg: string; text: string; border: string; dot: string }> = {
  green: { bg: 'bg-success/[0.12]', text: 'text-success', border: 'border-success/30', dot: 'bg-success' },
  amber: { bg: 'bg-warning/15',     text: 'text-warning', border: 'border-warning/30', dot: 'bg-warning' },
  red:   { bg: 'bg-danger/[0.12]',  text: 'text-danger',  border: 'border-danger/30',  dot: 'bg-danger' },
}

export const ELIGIBILITY_LABELS: Record<Eligibility, string> = {
  green: 'Eligible',
  amber: 'Check first',
  red:   'Blocked',
}

export const STATUS_COLORS: Record<AppStatus, string> = {
  'Evaluated': 'text-info',
  'Applied':   'text-accent',
  'Responded': 'text-accent',
  'Interview': 'text-warning',
  'Offer':     'text-success',
  'Rejected':  'text-danger',
  'Discarded': 'text-text-4',
  'SKIP':      'text-text-4',
}

// Statuses that mean "you've already engaged this listing" — applied, heard
// back, interviewing, got an offer, or got rejected. Drives the Database's
// per-row status badge and its "Untapped only" toggle (which hides these so
// only scored-but-not-yet-pursued listings remain). 'Evaluated' is excluded —
// it means promoted-to-tracker-but-not-sent, i.e. still untapped. 'Discarded'
// rows are tombstoned out of the Database upstream, and 'SKIP' never reads as
// engagement, so neither earns a badge.
export const ENGAGED_STATUSES: ReadonlySet<AppStatus> = new Set<AppStatus>([
  'Applied', 'Responded', 'Interview', 'Offer', 'Rejected',
])
