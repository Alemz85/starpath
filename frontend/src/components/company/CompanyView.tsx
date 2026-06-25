'use client'

import { useState, useMemo } from 'react'
import { ArrowLeft, TrendingUp, TrendingDown, Minus, FileText, Send } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore, VIEW_LABELS } from '@/store/nav'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { EmptyState } from '@/components/shared/EmptyState'
import { OffersTable } from '@/components/database/OffersTable'
import { ReportSlideOver } from '@/components/reports/ReportSlideOver'
import { computeCompanyStats, type CompanyStats } from '@/lib/companyStats'
import {
  computeScoreTrajectory,
  buildEngagementTimeline,
  sparklinePath,
  trajectoryLabel,
  type ScoreTrajectory,
  type TimelineEvent,
} from '@/lib/companyTimeline'
import { scoreColor, tierHex } from '@/lib/tier'
import { cn } from '@/lib/utils'
import { STATUS_COLORS } from '@/types'
import type { ScoreEntry, ApplicationEntry, AppStatus } from '@/types'

export function CompanyView({ slug }: { slug: string }) {
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const loaded = useDataStore(s => s.loaded)
  const navigate = useNavStore(s => s.navigate)
  const returnView = useNavStore(s => s.companyReturnView)
  const [selectedEntry, setSelectedEntry] = useState<ScoreEntry | null>(null)

  // Resolve the display name from the slug — score-history first, then
  // applications (a company can be applied-to without a stored evaluation),
  // finally the raw slug as a last resort.
  const companyName = useMemo(() =>
    scoreHistory.find(s => toCompanySlug(s.company) === slug)?.company ||
    applications.find(a => toCompanySlug(a.company) === slug)?.company ||
    slug,
  [slug, scoreHistory, applications])

  const history = useMemo(
    () => scoreHistory.filter(s => toCompanySlug(s.company) === slug),
    [slug, scoreHistory],
  )
  const apps = useMemo(
    () => applications
      .filter(a => toCompanySlug(a.company) === slug)
      .sort((a, b) => b.date.localeCompare(a.date)),
    [slug, applications],
  )
  const stats = useMemo(() => computeCompanyStats(history), [history])
  const trajectory = useMemo(() => computeScoreTrajectory(history), [history])
  const timeline = useMemo(() => buildEngagementTimeline(history, apps), [history, apps])

  const selectedId = selectedEntry ? `${selectedEntry.company}-${selectedEntry.role}` : null

  // Determine whether there is any data at all for this company.
  const hasAnyData = history.length > 0 || apps.length > 0

  const backLabel = VIEW_LABELS[returnView]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Title bar — the whole bar is a macOS drag region; interactive
          elements (back button, logo, heading text) must opt out via
          titlebar-no-drag so Electron doesn't swallow their clicks. */}
      <div
        className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome flex items-center"
        role="banner"
      >
        <button
          type="button"
          onClick={() => navigate(returnView)}
          className="titlebar-no-drag flex items-center gap-1.5 py-1 pl-1.5 pr-2.5 hover:bg-bg-elevated rounded-md text-text-3 hover:text-text-1 transition-colors"
          aria-label={`Back to ${backLabel}`}
          title={`Back to ${backLabel}`}
        >
          <ArrowLeft size={16} aria-hidden />
          <span className="text-label">{backLabel}</span>
        </button>

        <div className="titlebar-no-drag flex items-center gap-2 min-w-0">
          <CompanyLogo company={companyName} size={24} />
          {/* h1 is the only top-level heading in this view */}
          <h1 className="text-body text-text-1 font-medium truncate">{companyName}</h1>
        </div>

        {loaded && stats.evalCount > 0 && (
          <span
            className="titlebar-no-drag text-label text-text-4 font-mono tabular-nums"
            aria-label={`${stats.roleCount} role${stats.roleCount !== 1 ? 's' : ''}, ${stats.evalCount} evaluation${stats.evalCount !== 1 ? 's' : ''}`}
          >
            {stats.roleCount} role{stats.roleCount !== 1 && 's'} · {stats.evalCount} eval{stats.evalCount !== 1 && 's'}
          </span>
        )}
      </div>

      <main className="flex-1 overflow-auto bg-bg-base">
        {/* Not-loaded yet — show skeleton layout */}
        {!loaded && <LoadingSkeleton />}

        {/* Loaded but company not in any data */}
        {loaded && !hasAnyData && (
          <div className="flex items-center justify-center h-full">
            <EmptyState
              title={`No data found for "${companyName}"`}
              hint="Run a scouting evaluation to build this company's dossier, or check the Database for nearby matches."
            />
          </div>
        )}

        {/* Loaded and there is data */}
        {loaded && hasAnyData && (
          <div className="max-w-6xl mx-auto p-6 space-y-8">
            {stats.evalCount > 0 && (
              <section aria-labelledby="stats-heading">
                <h2 id="stats-heading" className="sr-only">Company snapshot</h2>
                <StatStrip stats={stats} appCount={apps.length} />
              </section>
            )}

            {/* Score trajectory + engagement timeline — how this company's
                roles have scored over evaluations, and the chronological feed
                of evaluations + applications. Only worth showing once there's
                more than a single data point to read direction from. */}
            {(trajectory.points.length >= 2 || timeline.length > 1) && (
              <section aria-labelledby="trajectory-heading" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
                <h2 id="trajectory-heading" className="sr-only">Score trajectory and engagement timeline</h2>
                {trajectory.points.length >= 2 && <TrajectoryCard trajectory={trajectory} />}
                {timeline.length > 0 && (
                  <div className={cn(trajectory.points.length < 2 && 'lg:col-span-2')}>
                    <TimelineCard events={timeline} />
                  </div>
                )}
              </section>
            )}

            {apps.length > 0 && <ApplicationsSection apps={apps} />}

            <section aria-labelledby="history-heading">
              <div className="flex items-center justify-between mb-4">
                <h2 id="history-heading" className="text-section text-text-1 font-medium">
                  Score history &amp; roles
                </h2>
                <div className="text-label text-text-4" aria-live="polite">
                  {history.length} evaluation{history.length !== 1 && 's'}
                </div>
              </div>

              {history.length > 0 ? (
                <div className="border border-border-default rounded-md overflow-hidden bg-bg-chrome">
                  <OffersTable
                    rows={history}
                    onOpenReport={setSelectedEntry}
                    onRowClick={(entry) => setSelectedEntry(entry)}
                    selectedId={selectedId}
                  />
                </div>
              ) : (
                /* Company is in applications but has no score-history rows */
                <EmptyState
                  title="No evaluations on record yet"
                  hint={`Paste a ${companyName} job listing into scouting to build the history.`}
                />
              )}
            </section>
          </div>
        )}
      </main>

      {selectedEntry && (
        <ReportSlideOver
          company={selectedEntry.company}
          role={selectedEntry.role}
          scoreEntry={selectedEntry}
          onSwitchEntity={(targetCompany, targetRole) => {
            const match = [...scoreHistory]
              .filter(r => r.company === targetCompany && r.role === targetRole)
              .sort((a, b) => b.date.localeCompare(a.date))[0]
            if (match) setSelectedEntry(match)
          }}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  )
}

// ─── Loading skeleton ──────────────────────────────────────────────────────────

// Mirrors the layout of StatStrip + Applications + history table so the UI
// doesn't collapse to a spinner dot while data loads.
function LoadingSkeleton() {
  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8" aria-busy="true" aria-label="Loading company data">
      {/* Stat strip placeholder */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border-default bg-bg-elevated px-4 py-3 space-y-2"
          >
            <div className="shimmer h-2.5 rounded w-16" />
            <div className="shimmer h-5 rounded w-10" />
          </div>
        ))}
      </div>

      {/* History table placeholder */}
      <div className="space-y-2">
        <div className="shimmer h-4 rounded w-40" />
        <div className="border border-border-default rounded-md overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border-default last:border-b-0">
              <div className="shimmer h-3 rounded flex-1" />
              <div className="shimmer h-3 rounded w-10" />
              <div className="shimmer h-3 rounded w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Stat strip ───────────────────────────────────────────────────────────────

