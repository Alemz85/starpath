'use client'

import { useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { cn } from '@/lib/utils'
import { canonicalizeArchetype } from '@/lib/archetype'
import { TOP_LIST_DEFS, TopListCard, buildTopList } from '@/components/shared/TopListCard'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  Button, Chip, Panel, PageHeader, StatStrip, Stat, type ChipTone,
} from '@/components/ui'
import { WantEase } from '@/components/shared/WantEase'
import { ListingsChart } from '@/components/trends/ListingsChart'
import {
  type TimeRange, type Funnel, type PeriodGranularity,
  type TargetingMomentum, type MomentumDirection, type ArchetypeMix,
  TIME_RANGE_LABEL, filterByDateWindow,
  avg, buildByPeriod, pickGranularity, buildFunnel, scoredOnly,
  buildTargetingMomentum, buildArchetypeMix,
} from '@/lib/trendsAnalytics'
import { themeColor } from '@/lib/themes'
import { listingDateKey, postedDateOf } from '@/lib/listingDates'
import { pickPostedDate } from '@/lib/postedDate'
import type { ScoreEntry } from '@/types'

// The analytics lib labels dimensions in title case ("Skills Match"); the UI
// is sentence case everywhere.
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

// How many rows each top list shows.
const TOP_LIMIT = 6

