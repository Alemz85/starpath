// Tier and score-colour source of truth.
//
// One ordinal ladder serves both tier chips and floating score numbers: the
// deeper the tier colour, the stronger the fit. The colours are theme tokens
// (tier-1 … tier-4 in src/app/themes.css); these helpers return CSS colour
// strings that read them — `rgb(var(--c-tier-1))` — so inline styles, SVG
// attributes and chart props follow the active theme without a re-render.
//
// `TIER_COLOR` (this file) ≠ `TIER_COLORS` from `@/types` — the latter is a chip
// class map; this file owns the colours for SVG strokes / inline styles.

import type { TierKey, Verdict } from '@/types'
import { themeColor, type ChannelToken } from './themes'
import { normalizeVerdict, VERDICT_ACTIONS, VERDICT_LABELS, VERDICT_TIER } from './scoreBands'
export type { TierKey }

const TIER_TOKEN: Record<TierKey, ChannelToken> = { T1: 'tier-1', T2: 'tier-2', T3: 'tier-3', T4: 'tier-4' }

export const TIER_COLOR: Record<TierKey, string> = {
  T1: themeColor('tier-1'), // strongest
  T2: themeColor('tier-2'),
  T3: themeColor('tier-3'),
  T4: themeColor('tier-4'), // faded
}

// Lighter companion per tier for gradient strokes / halos.
export const TIER_COLOR_LIGHT: Record<TierKey, string> = {
  T1: themeColor('tier-1-light'),
  T2: themeColor('tier-2-light'),
  T3: themeColor('tier-3-light'),
  T4: themeColor('tier-4-light'),
}

export const TIER_BG: Record<TierKey, string> = {
  T1: themeColor('tier-1-bg'),
  T2: themeColor('tier-2-bg'),
  T3: themeColor('tier-3-bg'),
  T4: themeColor('tier-4-bg'),
}

// Numeric score → display colour. Scoring v2 colours the Want and the Ease
// numbers each on their own with this ladder (Priority is never coloured as a
// headline, docs/scoring-v2.md §5). One hue, so the eye sorts by depth, never
// by category. The colour is a magnitude cue only: whether to apply comes
// from the verdict (Want × Ease grid), never from these cut-offs.
//   ≥ 8.0 → tier-1
//   ≥ 7.0 → tier-2
//   ≥ 5.0 → score-mid (the theme's secondary text colour)
//   <  5.0 → tier-4
export function scoreColor(v: number): string {
  if (v >= 8)   return TIER_COLOR.T1
  if (v >= 7)   return TIER_COLOR.T2
  if (v >= 5)   return themeColor('score-mid')
  return TIER_COLOR.T4
}

export function scoreColorLight(v: number): string {
  if (v >= 8)   return TIER_COLOR_LIGHT.T1
  if (v >= 7)   return TIER_COLOR_LIGHT.T2
  if (v >= 5)   return TIER_COLOR.T4
  return themeColor('track')
}

/** A tier's colour, optionally translucent (`tierColor('T1', 0.2)` for a chip
 *  border). Unknown tiers fall back to T4. */
export function tierColor(tier: TierKey | string | undefined | null, alpha?: number): string {
  const key: TierKey = tier === 'T1' || tier === 'T2' || tier === 'T3' || tier === 'T4' ? tier : 'T4'
  return themeColor(TIER_TOKEN[key], alpha)
}

// The verdict copy (scoring v2, docs/scoring-v2.md §4) — the ONE place a
// verdict key becomes words. `short` → the label ("Stretch"); default → the
// label with its action ("Stretch — apply with prep"). A verdict has no colour
// of its own: use `verdictTier(v)` with the tier tokens / TierChip.
export function tierVerdict(verdict: Verdict | string | null | undefined, opts: { short?: boolean } = {}): string {
  const v = normalizeVerdict(verdict ?? '')
  if (!v) return '—'
  return opts.short ? VERDICT_LABELS[v] : `${VERDICT_LABELS[v]} — ${VERDICT_ACTIONS[v]}`
}

/** The storage tier a verdict maps to (its colour source). */
export function verdictTier(verdict: Verdict | string | null | undefined): TierKey | null {
  const v = normalizeVerdict(verdict ?? '')
  return v ? VERDICT_TIER[v] : null
}

export function tierLabel(tier: TierKey | string | undefined | null): string {
  if (tier === 'T1' || tier === 'T2' || tier === 'T3' || tier === 'T4') return tier
  return '—'
}

// Neutral fallback for non-numeric / missing scores.
export const NEUTRAL_SCORE_COLOR = themeColor('score-mid')
