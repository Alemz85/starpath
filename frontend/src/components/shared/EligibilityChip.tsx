'use client'

// The ONE eligibility chip and the ONE verdict chip (scoring v2,
// DESIGN-meta § Eligibility and verdict). Thin wrappers over the
// design-system primitives so the mapping lives in a single place:
//
//   EligibilityChip — `Chip` semantic tones:
//     green → success ("Eligible")
//     amber → warning ("Check first")
//     red   → danger  ("Blocked")
//   VerdictChip — `TierChip` colouring via the verdict → tier map
//     (docs/scoring-v2.md §4); a verdict never gets a colour of its own.

import { cn } from '@/lib/utils'
import type { Eligibility, Verdict } from '@/types'
import { ELIGIBILITY_LABELS } from '@/types'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { tierColor, tierVerdict, verdictTier, TIER_BG } from '@/lib/tier'

const ELIGIBILITY_TONE: Record<Eligibility, ChipTone> = {
  green: 'success',
  amber: 'warning',
  red:   'danger',
}

// Dot colours for the compact form — the same semantic tokens.
const ELIGIBILITY_DOT: Record<Eligibility, string> = {
  green: 'bg-success',
  amber: 'bg-warning',
  red:   'bg-danger',
}

export function EligibilityChip({
  status, reason, compact = false, className,
}: {
  status: Eligibility | null | undefined
  /** Shown in the tooltip. */
  reason?: string | null
  /** Dot only — for dense table cells. */
  compact?: boolean
  className?: string
}) {
  if (!status) return null
  const title = reason ? `${ELIGIBILITY_LABELS[status]} — ${reason}` : ELIGIBILITY_LABELS[status]
  if (compact) {
    return (
      <span className={cn('inline-flex items-center', className)} title={title} aria-label={title}>
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', ELIGIBILITY_DOT[status])} aria-hidden />
      </span>
    )
  }
  return (
    <Chip tone={ELIGIBILITY_TONE[status]} className={className} title={title}>
      {ELIGIBILITY_LABELS[status]}
    </Chip>
  )
}

export function VerdictChip({
  verdict, showAction = false, size = 'sm', className,
}: {
  verdict: Verdict | null | undefined
  /** "Stretch — apply with prep" instead of "Stretch". */
  showAction?: boolean
  size?: 'sm' | 'md'
  className?: string
}) {
  const tier = verdictTier(verdict)
  if (!tier) return null
  // Same chip shape and tier colouring as `TierChip` (components/ui/chip),
  // with the verdict label instead of the tier symbol.
  const color = tierColor(tier)
  return (
    <span
      className={cn('chip font-semibold', size === 'md' && 'chip-md', className)}
      style={{ color, background: TIER_BG[tier] ?? TIER_BG.T4, borderColor: tierColor(tier, 0.2) }}
      title={`${tierVerdict(verdict)} (${tier})`}
    >
      {tierVerdict(verdict, { short: !showAction })}
    </span>
  )
}
