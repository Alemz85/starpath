// Typed wrapper around window.electron (set by Electron preload)
// Falls back gracefully in browser/dev-without-electron context.

import type { ElectronAPI } from '../../electron/preload'
import type { NetworkOverview } from './networkLens'
import type { ProfileListResult, ProfileMutationResult } from './profiles'
import type { DataRootInfo, PrivateInitResult } from './dataRoot'
import type {
  StatusChangeRequest, StatusChangeResult, StatusHistoryQuery, StatusLogEntry,
} from './statusLog'
import type {
  ChatProposalDecisionStatus, ChatRuntimeEnvelope, ChatRuntimeSnapshot,
  ChatSession, ChatSessionMeta,
} from './chat/types'

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

function api(): ElectronAPI {
  if (typeof window !== 'undefined' && window.electron) return window.electron
  // In Next.js SSR or plain browser context — return stubs that resolve to null
  const stub = () => Promise.resolve(null)
  return new Proxy({} as ElectronAPI, { get: () => stub })
}

export const ipc = {
  // App config
  getConfig:            ()                     => api().getConfig(),
  setRepoPath:          (p: string)             => api().setRepoPath(p),
  setOnboardingComplete:(v: boolean)            => api().setOnboardingComplete(v),
  setTailoringComplete: (v?: boolean)           => api().setTailoringComplete(v),
  setModels:            (m: { pipeline: string; tailorCv: string; draftApp: string; interviewPrep: string; generateReport: string }) => api().setModels(m),
  setFeatures:          (f: Record<string, boolean>) => api().setFeatures(f),
  selectFolder:         ()                     => api().selectFolder() as Promise<{ path: string; valid: boolean } | null>,
  selectCvPdf:          ()                     => api().selectCvPdf()  as Promise<{ path: string } | null>,
  validatePath:         (p: string)             => api().validatePath(p) as Promise<{ path: string; valid: boolean }>,
  openExternal:         (url: string)           => api().openExternal(url),
  revealFile:           (filePath: string)      => api().revealFile(filePath) as Promise<boolean>,
  /** Open a repo-relative file (resolved through the data root) with the
   *  system's default app. False when it doesn't exist or can't open. */
  openFile:             (filePath: string)      => api().openFile(filePath) as Promise<boolean>,

  // Data root — where personal files live. `info()` is null outside
  // Electron; `setDataPath('demo')` shows the fictional demo read-only,
  // `setDataPath(null)` goes back to the user's own data. Both resolve to
  // the new info (main also broadcasts it on `onChanged`).
  dataRoot: {
    info:          () => api().getDataRoot() as Promise<DataRootInfo | null>,
    setDataPath:   (value: 'demo' | null) => api().setDataPath(value) as Promise<DataRootInfo | null>,
    onChanged:     (cb: (info: DataRootInfo) => void) => api().onDataRootChanged(i => cb(i as DataRootInfo)),
    /** `node scripts/private.mjs init --json`, relayed verbatim. */
    initPrivate:   () => api().privateInit() as Promise<PrivateInitResult | null>,
  },

  // System prompts for `claude --append-system-prompt-file`: the absolute
  // file to pass (the user's private override, a composed copy, or the repo
  // default). Callers fall back to the repo-relative path on null/error.
  prompt: {
    resolve:       (rel: string) => api().resolvePrompt(rel) as Promise<string | null>,
  },

  // Claude
  checkClaude:          ()                     => api().checkClaude() as Promise<{ installed: boolean }>,
  checkClaudeAuth:      ()                     => api().checkClaudeAuth() as Promise<{ authenticated: boolean; reason?: 'expired' | 'logged-out' }>,
  runClaudeLogin:       ()                     => api().runClaudeLogin(),

  // File system
  readFile:             (path: string)          => api().readFile(path) as Promise<string | null>,
  writeFile:            (path: string, c: string) => api().writeFile(path, c),
  fileExists:           (path: string)          => api().fileExists(path) as Promise<boolean>,
  listDir:              (path: string)          => api().listDir(path) as Promise<string[]>,
  listRecursive:        (dir: string, ext: string) => api().listRecursive(dir, ext) as Promise<string[]>,

  /** Tracker writes. A status change is never a renderer-side rewrite of
   *  applications.md: main runs scripts/lib/status-ledger.mjs (validate against
   *  templates/states.yml → rewrite the Status cell under the tracker lock →
   *  append to the status log). Errors come back as `{ ok: false }`, never a
   *  throw. The history is oldest-first; an empty query reads the whole log. */
  tracker: {
    setStatus:     (req: StatusChangeRequest) =>
                     api().trackerSetStatus(req) as Promise<StatusChangeResult | null>,
    statusHistory: (query: StatusHistoryQuery = {}) =>
                     api().trackerStatusHistory(query) as Promise<StatusLogEntry[] | null>,
  },

  // Logo cache
  fetchLogo:            (domain: string)             => api().fetchLogo(domain) as Promise<string | null>,

  // DB-backed query layer. Returns rows shaped to match the corresponding
  // ScoreEntry / ApplicationEntry / ScoutingEntry / ReportFile types, with
  // SQL columns mapped 1:1. Use these instead of re-parsing files in the
  // renderer.
  db: {
    applications:           (f?: { tier?: string; status?: string; search?: string }) =>
                              api().dbApplications(f) as Promise<DbApplicationRow[]>,
    scouting:               (f?: { tier?: string; search?: string }) =>
                              api().dbScouting(f) as Promise<DbScoutingRow[]>,
    scoreHistory:           (f?: { since?: string; until?: string; company?: string; tier?: string }) =>
                              api().dbScoreHistory(f) as Promise<DbScoreHistoryRow[]>,
    pipeline:               () =>
                              api().dbPipeline() as Promise<DbPipelineRow[]>,
    reports:                (f?: { tier?: string; search?: string }) =>
                              api().dbReports(f) as Promise<DbReportRow[]>,
    applicationsWithScores: () =>
                              api().dbApplicationsWithScores() as Promise<DbApplicationWithScoreRow[]>,
    trends:                 () =>
                              api().dbTrends() as Promise<DbTrends>,
    resync:                 () => api().dbResync() as Promise<unknown>,
    rebuild:                () => api().dbRebuild() as Promise<unknown>,
    onChanged:              (cb: (sources: string[]) => void) => api().onDbChanged(cb),
  },

  // Network lens — the whole-network overview (roster × pipeline × cadence),
  // composed in the main process by the repo's own pure cores. Returns null
  // when no repo is configured or the repo's scripts predate the lens.
  network: {
    overview: () => api().networkOverview() as Promise<NetworkOverview | null>,
  },

  // Profiles — switchable search profiles (one active globally; switching
  // re-points the repo's canonical symlinks via scripts/profile.mjs). list
  // reports { active: null, profiles: [] } on pre-migration repos — hide
  // every profile surface on that shape.
  profile: {
    list:      () => api().profileList()   as Promise<ProfileListResult>,
    active:    () => api().profileActive() as Promise<{ active: string | null }>,
    switch:    (slug: string) => api().profileSwitch(slug) as Promise<ProfileMutationResult>,
    create:    (opts: { slug: string; from?: string; label?: string }) =>
                 api().profileCreate(opts) as Promise<ProfileMutationResult>,
    onChanged: (cb: (slug: string) => void) => api().onProfileChanged(cb),
  },

  // Chat — the conversational tab. Main owns the single live generation; the
  // renderer reattaches by pulling `state()` on mount and folding every
  // `onEvent` envelope whose sequence is ahead of the snapshot's.
  chat: {
    send:          (sessionId: string | null, message: string) =>
                     api().chatSend(sessionId, message) as Promise<{ sessionId: string; generationId: string }>,
    stop:          (sessionId: string) => api().chatStop(sessionId) as Promise<boolean>,
    state:         ()                  => api().chatState()    as Promise<ChatRuntimeSnapshot | null>,
    sessions:      ()                  => api().chatSessions() as Promise<ChatSessionMeta[]>,
    get:           (id: string)        => api().chatSessionGet(id) as Promise<ChatSession | null>,
    create:        ()                  => api().chatSessionNew()   as Promise<ChatSessionMeta>,
    remove:        (id: string)        => api().chatSessionDelete(id) as Promise<boolean>,
    // Records a proposal-card decision and returns the refreshed session.
    // `at` is stamped in main, so callers pass status/detail only.
    recordDecision: (
      sessionId: string,
      messageId: string,
      blockId: string,
      decision: { status: ChatProposalDecisionStatus; detail?: string },
    ) => api().chatProposalDecision(sessionId, messageId, blockId, decision) as Promise<ChatSession | null>,
    onEvent:       (cb: (envelope: ChatRuntimeEnvelope) => void) =>
                     api().onChatEvent(e => cb(e as ChatRuntimeEnvelope)),
  },

  // Shell
  run:                  (cmd: string, args: string[]) => api().run(cmd, args) as Promise<{ stdout: string; stderr: string; code: number }>,
  spawn:                (id: string, cmd: string, args: string[]) => api().spawn(id, cmd, args),
  kill:                 (id: string)            => api().kill(id),
  onSpawnOutput:        (cb: (id: string, chunk: string) => void) => api().onSpawnOutput(cb),
  onSpawnDone:          (cb: (id: string, code: number) => void)  => api().onSpawnDone(cb),
}

