'use client'

import type { ReactNode } from 'react'
import { Globe } from 'lucide-react'
import { canonicalizeArchetype } from '@/lib/archetype'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { WantEase } from '@/components/shared/WantEase'
import { Panel } from '@/components/ui'
import { buildTopBy, locationFlag, primaryPlace, type RankAxis, type TopRow } from '@/lib/trendsAnalytics'
import type { ScoreEntry } from '@/types'

export type TopListKind = 'companies' | 'locations' | 'archetypes'

/** The three top lists Trends leads with, each ranked on one named axis
 *  (Want or Ease, never both folded). Chat's `starpath:top` card reads the
 *  same definitions, so the two never disagree. */
export const TOP_LIST_DEFS: Record<TopListKind, {
  title: string
  key: (e: ScoreEntry) => string
  rankBy: RankAxis
  icon?: (label: string) => ReactNode
}> = {
  companies: {
    title: 'Top companies by Ease',
    key: e => e.company,
    rankBy: 'ease',
    icon: label => <CompanyLogo company={label} size={20} className="shrink-0" />,
  },
  locations: {
    title: 'Top locations by Want',
    key: e => primaryPlace(e.location),
    rankBy: 'want',
    icon: label => (
      <span className="w-5 shrink-0 flex items-center justify-center text-section leading-none" aria-hidden>
        {locationFlag(label) ?? <Globe size={13} className="text-text-4" />}
      </span>
    ),
  },
  archetypes: {
    title: 'Top archetypes by Ease',
    key: e => canonicalizeArchetype(e.archetype),
    rankBy: 'ease',
  },
}

export function buildTopList(rows: ScoreEntry[], kind: TopListKind, limit: number): TopRow[] {
  const def = TOP_LIST_DEFS[kind]
  return buildTopBy(rows, def.key, def.rankBy, limit)
}

// Every top list has the same anatomy: optional leading icon, label, the
// Want · Ease pair (both shown, whichever axis ranks), and the listing count.
export function TopListCard({
  title, items, icon, action, className,
}: {
  title: string
  /** Optional heading action (chat's "Open Trends"). */
  action?: ReactNode
  items: TopRow[]
  icon?: (label: string) => ReactNode
  className?: string
}) {
  return (
    <Panel
      title={title}
      meta={<span title="Average Want · Ease · number of scored listings">Want · Ease · n</span>}
      action={action}
      className={className}
    >
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default">
          {items.map(({ label, count, avgWant, avgEase }) => (
            <li key={label} className="h-9 flex items-center gap-2.5">
              {icon?.(label)}
              <span className="flex-1 min-w-0 text-body text-text-1 truncate" title={label}>{label}</span>
              <WantEase want={avgWant} ease={avgEase} size="sm" bare className="shrink-0" />
              <span className="w-6 shrink-0 text-right text-label tabular-nums text-text-4">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function EmptyHint() {
  return <p className="text-label text-text-4 py-4 text-center">No data</p>
}
