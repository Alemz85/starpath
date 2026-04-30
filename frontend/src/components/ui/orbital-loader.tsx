// Three concentric rings rotating at staggered durations and
// alternating directions. Pure CSS keyframes (no motion library
// dependency) so the loader stays cheap to mount everywhere. Stroke is
// the galaxy violet accent; rings are open at the top so each one
// reads as a single arc rather than a circle. Honors prefers-reduced-
// motion via globals.css media query.

import { cn } from '@/lib/utils'

interface OrbitalLoaderProps {
  /** Outer diameter in px. */
  size?: number
  /** Number of concentric rings (1–3). Use 1 or 2 in tight inline
   *  contexts (sidebar corner, list-row indicator) where 3 stacked
   *  borders mush together at small sizes. */
  rings?: 1 | 2 | 3
  /** Stroke width override. Defaults to 2px (size ≥ 24) or 1.5px (size < 24). */
  strokeWidth?: number
  /** Optional stroke color class. Defaults to text-accent currentColor. */
  strokeClass?: string
  className?: string
}

export function OrbitalLoader({
  size = 56,
  rings = 3,
  strokeWidth,
  strokeClass = 'text-accent',
  className,
}: OrbitalLoaderProps) {
  const sw = strokeWidth ?? (size < 24 ? 1.5 : 2)
  const ringBase = 'absolute rounded-full pointer-events-none'
  const ringStyle = {
    borderTopColor: 'currentColor',
    borderTopStyle: 'solid' as const,
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
    borderRightStyle: 'solid' as const,
    borderBottomStyle: 'solid' as const,
    borderLeftStyle: 'solid' as const,
    borderWidth: sw,
  }
  return (
    <div
      className={cn('relative inline-block', strokeClass, className)}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    >
      <span
        className={cn(ringBase, 'inset-0 orbital-spin orbital-spin-cw')}
        style={{ ...ringStyle, animationDuration: '1.6s' }}
      />
      {rings >= 2 && (
        <span
          className={cn(ringBase, 'orbital-spin orbital-spin-ccw')}
          style={{
            ...ringStyle,
            inset: rings === 2 ? '22%' : '14%',
            opacity: 0.75,
            animationDuration: '2.1s',
          }}
        />
      )}
      {rings >= 3 && (
        <span
          className={cn(ringBase, 'inset-[30%] orbital-spin orbital-spin-cw')}
          style={{
            ...ringStyle,
            opacity: 0.5,
            animationDuration: '1.1s',
          }}
        />
      )}
    </div>
  )
}
