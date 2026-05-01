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

// Numeric score → display color. Used everywhere a single number needs
// a galaxy color (Database dial, Trends top-X, slide-over rollups,
// Reports list scores).
//
// Why this diverges from TIER_HEX directly: tier chips are a 4-state
// discrete badge (T1/T2/T3/T4) where the lavender (#A89CD9) reads fine
// because it sits inside `tier-3-bg #F4F1FA` with a "T3" label — chip
// context tells you it's a tier marker. A floating score number on a
// table cell has none of that context, so re-using the lavender there
// made every 5–7 score look like a washed-out purple. Score colors
// also differ from the chart palette — that one is *categorical*
// (different series), this one is *ordinal* (magnitude). Rainbow-
// encoding ordinal data is the classic bad-viz mistake; every band
// here either runs cool (high) or fades neutral (low) so the eye can
// always sort scores by hue saturation.
//
// 5 bands matched to `_shared.md` § Score interpretation:
//   ≥ 9.0 → aurora teal (chart-3)   — Strong match; "stellar" tier
//   ≥ 8.0 → deep galaxy indigo      — Good match; salient brand-deep
//   ≥ 7.0 → galaxy violet           — Decent match; brand anchor at the apply threshold
//   ≥ 5.0 → text-3 slate gray       — Below threshold; reads as "data, not hierarchy"
//   <  5.0 → T4 faded slate          — Sub-floor; fully receded
//
// Aurora teal at the top is the only non-violet hue here. It earns
// the slot because (a) it's the documented "cool counterpart" of
// galaxy violet in the data-viz palette so it stays in the cosmic
// family, (b) it breaks the all-violet monotone exactly where it's
// rare and deserved (≥9.0 scores are uncommon — averaging across the
// `data/scouting.md` corpus they're <10% of evaluations), and (c)
// teal reads as "premium / exceptional" in adjacent design systems
// (Stripe, GitHub Sponsor) without crossing into warm "warning" hues.
export function scoreColor(v: number): string {
  if (v >= 9)   return '#2EB8A8'      // aurora teal (chart-3) — stellar
  if (v >= 8)   return TIER_HEX.T1    // #3D2BB5 — deep galaxy indigo
  if (v >= 7)   return TIER_HEX.T2    // #7C5CFF — galaxy violet (brand anchor)
  if (v >= 5)   return '#5D6C7B'      // text-3 slate gray — below threshold
  return '#94A3B8'                     // T4 faded slate — sub-floor
}

// Companion to scoreColor — returns the lighter tone used for gradient
// strokes / fills (dial rim, orbit halo, bar fade). Each band's "light"
// hue is the next band's "dark" hue (mostly), so when scores are laid
// out in order the colour flow stays continuous.
export function scoreColorLight(v: number): string {
  if (v >= 9)   return TIER_HEX.T1          // teal fades into brand-deep indigo
  if (v >= 8)   return TIER_HEX_LIGHT.T1    // #7C5CFF — fades into brand violet
  if (v >= 7)   return TIER_HEX_LIGHT.T2    // #B5A3FF — accent-light
  if (v >= 5)   return '#94A3B8'            // T4 base — slate's "halo"
  return '#CED0D4'                           // border-strong — full fade-out
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
