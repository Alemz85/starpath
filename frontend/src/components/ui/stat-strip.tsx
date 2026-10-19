import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Key-figure strip: a quiet card carrying the page's few important numbers in
// a row, separated by hairlines. The galaxy wash is the one place the brand
// surface survives on a work screen; it stays faint. `flat` drops the card for
// strips that already sit inside a panel.
export function StatStrip({ children, className, flat }: { children: ReactNode; className?: string; flat?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-stretch divide-x divide-border-default',
        !flat && 'card galaxy-bg px-6 py-4 shadow-cosmos',
        className,
      )}
    >
      {children}
    </div>
  )
}

export type StatTone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'

const TONE_CLASS: Record<StatTone, string> = {
  default: 'text-text-1',
  accent:  'text-accent-text',
  success: 'text-success',
  warning: 'text-warning-text',
  danger:  'text-danger',
  muted:   'text-text-4',
}

const DOT_CLASS: Record<StatTone, string> = {
  default: 'bg-accent',
  accent:  'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger:  'bg-danger',
  muted:   'bg-text-4',
}

export interface StatProps {
  value: ReactNode
  label: string
  /** Secondary line under the label ("9 companies", "next in 3 days"). */
  hint?: ReactNode
  tone?: StatTone
  /** Small marker beside the number for "act now" figures. */
  dot?: boolean
  /** Tooltip for the whole figure. */
  title?: string
  className?: string
}

export function Stat({ value, label, hint, tone = 'default', dot, title, className }: StatProps) {
  return (
    <div className={cn('px-6 first:pl-0 last:pr-0 min-w-0 flex-1', className)} title={title}>
      <div className="flex items-start gap-1.5">
        <span className={cn('text-stat tabular-nums truncate', TONE_CLASS[tone])}>{value}</span>
        {dot && <span className={cn('inline-block w-1.5 h-1.5 rounded-full shrink-0 mt-1.5', DOT_CLASS[tone])} aria-hidden />}
      </div>
      <div className="text-body font-medium text-text-2 mt-1.5 truncate">{label}</div>
      {hint && <div className="text-label text-text-4 truncate">{hint}</div>}
    </div>
  )
}
