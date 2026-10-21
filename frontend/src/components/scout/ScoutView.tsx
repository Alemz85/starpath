'use client'

import { useMemo } from 'react'
import { clsx } from 'clsx'
import { CalendarCheck2 } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { formatRelative } from '@/lib/utils'
import { buildTodaySummary, type TodaySummary } from '@/lib/todayCockpit'
import { buildFunnel } from '@/lib/trendsAnalytics'
import { DeadlineRow } from '@/components/shared/DeadlineRow'
import { ScoutingActionPanel } from '@/components/command-center/CommandCenter'
import { DailyBriefPanel } from '@/components/command-center/DailyBriefPanel'
import { Button, PageHeader, Panel } from '@/components/ui'

// Scout — the home surface. One overview card tells the whole story (how
// far the pipeline has travelled, what needs the user now), the scan actions
// sit directly under it, and the rest of the canvas is the deadline list.

export function ScoutView() {
  const repoPath = useAppStore(s => s.repoPath)
  const dailyBriefEnabled = useAppStore(s => s.features.dailyBriefPanel)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const pipeline = useDataStore(s => s.pipeline)
  const scansThisMonth = useDataStore(s => s.scansThisMonth)
  const loaded = useDataStore(s => s.loaded)
  const refresh = useDataStore(s => s.refresh)
  const navigate = useNavStore(s => s.navigate)

  const summary = useMemo(() => buildTodaySummary(applications), [applications])
  const funnel = useMemo(() => buildFunnel(applications), [applications])
  const distinctCompanies = useMemo(
    () => new Set(scoreHistory.map(e => e.company).filter(Boolean)).size,
    [scoreHistory],
  )
  const lastScanDate = useMemo(
    () => (scoreHistory.length ? [...scoreHistory].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? null : null),
    [scoreHistory],
  )

  const meta = loaded
    ? [
        lastScanDate ? `Last scan ${formatRelative(lastScanDate)}` : 'No scans yet',
        `${scansThisMonth} ${scansThisMonth === 1 ? 'scan' : 'scans'} this month`,
      ].join(' · ')
    : undefined

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Scout" meta={meta} />

      <div className="flex-1 min-h-0 flex flex-col gap-4 p-5 overflow-hidden" aria-busy={!loaded}>
        <OverviewCard
          loaded={loaded}
          evaluated={scoreHistory.length}
          companies={distinctCompanies}
          pending={pipeline.length}
          funnel={funnel}
          summary={summary}
        />

        <ScoutingActionPanel repoPath={repoPath} onPipelineDone={refresh} />

        <div className="flex-1 min-h-0 flex flex-col gap-4">
          {dailyBriefEnabled && <DailyBriefPanel className="shrink-0 max-h-[40%]" />}
          <DeadlinesPanel loaded={loaded} summary={summary} onOpenApplying={() => navigate('applying')} />
        </div>
      </div>
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────
//
// Left: the pipeline as a funnel, evaluated → sent → responded → interviewing
// → offers, each stage a figure over a bar scaled to the first stage so the
// drop-off reads at a glance. Stage colours follow the lifecycle semantics
// used everywhere else (violet in motion, amber interviewing, green offer).
// Right: the four figures that ask for the user's time today.

interface FunnelCounts { sent: number; responded: number; interview: number; offer: number; rejected: number }

// The application lifecycle, left to right. Each stage is a figure over its
// label, type only: the figure takes the lifecycle colour (accent in motion,
// amber interviewing, green offers, red rejections) only once the count is
// non-zero, and sits in text-1 otherwise. Evaluated roles are counted in the
// card's meta line, not here: this row is about applications.
const STAGES: Array<{ key: keyof FunnelCounts; label: string; tone: 'accent' | 'warning' | 'success' | 'danger' }> = [
  { key: 'sent',      label: 'Sent',       tone: 'accent' },
  { key: 'responded', label: 'Responded',  tone: 'accent' },
  { key: 'interview', label: 'Interviews', tone: 'warning' },
  { key: 'offer',     label: 'Offers',     tone: 'success' },
  { key: 'rejected',  label: 'Rejected',   tone: 'danger' },
]

const STAGE_FIGURE_CLASS: Record<(typeof STAGES)[number]['tone'], string> = {
  accent:  'text-accent-text',
  warning: 'text-warning-text',
  success: 'text-success',
  danger:  'text-danger',
}

function OverviewCard({ loaded, evaluated, companies, pending, funnel, summary }: {
  loaded: boolean
  evaluated: number
  companies: number
  pending: number
  funnel: FunnelCounts
  summary: TodaySummary
}) {
  const next = summary.deadlines[0]
  const nextLabel = next
    ? `Next ${next.daysLeft === 0 ? 'today' : next.daysLeft === 1 ? 'tomorrow' : `in ${next.daysLeft} days`}`
    : 'None upcoming'

  return (
    <section aria-label="Where things stand" className="card galaxy-bg shadow-cosmos overflow-hidden shrink-0">
      <div className="flex items-baseline justify-between gap-4 px-6 pt-4 pb-3 border-b border-border-default/60">
        <h2 className="text-title text-text-1">Where things stand</h2>
        {loaded && (
          <span className="text-label text-text-3 tabular-nums truncate">
            {evaluated} evaluated across {companies} {companies === 1 ? 'company' : 'companies'}
            {summary.urgent > 0 && (
              <>
                {' · '}
                <span className="text-danger font-medium">
                  {summary.urgent} {summary.urgent === 1 ? 'deadline closes' : 'deadlines close'} this week
                </span>
              </>
            )}
          </span>
        )}
      </div>

      {!loaded ? (
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] divide-x divide-border-default/60" aria-hidden>
          <div className="px-6 py-4 flex gap-6">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-10 w-28 shimmer rounded" />)}
          </div>
          <div className="px-6 py-4 flex flex-col gap-2">
            {[0, 1, 2, 3].map(i => <div key={i} className="h-8 shimmer rounded" />)}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] divide-x divide-border-default/60">
          <div className="px-6 py-4 min-w-0 flex flex-col">
            <div className="label">Applications</div>
            <ol className="flex items-start gap-6 mt-8" aria-label="Application stages">
              {STAGES.map((stage, i) => {
                const value = funnel[stage.key] ?? 0
                return (
                  <li
                    key={stage.key}
                    className={clsx(
                      'min-w-0 flex-1',
                      // Rejected is set apart from the path by a hairline.
                      i === STAGES.length - 1 && 'pl-6 border-l border-border-default/60',
                    )}
                  >
                    <div className={clsx('text-stat tabular-nums', value > 0 ? STAGE_FIGURE_CLASS[stage.tone] : 'text-text-1')}>{value}</div>
                    <div className="text-label text-text-3 mt-0.5 truncate">{stage.label}</div>
                  </li>
                )
              })}
            </ol>
            <p className="mt-auto pt-4 text-label text-text-3">
              {evaluated === 0
                ? 'Nothing evaluated yet. Run a scan, then filter the inbox into the Database.'
                : funnel.sent === 0
                  ? `None of the ${evaluated} evaluated roles has been applied to yet.`
                  : <>
                      <span className="text-text-1 font-medium tabular-nums">{funnel.sent} of {evaluated}</span> evaluated roles became applications
                      {funnel.responded > 0 && <> · <span className="text-text-1 font-medium tabular-nums">{Math.round((funnel.responded / funnel.sent) * 100)}%</span> got a reply</>}
                    </>}
            </p>
          </div>

          <div className="px-6 py-3 min-w-0">
            <div className="label mt-1 mb-1">Needs you</div>
            <ul className="divide-y divide-border-default/50">
              <AttentionRow
                label="Listings to filter"
                hint={pending > 0 ? 'Waiting since the last scan' : 'Inbox is clear'}
                value={pending}
                tone={pending > 0 ? 'accent' : 'default'}
                dot={pending > 0}
              />
              <AttentionRow
                label="Deadlines"
                hint={nextLabel}
                value={summary.deadlines.length}
                tone={summary.urgent > 0 ? 'danger' : 'default'}
                dot={summary.urgent > 0}
              />
              <AttentionRow
                label="Waiting for a reply"
                hint="Applications sent"
                value={summary.awaitingResponse}
              />
              <AttentionRow
                label="Waiting for next round"
                hint="Interviews in progress"
                value={summary.awaitingNextRound}
              />
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}

const ATTENTION_TONE = {
  default: 'text-text-1',
  accent:  'text-accent-text',
  danger:  'text-danger',
} as const

function AttentionRow({ label, hint, value, tone = 'default', dot }: {
  label: string
  hint: string
  value: number
  tone?: keyof typeof ATTENTION_TONE
  dot?: boolean
}) {
  return (
    <li className="flex items-center gap-3 h-10">
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium text-text-1 truncate">{label}</div>
        <div className="text-label text-text-4 truncate">{hint}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={clsx('text-[18px] font-semibold tabular-nums leading-none', ATTENTION_TONE[tone])}>{value}</span>
        {dot && (
          <span className={clsx('w-1.5 h-1.5 rounded-full', tone === 'danger' ? 'bg-danger' : 'bg-accent')} aria-hidden />
        )}
      </div>
    </li>
  )
}

// ─── Deadlines ───────────────────────────────────────────────────────────────

function DeadlinesPanel({ loaded, summary, onOpenApplying }: {
  loaded: boolean
  summary: TodaySummary
  onOpenApplying: () => void
}) {
  const { deadlines, urgent } = summary
  const meta = !loaded
    ? undefined
    : deadlines.length === 0
      ? undefined
      : `${deadlines.length} upcoming${urgent > 0 ? ` · ${urgent} this week` : ''}`
  return (
    <Panel title="Deadlines" meta={meta} flush className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto" aria-label="Upcoming deadlines">
        {!loaded ? (
          <div className="px-4 pb-4 flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map(i => <div key={i} className="h-12 shimmer rounded" />)}
          </div>
        ) : deadlines.length === 0 ? (
          <NoDeadlines onOpenApplying={onOpenApplying} />
        ) : (
          <ul className="divide-y divide-border-default/60" aria-label={`${deadlines.length} upcoming deadline${deadlines.length === 1 ? '' : 's'}`}>
            {deadlines.map(item => (
              <li key={item.id}>
                <DeadlineRow item={item} onOpen={onOpenApplying} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}

function NoDeadlines({ onOpenApplying }: { onOpenApplying: () => void }) {
  return (
    <div className="h-full min-h-[160px] flex items-center justify-center px-6 py-8">
      <div className="max-w-sm text-center">
        <CalendarCheck2 size={24} strokeWidth={1.5} className="mx-auto mb-2.5 text-text-4" aria-hidden />
        <h3 className="text-section text-text-1">No upcoming deadlines</h3>
        <p className="text-label text-text-3 mt-1">
          Deadlines show up here for listings you've moved to Applying but haven't sent yet.
        </p>
        <Button tone="ghost" size="sm" onClick={onOpenApplying} className="mt-3">Go to Applying</Button>
      </div>
    </div>
  )
}
