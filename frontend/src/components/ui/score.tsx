import { cn } from '@/lib/utils'
import { scoreColor, NEUTRAL_SCORE_COLOR } from '@/lib/tier'

// Score renderings. One number treatment (tabular, semibold, tier-ladder
// colour) at three sizes, plus a 3px bar for scanning magnitude.

export function ScoreNumber({
  value, size = 'md', denominator, decimals, className, title,
}: {
  value: number | null | undefined
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Append "/10" in the muted colour. */
  denominator?: boolean
  /** Force decimals (default: one decimal, integers shown bare at sm/md). */
  decimals?: number
  className?: string
  title?: string
}) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : null
  const sizeClass =
    size === 'xl' ? 'text-display' :
    size === 'lg' ? 'text-stat' :
    size === 'md' ? 'text-[14px] font-semibold' :
    'text-[12px] font-semibold'
  if (n === null || n <= 0) {
    return <span className={cn('tabular-nums text-text-4', sizeClass, className)}>—</span>
  }
  const text = decimals != null ? n.toFixed(decimals) : n.toFixed(1)
  return (
    <span className={cn('tabular-nums', sizeClass, className)} style={{ color: scoreColor(n) }} title={title}>
      {text}
      {denominator && <span className="text-text-4 font-normal text-[0.7em] ml-0.5">/10</span>}
    </span>
  )
}

export function ScoreBar({ value, className, width }: { value: number | null | undefined; className?: string; width?: number | string }) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(10, value)) : 0
  return (
    <div className={cn('score-bar-track', className)} style={{ width }} aria-hidden>
      <div className="score-bar-fill" style={{ width: `${n * 10}%`, background: n > 0 ? scoreColor(n) : NEUTRAL_SCORE_COLOR }} />
    </div>
  )
}
