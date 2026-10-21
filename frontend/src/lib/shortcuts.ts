import { VIEW_LABELS, type ViewId } from '@/store/nav'

// ─── Go-to navigation chords ─────────────────────────────────────────────────
//
// GitHub/Linear-style "go to" chords: press `g`, then a letter, to jump
// straight to a view. The letter is the view's mnemonic initial. We chord only
// the five daily-driver tabs — Activity, Configuration, and Settings stay
// reachable through ⌘K — so the set is small, unambiguous, and memorable
// (every chord is just `g` + the first letter of its label).
//
// This map is the single source of truth: the runtime matcher (reduceChord)
// and the cheatsheet rows (navShortcutRows) both derive from it, so they can
// never drift apart.
export const NAV_CHORDS: Readonly<Record<string, ViewId>> = {
  s: 'scouting',
  a: 'applying',
  d: 'database',
  r: 'reports',
  t: 'trends',
}

// How long after pressing `g` the second key still counts as part of the
// chord. After this window the leader lapses and `g` does nothing on its own.
export const CHORD_TIMEOUT_MS = 1200

export interface ChordState {
  /** The pending leader key, or null when no chord is in progress. */
  leader: 'g' | null
  /** Timestamp (ms) the leader was pressed; used to expire stale chords. */
  at: number
}

export const IDLE_CHORD: ChordState = { leader: null, at: 0 }

export type ChordResult =
  /** Full `g`+letter sequence resolved — navigate, then reset. */
  | { type: 'navigate'; view: ViewId; next: ChordState }
  /** `g` captured; waiting for the second key. */
  | { type: 'leader'; next: ChordState }
  /** Second key was not a nav target (or the leader expired) — consume + clear. */
  | { type: 'reset'; next: ChordState }
  /** Not part of any chord; the caller should leave the event alone. */
  | { type: 'ignore' }

/**
 * Pure state machine for the two-key `g`+letter navigation chord. Kept free of
 * the DOM so the timing/expiry/resolution rules are unit-testable with a pinned
 * clock — the component just feeds it `event.key` and `Date.now()`.
 */
export function reduceChord(state: ChordState, key: string, now: number): ChordResult {
  const lower = key.toLowerCase()

  // An active, unexpired leader → the second key resolves (or cancels) it.
  if (state.leader === 'g' && now - state.at <= CHORD_TIMEOUT_MS) {
    const view = NAV_CHORDS[lower]
    if (view) return { type: 'navigate', view, next: IDLE_CHORD }
    return { type: 'reset', next: IDLE_CHORD } // unknown second key cancels the chord
  }

  // No active leader (or it expired): a fresh `g` opens a new chord.
  if (lower === 'g') return { type: 'leader', next: { leader: 'g', at: now } }

  return { type: 'ignore' }
}

// ─── Cheatsheet content ──────────────────────────────────────────────────────

export interface ShortcutRow {
  /** Key hint, rendered as one <kbd> chip per element, e.g. ['G', 'S']. */
  keys: string[]
  label: string
  /** How a multi-key hint reads: pressed in sequence ('then', the default for
   *  chords) or together ('plus', for modifier combos like ⌘K). Unset for
   *  single keys. */
  combo?: 'then' | 'plus'
}

export interface ShortcutGroup {
  heading: string
  rows: ShortcutRow[]
}

/** ⌘1 … ⌘9 in the native View menu, in the sidebar's order. The menu
 *  template in electron/main.ts (buildMenu) is the other copy; keep both the
 *  same. Settings has ⌘, in the app menu instead. */
export const NAV_NUMBERS: ReadonlyArray<ViewId> = [
  'chat', 'scouting', 'applying', 'database', 'reports', 'trends', 'scan', 'messages', 'profile',
]

/** Navigate rows for the cheatsheet: the ⌘-number of every destination, with
 *  the g-chord beside it where one exists. Labels come from the single
 *  source in store/nav.ts (VIEW_LABELS). */
export function navShortcutRows(): ShortcutRow[] {
  const chordFor = new Map(Object.entries(NAV_CHORDS).map(([key, view]) => [view, key]))
  return NAV_NUMBERS.map((view, i) => {
    const chord = chordFor.get(view)
    return {
      keys: ['⌘', String(i + 1)],
      label: chord ? `${VIEW_LABELS[view]} (also G then ${chord.toUpperCase()})` : VIEW_LABELS[view],
      combo: 'plus' as const,
    }
  })
}

/** The full grouped cheatsheet shown in the ShortcutsOverlay. Every row here
 *  is also an item in the menu bar, so nothing lives only as a shortcut. */
export function shortcutGroups(): ShortcutGroup[] {
  return [
    { heading: 'Go to', rows: navShortcutRows() },
    {
      heading: 'General',
      rows: [
        { keys: ['⌘', 'K'], label: 'Command palette — search & jump anywhere', combo: 'plus' },
        { keys: ['⌘', 'N'], label: 'Add a listing', combo: 'plus' },
        { keys: ['⌘', 'F'], label: 'Find in the Database', combo: 'plus' },
        { keys: ['⇧', '⌘', 'E'], label: 'Export the Database', combo: 'plus' },
        { keys: ['⌃', '⌘', 'S'], label: 'Hide or show the sidebar', combo: 'plus' },
        { keys: ['⌘', ','], label: 'Settings', combo: 'plus' },
        { keys: ['⌘', '/'], label: 'Keyboard shortcuts (this panel; ? works too)', combo: 'plus' },
        { keys: ['Esc'],    label: 'Close palette or panel' },
      ],
    },
  ]
}
