'use client'

import { useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { canonicalizeArchetype } from '@/lib/archetype'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import type { ScoreEntry } from '@/types'

const DIM_COLORS = [
  '#7C5CFF', '#C99518', '#A0612C', '#6B7280',
  '#2ABBA7', '#F3425F', '#54C7EC', '#A121CE',
]

type DimKey = 'avg_overall' | 'avg_current_fit' | 'avg_aspirational_fit' | 'avg_skills_match' | 'avg_brand_value' | 'avg_growth' | 'avg_wlb'

const DIMENSIONS: Array<{ key: DimKey; label: string; field: keyof ScoreEntry }> = [
  { key: 'avg_overall',          label: 'Overall',          field: 'overall' },
  { key: 'avg_current_fit',      label: 'Current Fit',      field: 'current_fit' },
  { key: 'avg_aspirational_fit', label: 'Aspirational Fit', field: 'aspirational_fit' },
  { key: 'avg_skills_match',     label: 'Skills Match',     field: 'skills_match' },
  { key: 'avg_brand_value',      label: 'Brand Value',      field: 'brand_value' },
  { key: 'avg_growth',           label: 'Growth',           field: 'growth_mobility' },
  { key: 'avg_wlb',              label: 'Work-Life',        field: 'work_life_balance' },
]

type TimeRange = 'all' | '1y' | '6m' | '1m'

const TIME_RANGE_DAYS: Record<TimeRange, number | null> = {
  all: null, '1y': 365, '6m': 182, '1m': 30,
}

const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time', '1y': '1y', '6m': '6mo', '1m': '1mo',
}

