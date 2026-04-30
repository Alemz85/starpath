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

export interface AppConfig {
  repoPath?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
  tailoringComplete?: boolean
  models?: ModelPrefs
}

// ─── Score history (data/score-history.tsv) ───────────────────────────────────

export interface ScoreEntry {
  date: string
  archetype: string
  skills_match: number
  ease_of_entry: number
  strategic_fit: number
  current_fit: number
  growth_mobility: number
  optionality_exit: number
  brand_value: number
  sales_trap_risk: number
  aspirational_fit: number
  overall: number
  best_cities: number
  salary_adj_city: number
  work_life_balance: number
  best_fit_roles: string
  mode: 'scouting' | 'oferta'
  company: string
  role: string
  tier: 'T1' | 'T2' | 'T2-high' | 'T3' | 'T4' | string
  source: string
  location: string
  employment_type: string
  duration: string
  salary_raw: string
  /** The listing URL — added to score-history.tsv as column 26.
   *  Empty for legacy rows; populated for evaluations from 2026-04-29 onward.
   *  This is the stable join key between score_history and reports_index. */
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

export type ScoutingTier = 'T1' | 'T2-high' | 'T2' | 'T3' | 'T4'

export interface ScoutingEntry {
  num: number
  date: string
  company: string
  role: string
  score: string        // raw string e.g. "3.40/5"
  tier: ScoutingTier
  cfaf: string         // raw string e.g. "3.67/3.0"
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

export type TierKey = 'T1' | 'T2-high' | 'T2' | 'T3' | 'T4'

export const TIER_LABELS: Record<TierKey, string> = {
  'T1': 'T1',
  'T2-high': 'T2+',
  'T2': 'T2',
  'T3': 'T3',
  'T4': 'T4',
}

// Consistent fill + border opacity across tiers so the active-state highlight
// reads the same regardless of which tier is selected. Earlier values varied
// (T1 /20, T2-3 /15, T4 /10) which made T1 chips pop and T4 chips look
// half-disabled.
//
// T2-high uses accent-hover (`#5B3FE8`) — the gradient stop between T1
// and T2 in the wordmark gradient. Earlier this slot was `bg-success`,
// which collided with the offer-status semantic (DESIGN-meta § Status
// scale reserves success green for offer-received). The galaxy gradient
// keeps the tier ladder visually monotonic: T1 indigo → T2-high → T2 →
// T3 → T4.
export const TIER_COLORS: Record<TierKey, { bg: string; text: string; border: string }> = {
  'T1':     { bg: 'bg-tier-1/15',       text: 'text-tier-1',       border: 'border-tier-1/35' },
  'T2-high':{ bg: 'bg-accent-hover/15', text: 'text-accent-hover', border: 'border-accent-hover/35' },
  'T2':     { bg: 'bg-tier-2/15',       text: 'text-tier-2',       border: 'border-tier-2/35' },
  'T3':     { bg: 'bg-tier-3/15',       text: 'text-tier-3',       border: 'border-tier-3/35' },
  'T4':     { bg: 'bg-tier-4/15',       text: 'text-tier-4',       border: 'border-tier-4/35' },
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
