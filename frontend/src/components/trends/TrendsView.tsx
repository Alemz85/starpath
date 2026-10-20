'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useAppStore } from '@/store/app'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canonicalizeArchetype } from '@/lib/archetype'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { EmptyState } from '@/components/shared/EmptyState'
import { ViewTabs, viewPanelId, viewTabId, type ViewTab } from '@/components/shared/ViewTabs'
import { ScoreTrendPanel } from '@/components/scoretrend/ScoreTrendView'
import {
  Button, Chip, Panel, PageHeader, StatStrip, Stat, type ChipTone,
} from '@/components/ui'
import { scoreColor } from '@/lib/tier'
import { analyzeScoreTrend } from '@/lib/scoreTrend'
import { WantEase } from '@/components/shared/WantEase'
import {
  type TimeRange, type DateBucket, type TopRow, type Distribution, type Funnel,
  type DimensionProfile, type TargetingMomentum, type MomentumDirection,
  type ArchetypeMix,
  TIME_RANGE_LABEL, filterByDateWindow,
  avg, buildByDate, buildTopBy, buildDistribution, buildFunnel, scoredOnly,
  buildDimensionProfile, buildTargetingMomentum, buildArchetypeMix,
  locationFlag,
} from '@/lib/trendsAnalytics'
import { themeColor } from '@/lib/themes'

// Multi-series chart palette — sourced from the documented categorical
// chart tokens (DESIGN-meta.md § Charts). Charts only, never chrome.
//
// Series order maps to the DIMENSIONS array below: the theme's chart-1 for
// Want and chart-3 for Ease — scoring v2 states every trend on the two axes
// separately (there is no rolled-up line). The remaining slots fan out
// warm/cool/warm/cool so adjacent series contrast at first glance.
const DIM_COLORS = [
  themeColor('chart-1'),  // Want (the theme's anchor colour)
  themeColor('chart-3'),  // Ease
  themeColor('chart-4'),  // Skills match
  themeColor('chart-5'),  // Brand value
  themeColor('chart-6'),  // Growth
  themeColor('chart-7'),  // Work-life (intentionally muted)
]

type DimKey = 'avg_want' | 'avg_ease' | 'avg_skills_match' | 'avg_brand_value' | 'avg_growth' | 'avg_wlb'

const DIMENSIONS: Array<{ key: DimKey; label: string }> = [
  { key: 'avg_want',             label: 'Want'             },
  { key: 'avg_ease',             label: 'Ease'             },
  { key: 'avg_skills_match',     label: 'Skills match'     },
  { key: 'avg_brand_value',      label: 'Brand value'      },
  { key: 'avg_growth',           label: 'Growth'           },
  { key: 'avg_wlb',              label: 'Work-life'        },
]

// Sub-tabs under the title bar: the landscape analytics (Overview) and the
// re-evaluation trajectory panel (Score trend, absorbed from the retired
// standalone scoretrend view). 'scoretrend' doubles as the deep-link key —
// navigate('trends', '', '', 'scoretrend') lands on that tab via the nav
// store's one-shot viewTab request.
type TrendsTab = 'overview' | 'scoretrend'

const TRENDS_TABS: ReadonlyArray<ViewTab<TrendsTab>> = [
  { key: 'overview',   label: 'Overview'    },
  { key: 'scoretrend', label: 'Score trend' },
]

// dataKey → human label, used by the custom chart tooltip to name each
// active series (recharts only hands the tooltip the raw dataKey).
const DIM_LABEL_BY_KEY: Record<string, string> =
  Object.fromEntries(DIMENSIONS.map(d => [d.key, d.label]))

// Color (sourced from the line palette) keyed by dataKey, so the tooltip
// dots match the line colors regardless of which dims are toggled on.
const DIM_COLOR_BY_KEY: Record<string, string> =
  Object.fromEntries(DIMENSIONS.map((d, i) => [d.key, DIM_COLORS[i % DIM_COLORS.length]]))

// The analytics lib labels dimensions in title case ("Skills Match"); the UI
// is sentence case everywhere.
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

