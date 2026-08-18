// Typed wrapper around window.electron (set by Electron preload)
// Falls back gracefully in browser/dev-without-electron context.

import type { ElectronAPI } from '../../electron/preload'
import type { NetworkOverview } from './networkLens'
import type { ProfileListResult, ProfileMutationResult } from './profiles'
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
                              api().dbApplicationsWithScores() as Promise<Array<DbApplicationRow & { overall: number | null; current_fit: number | null; aspirational_fit: number | null; archetype: string | null }>>,
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
  score_raw: string; score_num: number | null
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
  score_raw: string; score_num: number | null
  tier: string; cfaf: string; report: string
  deadline: string; promotion_hint: string; notes: string
  entity_id: string
  cities: string
}

export interface DbScoreHistoryRow {
  id: number; date: string; archetype: string
  skills_match: number; ease_of_entry: number; strategic_fit: number
  current_fit: number; growth_mobility: number; optionality_exit: number
  brand_value: number; sales_trap_risk: number; aspirational_fit: number
  overall: number; best_cities: number; salary_adj_city: number
  work_life_balance: number; best_fit_roles: string
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
  overall: number | null; current_fit: number | null; aspirational_fit: number | null
}

export interface DbTrendBucket {
  label: string; count: number
  avg_overall: number; avg_current_fit: number; avg_aspirational_fit: number
  avg_skills_match: number; avg_brand_value: number; avg_growth: number; avg_wlb: number
}

export interface DbTrends {
  byDate: DbTrendBucket[]
  byArchetype: DbTrendBucket[]
  tierDistribution: Array<{ tier: string; count: number }>
}