// ─── DB row shapes (mirrors of SQLite columns) ────────────────────────────────

export interface DbApplicationRow {
  num: number; date: string; company: string; role: string
  /** Raw Score cell — `W8.3 E5.6` (v2) or a legacy `7.4/10`. */
  score_raw: string
  /** Parsed from score_raw (docs/scoring-v2.md §8.3); null when absent. */
  want: number | null; ease: number | null; legacy_score: number | null
  status: string; pdf: number; deadline: string; report: string; notes: string
  tier: string
  /** Computed at sync time from (company, role, latest location). Stable
   *  across re-evaluations and re-posts. Empty when no location resolved. */
  entity_id: string
  /** JSON-encoded string[] — full city list for multi-city listings,
   *  empty array '[]' for single-city. The Database city filter checks
   *  this in addition to the row's primary location. */
  cities: string
}

export interface DbScoutingRow {
  num: number; date: string; company: string; role: string
  want: number | null; ease: number | null
  tier: string; eligibility: string | null; eligibility_reason: string; report: string
  deadline: string; promotion_hint: string; notes: string
  entity_id: string
  cities: string
}

export interface DbApplicationWithScoreRow extends DbApplicationRow {
  /** Latest score-history evaluation for the same (company, role). */
  sh_want: number | null; sh_ease: number | null
  priority: number | null; verdict: string | null; eligibility: string | null
  archetype: string | null; sh_date: string | null
}

