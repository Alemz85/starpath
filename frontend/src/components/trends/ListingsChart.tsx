'use client'

import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Button, Panel } from '@/components/ui'
import { themeColor } from '@/lib/themes'
import {
  type PeriodBucket, type PeriodGranularity, MIN_SCORED_PER_PERIOD_FOR_WANT,
} from '@/lib/trendsAnalytics'

// Listings per period with the mean-Want line on top (DESIGN-meta § Charts,
// "Count bars with a gated line"). Bars are the count of distinct listings
// first evaluated in the period, blocked ones stacked on top in the eligibility
// red; the line is mean Want over the scored ones, on its own 0–10 axis.
//
// The line obeys the window-mean gate (docs/scoring-statistical-design.md
// § 3.3): a period under MIN_SCORED_PER_PERIOD_FOR_WANT scored listings has no
// point (the line breaks there), the tooltip states the shortfall, and the
// footnote names the gate. Blocked listings never enter the line.

const BAR_COLOR = themeColor('chart-7')
const BLOCKED_COLOR = themeColor('danger', 0.4)
const WANT_COLOR = themeColor('chart-1')

const GRANULARITY_LABEL: Record<PeriodGranularity, string> = { week: 'Week', month: 'Month' }

export function ListingsChart({
  buckets, granularity, onGranularity,
}: {
  buckets: PeriodBucket[]
  granularity: PeriodGranularity
  onGranularity: (g: PeriodGranularity) => void
}) {
  const listings = buckets.reduce((n, b) => n + b.listings, 0)
  const plotted = buckets.filter(b => b.avgWant != null).length
  const withheld = buckets.filter(b => b.wantWithheld).length
  // Bars need their segments as separate keys; the line reads avgWant as-is.
  const data = buckets.map(b => ({ ...b, open: b.listings - b.blocked }))

  return (
    <Panel
      title={`Listings per ${granularity}`}
      meta={`${listings} listing${listings === 1 ? '' : 's'} over ${buckets.length} ${granularity}${buckets.length === 1 ? '' : 's'}`}
      action={
        <div className="flex items-center gap-0.5 rounded border border-border-default p-0.5">
          {(['week', 'month'] as const).map(g => (
            <Button
              key={g}
              tone={granularity === g ? 'tinted' : 'ghost'}
              size="xs"
              onClick={() => onGranularity(g)}
            >
              {GRANULARITY_LABEL[g]}
            </Button>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <LegendSwatch color={BAR_COLOR} label="Listings" />
        <LegendSwatch color={BLOCKED_COLOR} label="Blocked" />
        <span className="flex items-center gap-1.5 text-label text-text-3">
          <span className="w-3 h-0.5 rounded-pill shrink-0" style={{ background: WANT_COLOR }} aria-hidden />
          Mean Want
        </span>
      </div>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={themeColor('divider')} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: themeColor('text-3'), fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: themeColor('divider') }}
            />
            <YAxis
              yAxisId="n"
              allowDecimals={false}
              tick={{ fill: themeColor('text-3'), fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <YAxis
              yAxisId="want"
              orientation="right"
              domain={[0, 10]}
              ticks={[0, 5, 10]}
              tick={{ fill: themeColor('text-4'), fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={24}
            />
            <Tooltip content={<PeriodTooltip />} cursor={{ fill: themeColor('bg-elevated') }} />
            <Bar yAxisId="n" dataKey="open" stackId="n" fill={BAR_COLOR} maxBarSize={36} isAnimationActive={false} />
            <Bar yAxisId="n" dataKey="blocked" stackId="n" fill={BLOCKED_COLOR} maxBarSize={36} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <Line
              yAxisId="want"
              type="monotone"
              dataKey="avgWant"
              stroke={WANT_COLOR}
              strokeWidth={2}
              connectNulls={false}
              dot={{ r: 3, fill: WANT_COLOR, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-micro text-text-4">
        Each listing counts once, in the {granularity} it was first evaluated. Mean Want is drawn
        for {granularity}s with at least {MIN_SCORED_PER_PERIOD_FOR_WANT} scored listings
        {plotted === 0
          ? `; none has that many yet${granularity === 'week' ? ', try Month' : ''}.`
          : withheld > 0
            ? ` (${withheld} withheld).`
            : '.'}
        {' '}Blocked listings have no Want and are left out of it.
      </p>
    </Panel>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-label text-text-3">
      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

interface PeriodTooltipProps {
  active?: boolean
  payload?: Array<{ payload?: PeriodBucket }>
}

// States the counts behind every bar and, for the line, either the mean with
// its confidence tier and n, or the shortfall that withheld it (docs § 4).
function PeriodTooltip({ active, payload }: PeriodTooltipProps) {
  const b = payload?.[0]?.payload
  if (!active || !b) return null
  return (
    <div className="card shadow-menu rounded-lg px-3 py-2 min-w-[180px] text-label">
      <div className="font-medium text-text-1 mb-1.5">{b.title}</div>
      <ul className="flex flex-col gap-1 tabular-nums">
        <li className="flex justify-between gap-4">
          <span className="text-text-3">Listings</span>
          <span className="text-text-1 font-medium">{b.listings}</span>
        </li>
        {b.blocked > 0 && (
          <li className="flex justify-between gap-4">
            <span className="text-text-3">Blocked</span>
            <span className="text-text-2">{b.blocked}</span>
          </li>
        )}
        <li className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5 text-text-3">
            <span className="w-2 h-0.5 rounded-pill shrink-0" style={{ background: WANT_COLOR }} aria-hidden />
            Mean Want
          </span>
          <span className="text-text-1 font-medium">{b.avgWant != null ? b.avgWant.toFixed(1) : '—'}</span>
        </li>
      </ul>
      <div className="mt-1.5 text-micro text-text-4">
        {b.avgWant != null
          ? `${b.scored} scored · ${b.wantConfidence} confidence`
          : b.wantWithheld
            ? `Withheld: ${b.scored} scored, ${MIN_SCORED_PER_PERIOD_FOR_WANT} needed`
            : 'No scored listings'}
      </div>
    </div>
  )
}
