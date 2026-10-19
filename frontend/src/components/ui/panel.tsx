import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SectionHeading } from './section-heading'

// A card with an optional heading. Flat, hairline, 12px radius, 16px padding.
export interface PanelProps {
  title?: ReactNode
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  /** Remove the padding (tables, lists that run edge to edge). */
  flush?: boolean
}

export function Panel({ title, meta, action, children, className, flush }: PanelProps) {
  return (
    <section className={cn('card', !flush && 'p-4', className)}>
      {title != null && (
        <SectionHeading title={title} meta={meta} action={action} className={flush ? 'px-4 pt-3' : undefined} />
      )}
      {children}
    </section>
  )
}
