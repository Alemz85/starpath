'use client'

import { useMemo } from 'react'
import { ArrowRight, CalendarCheck2, Briefcase } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { cn } from '@/lib/utils'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { RunningInScanFooter, HeroStatTile } from '@/components/command-center/CommandCenter'
import { buildTodaySummary, type DeadlineItem } from '@/lib/todayCockpit'

// Severity → countdown-chip tone. Reuses the semantic tokens so a deadline two
// days out reads the same red as an urgent deadline badge elsewhere in the app.
function severityTone(sev: DeadlineItem['severity']): string {
  switch (sev) {
    case 'critical': return 'text-danger bg-danger/10 border-danger/30'
    case 'high':     return 'text-warning bg-warning/10 border-warning/30'
    case 'medium':   return 'text-accent bg-accent/10 border-accent/30'
    default:         return 'text-text-3 bg-bg-elevated border-border-default'
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
      {/* Title bar — landmark header for screen readers */}
      <header className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome" aria-label="Today cockpit">
        <h1 className="text-body text-text-1 font-medium">Today</h1>
        {/* Live region so screen readers announce the count when it updates */}
        <span
          className="text-label text-text-4 font-mono"
          aria-live="polite"
          aria-atomic="true"
        >
          {loaded ? `${deadlines.length} upcoming ${deadlines.length === 1 ? 'deadline' : 'deadlines'}` : '…'}
        </span>
      </header>

      <div
        className="flex-1 flex flex-col px-8 pt-8 pb-6 gap-5 overflow-hidden min-h-0"
        aria-busy={!loaded}
      >
        {/* Editorial hero — headline plus the three "where things stand"
            counts. Mirrors the Applying hero (galaxy-bg card, display title,
            divided stat strip). */}
        <section
          className="shrink-0 galaxy-bg rounded-xl border border-border-default px-9 py-7 shadow-cosmos"
          aria-label="Pipeline summary"
        >
          <div className="flex items-baseline justify-between gap-6 flex-wrap mb-7">
            {/* h2 here so the page hierarchy is h1 (title bar) → h2 (section) */}
            <h2 className="text-display-2 text-text-1">What's next</h2>
            {loaded && urgent > 0 && (
              <span className="text-label text-danger font-medium">
                {urgent} {urgent === 1 ? 'deadline closes' : 'deadlines close'} this week
              </span>
            )}
          </div>

          {loaded ? (
            <div className="grid grid-cols-3 divide-x divide-border-default/50">
              <HeroStatTile
                value={deadlines.length}
                label="Deadlines"
                sub={next ? `next ${next.daysLeft === 0 ? 'today' : next.daysLeft === 1 ? 'tomorrow' : `in ${next.daysLeft} days`}` : 'none upcoming'}
                accent={urgent > 0 ? 'text-danger' : undefined}
                highlightDot={urgent > 0 ? 'bg-danger' : undefined}
              />
              <HeroStatTile
                value={summary.awaitingResponse}
                label="Waiting for response"
                sub="applications sent"
              />
              <HeroStatTile
                value={summary.awaitingNextRound}
                label="Waiting for next round"
                sub="interviews in progress"
              />
            </div>
          ) : (
            /* Skeleton — three columns matching the real stat strip layout */
            <div className="grid grid-cols-3 gap-4" aria-hidden="true">
              {[0, 1, 2].map(i => (
                <div key={i} className="space-y-2 px-5 first:pl-0">
                  <div className="h-7 w-10 shimmer rounded" />
                  <div className="h-3.5 w-20 shimmer rounded" />
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
              {[0, 1, 2].map(i => <div key={i} className="h-[60px] shimmer rounded-lg" />)}
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
    <div className="group flex items-center gap-3.5 rounded-lg bg-bg-base border border-border-default px-4 py-3 transition-colors hover:border-border-strong">
      {/* Company logo — decorative; company name appears in the text beside it */}
      <CompanyLogo company={item.company} size={32} className="shrink-0" aria-hidden />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-1 leading-tight truncate">{item.company}</p>
        <p className="text-[12px] text-text-3 truncate mt-0.5">{item.role}</p>
      </div>

      {/* Date + countdown */}
      <div className="shrink-0 flex items-center gap-2.5">
        <span className="text-[12px] text-text-2 font-mono tabular-nums">{DATE_FMT.format(item.date)}</span>
        <span
          className={cn(
            'inline-flex items-center text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full border',
            severityTone(item.severity),
          )}
        >
          {countdown(item.daysLeft)}
        </span>
      </div>

      {/* Secondary outlined pill — the row is a heads-up, not a primary CTA */}
      <button
        onClick={onOpen}
        aria-label={`Open ${item.company} — ${item.role} in Applying`}
        className="shrink-0 inline-flex items-center gap-1 pl-3 pr-2.5 h-7 rounded-pill border border-border-strong text-text-2 text-[12px] font-medium hover:bg-bg-elevated transition-colors"
      >
        Open
        <ArrowRight size={12} aria-hidden className="text-text-4" />
      </button>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoDeadlines({ onOpenApplying }: { onOpenApplying: () => void }) {
  return (
    <div className="h-full flex items-center justify-center py-4">
      <div className="max-w-sm w-full px-6 text-center">
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-4"
          aria-hidden="true"
        >
          <CalendarCheck2 size={22} className="text-success" />
        </span>

        <h2 className="text-[15px] font-semibold text-text-1">No upcoming deadlines</h2>
        <p className="text-[12.5px] text-text-3 leading-relaxed mt-2">
          Deadlines show up here for listings you've moved to Applying but haven't sent yet.
        </p>

        <div className="flex items-center justify-center mt-5">
          <button
            onClick={onOpenApplying}
            aria-label="Go to Applying"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-pill border border-border-strong text-text-2 text-[12px] font-medium hover:bg-bg-elevated transition-colors"
          >
            <Briefcase size={13} aria-hidden className="text-text-4" />
            Go to Applying
          </button>
        </div>
      </div>
    </div>
  )
}
