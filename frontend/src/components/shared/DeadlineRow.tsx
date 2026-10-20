'use client'

import { ArrowRight } from 'lucide-react'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { Button, Chip, type ChipTone } from '@/components/ui'
import type { DeadlineItem } from '@/lib/todayCockpit'

function severityTone(sev: DeadlineItem['severity']): ChipTone {
  switch (sev) {
    case 'critical': return 'danger'
    case 'high':     return 'warning'
    case 'medium':   return 'accent'
    default:         return 'neutral'
  }
}

function countdown(days: number): string {
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `In ${days} days`
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

/** One upcoming deadline: logo, company and role, the date, a countdown chip
 *  coloured by urgency, and an Open action (Scout's Deadlines panel, chat). */
export function DeadlineRow({ item, onOpen }: { item: DeadlineItem; onOpen: () => void }) {
  return (
    <div className="group flex items-center gap-3 h-14 px-4 transition-colors duration-150 hover:bg-bg-elevated">
      <CompanyLogo company={item.company} size={32} className="shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-1 leading-tight truncate">{item.company}</p>
        <p className="text-label text-text-3 truncate mt-0.5">{item.role}</p>
      </div>
      <div className="shrink-0 flex items-center gap-2.5">
        <span className="text-label text-text-2 tabular-nums">{DATE_FMT.format(item.date)}</span>
        <Chip tone={severityTone(item.severity)} size="sm">{countdown(item.daysLeft)}</Chip>
      </div>
      <Button
        tone="ghost"
        size="sm"
        onClick={onOpen}
        aria-label={`Open ${item.company} — ${item.role} in Applying`}
        trailing={<ArrowRight size={12} aria-hidden />}
        className="shrink-0"
      >
        Open
      </Button>
    </div>
  )
}