export function TrendsView() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const listingDates = useDataStore(s => s.listingDates)
  const reportPosted = useDataStore(s => s.reportPosted)
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  // null = automatic: weeks when they can carry a Want line, months otherwise.
  const [granularityChoice, setGranularityChoice] = useState<PeriodGranularity | null>(null)

  // Filter once by time range; everything else derives from this. Computing
  // client-side from scoreHistory (already in the data store) instead of an
  // IPC call avoids an empty-chart flash on every tab switch.
  const filtered = useMemo(() => filterByDateWindow(scoreHistory, timeRange), [scoreHistory, timeRange])

  // The time chart places each listing by its posting date (scan-history,
  // else the report's `**Posted:**` line), else by its first evaluation
  // (buildByPeriod's own fallback, so the evaluation date isn't passed here).
  const periodOpts = useMemo(
    () => ({
      postedDate: (e: ScoreEntry) => pickPostedDate({
        scanPosted: postedDateOf(listingDates, e.company, e.role),
        reportPosted: reportPosted[listingDateKey(e.company, e.role)],
      })?.date,
    }),
    [listingDates, reportPosted],
  )
  const granularity = useMemo(
    () => granularityChoice ?? pickGranularity(filtered, periodOpts),
    [granularityChoice, filtered, periodOpts],
  )
  const byPeriod = useMemo(() => buildByPeriod(filtered, granularity, periodOpts), [filtered, granularity, periodOpts])

  // Top lists, each ranked on one named axis (Want or Ease, never both folded).
  const topCompanies  = useMemo(() => buildTopList(filtered, 'companies', TOP_LIMIT), [filtered])
  const topLocations  = useMemo(() => buildTopList(filtered, 'locations', TOP_LIMIT), [filtered])
  const topArchetypes = useMemo(() => buildTopList(filtered, 'archetypes', TOP_LIMIT), [filtered])

  const stats = useMemo(() => {
    if (filtered.length === 0) return null
    // Score averages over SCORED rows only — blocked rows have no Want/Ease
    // and count in the eligibility split instead (docs/scoring-v2.md §9).
    const scored = scoredOnly(filtered)
    return {
      total:   filtered.length,
      blocked: filtered.length - scored.length,
      avgWant: scored.length ? avg(scored, 'want').toFixed(2) : '—',
      avgEase: scored.length ? avg(scored, 'ease').toFixed(2) : '—',
    }
  }, [filtered])

  // Targeting momentum — splits the windowed corpus chronologically into an
  // earlier vs later half and contrasts their quality (median Want and Ease,
  // actionable share, per-dimension means). Gated per half (docs § 3.5).
  const momentum = useMemo(() => buildTargetingMomentum(filtered), [filtered])

  // Archetype focus — the composition of the corpus rather than its quality:
  // where evaluation effort goes, and whether that allocation drifted between
  // the earlier and later half. The top archetypes list answers the quality
  // question; this card shows no scores at all.
  const archetypeMix = useMemo(
    () => buildArchetypeMix(filtered, canonicalizeArchetype),
    [filtered],
  )

  // Applications rolled into a cumulative conversion funnel, filtered to the
  // same time window (by tracker-add date). Reads applications.md, not
  // score-history: the downstream counterpart to the score analytics above.
  const filteredApps = useMemo(() => filterByDateWindow(applications, timeRange), [applications, timeRange])
  const funnel = useMemo(() => buildFunnel(filteredApps), [filteredApps])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Trends"
        meta={stats ? `${stats.total} evaluations` : null}
        actions={
          <div className="flex items-center gap-0.5 rounded border border-border-default p-0.5">
            {(['all', '1y', '6m', '1m'] as const).map(r => (
              <Button
                key={r}
                tone={timeRange === r ? 'tinted' : 'ghost'}
                size="xs"
                onClick={() => setTimeRange(r)}
              >
                {TIME_RANGE_LABEL[r]}
              </Button>
            ))}
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-5 flex flex-col gap-4">
          {stats && (
            <StatStrip>
              <Stat value={stats.total} label="Total evaluated" />
              <Stat value={stats.avgWant} label="Avg Want" />
              <Stat value={stats.avgEase} label="Avg Ease" />
              <Stat value={stats.blocked} label="Blocked" title="Eligibility red: no Want or Ease, excluded from the averages" />
            </StatStrip>
          )}

          {!loaded ? (
            <div className="h-64 shimmer rounded-lg" />
          ) : filtered.length === 0 ? (
            <div className="card h-64 flex items-center justify-center">
              <EmptyState
                title="No evaluations yet"
                hint="Run a Filter to Database scan to populate Trends."
              />
            </div>
          ) : (
            <>
              {/* Top lists lead: each answers "which X is best on one axis",
                  named in the title. They share the page's time range. */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <TopListCard title={TOP_LIST_DEFS.companies.title} icon={TOP_LIST_DEFS.companies.icon} items={topCompanies} />
                <TopListCard title={TOP_LIST_DEFS.locations.title} icon={TOP_LIST_DEFS.locations.icon} items={topLocations} />
                <TopListCard title={TOP_LIST_DEFS.archetypes.title} icon={TOP_LIST_DEFS.archetypes.icon} items={topArchetypes} />
              </div>

              {/* Listings by posting date, wanted vs the rest. */}
              {byPeriod.length > 0 && (
                <ListingsChart
                  buckets={byPeriod}
                  granularity={granularity}
                  onGranularity={setGranularityChoice}
                />
              )}

              {/* Targeting momentum — the only panel about the *direction* of
                  pipeline quality. Needs at least two scored rows to split; the
                  card falls back to a hint when the halves are too thin. */}
              {momentum.scoredCount >= 2 && (
                <TargetingMomentumCard momentum={momentum} />
              )}

              {/* Archetype focus — gated on two distinct archetypes so a
                  single-bucket corpus doesn't render a one-segment "mix". */}
              {archetypeMix.distinct >= 2 && (
                <ArchetypeFocusCard mix={archetypeMix} />
              )}

              {/* Pipeline conversion — gated on one sent application so it
                  never shows an all-zero funnel. */}
              {funnel.sent > 0 && (
                <ConversionFunnelCard funnel={funnel} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Targeting momentum card ─────────────────────────────────────────────────
//
// Two stat blocks (earlier half · later half) sit either side of two verdict
// chips, one per axis, so the headline reads at a glance: "median Want
// 6.2 → 7.4, improving; Ease steady". Want and Ease each carry their own
// direction against their own deadband (docs/scoring-v2.md §9). The
// verdict uses the SEMANTIC tones (success / danger / muted) because "is my
// targeting getting better or worse" is a state, not a categorical series.
// Below the stats, a compact strip shows the dimensions that moved most between
// the two halves so the user can see *where* the shift came from. Under the
// per-half floor (or on a same-day corpus) the whole verdict layer collapses to
// a single honest hint instead of asserting a trend on noise.

// `arrow` is the glyph in the chip; the halves' numbers take the shared WantEase colours.
const MOMENTUM_VERDICT: Record<MomentumDirection, { label: string; arrow: string; tone: ChipTone }> = {
  improving: { label: 'Improving', arrow: '↑', tone: 'success' },
  declining: { label: 'Declining', arrow: '↓', tone: 'danger' },
  steady:    { label: 'Steady',    arrow: '→', tone: 'muted' },
}

const signedTenths = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(1)}`

function TargetingMomentumCard({ momentum }: { momentum: TargetingMomentum }) {
  const { earlier, recent, wantMedianDelta, easeMedianDelta, applyPctDelta, wantDirection, easeDirection, dimShifts, lowSignal } = momentum
  const wantVerdict = MOMENTUM_VERDICT[wantDirection]
  const easeVerdict = MOMENTUM_VERDICT[easeDirection]
  // Lead with the dimensions that actually moved; a flat-everything corpus
  // shows nothing here rather than a row of ±0.0 badges.
  const movers = lowSignal ? [] : dimShifts.filter(s => Math.abs(s.delta) >= 0.05).slice(0, 3)
  // Every scored row on one date: there is no timeline to split (the lib
  // reports lowSignal for this case), so the hint says so plainly.
  const sameDay = momentum.scoredCount >= 2 && earlier.dateFrom !== '' && earlier.dateFrom === recent.dateTo

  return (
    <Panel
      title="Targeting momentum"
      meta={lowSignal
        ? `Earlier vs later · ${momentum.scoredCount} scored`
        : `${earlier.count} earlier · ${recent.count} later`}
    >
      {lowSignal ? (
        <p className="text-label text-text-3">
          {sameDay
            ? `All ${momentum.scoredCount} scored evaluations are from ${fmtDay(earlier.dateFrom)}, so there is no earlier and later half to compare yet. Evaluate on a few more days and this will show whether your later picks score higher than your earlier ones.`
            : 'Not enough scored evaluations on each side of the timeline to read a trend yet. Evaluate a few more and this will show whether your later picks are scoring higher than your earlier ones.'}
        </p>
      ) : (
        <>
          {/* Earlier → direction → later. The two halves use the same metric
              rows; the centre chip carries the direction. */}
          <div className="flex items-stretch gap-3">
            <HalfBlock title="Earlier" want={earlier.medianWant} ease={earlier.medianEase} from={earlier.dateFrom} to={earlier.dateTo} />
            <div className="flex flex-col items-center justify-center gap-2.5 shrink-0 px-1">
              {([['Want', wantVerdict, wantMedianDelta], ['Ease', easeVerdict, easeMedianDelta]] as const).map(([axis, v, d]) => (
                <span key={axis} className="flex flex-col items-center gap-1">
                  <Chip tone={v.tone} size="md">
                    <span aria-hidden>{v.arrow}</span>{axis} {v.label.toLowerCase()}
                  </Chip>
                  <span className="text-micro tabular-nums text-text-4">
                    {signedTenths(d)} median
                  </span>
                </span>
              ))}
            </div>
            <HalfBlock title="Later" want={recent.medianWant} ease={recent.medianEase} from={recent.dateFrom} to={recent.dateTo} />
          </div>

          {/* Actionable share movement (Go / Stretch / Solid), earlier → later. */}
          <div className="flex items-baseline justify-between gap-3 mt-3 pt-2.5 border-t border-border-default text-label">
            <span className="text-text-3">Actionable share (Go / Stretch / Solid)</span>
            <span className="tabular-nums">
              <span className="text-text-4">{earlier.applyPct}%</span>
              <span className="text-text-4 px-1">→</span>
              <span className="text-text-2 font-medium">{recent.applyPct}%</span>
              {applyPctDelta !== 0 && (
                <span className={cn('ml-1.5', applyPctDelta > 0 ? 'text-success' : 'text-danger')}>
                  ({applyPctDelta > 0 ? '+' : '−'}{Math.abs(applyPctDelta)}pt)
                </span>
              )}
            </span>
          </div>

          {/* Biggest dimension movers between the halves — where the shift came
              from. Hidden entirely when nothing moved meaningfully. */}
          {movers.length > 0 && (
            <div className="mt-3">
              <div className="label mb-1.5">Biggest shifts</div>
              <ul className="flex flex-wrap gap-1.5">
                {movers.map(s => (
                  <li key={String(s.field)}>
                    <Chip size="md">
                      <span className="text-text-2">{sentenceCase(s.label)}</span>
                      <span
                        className="tabular-nums"
                        style={{ color: s.delta > 0 ? themeColor('accent-text') : themeColor('text-3') }}
                      >
                        {s.delta > 0 ? '+' : '−'}{Math.abs(s.delta).toFixed(1)}
                      </span>
                    </Chip>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

// One half of the momentum comparison: median Want and Ease (the headline
// pair, via the shared WantEase so each number takes its own ladder colour)
// with the date span beneath. Direction lives in the centre chips only.
function HalfBlock({
  title, want, ease, from, to,
}: {
  title: string; want: number; ease: number; from: string; to: string
}) {
  const span = from && to ? (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`) : '—'
  return (
    <div className="flex-1 min-w-0 rounded-lg bg-bg-elevated px-3 py-2.5">
      <div className="label mb-1.5">{title} · median</div>
      <WantEase want={want} ease={ease} />
      <div className="text-label tabular-nums text-text-4 mt-1.5 truncate" title={span}>{span}</div>
    </div>
  )
}

// "2026-06-25" → "Jun 25". Score-history dates are always YYYY-MM-DD ISO, so a
// UTC parse is exact and TZ-stable (no local-midnight drift).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number((d ?? '').slice(0, 2))}` : iso
}

// ─── Archetype focus card ────────────────────────────────────────────────────
//
// Where evaluation effort goes, not how good it is: no scores on this card
// (the top archetypes list has those). Two 100% bars, earlier half above later
// half, split by archetype, so a drift in focus reads as segments growing or
// shrinking between the rows. Under the per-half floor there is one bar for the
// whole window and no shift column.
//
// Segments use the categorical chart palette (DESIGN-meta § Charts): an
// archetype is a category, not a quality. The tail and unlabelled rows share
// the muted last slot.

const FOCUS_COLORS = [
  themeColor('chart-1'), themeColor('chart-3'), themeColor('chart-4'),
  themeColor('chart-5'), themeColor('chart-6'), themeColor('chart-2'),
]
const FOCUS_OTHER = themeColor('chart-7')

function ArchetypeFocusCard({ mix }: { mix: ArchetypeMix }) {
  const { slices, scoredCount, distinct, concentration, lowSignal, earlierTotal, recentTotal } = mix
  const shown = slices.slice(0, FOCUS_COLORS.length)
  const rest = slices.slice(FOCUS_COLORS.length)
  const restCount = rest.reduce((s, x) => s + x.count, 0)

  // One-word read on how concentrated the search is. Herfindahl thresholds:
  // ≥0.5 = one or two buckets dominate; ≤0.25 = spread thin across many.
  const focus = concentration >= 0.5 ? 'Focused'
    : concentration <= 0.25 ? 'Scattered'
    : 'Balanced'

  // Segment widths from counts, so the two rows sum to their half exactly;
  // whatever the shown slices don't cover (the tail, unlabelled rows) is Other.
  const segments = (count: (s: typeof shown[number]) => number, total: number) => {
    const parts = shown.map((s, i) => ({ key: s.label, pct: total ? (count(s) / total) * 100 : 0, color: FOCUS_COLORS[i] }))
    const covered = parts.reduce((n, p) => n + p.pct, 0)
    if (total && covered < 99.5) parts.push({ key: 'Other', pct: 100 - covered, color: FOCUS_OTHER })
    return parts
  }
  const rows = lowSignal
    ? [{ label: 'All', n: scoredCount, parts: segments(s => s.count, scoredCount) }]
    : [
        { label: 'Earlier', n: earlierTotal, parts: segments(s => s.earlierCount, earlierTotal) },
        { label: 'Later', n: recentTotal, parts: segments(s => s.recentCount, recentTotal) },
      ]

  return (
    <Panel
      title="Archetype focus"
      meta={<>
        <span className="text-accent-text font-medium">{focus}</span> · {distinct} archetypes · {scoredCount} scored
      </>}
    >
      <div className="flex flex-col gap-2 mb-4">
        {rows.map(r => (
          <div key={r.label} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-label text-text-3">{r.label}</span>
            <div className="flex-1 flex h-4 rounded overflow-hidden bg-bg-elevated">
              {r.parts.map(p => (
                <div
                  key={p.key}
                  className="h-full transition-[width] duration-200 ease-quart"
                  style={{ width: `${p.pct}%`, background: p.color }}
                  title={`${p.key}: ${Math.round(p.pct)}%`}
                />
              ))}
            </div>
            <span className="w-8 shrink-0 text-right text-label tabular-nums text-text-4">{r.n}</span>
          </div>
        ))}
      </div>

      {/* Legend doubles as the table: share of the whole window and, when the
          halves are trustworthy, the later-minus-earlier shift. */}
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
        {shown.map((s, i) => (
          <li key={s.label} className="flex items-baseline gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: FOCUS_COLORS[i] }} aria-hidden />
            <span className="flex-1 min-w-0 text-label text-text-1 truncate" title={s.label}>{s.label}</span>
            <span className="w-9 text-right text-label tabular-nums text-text-3" title="Share of scored evaluations">{s.sharePct}%</span>
            {!lowSignal && (
              <span className="w-8 text-right"><ShareShiftBadge shift={s.shareShift} /></span>
            )}
          </li>
        ))}
        {restCount > 0 && (
          <li className="flex items-baseline gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: FOCUS_OTHER }} aria-hidden />
            <span className="flex-1 min-w-0 text-label text-text-3 truncate">
              {rest.length} more archetype{rest.length === 1 ? '' : 's'}
            </span>
            <span className="w-9 text-right text-label tabular-nums text-text-4">{restCount}</span>
            {!lowSignal && <span className="w-8" />}
          </li>
        )}
      </ul>

      <p className="mt-3 pt-2 border-t border-border-default text-micro text-text-4">
        {lowSignal
          ? 'Earlier vs later split hidden: too few evaluations on each side of the timeline yet'
          : 'Earlier and later are the two halves of the window by evaluation date; shift is the later minus earlier share, in points'}
      </p>
    </Panel>
  )
}

// Signed share-of-attention shift for an archetype, in percentage points
// (later half minus earlier half). Accent when an archetype is gaining focus,
// slate when it's fading; sub-1pt reads as flat so a stable bucket doesn't
// masquerade as a mover.
function ShareShiftBadge({ shift }: { shift: number }) {
  const flat = Math.abs(shift) < 1            // sub-1pt is rounding noise, not a drift
  const sign = shift > 0 ? '+' : shift < 0 ? '−' : '±'
  const color = flat ? themeColor('text-4') : shift > 0 ? themeColor('accent-text') : themeColor('text-3')
  return (
    <span
      className="text-micro font-medium tabular-nums"
      style={{ color }}
      title="Later-half minus earlier-half share of attention (percentage points)"
    >
      {flat ? '±0' : `${sign}${Math.abs(shift)}`}
    </span>
  )
}

// ─── Conversion funnel card ──────────────────────────────────────────────────

// Stage colours follow the lifecycle semantics: Applied + Responded in the
// violet family (deepening as you advance), Interview amber, Offer green.
// `text` is the on-white text tone for the percentage (amber needs the darker
// warning-text to stay legible).
function ConversionFunnelCard({ funnel }: { funnel: Funnel }) {
  const { sent, responded, interview, offer, rejected } = funnel
  const pct = (n: number) => (sent ? Math.round((n / sent) * 100) : 0)
  const stages: Array<{ label: string; count: number; color: string; text: string }> = [
    { label: 'Applied',   count: sent,      color: themeColor('accent'), text: themeColor('accent-text') },
    { label: 'Responded', count: responded, color: themeColor('accent-text'), text: themeColor('accent-text') },
    { label: 'Interview', count: interview, color: themeColor('warning'), text: themeColor('warning-text') },
    { label: 'Offer',     count: offer,     color: themeColor('success'), text: themeColor('success') },
  ]
  return (
    <Panel
      title="Pipeline conversion"
      meta={<>
        <span className="text-accent-text font-medium">{pct(responded)}%</span> response rate · {sent} sent
        {rejected > 0 && ` · ${rejected} rejected`}
      </>}
    >
      <div className="flex flex-col gap-2">
        {stages.map(s => {
          const barPct = sent ? Math.max((s.count / sent) * 100, s.count > 0 ? 3 : 0) : 0
          return (
            <div key={s.label} className="flex items-center gap-3">
              <span className="w-[72px] shrink-0 text-label text-text-2">{s.label}</span>
              <div className="flex-1 h-4 rounded bg-bg-elevated overflow-hidden">
                <div
                  className="h-full rounded transition-[width] duration-200 ease-quart"
                  style={{ width: `${barPct}%`, background: s.color }}
                />
              </div>
              <span className="w-6 text-right text-label tabular-nums text-text-2">{s.count}</span>
              <span
                className="w-10 text-right text-label tabular-nums"
                style={{ color: s.count > 0 ? s.text : themeColor('text-4') }}
              >
                {pct(s.count)}%
              </span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