/** v2 score_history row (docs/scoring-v2.md §8.1). Numeric columns are NULL
 *  on blocked rows — never 0. */
export interface DbScoreHistoryRow {
  id: number; date: string; archetype: string
  skills_match: number | null; experience_bar: number | null; competition: number | null
  ease: number | null
  growth_mobility: number | null; optionality_exit: number | null
  brand_value: number | null; role_content: number | null
  best_cities: number | null; salary_adj_city: number | null; work_life_balance: number | null
  want: number | null; priority: number | null
  eligibility: string | null; eligibility_flags: string; verdict: string | null
  best_fit_roles: string
  mode: string; company: string; role: string; tier: string
  source: string; location: string; employment_type: string
  duration: string; salary_raw: string
  url: string
}

export interface DbPipelineRow {
  url: string; added_date: string | null; is_stale: number
  company: string | null; title: string | null
  relevance: number | null; relevance_note: string | null
}

export interface DbReportRow {
  path: string; company: string; role: string; tier: string; mtime: number
  url: string
  /** Latest matching evaluation; all null for an orphan report or a blocked
   *  row's scores. */
  want: number | null; ease: number | null; priority: number | null
  verdict: string | null; eligibility: string | null; eligibility_flags: string | null
}

/** Score averages exclude blocked rows; `blocked` counts them. */
export interface DbTrendBucket {
  label: string; count: number; blocked: number
  avg_want: number | null; avg_ease: number | null; avg_priority: number | null
  avg_skills_match: number | null; avg_brand_value: number | null
  avg_growth: number | null; avg_wlb: number | null
}

export interface DbTrends {
  byDate: DbTrendBucket[]
  byArchetype: DbTrendBucket[]
  tierDistribution: Array<{ tier: string; count: number }>
  verdictDistribution: Array<{ verdict: string; count: number }>
  eligibilityDistribution: Array<{ eligibility: string; count: number }>
}