function StatStrip({ stats, appCount }: { stats: CompanyStats; appCount: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <StatTile
        label="Best score"
        value={stats.bestScore > 0 ? stats.bestScore.toFixed(1) : '—'}
        color={stats.bestScore > 0 ? scoreColor(stats.bestScore) : undefined}
      />
      <StatTile
        label="Average"
        value={stats.avgScore > 0 ? stats.avgScore.toFixed(1) : '—'}
        color={stats.avgScore > 0 ? scoreColor(stats.avgScore) : undefined}
      />
      <StatTile
        label="Top tier"
        value={stats.bestTier ?? '—'}
        color={stats.bestTier ? tierHex(stats.bestTier) : undefined}
      />
      <StatTile
        label={stats.cities.length === 1 ? 'City' : 'Cities'}
        value={stats.cities.length > 0 ? String(stats.cities.length) : '—'}
        hint={stats.cities.join(' · ') || undefined}
      />
      <StatTile label="Applications" value={String(appCount)} />
    </div>
  )
}

function StatTile({
  label, value, color, hint,
}: {
  label: string
  value: string
  color?: string
  hint?: string
}) {
  return (
    <div
      className="rounded-lg border border-border-default bg-bg-elevated px-4 py-3"
      title={hint}
      aria-label={hint ? `${label}: ${value} (${hint})` : `${label}: ${value}`}
    >
      <div className="text-micro text-text-4 uppercase">{label}</div>
      <div
        className={cn('mt-1.5 text-page font-mono tabular-nums leading-none', !color && 'text-text-1')}
        style={color ? { color } : undefined}
        aria-hidden
      >
        {value}
      </div>
    </div>
  )
}

