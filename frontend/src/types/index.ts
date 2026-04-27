// ─── App config ───────────────────────────────────────────────────────────────

export interface AppConfig {
  repoPath?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  onboardingComplete?: boolean
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
}

// ─── Profile config (user/profile.yml) ─────────────────────────────────────

export type AppMode = 'scouting' | 'applying'

export interface ProfileConfig {
  current_mode: AppMode
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

export const TIER_COLORS: Record<TierKey, { bg: string; text: string; border: string }> = {
  'T1':     { bg: 'bg-tier-1/20',    text: 'text-tier-1',    border: 'border-tier-1/40' },
  'T2-high':{ bg: 'bg-success/15',   text: 'text-success',   border: 'border-success/30' },
  'T2':     { bg: 'bg-tier-2/15',    text: 'text-tier-2',    border: 'border-tier-2/30' },
  'T3':     { bg: 'bg-tier-3/15',    text: 'text-tier-3',    border: 'border-tier-3/30' },
  'T4':     { bg: 'bg-tier-4/10',    text: 'text-tier-4',    border: 'border-tier-4/20' },
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
