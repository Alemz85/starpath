// Tier and score-colour source of truth.
//
// One ordinal ladder serves both tier chips and floating score numbers: the
// deeper the violet, the stronger the fit. Values mirror the `tier-*` tokens in
// tailwind.config.ts; SVG attributes and inline styles can't reach Tailwind
// tokens, so the hexes live here too.
//
// `TIER_HEX` (this file) ≠ `TIER_COLORS` from `@/types` — the latter is a chip
// class map; this file owns the raw hexes for SVG strokes / inline styles.

import type { TierKey, Verdict } from '@/types'
import { normalizeVerdict, VERDICT_ACTIONS, VERDICT_LABELS, VERDICT_TIER } from './scoreBands'
export type { TierKey }

export const TIER_HEX: Record<TierKey, string> = {
  T1:        '#3D2BB5', // deep galaxy indigo — strongest
  T2:        '#7C5CFF', // galaxy violet (matches accent)
  T3:        '#8B7FC2', // muted lavender
  T4:        '#94A3B8', // faded slate
}

// Lighter companion per tier for gradient strokes / halos.
export const TIER_HEX_LIGHT: Record<TierKey, string> = {
  T1:        '#7C5CFF',
  T2:        '#B5A3FF',
  T3:        '#C8BEEC',
  T4:        '#C9D2DD',
}

export const TIER_BG_HEX: Partial<Record<TierKey, string>> = {
  T1: '#EFEAFF',
  T2: '#F1ECFF',
  T3: '#F4F1FA',
  T4: '#F1F4F7',
}

// Numeric score → display colour. Scoring v2 colours the Want and the Ease
// numbers each on their own with this ladder (Priority is never coloured as a
// headline, docs/scoring-v2.md §5). One hue, so the eye sorts by depth, never
// by category:
//   ≥ 8.0 → deep indigo   (Strong / Stellar — apply)
//   ≥ 7.0 → galaxy violet (Decent — apply if the pipeline is thin)
//   ≥ 5.0 → slate         (below the apply threshold)
//   <  5.0 → faded slate  (sub-floor)
export function scoreColor(v: number): string {
  if (v >= 8)   return TIER_HEX.T1
  if (v >= 7)   return TIER_HEX.T2
  if (v >= 5)   return '#5D6C7B'
  return '#94A3B8'
}

export function scoreColorLight(v: number): string {
  if (v >= 8)   return TIER_HEX_LIGHT.T1
  if (v >= 7)   return TIER_HEX_LIGHT.T2
  if (v >= 5)   return '#94A3B8'
  return '#CED0D4'
}

export function tierHex(tier: TierKey | string | undefined | null): string {
  if (!tier) return TIER_HEX.T4
  if (tier === 'T1' || tier === 'T2' || tier === 'T3' || tier === 'T4') {
    return TIER_HEX[tier]
  }
  return TIER_HEX.T4
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
export const NEUTRAL_SCORE_COLOR = '#5D6C7B'
