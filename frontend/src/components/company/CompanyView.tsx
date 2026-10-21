'use client'

import { useState, useMemo } from 'react'
import { ArrowLeft, TrendingUp, TrendingDown, Minus, FileText, Send } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore, VIEW_LABELS } from '@/store/nav'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  Button, Chip, PageHeader, ScoreNumber, SectionHeading, Stat, StatStrip as StatRow, StatusChip, TierChip,
} from '@/components/ui'
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
import { scoreColor } from '@/lib/tier'
import { MatchEase } from '@/components/shared/MatchEase'
import { parseScoreCell } from '@/lib/scoreBands'
import { cn } from '@/lib/utils'
import type { ScoreEntry, ApplicationEntry } from '@/types'
import { themeColor } from '@/lib/themes'

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
      {/* Title bar — the whole bar is a macOS drag region; PageHeader opts
          its actions slot out via titlebar-no-drag. */}
      <PageHeader
        title={companyName}
        meta={loaded && stats.evalCount > 0 ? (
          <span
            aria-label={`${stats.roleCount} role${stats.roleCount !== 1 ? 's' : ''}, ${stats.evalCount} evaluation${stats.evalCount !== 1 ? 's' : ''}`}
          >
            {stats.roleCount} role{stats.roleCount !== 1 && 's'} · {stats.evalCount} eval{stats.evalCount !== 1 && 's'}
          </span>
        ) : undefined}
        actions={
          <Button
            tone="ghost"
            size="sm"
            icon={<ArrowLeft size={13} aria-hidden />}
            onClick={() => navigate(returnView)}
            aria-label={`Back to ${backLabel}`}
            title={`Back to ${backLabel}`}
          >
            Back
          </Button>
        }
      />

      <main className="flex-1 overflow-auto">
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
          <div className="max-w-6xl mx-auto p-5 space-y-5">
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
              <section aria-labelledby="trajectory-heading" className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
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

            <section aria-labelledby="history-heading" className="card overflow-hidden">
              <SectionHeading
                className="px-4 pt-3 mb-0"
                title={<span id="history-heading">Score history and roles</span>}
                meta={
                  <span aria-live="polite">
                    {history.length} evaluation{history.length !== 1 && 's'}
                  </span>
                }
              />

              {history.length > 0 ? (
                <OffersTable
                  rows={history}
                  onOpenReport={setSelectedEntry}
                  onRowClick={(entry) => setSelectedEntry(entry)}
                  selectedId={selectedId}
                />
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
    <div className="max-w-6xl mx-auto p-5 space-y-5" aria-busy="true" aria-label="Loading company data">
      {/* Stat strip placeholder */}
      <div className="flex gap-10">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="shimmer h-5 rounded w-10" />
            <div className="shimmer h-3 rounded w-16" />
          </div>
        ))}
      </div>

      {/* History table placeholder */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-border-default">
          <div className="shimmer h-4 rounded w-40" />
        </div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 h-10 border-b border-border-default last:border-b-0">
            <div className="shimmer h-3 rounded flex-1" />
            <div className="shimmer h-3 rounded w-10" />
            <div className="shimmer h-3 rounded w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Stat strip ───────────────────────────────────────────────────────────────

function StatStrip({ stats, appCount }: { stats: CompanyStats; appCount: number }) {
  const cityLabel = stats.cities.length === 1 ? 'City' : 'Cities'
  const cityHint = stats.cities.join(' · ') || undefined
  return (
    <StatRow>
      {/* Scoring v2: Match · Ease pairs, never one combined number. "Best"
          is the highest-Priority listing; Average is over scored rows. */}
      <Stat
        label="Best listing"
        value={stats.best ? <MatchEase match={stats.best.match} ease={stats.best.ease} /> : '—'}
      />
      <Stat
        label="Average"
        value={stats.avgMatch != null || stats.avgEase != null ? <MatchEase match={stats.avgMatch} ease={stats.avgEase} /> : '—'}
      />
      <Stat
        label="Top tier"
        value={stats.bestTier ? <TierChip tier={stats.bestTier} size="md" /> : '—'}
      />
      <Stat
        label={cityLabel}
        value={stats.cities.length > 0 ? String(stats.cities.length) : '—'}
        hint={cityHint ? <span title={cityHint}>{cityHint}</span> : undefined}
      />
      <Stat label="Applications" value={String(appCount)} />
    </StatRow>
  )
}

// ─── Score trajectory ─────────────────────────────────────────────────────────

// Direction → icon + the same galaxy-token color the verdict text uses.
// improving → success green, declining → danger red, steady → text-3 slate.
const TRAJECTORY_META: Record<
  ScoreTrajectory['direction'],
  { Icon: typeof TrendingUp; color: string; tone: string }
> = {
  improving: { Icon: TrendingUp,   color: themeColor('success'), tone: 'text-success' },
  declining: { Icon: TrendingDown, color: themeColor('danger'), tone: 'text-danger' },
  steady:    { Icon: Minus,        color: themeColor('text-3'), tone: 'text-text-3' },
  flat:      { Icon: Minus,        color: themeColor('text-3'), tone: 'text-text-3' },
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
    <div className="card p-4 flex flex-col h-full">
      <SectionHeading
        title="Match trajectory"
        action={
          <span
            className={`inline-flex items-center gap-1 text-label font-medium ${meta.tone}`}
            aria-label={`${trajectoryLabel(direction)}${delta !== 0 ? `, ${deltaSign}${delta.toFixed(1)} since first evaluation` : ''}`}
          >
            <meta.Icon size={14} aria-hidden />
            {trajectoryLabel(direction)}
          </span>
        }
      />

      <div className="flex items-baseline gap-3">
        <span aria-hidden>
          <ScoreNumber value={latestScore} size="lg" />
        </span>
        {delta !== 0 && (
          <div className="text-label text-text-4" aria-hidden>
            {deltaSign}{delta.toFixed(1)} vs first
          </div>
        )}
      </div>

      {/* Sparkline — Match over evaluations, oldest→newest, left→right. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 w-full h-14"
        role="img"
        aria-label={`Match over ${points.length} evaluations, from ${points[0].score.toFixed(1)} to ${latestScore.toFixed(1)}`}
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
              fill={isLast ? lineColor : themeColor('bg-base')}
              stroke={lineColor}
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>

      <div className="mt-1.5 flex items-center justify-between text-label text-text-4">
        <span>{points[0].date}</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </div>
  )
}

// ─── Engagement timeline ──────────────────────────────────────────────────────

function TimelineCard({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="card p-4 h-full">
      <SectionHeading title="Engagement timeline" />
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
              ? 'border-accent/25 bg-accent-soft text-accent-text'
              : 'border-border-default bg-bg-elevated text-text-3',
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
          {(ev.match != null || ev.blocked) && (
            <MatchEase match={ev.match} ease={ev.ease} size="sm" blockedReason={ev.blocked ? 'Blocked' : null} className="shrink-0" />
          )}
          {ev.legacyScore != null && (
            <span className="text-label text-text-3 shrink-0" title="Legacy v1 score">{ev.legacyScore.toFixed(1)}/10</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-label text-text-4">
          {isApp
            ? <StatusChip status={ev.status ?? 'Applied'} />
            : <Chip size="sm">{label}</Chip>}
          <span>{ev.date}</span>
        </div>
      </div>
    </li>
  )
}

// ─── Applications ─────────────────────────────────────────────────────────────

// Application `score` cell: `M8.3 E5.6` (scoring v2) or a legacy `8.4/10`,
// shown as-is (docs/scoring-v2.md §8.3).
function AppScoreCell({ raw }: { raw: string }) {
  const cell = parseScoreCell(raw)
  if (!cell) return <span className="text-text-4">—</span>
  if ('legacy' in cell) return <span className="text-label text-text-3" title="Legacy v1 score">{cell.legacy.toFixed(1)}/10</span>
  return <MatchEase match={cell.match} ease={cell.ease} size="sm" bare />
}

function ApplicationsSection({ apps }: { apps: ApplicationEntry[] }) {
  return (
    <section aria-labelledby="applications-heading" className="card overflow-hidden">
      <SectionHeading
        className="px-4 pt-3 mb-0"
        title={<span id="applications-heading">Applications</span>}
        meta={apps.length}
      />
      <table className="w-full text-body border-collapse" aria-label={`${apps.length} application${apps.length !== 1 ? 's' : ''}`}>
        <thead>
          <tr className="bg-bg-elevated/60 border-b border-border-default">
            <th className="th text-left px-4 h-8">Role</th>
            <th className="th text-right px-3 h-8 w-28">Match · Ease</th>
            <th className="th text-left px-3 h-8 w-28">Date</th>
            <th className="th text-left px-4 h-8 w-32">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {apps.map(a => {
            return (
              <tr key={`${a.num}-${a.role}`} className="h-10 hover:bg-bg-elevated transition-colors duration-150">
                <td className="px-4 text-text-1 truncate max-w-0 w-full">{a.role}</td>
                <td className="px-3 text-right">
                  <AppScoreCell raw={a.score} />
                </td>
                <td className="px-3 text-label text-text-3 whitespace-nowrap">{a.date}</td>
                <td className="px-4">
                  <span aria-label={`Status: ${a.status}`}>
                    <StatusChip status={a.status} />
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
