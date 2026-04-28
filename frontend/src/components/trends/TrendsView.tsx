'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { ipc, type DbTrends, type DbTrendBucket } from '@/lib/ipc'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'

const DIM_COLORS = [
  '#7C5CFF', '#C99518', '#A0612C', '#6B7280',
  '#2ABBA7', '#F3425F', '#54C7EC', '#A121CE',
]

type DimKey = 'avg_overall' | 'avg_current_fit' | 'avg_aspirational_fit' | 'avg_skills_match' | 'avg_brand_value' | 'avg_growth' | 'avg_wlb'

const DIMENSIONS: Array<{ key: DimKey; label: string }> = [
  { key: 'avg_overall',          label: 'Overall' },
  { key: 'avg_current_fit',      label: 'Current Fit' },
  { key: 'avg_aspirational_fit', label: 'Aspirational Fit' },
  { key: 'avg_skills_match',     label: 'Skills Match' },
  { key: 'avg_brand_value',      label: 'Brand Value' },
  { key: 'avg_growth',           label: 'Growth' },
  { key: 'avg_wlb',              label: 'Work-Life' },
]

type TimeRange = 'all' | '1y' | '6m' | '1m'

const TIME_RANGE_DAYS: Record<TimeRange, number | null> = {
  all: null,
  '1y': 365,
  '6m': 182,
  '1m': 30,
}

const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time',
  '1y': '1y',
  '6m': '6mo',
  '1m': '1mo',
}

export function TrendsView() {
  const { loaded, scoreHistory } = useDataStore()
  const [trends, setTrends] = useState<DbTrends | null>(null)
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['avg_overall', 'avg_current_fit', 'avg_aspirational_fit']))
  const [groupBy, setGroupBy] = useState<'date' | 'archetype'>('date')
  const [timeRange, setTimeRange] = useState<TimeRange>('all')

  // Pull pre-aggregated buckets from SQL. Live-reload on db:changed handled
  // by the store; we re-fetch trends whenever scoreHistory updates.
  useEffect(() => {
    let cancelled = false
    ipc.db.trends().then(t => { if (!cancelled) setTrends(t) }).catch(() => {})
    return () => { cancelled = true }
  }, [scoreHistory.length])

  const toggleDim = (key: DimKey) => {
    const next = new Set(activeDims)
    if (next.has(key)) { if (next.size > 1) next.delete(key) } else next.add(key)
    setActiveDims(next)
  }

  const buckets: DbTrendBucket[] = useMemo(() => {
    if (!trends) return []
    if (groupBy === 'archetype') return trends.byArchetype
    // Date buckets: filter by label (YYYY-MM-DD) against the time range cutoff.
    // For 'all', no filtering. For '1m' / '6m' / '1y', drop buckets older
    // than today − N days. Keeps the right edge of the chart anchored to
    // today regardless of how far back the data goes.
    const days = TIME_RANGE_DAYS[timeRange]
    if (days == null) return trends.byDate
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffIso = cutoff.toISOString().slice(0, 10)
    return trends.byDate.filter(b => b.label >= cutoffIso)
  }, [trends, groupBy, timeRange])

  const stats = useMemo(() => {
    if (!trends) return null
    const total = trends.byDate.reduce((s, b) => s + b.count, 0)
    if (total === 0) return null
    const weighted = (k: keyof DbTrendBucket) => {
      let sum = 0
      for (const b of trends.byDate) sum += (b[k] as number) * b.count
      return (sum / total).toFixed(2)
    }
    return {
      total,
      avgOverall: weighted('avg_overall'),
      avgCF:      weighted('avg_current_fit'),
      avgAF:      weighted('avg_aspirational_fit'),
    }
  }, [trends])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Trends</h1>
        {stats && (
          <span className="text-label text-text-4 font-mono">{stats.total} evaluations</span>
        )}
        <div className="flex-1" />
        {/* Time-range selector — only meaningful when grouping by date. The
            archetype view aggregates across all time anyway. */}
        {groupBy === 'date' && (
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
        )}
        <div className="titlebar-no-drag flex rounded-md overflow-hidden border border-border-default">
          {(['date', 'archetype'] as const).map(g => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={cn(
                'px-3 py-1 text-label transition-colors',
                groupBy === g ? 'bg-accent/20 text-accent-text' : 'text-text-4 hover:text-text-2',
              )}
            >
              {g === 'date' ? 'Over time' : 'By archetype'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {stats && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total evaluated', value: stats.total },
              { label: 'Avg overall', value: stats.avgOverall },
              { label: 'Avg current fit', value: stats.avgCF },
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
              style={activeDims.has(key) ? { backgroundColor: DIM_COLORS[i % DIM_COLORS.length] + '33', borderColor: DIM_COLORS[i % DIM_COLORS.length] + '80', color: DIM_COLORS[i % DIM_COLORS.length] } : {}}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: activeDims.has(key) ? DIM_COLORS[i % DIM_COLORS.length] : '#CED0D4' }}
              />
              {label}
            </button>
          ))}
        </div>

        {!loaded || !trends ? (
          <div className="h-64 shimmer rounded-lg" />
        ) : buckets.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-label text-text-4">
            No data to display.
          </div>
        ) : (
          <div className="galaxy-bg border border-border-default rounded-lg p-4" style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={buckets} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
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
      </div>
    </div>
  )
}
