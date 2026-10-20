// Data root — the renderer-safe half (types, constants, gating, onboarding
// choice). No Node imports: the renderer bundles this file, and the Electron
// main process compiles it too (tsconfig.electron.json), so imports stay
// relative and type-only where they cross into src/types.
//
// Where personal data lives is decided in the main process by the repo's own
// `scripts/lib/data-root.mjs` (resolveDataRoot). Main publishes the outcome as
// a DataRootInfo over `app:data-root` / `data-root:changed`; everything here
// is a pure function of that payload. The node-side helpers (path mapping,
// confinement, chat folder, dev repo detection) live in lib/dataRootMain.ts.

export type DataRootKind = 'private' | 'external' | 'demo' | 'none'
export type DataRootSource = 'config' | 'env' | 'default'

export interface DataRootInfo {
  /** Absolute data root; null while no repository is configured. For kind
   *  'none' this is where private/ WOULD be (nothing exists there yet). */
  root: string | null
  kind: DataRootKind
  source: DataRootSource
  repoPath: string | null
  /** `<repo>/demo` exists, so "Explore the demo" can be offered. */
  demoAvailable: boolean
  /** `<repo>/private` exists. */
  privateExists: boolean
  /** There is own data to return to from the demo: the private root, or an
   *  un-migrated checkout whose `user/` or `data/` still sit in the repo. */
  ownDataAvailable: boolean
}

/** The config.json `dataPath` value for demo mode. */
export const DEMO_DATA_PATH = 'demo'

/** Error code main puts at the front of every refused demo-mode write. */
export const DEMO_READ_ONLY = 'demo-read-only'

/** Tooltip on every control the demo disables. */
export const DEMO_READ_ONLY_TOOLTIP = 'Demo data is read-only'

export function isDemo(info: DataRootInfo | null | undefined): boolean {
  return info?.kind === 'demo'
}

/**
 * The one write gate. Everything that writes a personal file or spawns work
 * (scans, evaluations, tailoring, chat, configuration saves, profile
 * switches) asks this. Unknown state (not loaded yet) counts as writable so
 * a slow first IPC never flashes every button disabled; main refuses demo
 * writes on its own regardless.
 */
export function canWrite(info: DataRootInfo | null | undefined): boolean {
  return !isDemo(info)
}

export interface WriteGate {
  canWrite: boolean
  /** Tooltip for a disabled control; undefined when writable. */
  readOnlyTitle: string | undefined
}

export function writeGate(info: DataRootInfo | null | undefined): WriteGate {
  const ok = canWrite(info)
  return { canWrite: ok, readOnlyTitle: ok ? undefined : DEMO_READ_ONLY_TOOLTIP }
}

/** True for an Error (or IPC rejection) carrying main's demo refusal code. */
export function isDemoReadOnlyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes(DEMO_READ_ONLY)
}

/** Settings › General › Data: a plain-language name for the kind. */
export function dataKindLabel(kind: DataRootKind): string {
  switch (kind) {
    case 'private':  return 'Private folder'
    case 'external': return 'External folder'
    case 'demo':     return 'Demo data (fictional, read-only)'
    case 'none':     return 'Repository folders (no private folder yet)'
  }
}

// ─── App gate ────────────────────────────────────────────────────────────────

export interface GateInput {
  isOnboarded: boolean
  repoPath: string | null
  tailoringComplete: boolean
  /** Set by "Use my own data" when there is no own data yet. */
  forceOnboarding?: boolean
  info: DataRootInfo | null | undefined
}

/** Demo mode never forces onboarding (or tailoring): it goes straight to the app. */
export function needsOnboarding(g: GateInput): boolean {
  if (isDemo(g.info) && !!g.repoPath) return false
  return !!g.forceOnboarding || !g.isOnboarded || !g.repoPath
}

export function needsTailoring(g: GateInput): boolean {
  if (isDemo(g.info)) return false
  return !needsOnboarding(g) && !g.tailoringComplete
}

// ─── Onboarding choice ───────────────────────────────────────────────────────
//
// The first onboarding screen offers "Explore the demo" (fictional data,
// read-only) and "Set up my own search" (the existing wizard). Choosing your
// own search on a checkout with no private root yet runs `private init`
// first, so every wizard write lands in private/.

export type OnboardingPhase = 'choose' | 'init-private' | 'wizard'

/** 'own' skips the choice: the user already asked for their own data. */
export type OnboardingIntent = 'choose' | 'own'

export function initialOnboardingPhase(input: {
  demoAvailable: boolean
  intent: OnboardingIntent
  kind: DataRootKind
  repoPath: string | null
}): OnboardingPhase {
  if (input.intent === 'choose' && input.demoAvailable) return 'choose'
  return phaseAfterChoosingOwn(input)
}

/** Needs `private init` before the wizard writes anything. */
export function needsPrivateInit(input: { kind: DataRootKind; repoPath: string | null }): boolean {
  return !!input.repoPath && input.kind === 'none'
}

export function phaseAfterChoosingOwn(input: { kind: DataRootKind; repoPath: string | null }): OnboardingPhase {
  return needsPrivateInit(input) ? 'init-private' : 'wizard'
}

/** "Use my own data" from the demo badge: back to own data, or set it up. */
export function ownDataAction(info: DataRootInfo | null | undefined): 'leave-demo' | 'setup' {
  return info?.ownDataAvailable ? 'leave-demo' : 'setup'
}

/** Settings › General › "Show demo data". */
export function demoToggleState(info: DataRootInfo | null | undefined): {
  checked: boolean
  disabled: boolean
  hint: string | undefined
} {
  if (!info || !info.repoPath) {
    return { checked: false, disabled: true, hint: 'Choose a repository first' }
  }
  if (isDemo(info)) {
    return info.ownDataAvailable
      ? { checked: true, disabled: false, hint: undefined }
      : { checked: true, disabled: true, hint: 'Set up your own search first (Use my own data)' }
  }
  return info.demoAvailable
    ? { checked: false, disabled: false, hint: undefined }
    : { checked: false, disabled: true, hint: 'This checkout has no demo/ folder' }
}

// ─── private init ────────────────────────────────────────────────────────────

/** `node scripts/private.mjs init --json`, as main relays it. */
export interface PrivateInitResult {
  ok: boolean
  error?: string
  message?: string
  repoRoot?: string
  privateRoot?: string
  moved?: unknown[]
  linked?: unknown[]
  created?: unknown[]
  skipped?: unknown[]
  conflicts?: unknown[]
  warnings?: unknown[]
  [k: string]: unknown
}

/** Human lines for a failed init: the message, then each conflict/warning. */
export function describePrivateInitFailure(res: PrivateInitResult | null | undefined): string[] {
  if (!res) return ['No response from the app. Try again.']
  const lines: string[] = []
  if (res.message) lines.push(String(res.message))
  else if (res.error) lines.push(`private init failed (${res.error})`)
  const asLine = (v: unknown): string =>
    typeof v === 'string' ? v
      : v && typeof v === 'object'
        ? String((v as Record<string, unknown>).message ?? (v as Record<string, unknown>).path ?? JSON.stringify(v))
        : String(v)
  for (const c of Array.isArray(res.conflicts) ? res.conflicts : []) lines.push(`Conflict: ${asLine(c)}`)
  if (!res.ok) {
    for (const w of Array.isArray(res.warnings) ? res.warnings : []) lines.push(asLine(w))
  }
  return lines.length ? lines : ['private init failed with no message.']
}