// ─── Score trajectory ─────────────────────────────────────────────────────────

// Direction → icon + the same galaxy-token color the verdict text uses.
// improving → success green, declining → danger red, steady → text-3 slate.
const TRAJECTORY_META: Record<
  ScoreTrajectory['direction'],
  { Icon: typeof TrendingUp; color: string; tone: string }
> = {
  improving: { Icon: TrendingUp,   color: '#007D1E', tone: 'text-success' },
  declining: { Icon: TrendingDown, color: '#C80A28', tone: 'text-danger' },
  steady:    { Icon: Minus,        color: '#5D6C7B', tone: 'text-text-3' },
  flat:      { Icon: Minus,        color: '#5D6C7B', tone: 'text-text-3' },
}

function TrajectoryCard({ trajectory }: { trajectory: ScoreTrajectory }) {
  const { direction, delta, latestScore, points } = trajectory
  const meta = TRAJECTORY_META[direction]
  const W = 260
  const H = 56
  const path = sparklinePath(points, W, H, 4)
  const deltaSign = delta > 0 ? '+' : ''
  const lineColor = scoreColor(latestScore)

  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated p-4 flex flex-col">
      <div className="flex items-center justify-between">
        <h3 className="text-micro text-text-4 uppercase">Score trajectory</h3>
        <span
          className={cn('inline-flex items-center gap-1 text-label font-medium', meta.tone)}
          aria-label={`${trajectoryLabel(direction)}${delta !== 0 ? `, ${deltaSign}${delta.toFixed(1)} since first evaluation` : ''}`}
        >
          <meta.Icon size={14} aria-hidden />
          {trajectoryLabel(direction)}
        </span>
      </div>

      <div className="mt-3 flex items-end gap-3">
        <div
          className="text-page font-mono tabular-nums leading-none"
          style={{ color: lineColor }}
          aria-hidden
        >
          {latestScore.toFixed(1)}
        </div>
        {delta !== 0 && (
          <div className="text-label font-mono tabular-nums text-text-4 pb-0.5" aria-hidden>
            {deltaSign}{delta.toFixed(1)} vs first
          </div>
        )}
      </div>

      {/* Sparkline — score over evaluations, oldest→newest, left→right. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 w-full h-14"
        role="img"
        aria-label={`Score over ${points.length} evaluations, from ${points[0].score.toFixed(1)} to ${latestScore.toFixed(1)}`}
        preserveAspectRatio="none"
      >
        <polyline
          points={path}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => {
          const [cx, cy] = path.split(' ')[i].split(',').map(Number)
          const isLast = i === points.length - 1
          return (
            <circle
              key={`${p.date}-${i}`}
              cx={cx}
              cy={cy}
              r={isLast ? 2.6 : 1.6}
              fill={isLast ? lineColor : '#fff'}
              stroke={lineColor}
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>

      <div className="mt-1.5 flex items-center justify-between text-micro text-text-4 font-mono tabular-nums">
        <span>{points[0].date}</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </div>
  )
}

// ─── Engagement timeline ──────────────────────────────────────────────────────

function TimelineCard({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="rounded-lg border border-border-default bg-bg-elevated p-4">
      <h3 className="text-micro text-text-4 uppercase mb-3">Engagement timeline</h3>
      <ol className="relative" role="list">
        {events.map((ev, i) => (
          <TimelineRow key={`${ev.date}-${ev.kind}-${ev.role}-${i}`} ev={ev} last={i === events.length - 1} />
        ))}
      </ol>
    </div>
  )
}

function TimelineRow({ ev, last }: { ev: TimelineEvent; last: boolean }) {
  const isApp = ev.kind === 'application'
  const Icon = isApp ? Send : FileText
  const label = isApp
    ? (ev.status ?? 'Application')
    : 'Evaluated'

  return (
    <li className="relative flex gap-3 pb-3 last:pb-0" role="listitem">
      {/* Connector rail + node */}
      <div className="relative flex flex-col items-center">
        <span
          className={cn(
            'flex items-center justify-center w-6 h-6 rounded-full border shrink-0',
            isApp
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-border-strong bg-bg-base text-text-3',
          )}
          aria-hidden
        >
          <Icon size={12} />
        </span>
        {!last && <span className="w-px flex-1 bg-border-default mt-1" aria-hidden />}
      </div>

      <div className="min-w-0 flex-1 -mt-0.5">
        <div className="flex items-baseline gap-2">
          <span className="text-body text-text-1 truncate">{ev.role || '—'}</span>
          {ev.score != null && (
            <span
              className="text-label font-mono tabular-nums shrink-0"
              style={{ color: scoreColor(ev.score) }}
            >
              {ev.score.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-label text-text-4">
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-px rounded-pill text-[11px] font-medium',
              isApp ? STATUS_COLORS[ev.status ?? 'Applied'] : 'text-text-3 bg-bg-panel',
            )}
          >
            {label}
          </span>
          <span className="font-mono tabular-nums">{ev.date}</span>
        </div>
      </div>
    </li>
  )
}

