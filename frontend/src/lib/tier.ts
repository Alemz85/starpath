// Tier and score-color source of truth.
//
// The values mirror the `tier-1`…`tier-4` Tailwind tokens (see
// `tailwind.config.ts`) and the documented galaxy-violet tier scale in
// `DESIGN-meta.md` § Color Palette / Tier scale. SVG attributes and
// inline styles can't reference Tailwind tokens directly, so this module
// exposes the same hexes as constants.
//
// `TIER_HEX` (this file) ≠ `TIER_COLORS` from `@/types` — the latter is
// a chip class map (bg/text/border tailwind classes) and stays the
// source of truth for tier chips; this file owns the raw hexes for SVG
// strokes / inline `style` props / canvas-confetti palettes.

import type { TierKey } from '@/types'
export type { TierKey }

export const TIER_HEX: Record<TierKey, string> = {
  T1:        '#3D2BB5', // tier-1 — deep galaxy indigo
  'T2-high': '#5B3FE8', // accent-hover — sits between T1 and T2 in the wordmark gradient
  T2:        '#7C5CFF', // tier-2 — galaxy violet (matches accent)
  T3:        '#A89CD9', // tier-3 — muted lavender
  T4:        '#94A3B8', // tier-4 — faded slate
}

// Lighter companion for each tier — used for gradient strokes / fills
// where the dial or bar needs depth without leaving the tier hue.
export const TIER_HEX_LIGHT: Record<TierKey, string> = {
  T1:        '#7C5CFF', // tier-2 (T1 dial fades into the brand violet)
  'T2-high': '#7C5CFF',
  T2:        '#B5A3FF', // accent-light
  T3:        '#C8BEEC',
  T4:        '#C9D2DD',
}

export const TIER_BG_HEX: Partial<Record<TierKey, string>> = {
  T1: '#EFEAFF', // tier-1-bg
  T2: '#F1ECFF', // tier-2-bg
  T3: '#F4F1FA', // tier-3-bg
}

// Numeric score → tier color. Same banding used everywhere a single
// number needs a galaxy color (Database dial, Trends top-X, slide-over
// rollups, Reports list scores).
//
// Banding: ≥8.5 T1 · ≥7 T2 · ≥5 T3 · else T4 (matches `templates/states.yml`
// score interpretation and historical scoreColor implementations).
export function scoreColor(v: number): string {
  if (v >= 8.5) return TIER_HEX.T1
  if (v >= 7)   return TIER_HEX.T2
  if (v >= 5)   return TIER_HEX.T3
  return TIER_HEX.T4
}

// Companion to scoreColor — returns the lighter tier hue for gradient
// strokes / fills.
export function scoreColorLight(v: number): string {
  if (v >= 8.5) return TIER_HEX_LIGHT.T1
  if (v >= 7)   return TIER_HEX_LIGHT.T2
  if (v >= 5)   return TIER_HEX_LIGHT.T3
  return TIER_HEX_LIGHT.T4
}

export function tierHex(tier: TierKey | string | undefined | null): string {
  if (!tier) return TIER_HEX.T4
  if (tier === 'T1' || tier === 'T2-high' || tier === 'T2' || tier === 'T3' || tier === 'T4') {
    return TIER_HEX[tier]
  }
  return TIER_HEX.T4
}

// Neutral fallback for non-numeric / missing scores. Matches `text-3`
// (Slate Gray) so the cell reads as "secondary metadata" rather than a
// muted-disabled state.
export const NEUTRAL_SCORE_COLOR = '#5D6C7B' // text-3