export function TrendsView() {
  const { loaded, scoreHistory } = useDataStore()
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['avg_overall', 'avg_current_fit', 'avg_aspirational_fit']))
  const [timeRange, setTimeRange] = useState<TimeRange>('all')

  // Filter once by time range; everything else (chart, top-X panels, stats)
  // derives from this. Computing client-side from scoreHistory (already in
  // the data store) instead of an IPC trends() call eliminates the empty-
  // chart flash that fired on every Scan→Trends tab switch.
  const filtered = useMemo(() => {
    const days = TIME_RANGE_DAYS[timeRange]
    if (days == null) return scoreHistory
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffIso = cutoff.toISOString().slice(0, 10)
    return scoreHistory.filter(s => (s.date ?? '') >= cutoffIso)
  }, [scoreHistory, timeRange])

  const byDate         = useMemo(() => buildByDate(filtered),                                      [filtered])
  const topCompanies   = useMemo(() => buildTopBy(filtered, e => e.company, 6),                    [filtered])
  const topLocations   = useMemo(() => buildTopBy(filtered, e => e.location, 6),                   [filtered])
  const topArchetypes  = useMemo(() => buildTopBy(filtered, e => canonicalizeArchetype(e.archetype), 6), [filtered])

  const stats = useMemo(() => {
    if (filtered.length === 0) return null
    return {
      total:      filtered.length,
      avgOverall: avg(filtered, 'overall').toFixed(2),
      avgCF:      avg(filtered, 'current_fit').toFixed(2),
      avgAF:      avg(filtered, 'aspirational_fit').toFixed(2),
    }
  }, [filtered])

  const toggleDim = (key: DimKey) => {
    setActiveDims(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) } else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Trends</h1>
        {stats && (
          <span className="text-label text-text-4 font-mono">{stats.total} evaluations</span>
        )}
        <div className="flex-1" />
        <div className="titlebar-no-drag flex rounded-md overflow-hidden border border-border-default">
          {(['all', '1y', '6m', '1m'] as const).map(r => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={cn(
                'px-2.5 py-1 text-label transition-colors',
                timeRange === r ? 'bg-accent/20 text-accent-text' : 'text-text-4 hover:text-text-2',
              )}
            >
              {TIME_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {stats && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total evaluated',      value: stats.total },
              { label: 'Avg overall',          value: stats.avgOverall },
              { label: 'Avg current fit',      value: stats.avgCF },
              { label: 'Avg aspirational fit', value: stats.avgAF },
            ].map(({ label, value }) => (
              <div key={label} className="bg-bg-panel border border-border-default rounded-lg p-3">
                <div className="text-micro text-text-4 uppercase mb-1">{label}</div>
                <div className="text-section font-mono text-text-1 font-medium">{value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {DIMENSIONS.map(({ key, label }, i) => (
            <button
              key={key}
              onClick={() => toggleDim(key)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-label border transition-colors',
                activeDims.has(key)
                  ? 'border-transparent text-white'
                  : 'border-border-default text-text-4 hover:text-text-2',
              )}
              style={activeDims.has(key) ? {
                backgroundColor: DIM_COLORS[i % DIM_COLORS.length] + '33',
                borderColor: DIM_COLORS[i % DIM_COLORS.length] + '80',
                color: DIM_COLORS[i % DIM_COLORS.length],
              } : {}}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: activeDims.has(key) ? DIM_COLORS[i % DIM_COLORS.length] : '#CED0D4' }}
              />
              {label}
            </button>
          ))}
        </div>

        {!loaded ? (
          <div className="h-64 shimmer rounded-lg" />
        ) : byDate.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-label text-text-4">
            No data to display.
          </div>
        ) : (
          <div className="galaxy-bg border border-border-default rounded-lg p-4" style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={byDate} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#DEE3E9" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#5D6C7B', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#DEE3E9' }}
                />
                <YAxis
                  domain={[0, 10]}
                  tick={{ fill: '#5D6C7B', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <Tooltip
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #DEE3E9', borderRadius: 12, fontSize: 12, boxShadow: '0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)' }}
                  labelStyle={{ color: '#1C2B33', fontWeight: 600 }}
                  itemStyle={{ color: '#5D6C7B' }}
                />
                {DIMENSIONS.map(({ key }, i) =>
                  activeDims.has(key) ? (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={DIM_COLORS[i % DIM_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ) : null
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Top-X panels: separate rhythms for archetype (horizontal bars,
            structural shape) vs companies/locations (logo + count, more
            scannable). Time-series chart and these panels share the same
            time range so the cross-section reads cleanly. */}
        {loaded && filtered.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <TopCompaniesCard items={topCompanies} />
            <TopLocationsCard items={topLocations} />
            <TopArchetypesCard items={topArchetypes} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Aggregations ────────────────────────────────────────────────────────────

interface DateBucket {
  label: string; count: number
  avg_overall: number; avg_current_fit: number; avg_aspirational_fit: number
  avg_skills_match: number; avg_brand_value: number
  avg_growth: number; avg_wlb: number
}

function buildByDate(rows: ScoreEntry[]): DateBucket[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const s of rows) {
    if (!s.date) continue
    const date = s.date.slice(0, 10)
    const list = map.get(date)
    if (list) list.push(s)
    else map.set(date, [s])
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({
      label: date,
      count: entries.length,
      avg_overall:          avg(entries, 'overall'),
      avg_current_fit:      avg(entries, 'current_fit'),
      avg_aspirational_fit: avg(entries, 'aspirational_fit'),
      avg_skills_match:     avg(entries, 'skills_match'),
      avg_brand_value:      avg(entries, 'brand_value'),
      avg_growth:           avg(entries, 'growth_mobility'),
      avg_wlb:              avg(entries, 'work_life_balance'),
    }))
}

interface TopRow { label: string; count: number; avgScore: number }

function buildTopBy(rows: ScoreEntry[], key: (e: ScoreEntry) => string, limit: number): TopRow[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const e of rows) {
    const k = (key(e) ?? '').trim()
    if (!k) continue
    const list = map.get(k)
    if (list) list.push(e)
    else map.set(k, [e])
  }
  return [...map.entries()]
    .map(([label, entries]) => ({ label, count: entries.length, avgScore: avg(entries, 'overall') }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore)
    .slice(0, limit)
}

function avg(rows: ScoreEntry[], field: keyof ScoreEntry): number {
  let sum = 0, n = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number') { sum += v; n++ }
  }
  return n === 0 ? 0 : sum / n
}

// ─── Top-X panels ────────────────────────────────────────────────────────────

function TopCompaniesCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Companies">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="space-y-1.5">
          {items.map(({ label, count, avgScore }) => (
            <li key={label} className="flex items-center gap-2.5">
              <CompanyLogo company={label} size={20} className="shrink-0" />
              <span className="flex-1 min-w-0 text-[12px] text-text-1 font-medium truncate">{label}</span>
              <span className="text-[10px] font-mono tabular-nums text-text-3 shrink-0">{avgScore.toFixed(1)}</span>
              <span className="text-[10.5px] font-mono tabular-nums text-text-1 shrink-0 w-6 text-right">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function TopLocationsCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Locations">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="space-y-1.5">
          {items.map(({ label, count, avgScore }) => (
            <li key={label} className="flex items-center gap-2.5">
              <span className="flex-1 min-w-0 text-[12px] text-text-2 truncate">{label}</span>
              <span className="text-[10px] font-mono tabular-nums text-text-3 shrink-0">{avgScore.toFixed(1)}</span>
              <span className="text-[10.5px] font-mono tabular-nums text-text-1 shrink-0 w-6 text-right">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

function TopArchetypesCard({ items }: { items: TopRow[] }) {
  const max = items.length ? Math.max(...items.map(i => i.count)) : 0
  return (
    <PanelCard title="Top Archetypes">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="space-y-2">
          {items.map(({ label, count, avgScore }) => {
            const pct = max ? (count / max) * 100 : 0
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[11.5px] text-text-2 truncate">{label}</span>
                  <span className="text-[10px] font-mono tabular-nums text-text-3 shrink-0">
                    {avgScore.toFixed(1)} · {count}
                  </span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                  <div
                    className="h-full rounded-pill bg-accent"
                    style={{ width: `${pct}%`, transition: 'width 320ms ease' }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-3">
      <div className="text-micro text-text-4 uppercase tracking-wider mb-2 px-1">{title}</div>
      {children}
    </div>
  )
}

function EmptyHint() {
  return <p className="text-[11px] text-text-4 py-3 text-center">No data</p>
}
