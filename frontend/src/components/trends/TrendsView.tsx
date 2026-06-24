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
import { EmptyState } from '@/components/shared/EmptyState'
import { scoreColor as galaxyScoreColor } from '@/lib/tier'
import {
  type TimeRange, type DateBucket, type TopRow, type Distribution, type Funnel,
  TIME_RANGE_LABEL, filterByDateWindow,
  avg, buildByDate, buildTopBy, buildDistribution, buildFunnel, locationFlag,
} from '@/lib/trendsAnalytics'

// Multi-series chart palette — sourced from the documented categorical
// chart tokens (DESIGN-meta.md § Data Viz palette). Aurora-tuned cousins
// of galaxy violet so adjacent lines actually contrast instead of
// collapsing into one violet ladder.
//
// Series order maps to the DIMENSIONS array below: Overall (deep indigo)
// reads as the rolled-up "headline" number; Current Fit gets the brand
// galaxy violet because it's the day-to-day reachability driver of the
// rollup (CF×0.70 + AF×0.30) — the line the user watches most. The
// remaining slots fan out warm/cool/warm/cool so adjacent series
// contrast at first glance.
const DIM_COLORS = [
  '#3D2BB5',  // chart-2 — deep indigo, Overall (the rollup)
  '#7C5CFF',  // chart-1 — galaxy violet, Current Fit (brand anchor; primary driver)
  '#2EB8A8',  // chart-3 — aurora teal, Aspirational Fit
  '#E84F8E',  // chart-4 — nebula pink, Skills Match
  '#F2A837',  // chart-5 — cosmic amber, Brand Value
  '#4D8DFF',  // chart-6 — azure, Growth
  '#8595A4',  // chart-7 — slate, Work-Life (intentionally muted)
]

type DimKey = 'avg_overall' | 'avg_current_fit' | 'avg_aspirational_fit' | 'avg_skills_match' | 'avg_brand_value' | 'avg_growth' | 'avg_wlb'

const DIMENSIONS: Array<{ key: DimKey; label: string }> = [
  { key: 'avg_overall',          label: 'Overall'          },
  { key: 'avg_current_fit',      label: 'Current Fit'      },
  { key: 'avg_aspirational_fit', label: 'Aspirational Fit' },
  { key: 'avg_skills_match',     label: 'Skills Match'     },
  { key: 'avg_brand_value',      label: 'Brand Value'      },
  { key: 'avg_growth',           label: 'Growth'           },
  { key: 'avg_wlb',              label: 'Work-Life'        },
]

// dataKey → human label, used by the custom chart tooltip to name each
// active series (recharts only hands the tooltip the raw dataKey).
const DIM_LABEL_BY_KEY: Record<string, string> =
  Object.fromEntries(DIMENSIONS.map(d => [d.key, d.label]))

// Color (sourced from the line palette) keyed by dataKey, so the tooltip
// dots match the line colors regardless of which dims are toggled on.
const DIM_COLOR_BY_KEY: Record<string, string> =
  Object.fromEntries(DIMENSIONS.map((d, i) => [d.key, DIM_COLORS[i % DIM_COLORS.length]]))

