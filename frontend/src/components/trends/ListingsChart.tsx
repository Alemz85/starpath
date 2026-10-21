'use client'

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Button, Panel } from '@/components/ui'
import { themeColor } from '@/lib/themes'
import { tierColor } from '@/lib/tier'
import { MATCH_HIGH } from '@/lib/scoreBands'
import { type PeriodBucket, type PeriodGranularity } from '@/lib/trendsAnalytics'

// Listings posted per period (DESIGN-meta § Charts, "Count bars"). Bars count
// distinct listings by the period they were posted (scan-history's posting
// date, else the report's `**Posted:**` date, else their first evaluation): the strong matches at the foot in the
// top-score colour (Match ≥ MATCH_HIGH, the colour a Match of 8 takes
// everywhere), the rest above, blocked ones on top in the eligibility red.
// Counts only, so nothing is gated (docs/scoring-statistical-design.md § 3.6);
// the tooltip says which date placed each bar's listings.

const STRONG_MATCH_COLOR = tierColor('T1')
const BAR_COLOR = themeColor('chart-7')
const BLOCKED_COLOR = themeColor('danger', 0.4)

const GRANULARITY_LABEL: Record<PeriodGranularity, string> = { week: 'Week', month: 'Month' }

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// "2026-09-07" → "September 2026" (month) or "the week of September 7, 2026"
// (week), for the spoken chart description. UTC parse: ISO day, TZ-stable.
function periodInWords(start: string, granularity: PeriodGranularity): string {
  const [y, m, d] = start.split('-').map(Number)
  const month = MONTH_LONG[(m ?? 1) - 1] ?? start
  return granularity === 'month' ? `${month} ${y}` : `the week of ${month} ${d}, ${y}`
}

// A plain-sentence description of the chart for assistive tech, built from
// the same buckets the bars draw, so a screen reader gets the totals and the
// peak without the SVG.
function describeChart(buckets: PeriodBucket[], granularity: PeriodGranularity): string {
  const listings = buckets.reduce((n, b) => n + b.listings, 0)
  const strong = buckets.reduce((n, b) => n + b.strongMatch, 0)
  const blocked = buckets.reduce((n, b) => n + b.blocked, 0)
  const other = listings - strong - blocked
  const periods = `${buckets.length} ${granularity}${buckets.length === 1 ? '' : 's'}`
  const head = `Listings posted per ${granularity}: ${listings} listing${listings === 1 ? '' : 's'} over ${periods}; strong matches ${strong}, other ${other}, blocked ${blocked}.`
  if (listings === 0 || buckets.length <= 1) return head
  const peak = buckets.reduce((best, b) => (b.listings > best.listings ? b : best), buckets[0])
  return `${head} Most in ${periodInWords(peak.start, granularity)} with ${peak.listings}.`
}

export function ListingsChart({
  buckets, granularity, onGranularity,
}: {
  buckets: PeriodBucket[]
  granularity: PeriodGranularity
  onGranularity: (g: PeriodGranularity) => void
}) {
  const listings = buckets.reduce((n, b) => n + b.listings, 0)
  const postedCount = buckets.reduce((n, b) => n + b.posted, 0)
  // Bars need their segments as separate keys.
  const data = buckets.map(b => ({ ...b, rest: b.listings - b.blocked - b.strongMatch }))
  const description = describeChart(buckets, granularity)

  return (
    <Panel
      title={`Listings posted per ${granularity}`}
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
        <LegendSwatch color={STRONG_MATCH_COLOR} label={`Strong match (Match ${MATCH_HIGH.toFixed(1)}+)`} />
        <LegendSwatch color={BAR_COLOR} label="Other" />
        <LegendSwatch color={BLOCKED_COLOR} label="Blocked" />
      </div>

      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          {/* The SVG is the image: role="img" with the description as its
              name, so the axis ticks and bars inside are presentational.
              accessibilityLayer makes it focusable and lets the arrow keys
              walk the tooltip across the periods. */}
          <BarChart
            data={data}
            margin={{ top: 4, right: 4, bottom: 4, left: 0 }}
            accessibilityLayer
            role="img"
            aria-label={description}
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <CartesianGrid stroke={themeColor('divider')} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: themeColor('text-3'), fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: themeColor('divider') }}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: themeColor('text-3'), fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={28}
            />
            <Tooltip content={<PeriodTooltip />} cursor={{ fill: themeColor('bg-elevated') }} />
            <Bar dataKey="strongMatch" stackId="n" fill={STRONG_MATCH_COLOR} maxBarSize={36} isAnimationActive={false} />
            <Bar dataKey="rest" stackId="n" fill={BAR_COLOR} maxBarSize={36} isAnimationActive={false} />
            <Bar dataKey="blocked" stackId="n" fill={BLOCKED_COLOR} maxBarSize={36} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-micro text-text-4">
        Each listing counts once, in the {granularity} it was posted
        {postedCount === listings
          ? '. '
          : postedCount === 0
            ? `: no posting dates on file, so the ${granularity} it was first evaluated. `
            : ` (${postedCount} of ${listings} have a posting date from the scans or their report; the rest use the ${granularity} they were first evaluated). `}
        Strong match means Match {MATCH_HIGH.toFixed(1)} or more and not blocked (a Go, Stretch or Growth target verdict).
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

// The counts behind a bar, and which date placed its listings, so a bar made
// of evaluation-date fallbacks isn't read as a hiring cycle.
function PeriodTooltip({ active, payload }: PeriodTooltipProps) {
  const b = payload?.[0]?.payload
  if (!active || !b) return null
  const placedBy = b.listings === 0
    ? 'Nothing posted'
    : b.evaluated === 0
      ? 'By posting date'
      : b.posted === 0
        ? 'By first evaluation (no posting dates)'
        : `${b.posted} by posting date · ${b.evaluated} by first evaluation`
  return (
    <div className="card shadow-menu rounded-lg px-3 py-2 min-w-[180px] text-label">
      <div className="font-medium text-text-1 mb-1.5">{b.title}</div>
      <ul className="flex flex-col gap-1 tabular-nums">
        <li className="flex justify-between gap-4">
          <span className="text-text-3">Listings</span>
          <span className="text-text-1 font-medium">{b.listings}</span>
        </li>
        <li className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5 text-text-3">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: STRONG_MATCH_COLOR }} aria-hidden />
            Strong match
          </span>
          <span className="text-text-2">{b.strongMatch}</span>
        </li>
        {b.blocked > 0 && (
          <li className="flex justify-between gap-4">
            <span className="text-text-3">Blocked</span>
            <span className="text-text-2">{b.blocked}</span>
          </li>
        )}
      </ul>
      <div className="mt-1.5 text-micro text-text-4">{placedBy}</div>
    </div>
  )
}
