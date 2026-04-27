'use client'

import { useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'
import { cn } from '@/lib/utils'

const DIM_COLORS = [
  '#7C5CFF', '#E8B547', '#C8C5D6', '#C77B3B',
  '#5CFFB8', '#FF5CAA', '#5CB8FF', '#FFD05C',
]

type DimKey = 'current_fit' | 'aspirational_fit' | 'overall' | 'skills_match' | 'brand_value' | 'growth_mobility' | 'work_life_balance'
const DIMENSIONS: Array<{ key: DimKey; label: string }> = [
  { key: 'overall',          label: 'Overall' },
  { key: 'current_fit',      label: 'Current Fit' },
  { key: 'aspirational_fit', label: 'Aspirational Fit' },
  { key: 'skills_match',     label: 'Skills Match' },
  { key: 'brand_value',      label: 'Brand Value' },
  { key: 'growth_mobility',  label: 'Growth' },
  { key: 'work_life_balance',label: 'Work-Life' },
]

export function TrendsView() {
  const { scoreHistory, loaded } = useDataStore()
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['overall', 'current_fit', 'aspirational_fit']))
  const [groupBy, setGroupBy] = useState<'date' | 'archetype'>('date')

  const toggleDim = (key: DimKey) => {
    const next = new Set(activeDims)
    if (next.has(key)) { if (next.size > 1) next.delete(key) } else next.add(key)
    setActiveDims(next)
  }

  // Build chart data
  const chartData = useMemo(() => {
    if (groupBy === 'date') {
      // Group by date, average scores per day
      const byDate: Record<string, { sum: Record<string, number>; count: number }> = {}
      for (const s of scoreHistory) {
        const d = s.date?.slice(0, 10) ?? 'Unknown'
        if (!byDate[d]) byDate[d] = { sum: {}, count: 0 }
        byDate[d].count++
        for (const dim of DIMENSIONS) {
          byDate[d].sum[dim.key] = (byDate[d].sum[dim.key] ?? 0) + (s[dim.key] as number ?? 0)
        }
      }
      return Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { sum, count }]) => ({
          label: date,
          ...Object.fromEntries(DIMENSIONS.map(d => [d.key, +(sum[d.key] / count).toFixed(2)])),
        }))
    } else {
      // Group by archetype
      const byArch: Record<string, { sum: Record<string, number>; count: number }> = {}
      for (const s of scoreHistory) {
        const arch = s.archetype || 'Unknown'
        if (!byArch[arch]) byArch[arch] = { sum: {}, count: 0 }
        byArch[arch].count++
        for (const dim of DIMENSIONS) {
          byArch[arch].sum[dim.key] = (byArch[arch].sum[dim.key] ?? 0) + (s[dim.key] as number ?? 0)
        }
      }
      return Object.entries(byArch)
        .sort(([, a], [, b]) => b.count - a.count)
        .map(([arch, { sum, count }]) => ({
          label: arch,
          ...Object.fromEntries(DIMENSIONS.map(d => [d.key, +(sum[d.key] / count).toFixed(2)])),
        }))
    }
  }, [scoreHistory, groupBy])

  // Summary stats
  const stats = useMemo(() => {
    if (scoreHistory.length === 0) return null
    const avg = (key: DimKey) =>
      (scoreHistory.reduce((s, r) => s + (r[key] as number ?? 0), 0) / scoreHistory.length).toFixed(2)
    return {
      total: scoreHistory.length,
      avgOverall: avg('overall'),
      avgCF: avg('current_fit'),
      avgAF: avg('aspirational_fit'),
    }
  }, [scoreHistory])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Trends</h1>
        {stats && (
          <span className="text-label text-text-4 font-mono">{stats.total} evaluations</span>
        )}
        <div className="flex-1" />
        {/* Group toggle */}
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
        {/* Summary cards */}
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

        {/* Dimension toggles */}
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
                style={{ background: activeDims.has(key) ? DIM_COLORS[i % DIM_COLORS.length] : '#3D3458' }}
              />
              {label}
            </button>
          ))}
        </div>

        {/* Chart */}
        {!loaded ? (
          <div className="h-64 shimmer rounded-lg" />
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-64 text-label text-text-4">
            No data to display.
          </div>
        ) : (
          <div className="bg-bg-panel border border-border-default rounded-lg p-4" style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#2A2342" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#6B6582', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#2A2342' }}
                />
                <YAxis
                  domain={[0, 10]}
                  tick={{ fill: '#6B6582', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <Tooltip
                  contentStyle={{ background: '#15102B', border: '1px solid #2A2342', borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: '#C8C5D6' }}
                  itemStyle={{ color: '#A89FCC' }}
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
