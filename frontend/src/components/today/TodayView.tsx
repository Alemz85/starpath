'use client'

import { useMemo } from 'react'
import { ArrowRight, CalendarCheck2 } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { RunningInScanFooter } from '@/components/command-center/CommandCenter'
import { Button, Chip, PageHeader, Stat, StatStrip, type ChipTone } from '@/components/ui'
import { buildTodaySummary, type DeadlineItem } from '@/lib/todayCockpit'

// Severity → countdown-chip tone. Reuses the semantic tones so a deadline two
// days out reads the same red as an urgent deadline chip elsewhere in the app.
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

export function TodayView() {
  const applications = useDataStore(s => s.applications)
  const loaded = useDataStore(s => s.loaded)
  const navigate = useNavStore(s => s.navigate)

  const summary = useMemo(() => buildTodaySummary(applications), [applications])
  const { deadlines, urgent } = summary
  const next = deadlines[0]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Title bar — the meta slot is a live region so screen readers announce
          the count when it updates. */}
      <PageHeader
        title="Today"
        live
        meta={loaded ? (
          <>
            {deadlines.length} upcoming {deadlines.length === 1 ? 'deadline' : 'deadlines'}
            {urgent > 0 && (
              <>
                {' · '}
                <span className="text-danger font-medium">
                  {urgent} {urgent === 1 ? 'closes' : 'close'} this week
                </span>
              </>
            )}
          </>
        ) : '…'}
      />

      <div
        className="flex-1 flex flex-col p-5 gap-5 overflow-hidden min-h-0"
        aria-busy={!loaded}
      >
        {/* Where things stand — three counts inline, no card around them. */}
        <section className="shrink-0" aria-label="Pipeline summary">
          {loaded ? (
            <StatStrip>
              <Stat
                value={deadlines.length}
                label="Deadlines"
                hint={next ? `Next ${next.daysLeft === 0 ? 'today' : next.daysLeft === 1 ? 'tomorrow' : `in ${next.daysLeft} days`}` : 'None upcoming'}
                tone={urgent > 0 ? 'danger' : 'default'}
                dot={urgent > 0}
              />
              <Stat
                value={summary.awaitingResponse}
                label="Waiting for response"
                hint="Applications sent"
              />
              <Stat
                value={summary.awaitingNextRound}
                label="Waiting for next round"
                hint="Interviews in progress"
              />
            </StatStrip>
          ) : (
            /* Skeleton — three columns matching the real stat strip layout */
            <div className="flex divide-x divide-border-default" aria-hidden="true">
              {[0, 1, 2].map(i => (
                <div key={i} className="space-y-2 px-5 first:pl-0">
                  <div className="h-[22px] w-10 shimmer rounded" />
                  <div className="h-3.5 w-24 shimmer rounded" />
                  <div className="h-3 w-16 shimmer rounded" />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* The deadline list — soonest first, nothing else. */}
        <main
          className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1"
          aria-label="Upcoming deadlines"
        >
          {!loaded ? (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map(i => <div key={i} className="h-14 shimmer rounded-lg" />)}
            </div>
          ) : deadlines.length === 0 ? (
            <NoDeadlines onOpenApplying={() => navigate('applying')} />
          ) : (
            <ul
              className="space-y-2 max-w-3xl list-none p-0 m-0"
              aria-label={`${deadlines.length} upcoming deadline${deadlines.length === 1 ? '' : 's'}`}
            >
              {deadlines.map(item => (
                <li key={item.id}>
                  <DeadlineRow item={item} onOpen={() => navigate('applying')} />
                </li>
              ))}
            </ul>
          )}
        </main>

        <RunningInScanFooter />
      </div>
    </div>
  )
}

// ─── Deadline row ─────────────────────────────────────────────────────────────

function DeadlineRow({ item, onOpen }: { item: DeadlineItem; onOpen: () => void }) {
  return (
    <div className="card group flex items-center gap-3 h-14 px-4 transition-colors duration-150 hover:border-border-strong">
      {/* Company logo — decorative; company name appears in the text beside it */}
      <CompanyLogo company={item.company} size={32} className="shrink-0" aria-hidden />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-1 leading-tight truncate">{item.company}</p>
        <p className="text-label text-text-3 truncate mt-0.5">{item.role}</p>
      </div>

      {/* Date + countdown */}
      <div className="shrink-0 flex items-center gap-2.5">
        <span className="text-label text-text-2 tabular-nums">{DATE_FMT.format(item.date)}</span>
        <Chip tone={severityTone(item.severity)} size="sm">
          {countdown(item.daysLeft)}
        </Chip>
      </div>

      {/* Secondary — the row is a heads-up, not a primary CTA */}
      <Button
        tone="secondary"
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

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoDeadlines({ onOpenApplying }: { onOpenApplying: () => void }) {
  return (
    <div className="h-full flex items-center justify-center py-4">
      <div className="max-w-sm w-full px-6 text-center">
        <CalendarCheck2 size={40} strokeWidth={1.5} className="mx-auto mb-3 text-text-4" aria-hidden="true" />

        <h2 className="text-section text-text-1">No upcoming deadlines</h2>
        <p className="text-label text-text-3 mt-1.5">
          Deadlines show up here for listings you've moved to Applying but haven't sent yet.
        </p>

        <div className="flex items-center justify-center mt-4">
          <Button
            tone="secondary"
            size="sm"
            onClick={onOpenApplying}
            aria-label="Go to Applying"
          >
            Go to Applying
          </Button>
        </div>
      </div>
    </div>
  )
}