export function TrendsView() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['avg_overall', 'avg_current_fit', 'avg_aspirational_fit']))
  const [timeRange, setTimeRange] = useState<TimeRange>('all')

  // Filter once by time range; everything else (chart, top-X panels, stats)
  // derives from this. Computing client-side from scoreHistory (already in
  // the data store) instead of an IPC trends() call eliminates the empty-
  // chart flash that fired on every Scan→Trends tab switch.
  const filtered = useMemo(() => filterByDateWindow(scoreHistory, timeRange), [scoreHistory, timeRange])

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

  const distribution = useMemo(() => buildDistribution(filtered), [filtered])

  // Applications rolled into a cumulative conversion funnel, filtered to the
  // same time window as the score-history views (by tracker-add date). Kept
  // separate from `filtered` since this reads applications.md, not
  // score-history — it answers "how is my pipeline converting", the
  // downstream counterpart to the upstream score analytics above.
  const filteredApps = useMemo(() => filterByDateWindow(applications, timeRange), [applications, timeRange])
  const funnel = useMemo(() => buildFunnel(filteredApps), [filteredApps])

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
                style={{ background: activeDims.has(key) ? DIM_COLORS[i % DIM_COLORS.length] : 'var(--divider-gray)' }}
              />
              {label}
            </button>
          ))}
        </div>

        {!loaded ? (
          <div className="h-64 shimmer rounded-lg" />
        ) : byDate.length === 0 ? (
          <div className="flex items-center justify-center h-64 rounded-lg border border-border-default bg-bg-panel/40">
            <EmptyState
              title="No score history yet"
              hint="Run a Filter to Database scan to populate the trend chart."
            />
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
                  content={<ChartTooltip />}
                  cursor={{ stroke: '#CED0D4', strokeDasharray: '3 3' }}
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

        {/* Score distribution — the *shape* of pipeline quality, which
            neither the time-series (averages) nor the top-X panels (best
            performers) reveal. Bands map 1:1 to the documented score-
            interpretation scale (`_shared.md` § Score interpretation), and
            an accent bracket marks the 7.0 apply threshold so the headline
            read is "what fraction of what I evaluate is worth applying to". */}
        {loaded && filtered.length > 0 && (
          <ScoreDistributionCard dist={distribution} />
        )}

        {/* Pipeline conversion — the downstream counterpart to the score
            analytics: of everything you actually applied to, how far did it
            get? Cumulative funnel (a status implies every earlier stage was
            reached), gated on having sent at least one application so it
            never shows an all-zero funnel. */}
        {loaded && funnel.sent > 0 && (
          <ConversionFunnelCard funnel={funnel} />
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

// ─── Score distribution card ─────────────────────────────────────────────────

function ScoreDistributionCard({ dist }: { dist: Distribution }) {
  const { bands, max, applyPct, total, median: med } = dist
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">Score Distribution</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          <span className="text-accent-text font-semibold">{applyPct}%</span>
          <span> clear the 7.0 bar</span>
          {total > 0 && <span> · median {med.toFixed(1)}</span>}
        </span>
      </div>

      {/* Bars track — fixed height; bar heights cap at 88% of the track so the
          count label sitting above the tallest bar never clips. */}
      <div className="flex items-end gap-2.5" style={{ height: 132 }}>
        {bands.map(b => {
          const h = (b.count / max) * 88
          return (
            <div key={b.key} className="flex-1 flex flex-col justify-end items-center h-full">
              <span
                className="text-[11px] font-mono tabular-nums font-semibold mb-1"
                style={{ color: b.count > 0 ? b.color : '#8595A4' }}
              >
                {b.count}
              </span>
              <div
                className="w-full rounded-t-[5px]"
                style={{
                  height: `${h}%`,
                  minHeight: b.count > 0 ? 3 : 0,
                  background: `linear-gradient(180deg, ${b.color} 0%, ${b.color}cc 100%)`,
                }}
              />
            </div>
          )
        })}
      </div>

      {/* Band labels under each column */}
      <div className="flex gap-2.5 mt-2">
        {bands.map(b => (
          <div key={b.key} className="flex-1 text-center">
            <div className="text-[11px] text-text-2 leading-tight">{b.label}</div>
            <div className="text-[10px] font-mono text-text-4">{b.range}</div>
          </div>
        ))}
      </div>

      {/* Apply-threshold bracket — spans the three apply-worthy bands (the last
          3 of 5 equal columns). The 2:3 flex split lines the accent rule up
          under the 7–8 / 8–9 / ≥9 columns. */}
      <div className="flex gap-2.5 mt-1.5">
        <div className="flex-[2]" aria-hidden />
        <div className="flex-[3] flex items-center gap-1.5">
          <span className="h-px flex-1 bg-accent/30" />
          <span className="text-[9px] uppercase tracking-[0.1em] text-accent/80 font-semibold whitespace-nowrap">apply-worthy</span>
          <span className="h-px flex-1 bg-accent/30" />
        </div>
      </div>
    </div>
  )
}

// ─── Chart tooltip ───────────────────────────────────────────────────────────

interface ChartTooltipProps {
  active?: boolean
  label?: string | number
  payload?: Array<{ dataKey?: string | number; value?: number | string; color?: string; payload?: DateBucket }>
}

// Custom tooltip for the dimensional time-series. The default recharts tooltip
// can't show n (evaluations behind each point), so a 9.5 from one lucky listing
// looked identical to a 9.5 averaged across twenty. Surfacing the count makes a
// spike honest: "n=1" reads as noise, "n=18" as signal.
function ChartTooltip({ active, label, payload }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const count = payload[0]?.payload?.count
  return (
    <div className="rounded-xl border border-border-default bg-white px-3 py-2 shadow-card min-w-[150px]">
      <div className="flex items-baseline justify-between gap-4 mb-1.5">
        <span className="text-[12px] font-semibold text-text-1">{label}</span>
        {typeof count === 'number' && (
          <span className="text-[10px] font-mono text-text-4 tabular-nums">n={count}</span>
        )}
      </div>
      <ul className="space-y-1">
        {payload.map(p => {
          const key = String(p.dataKey ?? '')
          return (
            <li key={key} className="flex items-center gap-2 text-[11.5px]">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color ?? DIM_COLOR_BY_KEY[key] }} />
              <span className="text-text-3 flex-1">{DIM_LABEL_BY_KEY[key] ?? key}</span>
              <span className="font-mono tabular-nums text-text-1 font-medium">
                {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ─── Conversion funnel card ──────────────────────────────────────────────────

// Stage colours track the kanban / STATUS_COLORS semantics: Applied + Responded
// in the violet family (deepening as you advance), Interview amber, Offer green.
function ConversionFunnelCard({ funnel }: { funnel: Funnel }) {
  const { sent, responded, interview, offer, rejected } = funnel
  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0)
  const stages: Array<{ label: string; count: number; color: string }> = [
    { label: 'Applied',   count: sent,      color: '#7C5CFF' },
    { label: 'Responded', count: responded, color: '#5B3FE8' },
    { label: 'Interview', count: interview, color: '#F7B928' },
    { label: 'Offer',     count: offer,     color: '#007D1E' },
  ]
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">Pipeline Conversion</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          <span className="text-accent-text font-semibold">{pct(responded)}%</span>
          <span> response rate · {sent} sent</span>
          {rejected > 0 && <span> · {rejected} rejected</span>}
        </span>
      </div>

      <div className="space-y-2">
        {stages.map(s => {
          const barPct = sent ? Math.max((s.count / sent) * 100, s.count > 0 ? 3 : 0) : 0
          return (
            <div key={s.label} className="flex items-center gap-3">
              <span className="w-[68px] shrink-0 text-[11px] text-text-2">{s.label}</span>
              <div className="flex-1 h-5 rounded-pill bg-bg-elevated overflow-hidden">
                <div
                  className="h-full rounded-pill"
                  style={{ width: `${barPct}%`, background: s.color, transition: 'width 320ms ease' }}
                />
              </div>
              <span className="w-6 text-right text-[11px] font-mono tabular-nums text-text-2">{s.count}</span>
              <span
                className="w-10 text-right text-[11px] font-mono tabular-nums"
                style={{ color: s.count > 0 ? s.color : '#8595A4' }}
              >
                {pct(s.count)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Top-X panels ────────────────────────────────────────────────────────────

// Each card uses the same header rhythm: title on the left, "AVG / N"
// column hints on the right. The header doubles as the column legend so
// the user knows what the two right-side numbers mean without hovering.

function TopCompaniesCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Companies">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default/40">
          {items.map(({ label, count, avgScore }) => {
            const color = scoreTierColor(avgScore)
            return (
              <li key={label} className="flex items-center gap-2.5 py-2">
                <CompanyLogo company={label} size={22} className="shrink-0" />
                <span className="flex-1 min-w-0 text-[12.5px] text-text-1 font-medium truncate">{label}</span>
                <span
                  className="text-[12px] font-mono font-semibold tabular-nums shrink-0 w-9 text-right"
                  style={{ color }}
                >
                  {avgScore.toFixed(1)}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-text-4 shrink-0 w-6 text-right">{count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function TopLocationsCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Locations">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default/40">
          {items.map(({ label, count, avgScore }) => {
            const flag = locationFlag(label)
            const color = scoreTierColor(avgScore)
            return (
              <li key={label} className="flex items-center gap-2.5 py-2">
                <span className="text-[16px] leading-none w-5 text-center shrink-0" aria-hidden>
                  {flag ?? '🌐'}
                </span>
                <span className="flex-1 min-w-0 text-[12.5px] text-text-1 truncate">{label}</span>
                <span
                  className="text-[12px] font-mono font-semibold tabular-nums shrink-0 w-9 text-right"
                  style={{ color }}
                >
                  {avgScore.toFixed(1)}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-text-4 shrink-0 w-6 text-right">{count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function TopArchetypesCard({ items }: { items: TopRow[] }) {
  const max = items.length ? Math.max(...items.map(i => i.avgScore)) : 0
  return (
    <PanelCard title="Top Archetypes">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="space-y-2.5 mt-1">
          {items.map(({ label, count, avgScore }) => {
            const pct = max ? (avgScore / max) * 100 : 0
            const color = scoreTierColor(avgScore)
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[12px] text-text-1 truncate">{label}</span>
                  <span className="text-[11px] font-mono tabular-nums shrink-0">
                    <span style={{ color }} className="font-semibold">{avgScore.toFixed(1)}</span>
                    <span className="text-text-4"> · {count}</span>
                  </span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                  <div
                    className="h-full rounded-pill"
                    style={{ width: `${pct}%`, background: color, transition: 'width 320ms ease' }}
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
    <div className="bg-bg-panel border border-border-default rounded-lg p-3.5">
      <div className="flex items-baseline justify-between mb-2 pb-1.5 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">{title}</span>
        <span className="text-[9.5px] font-mono uppercase tracking-[0.08em] text-text-4 shrink-0">
          AVG · N
        </span>
      </div>
      {children}
    </div>
  )
}

function EmptyHint() {
  return <p className="text-[11px] text-text-4 py-4 text-center">No data</p>
}

// Same galaxy palette as the rest of the app (Database scoreColor,
// ReportSlideOver hero, etc) — sourced from the shared `lib/tier.ts`
// module so a number reads as the same color everywhere it appears.
const scoreTierColor = galaxyScoreColor
