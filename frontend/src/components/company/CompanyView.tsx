'use client'

import { useState, useMemo } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useDataStore } from '@/store/data'
import { useNavStore, VIEW_LABELS } from '@/store/nav'
import { toCompanySlug } from '@/components/shared/CompanyLink'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome flex items-center">
        <button
          type="button"
          onClick={() => navigate(returnView)}
          className="flex items-center gap-1.5 py-1 pl-1.5 pr-2.5 hover:bg-bg-elevated rounded-md text-text-3 hover:text-text-1 transition-colors"
          title={`Back to ${VIEW_LABELS[returnView]}`}
        >
          <ArrowLeft size={16} />
          <span className="text-label">{VIEW_LABELS[returnView]}</span>
        </button>
        <CompanyLogo company={companyName} size={24} />
        <h1 className="text-body text-text-1 font-medium">{companyName}</h1>
        {loaded && stats.evalCount > 0 && (
          <span className="text-label text-text-4 font-mono tabular-nums">
            {stats.roleCount} role{stats.roleCount !== 1 && 's'} · {stats.evalCount} eval{stats.evalCount !== 1 && 's'}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-bg-base">
        <div className="max-w-6xl mx-auto p-6 space-y-8">
          {loaded && stats.evalCount > 0 && (
            <StatStrip stats={stats} appCount={apps.length} />
          )}

          {apps.length > 0 && <ApplicationsSection apps={apps} />}

          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-section text-text-1 font-medium">Score history &amp; roles</h2>
              <div className="text-label text-text-4">
                {history.length} evaluation{history.length !== 1 && 's'}
              </div>
            </div>
            {loaded ? (
              history.length > 0 ? (
                <div className="border border-border-default rounded-md overflow-hidden bg-bg-chrome">
                  <OffersTable
                    rows={history}
                    onOpenReport={setSelectedEntry}
                    onRowClick={(entry) => setSelectedEntry(entry)}
                    selectedId={selectedId}
                  />
                </div>
              ) : (
                <div className="py-12 text-center text-label text-text-4">
                  No evaluations on record for {companyName} yet.
                </div>
              )
            ) : (
              <div className="py-12 flex items-center justify-center">
                <div className="text-label text-text-4">Loading…</div>
              </div>
            )}
          </section>
        </div>
      </div>

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
    <div className="rounded-lg border border-border-default bg-bg-elevated px-4 py-3" title={hint}>
      <div className="text-micro text-text-4 uppercase">{label}</div>
      <div
        className={cn('mt-1.5 text-page font-mono tabular-nums leading-none', !color && 'text-text-1')}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  )
}

// ─── Applications ─────────────────────────────────────────────────────────────

function ApplicationsSection({ apps }: { apps: ApplicationEntry[] }) {
  return (
    <section>
      <h2 className="text-section text-text-1 font-medium mb-3">Applications</h2>
      <div className="rounded-md border border-border-default divide-y divide-border-default overflow-hidden bg-bg-chrome">
        {apps.map(a => (
          <div key={`${a.num}-${a.role}`} className="flex items-center gap-3 px-4 py-2.5">
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
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-pill border border-border-default bg-bg-elevated text-[11px] font-medium shrink-0',
      STATUS_COLORS[status],
    )}>
      {status}
    </span>
  )
}
