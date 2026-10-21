'use client'

// The ONE Want · Ease renderer (scoring v2, DESIGN-meta § Want · Ease). A
// thin wrapper over the design-system `ScoreNumber` primitive so the display
// rule lives in one place:
//
//   • Want first, then Ease, each a `ScoreNumber` with a `.label` caption —
//     never a single combined number, never Priority (a sort key only).
//   • Each number takes its own `scoreColor` (the ScoreNumber default).
//   • A blocked (eligibility red) listing has no scores: its reason is shown
//     IN PLACE of the pair as plain `text-label text-danger`.
//   • A missing score renders "—" (ScoreNumber's null state), never 0.

import { cn } from '@/lib/utils'
import { ScoreNumber } from '@/components/ui/score'

export interface WantEaseProps {
  want: number | null | undefined
  ease: number | null | undefined
  /** When set, the listing is blocked: show this reason instead of scores. */
  blockedReason?: string | null
  /** ScoreNumber size for both numbers. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Hide the "Want" / "Ease" captions (dense cells that carry a header). */
  bare?: boolean
  /** Force decimals on both numbers (ScoreNumber default: one). */
  decimals?: number
  /** Extra classes on each number (e.g. a size override). */
  numberClassName?: string
  className?: string
}

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : n.toFixed(2)

export function WantEase({ want, ease, blockedReason, size = 'md', bare = false, decimals, numberClassName, className }: WantEaseProps) {
  // A blocked row shows its reason in place of the scores, unless it was
  // scored anyway (profile score_through_red): then the numbers show and the
  // reason rides in the tooltip, next to the red eligibility flag.
  const scored = want != null && Number.isFinite(want) && ease != null && Number.isFinite(ease)
  if (blockedReason && !scored) {
    return (
      <span className={cn('text-label text-danger truncate', className)} title={`Blocked — ${blockedReason}`}>
        {blockedReason}
      </span>
    )
  }
  const title = `Want ${fmt(want)} · Ease ${fmt(ease)}${blockedReason ? ` · Blocked: ${blockedReason}` : ''}`
  return (
    <span className={cn('inline-flex items-baseline gap-1.5 whitespace-nowrap', className)} title={title}>
      {!bare && <span className="label">Want</span>}
      <ScoreNumber value={want} size={size} decimals={decimals} className={numberClassName} />
      <span className="text-text-4" aria-hidden>·</span>
      {!bare && <span className="label">Ease</span>}
      <ScoreNumber value={ease} size={size} decimals={decimals} className={numberClassName} />
    </span>
  )
}
