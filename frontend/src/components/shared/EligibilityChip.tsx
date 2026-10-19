'use client'

// The ONE eligibility chip and the ONE verdict chip (scoring v2,
// DESIGN-meta § Tier and Status Sections). Every view uses these so the
// colour mapping lives in a single place:
//
//   EligibilityChip — semantic tokens over their documented BG tints:
//     green → success  ("Eligible")
//     amber → warning  ("Check first")
//     red   → danger   ("Blocked")
//   VerdictChip — the verdict's storage-tier tokens (verdict → tier map,
//     docs/scoring-v2.md §4); a verdict never gets a colour of its own.
//
// Pill shape and the 10px mono label match the existing StatusBadge /
// tier chips, so no new radius, size or colour is introduced.

import { cn } from '@/lib/utils'
import type { Eligibility, Verdict } from '@/types'
import { ELIGIBILITY_COLORS, ELIGIBILITY_LABELS } from '@/types'
import { verdictDisplay } from '@/lib/tier'

export function EligibilityChip({
  status, reason, compact = false, className,
}: {
  status: Eligibility | null | undefined
  /** Shown in the tooltip (and inline for `red` when not compact). */
  reason?: string | null
  /** Dot only — for dense table cells. */
  compact?: boolean
  className?: string
}) {
  if (!status) return null
  const c = ELIGIBILITY_COLORS[status]
  const title = reason ? `${ELIGIBILITY_LABELS[status]} — ${reason}` : ELIGIBILITY_LABELS[status]
  if (compact) {
    return (
      <span className={cn('inline-flex items-center', className)} title={title} aria-label={title}>
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', c.dot)} aria-hidden />
      </span>
    )
  }
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill border',
        'text-[10px] font-mono font-semibold uppercase tracking-[0.06em] whitespace-nowrap',
        c.bg, c.text, c.border, className,
      )}
      title={title}
    >
      <span className={cn('inline-block w-1.5 h-1.5 rounded-full', c.dot)} aria-hidden />
      {ELIGIBILITY_LABELS[status]}
    </span>
  )
}

export function VerdictChip({
  verdict, showAction = false, className,
}: {
  verdict: Verdict | null | undefined
  /** Append the cell's action ("Stretch — apply with prep"). */
  showAction?: boolean
  className?: string
}) {
  const v = verdictDisplay(verdict)
  if (!v) return null
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-pill border',
        'text-[10px] font-mono font-semibold tracking-[0.02em] whitespace-nowrap',
        v.chip.bg, v.chip.text, v.chip.border, className,
      )}
      title={`${v.headline} (${v.tier})`}
    >
      {showAction ? v.headline : v.label}
    </span>
  )
}
