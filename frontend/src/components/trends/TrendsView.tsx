'use client'

import { useEffect, useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { useAppStore } from '@/store/app'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { canonicalizeArchetype } from '@/lib/archetype'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { EmptyState } from '@/components/shared/EmptyState'
import { ViewTabs, viewPanelId, viewTabId, type ViewTab } from '@/components/shared/ViewTabs'
import { ScoreTrendPanel } from '@/components/scoretrend/ScoreTrendView'
import { scoreColor as galaxyScoreColor } from '@/lib/tier'
import { analyzeScoreTrend } from '@/lib/scoreTrend'
import {
  type TimeRange, type DateBucket, type TopRow, type Distribution, type Funnel,
  type DimensionProfile, type TargetingMomentum, type MomentumDirection,
  type ArchetypeMix,
  TIME_RANGE_LABEL, filterByDateWindow,
  avg, buildByDate, buildTopBy, buildDistribution, buildFunnel,
  buildDimensionProfile, buildTargetingMomentum, buildArchetypeMix,
  APPLY_THRESHOLD, locationFlag,
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

// Sub-tabs under the title bar: the landscape analytics (Overview) and the
// re-evaluation trajectory panel (Score Trend, absorbed from the retired
// standalone scoretrend view). 'scoretrend' doubles as the deep-link key —
// navigate('trends', '', '', 'scoretrend') lands on that tab via the nav
// store's one-shot viewTab request.
type TrendsTab = 'overview' | 'scoretrend'

const TRENDS_TABS: ReadonlyArray<ViewTab<TrendsTab>> = [
  { key: 'overview',   label: 'Overview'    },
  { key: 'scoretrend', label: 'Score Trend' },
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
    return {
      total:      filtered.length,
      avgOverall: avg(filtered, 'overall').toFixed(2),
      avgCF:      avg(filtered, 'current_fit').toFixed(2),
      avgAF:      avg(filtered, 'aspirational_fit').toFixed(2),
    }
  }, [filtered])

  const distribution = useMemo(() => buildDistribution(filtered), [filtered])

  // Dimension profile — averages each scoring dimension across the corpus and,
  // crucially, contrasts the apply-worthy subset (overall >= 7) against all
  // scored rows so the user can see which dimensions actually *drive* a high
  // score vs which are flat noise for targeting. Pure derivation in lib/.
  const profile = useMemo(() => buildDimensionProfile(filtered), [filtered])

  // Targeting momentum — splits the windowed corpus chronologically into an
  // earlier vs recent half and contrasts their quality (median overall, apply
  // rate, per-dimension means). Answers "is the stuff I evaluate getting
  // better-fit over time?" — the trend *direction* the noisy daily line and the
  // static snapshots above can't show. Pure derivation in lib/; honest about
  // small samples (forces a "steady" verdict + a hint under the per-half floor).
  const momentum = useMemo(() => buildTargetingMomentum(filtered), [filtered])

  // Archetype mix — the only panel about the *composition* of the corpus rather
  // than its quality. Buckets every scored row by canonical archetype to show
  // where evaluation effort is going (share of attention + a concentration cue),
  // and contrasts the earlier vs recent half so a drift in focus reads as a
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Title bar — the meta caption and the time-range control follow the
          active tab: the range only filters the Overview analytics (Score
          Trend always reads the full history), so it renders only there. */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Trends</h1>
        {tab === 'overview' && stats && (
          <span className="text-label text-text-4 font-mono">{stats.total} evaluations</span>
        )}
        {tab === 'scoretrend' && loaded && scoreTrendMeta && !scoreTrendMeta.error && (
          <span className="text-label text-text-4 font-mono">
            {scoreTrendMeta.metadata?.evaluated ?? 0} evaluations · {scoreTrendMeta.trajectorySummary?.reevaluated ?? 0} re-evaluated
          </span>
        )}
        <div className="flex-1" />
        {tab === 'overview' && (
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
      </div>

      {/* With Score Trend deactivated only Overview remains — a one-tab strip
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
      <div className="flex-1 overflow-y-auto">
        <div
          role="tabpanel"
          id={viewPanelId('trends', 'overview')}
          aria-labelledby={viewTabId('trends', 'overview')}
          hidden={tab !== 'overview'}
          className="p-4 space-y-4"
        >
          {tab === 'overview' && (
            <>
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

              {/* Dimension profile — the only panel that explains *why* a role
                  scores well for this user. Ranks the seven scoring dimensions by
                  how much they separate an apply-worthy role (overall ≥ 7) from the
                  full corpus, turning the raw score columns into a targeting
                  cheat-sheet: chase roles strong on the high-delta dimensions. */}
              {loaded && profile.scoredCount > 0 && (
                <DimensionProfileCard profile={profile} />
              )}

              {/* Targeting momentum — the only panel about the *direction* of pipeline
                  quality. Splits the window into an earlier vs recent half and asks
                  whether the roles you evaluate are getting better-fit as you refine
                  targeting. Needs at least two scored rows to split; the card itself
                  falls back to a hint when either half is too thin for a verdict. */}
              {loaded && momentum.scoredCount >= 2 && (
                <TargetingMomentumCard momentum={momentum} />
              )}

              {/* Archetype mix — the only panel about *where the evaluation effort
                  goes* rather than how good it is. Share-of-attention per canonical
                  archetype, a concentration cue (focused vs scattered), and — when the
                  window has two real halves — how that allocation drifted earlier→
                  recent. Gated on at least two distinct archetypes so a single-bucket
                  corpus (nothing to compose) doesn't render a one-bar "mix". */}
              {loaded && archetypeMix.distinct >= 2 && (
                <ArchetypeMixCard mix={archetypeMix} />
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
            </>
          )}
        </div>

        {/* Score Trend — re-evaluation trajectories, absorbed from the retired
            standalone view. The panel carries its own p-4 body padding. */}
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

// ─── Dimension profile card ──────────────────────────────────────────────────
//
// Each row is a scoring dimension. The grey track shows the full-corpus average
// (the baseline "what every role offers"); the violet inner bar shows the
// apply-worthy subset's average for the same dimension. When the violet bar
// overshoots the grey one, that dimension *lifts* a role into apply-worthy
// territory — a positive delta, badged in violet on the right. A negative delta
// (winners score lower here) badges in slate: it's a tradeoff the user accepts.
// Both bars are on the same 0–10 scale so the eye reads magnitude directly.

function DimensionProfileCard({ profile }: { profile: DimensionProfile }) {
  const { dims, scoredCount, winnerCount, lowSignal } = profile
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-1 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">What drives your fit</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          {lowSignal
            ? <span>{scoredCount} scored · ranked by average</span>
            : <><span className="text-accent-text font-semibold">{winnerCount}</span><span> apply-worthy of {scoredCount}</span></>}
        </span>
      </div>

      {/* Legend — names the two bars so the magnitudes are unambiguous. The
          delta column is only meaningful with enough winners, so its legend
          entry hides under the low-signal fallback. */}
      <div className="flex items-center gap-3.5 mb-3 mt-2">
        <LegendDot color="#CED0D4" label="All scored" />
        {!lowSignal && <LegendDot color="#7C5CFF" label={`Apply-worthy (≥${APPLY_THRESHOLD.toFixed(0)})`} />}
      </div>

      <ul className="space-y-2.5">
        {dims.map(d => {
          const allPct     = Math.max(0, Math.min(d.avgAll, 10)) * 10
          const winnersPct = Math.max(0, Math.min(d.avgWinners, 10)) * 10
          // Below the winner floor the winners-bar is statistical noise — show
          // only the all-corpus track so we never imply a delta we can't trust.
          const showWinners = !lowSignal && winnerCount > 0
          return (
            <li key={String(d.field)}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[12px] text-text-1">{d.label}</span>
                <span className="flex items-baseline gap-2 text-[11px] font-mono tabular-nums shrink-0">
                  <span className="text-text-3">{d.avgAll.toFixed(1)}</span>
                  {showWinners && <DeltaBadge delta={d.delta} />}
                </span>
              </div>
              {/* Track = all-scored average. Overlaid inner bar = apply-worthy
                  average, drawn on the same 0–10 scale so the gap is the delta. */}
              <div className="relative h-2 rounded-pill bg-bg-elevated overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-pill"
                  style={{ width: `${allPct}%`, background: '#CED0D4' }}
                />
                {showWinners && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-pill"
                    style={{
                      width: `${winnersPct}%`,
                      background: d.delta >= 0
                        ? 'linear-gradient(90deg, #7C5CFF 0%, #5B3FE8 100%)'
                        : 'linear-gradient(90deg, #A89CD9 0%, #94A3B8 100%)',
                      transition: 'width 320ms ease',
                    }}
                  />
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {lowSignal && (
        <p className="text-[10.5px] text-text-4 mt-3 leading-snug">
          Evaluate a few more apply-worthy roles to compare what separates a strong fit from the rest.
        </p>
      )}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[10.5px] text-text-4">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {label}
    </span>
  )
}

// Signed delta badge — violet for "this dimension lifts a role into apply-
// worthy territory", slate for "winners are weaker here (a tradeoff)". Near-
// zero deltas read as flat so they don't masquerade as a signal.
function DeltaBadge({ delta }: { delta: number }) {
  const flat = Math.abs(delta) < 0.05
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'
  const color = flat ? '#8595A4' : delta > 0 ? '#7C5CFF' : '#5D6C7B'
  return (
    <span
      className="inline-flex items-center rounded-pill px-1.5 py-px text-[10px] font-semibold tabular-nums"
      style={{ color, background: flat ? 'transparent' : `${color}1f` }}
      title="Apply-worthy average minus the full-corpus average for this dimension"
    >
      {flat ? '±0.0' : `${sign}${Math.abs(delta).toFixed(1)}`}
    </span>
  )
}

// ─── Targeting momentum card ─────────────────────────────────────────────────
//
// Two stat blocks (earlier half · recent half) sit either side of a verdict
// pill, so the headline reads at a glance: "median 6.2 → 7.4, improving". The
// verdict uses the SEMANTIC scale (success / danger / muted) because "is my
// targeting getting better or worse" is a state, not a categorical series —
// green = improving, red = declining, slate = steady/flat. Below the stats, a
// compact strip shows the dimensions that moved most between the two halves so
// the user can see *where* the shift came from (e.g. "Skills Match climbed,
// Brand Value slipped"). Under the per-half floor the whole verdict layer
// collapses to a single honest hint instead of asserting a trend on noise.

// Verdict vocabulary, keyed to the semantic palette (DESIGN-meta § Status scale).
// `arrow` is the glyph in the pill; `color` drives pill text/tint and the recent-
// median figure. Steady is intentionally muted text-4 so a flat trend recedes.
const MOMENTUM_VERDICT: Record<MomentumDirection, { label: string; arrow: string; color: string }> = {
  improving: { label: 'Improving', arrow: '↑', color: '#007D1E' },   // success green
  declining: { label: 'Declining', arrow: '↓', color: '#C80A28' },   // danger red
  steady:    { label: 'Steady',    arrow: '→', color: '#8595A4' },   // muted slate
}

function TargetingMomentumCard({ momentum }: { momentum: TargetingMomentum }) {
  const { earlier, recent, medianDelta, applyPctDelta, direction, dimShifts, lowSignal } = momentum
  const verdict = MOMENTUM_VERDICT[direction]
  // Lead with the dimensions that actually moved; a flat-everything corpus
  // shows nothing here rather than a row of ±0.0 badges.
  const movers = lowSignal ? [] : dimShifts.filter(s => Math.abs(s.delta) >= 0.05).slice(0, 3)

  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">Targeting Momentum</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          {lowSignal
            ? <span>recent vs earlier · {momentum.scoredCount} scored</span>
            : <span>{earlier.count} earlier · {recent.count} recent</span>}
        </span>
      </div>

      {lowSignal ? (
        <p className="text-[11px] text-text-4 leading-snug py-1">
          Not enough scored evaluations on each side of the timeline to read a trend yet.
          Evaluate a few more and this will show whether your recent picks are scoring higher than your earlier ones.
        </p>
      ) : (
        <>
          {/* Earlier → verdict → recent. The two halves use the same metric
              rows; the centre pill carries the direction. */}
          <div className="flex items-stretch gap-3">
            <HalfBlock title="Earlier" median={earlier.medianOverall} applyPct={earlier.applyPct} from={earlier.dateFrom} to={earlier.dateTo} muted />
            <div className="flex flex-col items-center justify-center gap-1.5 shrink-0 px-1">
              <span
                className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: verdict.color, background: `${verdict.color}1f` }}
              >
                <span aria-hidden>{verdict.arrow}</span>{verdict.label}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-text-4">
                {medianDelta > 0 ? '+' : medianDelta < 0 ? '−' : '±'}{Math.abs(medianDelta).toFixed(1)} median
              </span>
            </div>
            <HalfBlock title="Recent" median={recent.medianOverall} applyPct={recent.applyPct} from={recent.dateFrom} to={recent.dateTo} accent={verdict.color} />
          </div>

          {/* Apply-rate movement — the share clearing the 7.0 bar, earlier→recent. */}
          <div className="flex items-baseline justify-between gap-3 mt-3 pt-2.5 border-t border-border-default/60 text-[11px]">
            <span className="text-text-3">Apply-worthy share (≥{APPLY_THRESHOLD.toFixed(0)})</span>
            <span className="font-mono tabular-nums">
              <span className="text-text-4">{earlier.applyPct}%</span>
              <span className="text-text-4 px-1">→</span>
              <span className="text-text-2 font-semibold">{recent.applyPct}%</span>
              {applyPctDelta !== 0 && (
                <span className="ml-1.5" style={{ color: applyPctDelta > 0 ? '#007D1E' : '#C80A28' }}>
                  ({applyPctDelta > 0 ? '+' : '−'}{Math.abs(applyPctDelta)}pt)
                </span>
              )}
            </span>
          </div>

          {/* Biggest dimension movers between the halves — where the shift came
              from. Hidden entirely when nothing moved meaningfully. */}
          {movers.length > 0 && (
            <div className="mt-2.5">
              <div className="text-[10px] text-text-4 uppercase tracking-[0.06em] mb-1.5">Biggest shifts</div>
              <ul className="flex flex-wrap gap-1.5">
                {movers.map(s => (
                  <li
                    key={String(s.field)}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border-default/70 bg-bg-elevated px-2 py-0.5 text-[11px]"
                  >
                    <span className="text-text-2">{s.label}</span>
                    <span
                      className="font-mono tabular-nums font-semibold"
                      style={{ color: s.delta > 0 ? '#7C5CFF' : '#5D6C7B' }}
                    >
                      {s.delta > 0 ? '+' : '−'}{Math.abs(s.delta).toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// One half of the momentum comparison: median overall (the headline figure) with
// the apply-worthy share and the date span beneath. The recent block tints its
// median to the verdict colour; the earlier block stays muted so the eye reads
// left→right as "from → to".
function HalfBlock({
  title, median, applyPct, from, to, muted, accent,
}: {
  title: string; median: number; applyPct: number; from: string; to: string
  muted?: boolean; accent?: string
}) {
  const span = from && to ? (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`) : '—'
  return (
    <div className="flex-1 min-w-0 rounded-md border border-border-default/70 bg-bg-elevated/60 px-3 py-2.5">
      <div className="text-[10px] text-text-4 uppercase tracking-[0.06em] mb-1">{title}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-[22px] leading-none font-mono tabular-nums font-semibold"
          style={{ color: muted ? '#5D6C7B' : (accent ?? '#050505') }}
        >
          {median.toFixed(1)}
        </span>
        <span className="text-[10px] text-text-4">median</span>
      </div>
      <div className="text-[10.5px] font-mono tabular-nums text-text-4 mt-1.5 truncate" title={span}>{span}</div>
    </div>
  )
}

// "2026-06-25" → "Jun 25". Score-history dates are always YYYY-MM-DD ISO, so a
// UTC parse is exact and TZ-stable (no local-midnight drift).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}` : iso
}

// ─── Archetype mix card ──────────────────────────────────────────────────────
//
// Each row is a canonical archetype, ordered by how much of the corpus it
// accounts for (biggest focus on top). The bar is share-of-attention; the right
// rail carries the archetype's avg fit (galaxy-tier coloured, so the eye reads
// "lots of attention on a low-scoring bucket" as a warning) and — when the
// window has two trustworthy halves — a signed share-shift badge showing whether
// that archetype is taking a growing or shrinking slice of recent attention.
//
// Bars use the categorical chart palette (DESIGN-meta § chart-1…chart-7), NOT
// the score-tier scale: an archetype is a category, not a quality, so colour
// here means "which bucket", never "how good". The avg-fit figure on the right
// is the only place tier colour belongs.

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
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">Archetype Mix</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">
          <span className="text-accent-text font-semibold">{focus}</span>
          <span> · {distinct} archetypes · {scoredCount} scored</span>
        </span>
      </div>

      <ul className="space-y-2.5">
        {shown.map((s, i) => {
          const color = DIM_COLORS[i % DIM_COLORS.length]
          const barPct = maxShare ? (s.sharePct / maxShare) * 100 : 0
          return (
            <li key={s.label}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="flex items-baseline gap-1.5 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: color }} />
                  <span className="text-[12px] text-text-1 truncate">{s.label}</span>
                </span>
                <span className="flex items-baseline gap-2 text-[11px] font-mono tabular-nums shrink-0">
                  {!lowSignal && <ShareShiftBadge shift={s.shareShift} />}
                  <span
                    className="font-semibold w-8 text-right"
                    style={{ color: scoreTierColor(s.avgScore) }}
                    title="Average overall fit for this archetype"
                  >
                    {s.avgScore.toFixed(1)}
                  </span>
                  <span className="text-text-3 w-9 text-right">{s.sharePct}%</span>
                  <span className="text-text-4 w-5 text-right">{s.count}</span>
                </span>
              </div>
              {/* Bar length is share-of-attention (scaled to the busiest bucket
                  so the leader fills the track); colour is the categorical hue. */}
              <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                <div
                  className="h-full rounded-pill"
                  style={{ width: `${barPct}%`, background: color, transition: 'width 320ms ease' }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      {/* Column legend + tail rollup. The right-rail numbers are unlabelled in
          the rows (space), so name them once here. */}
      <div className="flex items-baseline justify-between gap-3 mt-3 pt-2 border-t border-border-default/60 text-[10px] text-text-4">
        <span>
          {restCount > 0
            ? <>+{rest.length} more archetype{rest.length === 1 ? '' : 's'} · {restCount} eval{restCount === 1 ? '' : 's'}</>
            : lowSignal
              ? <span>Shift hidden — too few on each side of the timeline yet</span>
              : <span>Shift = recent vs earlier share of attention</span>}
        </span>
        <span className="font-mono uppercase tracking-[0.06em] shrink-0">
          {!lowSignal && 'Δ · '}AVG · SHARE · N
        </span>
      </div>
    </div>
  )
}

// Signed share-of-attention shift for an archetype, in percentage points
// (recent half minus earlier half). Violet when an archetype is gaining focus,
// slate when it's fading; near-zero reads as flat so a stable bucket doesn't
// masquerade as a mover. Mirrors DeltaBadge's vocabulary so the two cards rhyme.
function ShareShiftBadge({ shift }: { shift: number }) {
  const flat = Math.abs(shift) < 1            // sub-1pt is rounding noise, not a drift
  const sign = shift > 0 ? '+' : shift < 0 ? '−' : '±'
  const color = flat ? '#8595A4' : shift > 0 ? '#7C5CFF' : '#5D6C7B'
  return (
    <span
      className="inline-flex items-center rounded-pill px-1.5 py-px text-[10px] font-semibold tabular-nums"
      style={{ color, background: flat ? 'transparent' : `${color}1f` }}
      title="Recent-half minus earlier-half share of attention (percentage points)"
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