// ─── Applications ─────────────────────────────────────────────────────────────

function ApplicationsSection({ apps }: { apps: ApplicationEntry[] }) {
  return (
    <section aria-labelledby="applications-heading">
      <h2 id="applications-heading" className="text-section text-text-1 font-medium mb-3">
        Applications
      </h2>
      <div
        className="rounded-md border border-border-default divide-y divide-border-default overflow-hidden bg-bg-chrome"
        role="list"
        aria-label={`${apps.length} application${apps.length !== 1 ? 's' : ''}`}
      >
        {apps.map(a => (
          <div
            key={`${a.num}-${a.role}`}
            className="flex items-center gap-3 px-4 py-2.5"
            role="listitem"
          >
            <span className="flex-1 min-w-0 text-body text-text-1 truncate">{a.role}</span>
            {a.score && a.score !== '—' && (
              <span className="text-label font-mono text-text-3 tabular-nums shrink-0">{a.score}</span>
            )}
            <span className="text-label font-mono text-text-4 tabular-nums shrink-0">{a.date}</span>
            <StatusBadge status={a.status} />
          </div>
        ))}
      </div>
    </section>
  )
}

function StatusBadge({ status }: { status: AppStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-pill border border-border-default bg-bg-elevated text-[11px] font-medium shrink-0',
        STATUS_COLORS[status],
      )}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  )
}
