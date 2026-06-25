'use client'

import { useState, useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore, VIEW_LABELS } from '@/store/nav'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { EmptyState } from '@/components/shared/EmptyState'
import { OffersTable } from '@/components/database/OffersTable'
import { ReportSlideOver } from '@/components/reports/ReportSlideOver'
import { computeCompanyStats, type CompanyStats } from '@/lib/companyStats'
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
