'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Panel } from '@/components/ui'
import { loadUsage, onUsageRecorded } from '@/lib/usageLog'
import {
  formatCost,
  sourceLabel,
  weeklyTotals,
  type UsageEntry,
  type UsageTotals,
} from '@/lib/usage'
import { formatTokens } from '@/lib/spawnFormat'

const RECENT_ROWS = 40

/**
 * What the Claude runs cost: a weekly total (this week and last, Monday on)
 * and every recent run with the tokens and cost the CLI reported when it
 * finished. The numbers come from the runs' own result events (see
 * lib/usage.ts), so showing them costs nothing at run time.
 *
 * Reads batch/logs/app-usage.tsv (the app's runs) and batch/logs/usage.tsv
 * (the batch runner's). Reloads when a spawn finishes and its row is written.
 */
export function UsagePanel() {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)

  const load = useCallback(() => {
    loadUsage().then(setEntries).catch(() => setEntries([]))
  }, [])

  useEffect(() => {
    load()
    return onUsageRecorded(load)
  }, [load])

  const weeks = useMemo(() => weeklyTotals(entries ?? [], Date.now()), [entries])
  const recent = useMemo(() => (entries ?? []).slice(0, RECENT_ROWS), [entries])

  return (
    <Panel
      flush
      className="shrink-0"
      title="Token usage"
      meta={entries && entries.length > 0 ? `${entries.length} run${entries.length === 1 ? '' : 's'} recorded` : undefined}
    >
      {entries === null ? null : entries.length === 0 ? (
        <p className="px-4 pb-4 text-label text-text-3 max-w-[520px]">
          Evaluations, tailoring and drafts started here, and batch runs, are listed with the tokens and cost
          Claude reports when each one finishes. Nothing is measured while they run.
        </p>
      ) : (
        <>
          <div className="flex items-stretch divide-x divide-border-default px-4 pb-3">
            <WeekFigure label="This week" totals={weeks.thisWeek} />
            <WeekFigure label="Last week" totals={weeks.lastWeek} />
          </div>
          <div className="border-t border-border-default/50 max-h-[168px] overflow-y-auto px-1.5 py-1.5" role="list" aria-label="Recent runs">
            {recent.map((e, i) => (
              <UsageRow key={`${e.at}-${e.label}-${i}`} entry={e} />
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

function WeekFigure({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="px-6 first:pl-0 min-w-0 flex-1">
      <div className="text-label font-medium text-text-2">{label}</div>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-stat tabular-nums text-text-1 truncate">{totals.runs === 0 ? '—' : formatCost(totals.costUsd)}</span>
      </div>
      <div className="text-label text-text-4 truncate">
        {totals.runs === 0
          ? 'No runs'
          : `${totals.runs} run${totals.runs === 1 ? '' : 's'} · ${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out` +
            (totals.unpriced > 0 ? ` · ${totals.unpriced} without a cost` : '')}
      </div>
    </div>
  )
}

function UsageRow({ entry }: { entry: UsageEntry }) {
  const when = new Date(entry.at)
  const failed = entry.status === 'failed'
  const detail =
    `${formatTokens(entry.inputTokens)} in` +
    (entry.cachedShare > 0 ? ` (${Math.round(entry.cachedShare * 100)}% cached)` : '') +
    ` / ${formatTokens(entry.outputTokens)} out`
  return (
    <div role="listitem" className="flex items-center gap-3 h-8 px-2 rounded hover:bg-bg-elevated transition-colors duration-150">
      <span className="text-body font-medium text-text-1 truncate min-w-0 flex-1" title={entry.label}>{entry.label}</span>
      <span className={failed ? 'text-label text-danger shrink-0 w-[110px] text-right' : 'text-label text-text-3 shrink-0 w-[110px] text-right'}>
        {failed ? 'Failed' : sourceLabel(entry.source)}
      </span>
      <span className="text-label text-text-4 tabular-nums whitespace-nowrap shrink-0 w-[96px] text-right" title={when.toLocaleString()}>
        {when.toLocaleDateString([], { day: 'numeric', month: 'short' })} {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      <span className="text-label text-text-3 tabular-nums whitespace-nowrap shrink-0 w-[190px] text-right">{detail}</span>
      <span className="text-body text-text-1 tabular-nums shrink-0 w-[56px] text-right">{formatCost(entry.costUsd)}</span>
    </div>
  )
}