export function TrendsView() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['avg_want', 'avg_ease']))
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [tab, setTab] = useState<TrendsTab>('overview')

  // Score Trend is a deactivatable feature (Settings › General › Features).
  // When off, the tab strip collapses to Overview only and any landed-on or
  // deep-linked scoretrend state snaps back to Overview.
  const scoreTrendEnabled = useAppStore(s => s.features.scoreTrendTab)
  const tabs = useMemo(
    () => (scoreTrendEnabled ? TRENDS_TABS : TRENDS_TABS.filter(t => t.key !== 'scoretrend')),
    [scoreTrendEnabled],
  )
  useEffect(() => {
    if (!scoreTrendEnabled && tab === 'scoretrend') setTab('overview')
  }, [scoreTrendEnabled, tab])

  // One-shot sub-tab request from navigate('trends', '', '', <tab>) — CmdK
  // and other deep links land on Score Trend through this.
  const requestedTab = useNavStore(s => s.viewTab)
  useEffect(() => {
    if (requestedTab === 'overview') setTab(requestedTab)
    if (requestedTab === 'scoretrend' && scoreTrendEnabled) setTab(requestedTab)
  }, [requestedTab, scoreTrendEnabled])

  // Title-bar meta for the Score Trend tab — the same one-pass analysis the
  // panel runs, needed here only for the "{n} evaluations · {n} re-evaluated"
  // caption (the title bar belongs to the host, the panel stays self-
  // contained). Gated on the tab so Overview-only sessions never pay for it.
  const scoreTrendMeta = useMemo(
    () => (tab === 'scoretrend' ? analyzeScoreTrend(scoreHistory) : null),
    [tab, scoreHistory],
  )

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

  const distribution = useMemo(() => buildDistribution(filtered), [filtered])

  // Dimension profile — averages each scoring dimension across the corpus and,
  // crucially, contrasts the actionable subset (verdict Go / Stretch / Solid) against all
  // scored rows so the user can see which dimensions actually *drive* a high
  // score vs which are flat noise for targeting. Pure derivation in lib/.
  const profile = useMemo(() => buildDimensionProfile(filtered), [filtered])

  // Targeting momentum — splits the windowed corpus chronologically into an
  // earlier vs later half and contrasts their quality (median Want and Ease, apply
  // rate, per-dimension means). Answers "is the stuff I evaluate getting
  // better-fit over time?" — the trend *direction* the noisy daily line and the
  // static snapshots above can't show. Pure derivation in lib/; honest about
  // small samples (forces a "steady" verdict + a hint under the per-half floor).
  const momentum = useMemo(() => buildTargetingMomentum(filtered), [filtered])

  // Archetype mix — the only panel about the *composition* of the corpus rather
  // than its quality. Buckets every scored row by canonical archetype to show
  // where evaluation effort is going (share of attention + a concentration cue),
  // and contrasts the earlier vs later half so a drift in focus reads as a
  // signed share-point shift. Canonicalization is injected so the lib stays
  // React-free; honest about small samples (suppresses the shift under the floor).
  const archetypeMix = useMemo(
    () => buildArchetypeMix(filtered, canonicalizeArchetype),
    [filtered],
  )

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


  // Title-bar caption for the Score trend tab. Docs § 4 rule 1
  // (docs/scoring-statistical-design.md): the caption states the samples the
  // panel below rests on, and — when anything has been re-evaluated — how many
  // listings moved past a noise floor on Want or Ease (each against its own
  // floor, read from the analysis contract). No direction is claimed up here.
  const scoreTrendContract = scoreTrendMeta?.metadata?.contract
  const scoreTrendReevaluated = scoreTrendMeta?.trajectorySummary?.reevaluated ?? 0
  const scoreTrendPastFloor = (scoreTrendMeta?.listingTrajectories ?? [])
    .filter(t => t.want.detectable || t.ease.detectable).length
  const scoreTrendCaption = tab === 'scoretrend' && loaded && scoreTrendMeta && !scoreTrendMeta.error && scoreTrendContract ? (
    <span
      title={`Movement is counted against the Want ${scoreTrendContract.noiseFloors.want} and Ease ${scoreTrendContract.noiseFloors.ease} noise floors (${scoreTrendContract.doc}); a corpus verdict needs ${scoreTrendContract.minPerWindowForVerdict} scored evaluations per calendar window.`}
    >
      {scoreTrendMeta.metadata?.evaluated ?? 0} evaluations · {scoreTrendReevaluated} re-evaluated
      {scoreTrendReevaluated > 0 && ` · ${scoreTrendPastFloor} past a noise floor`}
    </span>
  ) : null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* The meta caption and the time-range control follow the active tab:
          the range only filters the Overview analytics (Score trend always
          reads the full history), so it renders only there. */}
      <PageHeader
        title="Trends"
        meta={tab === 'overview'
          ? (stats ? `${stats.total} evaluations` : null)
          : scoreTrendCaption}
        actions={tab === 'overview' ? (
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
        ) : undefined}
      />

      {/* With Score trend deactivated only Overview remains — a one-tab strip
          is chrome without a choice, so it hides entirely. */}
      {tabs.length > 1 && (
        <ViewTabs
          tabs={tabs}
          active={tab}
          onSelect={setTab}
          ariaLabel="Trends sections"
          idPrefix="trends"
        />
      )}

      {/* Tab panels share one scroll container; inactive panels unmount so
          neither tab pays for the other's charts. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div
          role="tabpanel"
          id={viewPanelId('trends', 'overview')}
          aria-labelledby={viewTabId('trends', 'overview')}
          hidden={tab !== 'overview'}
        >
          {tab === 'overview' && (
            <div className="p-5 flex flex-col gap-4">
              {stats && (
                <StatStrip>
                  <Stat value={stats.total} label="Total evaluated" />
                  <Stat value={stats.avgWant} label="Avg Want" />
                  <Stat value={stats.avgEase} label="Avg Ease" />
                  <Stat value={stats.blocked} label="Blocked" title="Eligibility red: no Want or Ease, excluded from the averages" />
                </StatStrip>
              )}

              {/* Series toggles. The dot carries the series colour; the chip
                  itself stays neutral. At least one series stays on. */}
              <div className="flex flex-wrap gap-1.5">
                {DIMENSIONS.map(({ key, label }, i) => {
                  const on = activeDims.has(key)
                  return (
                    <button
                      key={key}
                      onClick={() => toggleDim(key)}
                      className={cn(
                        'chip chip-md transition-colors duration-150',
                        on
                          ? 'bg-bg-base border-border-strong text-text-1'
                          : 'text-text-4 hover:text-text-2',
                      )}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: on ? DIM_COLORS[i % DIM_COLORS.length] : themeColor('divider') }}
                        aria-hidden
                      />
                      {label}
                    </button>
                  )
                })}
              </div>

              {!loaded ? (
                <div className="h-64 shimmer rounded-lg" />
              ) : byDate.length === 0 ? (
                <div className="card h-64 flex items-center justify-center">
                  <EmptyState
                    title="No score history yet"
                    hint="Run a Filter to Database scan to populate the trend chart."
                  />
                </div>
              ) : (
                <Panel className="h-[340px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={byDate} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                      <CartesianGrid stroke={themeColor('divider')} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: themeColor('text-3'), fontSize: 11 }}
                        tickLine={false}
                        axisLine={{ stroke: themeColor('divider') }}
                      />
                      <YAxis
                        domain={[0, 10]}
                        tick={{ fill: themeColor('text-3'), fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={28}
                      />
                      <Tooltip
                        content={<ChartTooltip />}
                        cursor={{ stroke: themeColor('track'), strokeDasharray: '3 3' }}
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
                </Panel>
              )}

              {/* Verdict distribution — the *shape* of pipeline quality, which
                  neither the time-series (averages) nor the top-X panels (best
                  performers) reveal. Bands map 1:1 to the scoring-v2 verdicts
                  (docs/scoring-v2.md §4), and an accent bracket marks the
                  actionable verdicts (Go / Stretch / Solid) so the headline
                  read is "what fraction of what I evaluate is worth applying to". */}
              {loaded && filtered.length > 0 && (
                <ScoreDistributionCard dist={distribution} />
              )}

              {/* Dimension profile — the only panel that explains *why* a role
                  scores well for this user. Ranks the scoring dimensions by how
                  much they separate an actionable role (Go / Stretch / Solid) from the
                  full corpus: chase roles strong on the high-delta dimensions. */}
              {loaded && profile.scoredCount > 0 && (
                <DimensionProfileCard profile={profile} />
              )}

              {/* Targeting momentum — the only panel about the *direction* of
                  pipeline quality. Splits the window into an earlier vs later
                  half; needs at least two scored rows to split, and the card
                  falls back to a hint when the halves are too thin (or share
                  one date) for a verdict. */}
              {loaded && momentum.scoredCount >= 2 && (
                <TargetingMomentumCard momentum={momentum} />
              )}

              {/* Archetype mix — where the evaluation effort goes rather than
                  how good it is. Gated on at least two distinct archetypes so a
                  single-bucket corpus doesn't render a one-bar "mix". */}
              {loaded && archetypeMix.distinct >= 2 && (
                <ArchetypeMixCard mix={archetypeMix} />
              )}

              {/* Pipeline conversion — of everything you applied to, how far did
                  it get? Gated on at least one sent application so it never
                  shows an all-zero funnel. */}
              {loaded && funnel.sent > 0 && (
                <ConversionFunnelCard funnel={funnel} />
              )}

              {/* Top-X panels share the chart's time range so the cross-section
                  reads cleanly. */}
              {loaded && filtered.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                  <TopCompaniesCard items={topCompanies} />
                  <TopLocationsCard items={topLocations} />
                  <TopArchetypesCard items={topArchetypes} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Score trend — re-evaluation trajectories. The panel carries its own
            body padding. */}
        <div
          role="tabpanel"
          id={viewPanelId('trends', 'scoretrend')}
          aria-labelledby={viewTabId('trends', 'scoretrend')}
          hidden={tab !== 'scoretrend'}
        >
          {tab === 'scoretrend' && <ScoreTrendPanel />}
        </div>
      </div>
    </div>
  )
}

