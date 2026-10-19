import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Heading for a panel or a section of a page: sentence-case title, a quiet
// meta read-out, an optional action. No eyebrow, no icon, no uppercase.
export interface SectionHeadingProps {
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
  /** Hairline under the heading (default on inside cards). */
  rule?: boolean
  /** `sm` for headings inside dense cards, `md` for page sections. */
  size?: 'sm' | 'md'
  className?: string
}

export function SectionHeading({ title, meta, action, rule = true, size = 'sm', className }: SectionHeadingProps) {
  return (
    <div className={cn(
      'flex items-baseline justify-between gap-3',
      rule ? 'pb-2 mb-3 border-b border-border-default' : 'mb-2',
      className,
    )}>
      <h2 className={cn('text-text-1 truncate min-w-0', size === 'md' ? 'text-title' : 'text-section')}>{title}</h2>
      <div className="flex items-baseline gap-3 shrink-0">
        {meta != null && meta !== '' && <span className="text-label text-text-3 tabular-nums">{meta}</span>}
        {action}
      </div>
    </div>
  )
}
