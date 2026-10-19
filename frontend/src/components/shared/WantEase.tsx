'use client'

// The ONE Want · Ease renderer (scoring v2, DESIGN-meta § Tier and Status
// Sections › Want · Ease). Every surface that shows a listing's scores uses
// this component so the display rule lives in one place:
//
//   • Want first, then Ease, separated by a middle dot — never a single
//     combined number, never Priority (that is a sort key only).
//   • Each number is coloured on its own by the shared `scoreColor` scale.
//   • A blocked (eligibility red) listing has no scores: its red reason is
//     rendered IN PLACE of the pair, in the `danger` token.
//   • A missing score renders "—", never 0.
//
// Sizes map onto type sizes the app already uses: `sm` = the 11px mono table
// cell, `md` = the 13px body mono, `lg` = the slide-over hero plate (44px).

import { cn } from '@/lib/utils'
import { scoreColor, NEUTRAL_SCORE_COLOR } from '@/lib/tier'

export interface WantEaseProps {
  want: number | null | undefined
  ease: number | null | undefined
  /** When set, the listing is blocked: show this reason instead of scores. */
  blockedReason?: string | null
  size?: 'sm' | 'md' | 'lg'
  /** `inline` = "W 8.3 · E 5.6"; `stacked` = two lines (narrow cells). */
  layout?: 'inline' | 'stacked'
  className?: string
}

const fmt = (n: number | null | undefined, decimals: number) =>
  n == null || !Number.isFinite(n) ? '—' : n.toFixed(decimals)

const colorOf = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? NEUTRAL_SCORE_COLOR : scoreColor(n)

export function WantEase({ want, ease, blockedReason, size = 'sm', layout = 'inline', className }: WantEaseProps) {
  if (blockedReason) {
    return (
      <span
        className={cn(
          'text-danger truncate',
          size === 'lg' ? 'text-section' : size === 'md' ? 'text-[13px]' : 'text-[11px]',
          className,
        )}
        title={`Blocked — ${blockedReason}`}
      >
        {blockedReason}
      </span>
    )
  }

  if (size === 'lg') {
    return (
      <div className={cn('flex items-end gap-6', className)} aria-label={`Want ${fmt(want, 2)} of 10, Ease ${fmt(ease, 2)} of 10`}>
        <HeroNumber label="Want" value={want} />
        <HeroNumber label="Ease" value={ease} />
      </div>
    )
  }

  const num = size === 'md' ? 'text-[13px]' : 'text-[11px]'
  const tag = 'text-[9px] uppercase text-text-4 tracking-wider'
  const label = `Want ${fmt(want, 2)}, Ease ${fmt(ease, 2)}`

  if (layout === 'stacked') {
    return (
      <div className={cn('font-mono tabular-nums leading-[1.15]', num, className)} title={label}>
        <div className="flex items-baseline gap-1.5">
          <span className={cn(tag, 'w-4')}>W</span>
          <span className="font-semibold" style={{ color: colorOf(want) }}>{fmt(want, 1)}</span>
        </div>
        <div className="flex items-baseline gap-1.5 mt-[3px]">
          <span className={cn(tag, 'w-4')}>E</span>
          <span className="font-semibold" style={{ color: colorOf(ease) }}>{fmt(ease, 1)}</span>
        </div>
      </div>
    )
  }

  return (
    <span className={cn('inline-flex items-baseline gap-1 font-mono tabular-nums whitespace-nowrap', num, className)} title={label}>
      <span className={tag}>W</span>
      <span className="font-semibold" style={{ color: colorOf(want) }}>{fmt(want, 1)}</span>
      <span className="text-text-4">·</span>
      <span className={tag}>E</span>
      <span className="font-semibold" style={{ color: colorOf(ease) }}>{fmt(ease, 1)}</span>
    </span>
  )
}

function HeroNumber({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex flex-col">
      <span className="text-micro text-text-4 uppercase tracking-[0.12em] mb-1">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="font-mono font-semibold tabular-nums leading-none text-[44px]" style={{ color: colorOf(value) }}>
          {fmt(value, value != null && Number.isInteger(value) ? 0 : 2)}
        </span>
        <span className="font-mono tabular-nums text-[15px] text-text-4">/10</span>
      </span>
    </div>
  )
}