// ─── Score distribution card ─────────────────────────────────────────────────

function ScoreDistributionCard({ dist }: { dist: Distribution }) {
  const { bands, max, applyPct, total, scored, medianWant, medianEase, eligibility } = dist
  return (
    <Panel
      title="Verdict distribution"
      meta={<>
        <span className="text-accent-text font-medium">{applyPct}%</span> actionable
        {scored > 0 && ` · median Want ${medianWant.toFixed(1)} · Ease ${medianEase.toFixed(1)}`}
        {total > 0 && ` · ${eligibility.red} blocked · ${eligibility.amber} check first`}
      </>}
    >
      {/* Bars track — fixed height; bar heights cap at 88% of the track so the
          count label sitting above the tallest bar never clips. */}
      <div className="flex items-end gap-2.5" style={{ height: 132 }}>
        {bands.map(b => {
          const h = (b.count / max) * 88
          return (
            <div key={b.key} className="flex-1 flex flex-col justify-end items-center h-full">
              <span
                className="text-micro tabular-nums mb-1"
                style={{ color: b.count > 0 ? b.color : themeColor('text-4') }}
              >
                {b.count}
              </span>
              <div
                className="w-full rounded-t-sm"
                style={{
                  height: `${h}%`,
                  minHeight: b.count > 0 ? 3 : 0,
                  background: b.color,
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
            <div className="text-label text-text-2">{b.label}</div>
          </div>
        ))}
      </div>

      {/* Actionable bracket — spans the three actionable verdicts (the
          first 3 of 7 equal columns: Go / Stretch / Solid). The 3:4 flex split
          lines the accent rule up under those columns. */}
      <div className="flex gap-2.5 mt-1.5">
        <div className="flex-[3] flex items-center gap-1.5">
          <span className="h-px flex-1 bg-accent/30" />
          <span className="text-micro text-accent-text whitespace-nowrap">Actionable</span>
          <span className="h-px flex-1 bg-accent/30" />
        </div>
        <div className="flex-[4]" aria-hidden />
      </div>
    </Panel>
  )
}

// ─── Dimension profile card ──────────────────────────────────────────────────
//
// Each row is a scoring dimension. The grey track shows the full-corpus average
// (the baseline "what every role offers"); the violet inner bar shows the
// actionable subset's average for the same dimension. When the violet bar
// overshoots the grey one, that dimension *lifts* a role into actionable
// territory — a positive delta, in violet on the right. A negative delta
// (winners score lower here) reads in slate: it's a tradeoff the user accepts.
// Both bars are on the same 0–10 scale so the eye reads magnitude directly.

function DimensionProfileCard({ profile }: { profile: DimensionProfile }) {
  const { dims, scoredCount, winnerCount, lowSignal } = profile
  return (
    <Panel
      title="What drives your fit"
      meta={lowSignal
        ? `${scoredCount} scored · ranked by average`
        : <><span className="text-accent-text font-medium">{winnerCount}</span> actionable of {scoredCount}</>}
    >
      {/* Legend — names the two bars so the magnitudes are unambiguous. The
          delta column is only meaningful with enough winners, so its legend
          entry hides under the low-signal fallback. */}
      <div className="flex items-center gap-4 mb-3">
        <LegendDot color={themeColor('track')} label="All scored" />
        {!lowSignal && <LegendDot color={themeColor('accent')} label="Actionable (Go / Stretch / Solid)" />}
      </div>

      <ul className="flex flex-col gap-2.5">
        {dims.map(d => {
          const allPct     = Math.max(0, Math.min(d.avgAll, 10)) * 10
          const winnersPct = Math.max(0, Math.min(d.avgWinners, 10)) * 10
          // Below the winner floor the winners-bar is statistical noise — show
          // only the all-corpus track so we never imply a delta we can't trust.
          const showWinners = !lowSignal && winnerCount > 0
          return (
            <li key={String(d.field)}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-label text-text-1">{sentenceCase(d.label)}</span>
                <span className="flex items-baseline gap-2 text-label tabular-nums shrink-0">
                  <span className="text-text-3">{d.avgAll.toFixed(1)}</span>
                  {showWinners && <DeltaBadge delta={d.delta} />}
                </span>
              </div>
              {/* Track = all-scored average. Overlaid inner bar = actionable
                  average, drawn on the same 0–10 scale so the gap is the delta. */}
              <div className="relative h-2 rounded-pill bg-bg-elevated overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-pill"
                  style={{ width: `${allPct}%`, background: themeColor('track') }}
                />
                {showWinners && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-pill transition-[width] duration-200 ease-quart"
                    style={{
                      width: `${winnersPct}%`,
                      background: d.delta >= 0 ? themeColor('accent') : themeColor('tier-4'),
                    }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {lowSignal && (
        <p className="text-label text-text-3 mt-3">
          Evaluate a few more actionable roles (Go / Stretch / Solid) to compare what separates a strong fit from the rest.
        </p>
      )}
    </Panel>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-label text-text-3">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} aria-hidden />
      {label}
    </span>
  )
}

// Signed delta — violet for "this dimension lifts a role into actionable
// territory", slate for "winners are weaker here (a tradeoff)". Near-zero
// deltas read as flat so they don't masquerade as a signal.
function DeltaBadge({ delta }: { delta: number }) {
  const flat = Math.abs(delta) < 0.05
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  const color = flat ? themeColor('text-4') : delta > 0 ? themeColor('accent-text') : themeColor('text-3')
  return (
    <span
      className="text-micro font-medium tabular-nums"
      style={{ color }}
      title="Actionable (Go / Stretch / Solid) average minus the full-corpus average for this dimension"
    >
      {flat ? '±0.0' : `${sign}${Math.abs(delta).toFixed(1)}`}
    </span>
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

// ─── Archetype mix card ──────────────────────────────────────────────────────
//
// Each row is a canonical archetype, ordered by how much of the corpus it
// accounts for (biggest focus on top). The bar is share-of-attention; the right
// rail carries the archetype's avg Want · Ease (score-ladder coloured, so "lots of
// attention on a low-scoring bucket" reads as a warning) and — when the window
// has two trustworthy halves — a signed share shift showing whether that
// archetype is taking a growing or shrinking slice of recent attention.
//
// Bars use the categorical chart palette (DESIGN-meta § Charts), NOT the score
// ladder: an archetype is a category, not a quality, so colour here means
// "which bucket", never "how good". The Want · Ease pair is the only place the
// score colour belongs.

function ArchetypeMixCard({ mix }: { mix: ArchetypeMix }) {
  const { slices, scoredCount, distinct, concentration, lowSignal } = mix
  // Cap the visible list so a long tail of one-off archetypes doesn't dominate;
  // roll the remainder into a single muted "+N more" footer line.
  const VISIBLE = 7
  const shown = slices.slice(0, VISIBLE)
  const rest = slices.slice(VISIBLE)
  const restCount = rest.reduce((s, x) => s + x.count, 0)
  const maxShare = shown.length ? Math.max(...shown.map(s => s.sharePct)) : 0

  // One-word read on how concentrated the search is. Herfindahl thresholds:
  // ≥0.5 = one or two buckets dominate; ≤0.25 = spread thin across many.
  const focus = concentration >= 0.5 ? 'Focused'
    : concentration <= 0.25 ? 'Scattered'
    : 'Balanced'

  return (
    <Panel
      title="Archetype mix"
      meta={<>
        <span className="text-accent-text font-medium">{focus}</span> · {distinct} archetypes · {scoredCount} scored
      </>}
    >
      {/* Column headings for the right rail. */}
      <div className="flex items-baseline justify-between gap-2 mb-2 text-micro text-text-4">
        <span>Archetype</span>
        <span className="flex items-baseline gap-2 shrink-0">
          {!lowSignal && (
            <span className="w-8 text-right" title="Later-half minus earlier-half share of attention (percentage points)">Shift</span>
          )}
          <span className="w-20 text-right" title="Average Want · Ease for this archetype">Want · Ease</span>
          <span className="w-9 text-right" title="Share of scored evaluations">Share</span>
          <span className="w-6 text-right" title="Scored evaluations">n</span>
        </span>
      </div>

      <ul className="flex flex-col gap-2.5">
        {shown.map((s, i) => {
          const color = DIM_COLORS[i % DIM_COLORS.length]
          const barPct = maxShare ? (s.sharePct / maxShare) * 100 : 0
          return (
            <li key={s.label}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: color }} aria-hidden />
                  <span className="text-label text-text-1 truncate">{s.label}</span>
                </span>
                <span className="flex items-baseline gap-2 text-label tabular-nums shrink-0">
                  {!lowSignal && (
                    <span className="w-8 text-right"><ShareShiftBadge shift={s.shareShift} /></span>
                  )}
                  <span className="w-20 text-right">
                    <WantEase want={s.avgWant} ease={s.avgEase} size="sm" bare />
                  </span>
                  <span className="text-text-3 w-9 text-right">{s.sharePct}%</span>
                  <span className="text-text-4 w-6 text-right">{s.count}</span>
                </span>
              </div>
              {/* Bar length is share-of-attention (scaled to the busiest bucket
                  so the leader fills the track); colour is the categorical hue. */}
              <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                <div
                  className="h-full rounded-pill transition-[width] duration-200 ease-quart"
                  style={{ width: `${barPct}%`, background: color }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      {/* Tail rollup, or what the shift column means. */}
      <p className="mt-3 pt-2 border-t border-border-default text-micro text-text-4">
        {restCount > 0
          ? <>+{rest.length} more archetype{rest.length === 1 ? '' : 's'} · {restCount} eval{restCount === 1 ? '' : 's'}</>
          : lowSignal
            ? 'Shift hidden: too few evaluations on each side of the timeline yet'
            : 'Shift is the later minus earlier share of attention'}
      </p>
    </Panel>
  )
}

// Signed share-of-attention shift for an archetype, in percentage points
// (later half minus earlier half). Violet when an archetype is gaining focus,
// slate when it's fading; near-zero reads as flat so a stable bucket doesn't
// masquerade as a mover. Mirrors DeltaBadge so the two cards rhyme.
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
  const blocked = payload[0]?.payload?.blocked
  return (
    <div className="card shadow-menu rounded-lg px-3 py-2 min-w-[150px] text-label">
      <div className="flex items-baseline justify-between gap-4 mb-1.5">
        <span className="font-medium text-text-1">{label}</span>
        {typeof count === 'number' && (
          <span className="text-text-4 tabular-nums">
            n={count}{typeof blocked === 'number' && blocked > 0 && ` · ${blocked} blocked`}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {payload.map(p => {
          const key = String(p.dataKey ?? '')
          return (
            <li key={key} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color ?? DIM_COLOR_BY_KEY[key] }} aria-hidden />
              <span className="text-text-3 flex-1">{DIM_LABEL_BY_KEY[key] ?? key}</span>
              <span className="tabular-nums text-text-1 font-medium">
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

// ─── Top-X panels ────────────────────────────────────────────────────────────

// Each card names its two right-hand columns in the heading meta so the
// numbers read without hovering.
const TOP_META = <span title="Average Want · Ease · number of scored evaluations">Want · Ease · count</span>

function TopCompaniesCard({ items }: { items: TopRow[] }) {
  return (
    <Panel title="Top companies" meta={TOP_META}>
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default">
          {items.map(({ label, count, avgWant, avgEase }) => (
            <li key={label} className="h-9 flex items-center gap-2.5">
              <CompanyLogo company={label} size={20} className="shrink-0" />
              <span className="flex-1 min-w-0 text-body text-text-1 truncate">{label}</span>
              <WantEase want={avgWant} ease={avgEase} size="sm" bare className="shrink-0" />
              <span className="w-6 shrink-0 text-right text-label tabular-nums text-text-4">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function TopLocationsCard({ items }: { items: TopRow[] }) {
  return (
    <Panel title="Top locations" meta={TOP_META}>
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default">
          {items.map(({ label, count, avgWant, avgEase }) => {
            const flag = locationFlag(label)
            return (
              <li key={label} className="h-9 flex items-center gap-2.5">
                <span className="w-5 shrink-0 flex items-center justify-center text-section leading-none" aria-hidden>
                  {flag ?? <Globe size={13} className="text-text-4" />}
                </span>
                <span className="flex-1 min-w-0 text-body text-text-1 truncate">{label}</span>
                <WantEase want={avgWant} ease={avgEase} size="sm" bare className="shrink-0" />
                <span className="w-6 shrink-0 text-right text-label tabular-nums text-text-4">{count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function TopArchetypesCard({ items }: { items: TopRow[] }) {
  // Bar length = mean Priority (the ranking key); the numbers shown are the
  // Want · Ease pair, never Priority itself.
  const max = items.length ? Math.max(...items.map(i => i.avgPriority)) : 0
  return (
    <Panel title="Top archetypes" meta={TOP_META}>
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="flex flex-col gap-2.5">
          {items.map(({ label, count, avgWant, avgEase, avgPriority }) => {
            const pct = max ? (avgPriority / max) * 100 : 0
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-body text-text-1 truncate">{label}</span>
                  <span className="flex items-baseline gap-2 shrink-0">
                    <WantEase want={avgWant} ease={avgEase} size="sm" bare />
                    <span className="w-6 text-right text-label tabular-nums text-text-4">{count}</span>
                  </span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                  <div
                    className="h-full rounded-pill transition-[width] duration-200 ease-quart"
                    style={{ width: `${pct}%`, background: scoreColor(avgWant) }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function EmptyHint() {
  return <p className="text-label text-text-4 py-4 text-center">No data</p>
}
