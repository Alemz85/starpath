import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The one title row every view uses. Sits under the macOS traffic lights,
// aligns with the sidebar's own title row, and carries: title · meta · actions.
// No icons before the title, no duplicate hero below it.
export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: string
  /** Short read-out next to the title: counts, status, a live caption. */
  meta?: ReactNode
  /** Right-aligned controls. Interactive children opt out of the drag region
   *  automatically via `.titlebar-no-drag` on the slot. */
  actions?: ReactNode
  /** aria-live announcement for the meta slot (counts that update). */
  live?: boolean
  className?: string
}

export function PageHeader({ title, meta, actions, live, className, ...rest }: PageHeaderProps) {
  return (
    <header className={cn('title-bar gap-3 px-4 border-b border-border-default/70', className)} {...rest}>
      <h1 className="text-title text-text-1 shrink-0">{title}</h1>
      {meta != null && meta !== '' && (
        <span
          className="text-label text-text-3 tabular-nums truncate min-w-0"
          aria-live={live ? 'polite' : undefined}
          aria-atomic={live ? 'true' : undefined}
        >
          {meta}
        </span>
      )}
      {actions && (
        <div className="titlebar-no-drag ml-auto flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </header>
  )
}
