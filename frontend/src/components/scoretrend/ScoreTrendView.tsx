'use client'

import { useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { CompanyLink } from '@/components/shared/CompanyLink'
import { EmptyState } from '@/components/shared/EmptyState'
import { scoreColor } from '@/lib/tier'
import {
  analyzeScoreTrend,
  type Trajectory, type LandscapeTrend, type TrajectorySummary,
  type TrendRecommendation, type Verdict, type Band,
} from '@/lib/scoreTrend'

// Verdict vocabulary, keyed to the semantic palette (DESIGN-meta § Status
// scale) — same hexes TrendsView's momentum card uses, so "improving /
// declining / steady" reads identically across the two analytics surfaces.
const VERDICT_META: Record<Verdict, { label: string; arrow: string; color: string }> = {
  improving: { label: 'Improving', arrow: '↑', color: '#007D1E' }, // success green
  declining: { label: 'Declining', arrow: '↓', color: '#C80A28' }, // danger red
  stable:    { label: 'Stable',    arrow: '→', color: '#8595A4' }, // muted slate
  unknown:   { label: 'Unknown',   arrow: '·', color: '#8595A4' },
}

// Band → short label, used in the band-transition chip.
const BAND_LABEL: Record<Band, string> = {
  strong: 'strong', solid: 'solid', pass: 'pass', weak: 'weak', unknown: '—',
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0')

export function ScoreTrendView() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)

  // The whole view derives from one analysis pass over the score history
  // already in the store — no IPC, no shelling out to score-trend.mjs. Mirrors
  // how TrendsView computes everything client-side from the same source.
  const analysis = useMemo(() => analyzeScoreTrend(scoreHistory), [scoreHistory])

  const reevaluated = analysis.trajectorySummary?.reevaluated ?? 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Score Trend</h1>
        {loaded && !analysis.error && (
          <span className="text-label text-text-4 font-mono">
            {analysis.metadata?.evaluated ?? 0} evaluations · {reevaluated} re-evaluated
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {!loaded ? (
          <div className="space-y-4">
            <div className="h-40 shimmer rounded-lg" />
            <div className="h-32 shimmer rounded-lg" />
          </div>
        ) : analysis.error ? (
          <div className="flex items-center justify-center h-64 rounded-lg border border-border-default bg-bg-panel/40">
            <EmptyState
              title="No score history yet"
              hint="Run a Filter to Database scan, then evaluate a few listings. This view tracks how their scores move when you re-evaluate them."
            />
          </div>
        ) : (
          <>
            {/* Recommendations first — the act-now layer, like the Trends and
                Today cockpits lead with "moves" before the evidence. */}
            {analysis.recommendations && analysis.recommendations.length > 0 && (
              <MovesCard recs={analysis.recommendations} />
            )}

            {/* Landscape trend — is targeting sharpening over calendar time? */}
            {analysis.landscapeTrend && (
              <LandscapeTrendCard trend={analysis.landscapeTrend} />
            )}

            {/* Re-evaluated listing roll-up + the per-listing movers. */}
            {analysis.trajectorySummary && reevaluated > 0 ? (
              <>
                <ReevalSummaryCard summary={analysis.trajectorySummary} />
                <TrajectoryListCard trajectories={analysis.listingTrajectories ?? []} />
              </>
            ) : (
              <NoReevalCard />
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Moves (recommendations) ─────────────────────────────────────────────────

const IMPACT_COLOR: Record<TrendRecommendation['impact'], string> = {
  high:   '#C80A28', // danger red — re-check now
  medium: '#7C5CFF', // galaxy violet
  low:    '#8595A4', // slate
}

function MovesCard({ recs }: { recs: TrendRecommendation[] }) {
  return (
    <div className="galaxy-bg border border-border-default rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3 pb-2 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">Moves</span>
        <span className="text-[11px] font-mono tabular-nums text-text-4">{recs.length} flagged</span>
      </div>
      <ul className="space-y-2.5">
        {recs.map((r, i) => (
          <li key={i} className="flex gap-2.5">
            <span
              className="mt-0.5 shrink-0 inline-flex items-center rounded-pill px-1.5 py-px text-[9px] uppercase tracking-[0.06em] font-semibold"
              style={{ color: IMPACT_COLOR[r.impact], background: `${IMPACT_COLOR[r.impact]}1f` }}
            >
              {r.impact}
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] text-text-1 leading-snug">{r.action}</p>
              <p className="text-[11px] text-text-4 leading-snug mt-0.5">{r.reasoning}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── Landscape trend ─────────────────────────────────────────────────────────

function LandscapeTrendCard({ trend }: { trend: LandscapeTrend }) {
  if (trend.insufficientData) {
    return (
      <div className="bg-bg-panel border border-border-default rounded-lg p-4">
        <CardHeader title="Landscape Trend" right="earlier vs recent" />
        <p className="text-[11px] text-text-4 leading-snug py-1">
          {trend.reason} Once you have enough evaluations across distinct dates, this
          shows whether the roles you score lately are stronger than your earlier ones.
        </p>
      </div>
    )
  }

  const v = VERDICT_META[trend.verdict]
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <CardHeader
        title="Landscape Trend"
        right={`${trend.older.count} earlier · ${trend.recent.count} recent`}
      />
      <div className="flex items-stretch gap-3 mt-2">
        <WindowBlock
          title="Earlier"
          avg={trend.older.avgOverall}
          share={trend.older.strongSolidShare}
          from={trend.older.dateRange.from}
          to={trend.older.dateRange.to}
          muted
        />
        <div className="flex flex-col items-center justify-center gap-1.5 shrink-0 px-1">
          <span
            className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-semibold"
            style={{ color: v.color, background: `${v.color}1f` }}
          >
            <span aria-hidden>{v.arrow}</span>{v.label}
          </span>
          <span className="text-[10px] font-mono tabular-nums text-text-4">
            {signed(trend.delta)} avg
          </span>
        </div>
        <WindowBlock
          title="Recent"
          avg={trend.recent.avgOverall}
          share={trend.recent.strongSolidShare}
          from={trend.recent.dateRange.from}
          to={trend.recent.dateRange.to}
          accent={v.color}
        />
      </div>

      {/* Strong/solid share movement — the cleanest "am I sourcing better
          roles?" number. */}
      <div className="flex items-baseline justify-between gap-3 mt-3 pt-2.5 border-t border-border-default/60 text-[11px]">
        <span className="text-text-3">Strong/solid share</span>
        <span className="font-mono tabular-nums">
          <span className="text-text-4">{trend.older.strongSolidShare}%</span>
          <span className="text-text-4 px-1">→</span>
          <span className="text-text-2 font-semibold">{trend.recent.strongSolidShare}%</span>
          {trend.strongSolidShareDelta !== 0 && (
            <span
              className="ml-1.5"
              style={{ color: trend.strongSolidShareDelta > 0 ? '#007D1E' : '#C80A28' }}
            >
              ({trend.strongSolidShareDelta > 0 ? '+' : '−'}{Math.abs(trend.strongSolidShareDelta)}pt)
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

function WindowBlock({
  title, avg, share, from, to, muted, accent,
}: {
  title: string; avg: number; share: number; from: string; to: string
  muted?: boolean; accent?: string
}) {
  const span = from && to ? (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`) : '—'
  return (
    <div className="flex-1 min-w-0 rounded-md border border-border-default/70 bg-bg-elevated/60 px-3 py-2.5">
      <div className="text-[10px] text-text-4 uppercase tracking-[0.06em] mb-1">{title}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          className="text-[22px] leading-none font-mono tabular-nums font-semibold"
          style={{ color: muted ? '#5D6C7B' : (accent ?? scoreColor(avg)) }}
        >
          {avg.toFixed(1)}
        </span>
        <span className="text-[10px] text-text-4">avg</span>
      </div>
      <div className="text-[10.5px] font-mono tabular-nums text-text-4 mt-1.5 truncate" title={span}>{span}</div>
    </div>
  )
}

// ─── Re-evaluated summary ────────────────────────────────────────────────────

function ReevalSummaryCard({ summary }: { summary: TrajectorySummary }) {
  const { verdicts, avgDelta, bandUpgrades, bandDowngrades } = summary
  const cells: Array<{ label: string; value: string; color: string }> = [
    { label: 'Improving',  value: String(verdicts.improving), color: '#007D1E' },
    { label: 'Declining',  value: String(verdicts.declining), color: '#C80A28' },
    { label: 'Stable',     value: String(verdicts.stable),    color: '#5D6C7B' },
    { label: 'Avg move',   value: signed(avgDelta),           color: avgDelta > 0 ? '#007D1E' : avgDelta < 0 ? '#C80A28' : '#5D6C7B' },
  ]
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <CardHeader
        title="Re-evaluated Listings"
        right={`${bandUpgrades} band upgrade${bandUpgrades === 1 ? '' : 's'} · ${bandDowngrades} downgrade${bandDowngrades === 1 ? '' : 's'}`}
      />
      <div className="grid grid-cols-4 gap-3 mt-2">
        {cells.map(c => (
          <div key={c.label} className="rounded-md border border-border-default/70 bg-bg-elevated/60 px-3 py-2.5">
            <div className="text-[10px] text-text-4 uppercase tracking-[0.06em] mb-1">{c.label}</div>
            <div className="text-[20px] leading-none font-mono tabular-nums font-semibold" style={{ color: c.color }}>
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Trajectory list (biggest movers) ────────────────────────────────────────

function TrajectoryListCard({ trajectories }: { trajectories: Trajectory[] }) {
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <CardHeader title="Biggest Movers" right="first → latest" />
      <ul className="divide-y divide-border-default/40 mt-1">
        {trajectories.map(t => <TrajectoryRow key={t.key} t={t} />)}
      </ul>
    </div>
  )
}

function TrajectoryRow({ t }: { t: Trajectory }) {
  const v = VERDICT_META[t.verdict]
  return (
    <li className="flex items-center gap-3 py-2.5">
      <CompanyLink company={t.company} size={22} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] text-text-1 font-medium truncate">{t.company}</span>
          <span className="text-[11px] text-text-4 truncate">{t.role}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] font-mono tabular-nums text-text-4">{t.evals} evals</span>
          {t.bandChanged && (
            <span className="inline-flex items-center rounded-pill bg-bg-elevated border border-border-default/70 px-1.5 py-px text-[9.5px] font-mono text-text-3">
              {BAND_LABEL[t.bandFrom]} → {BAND_LABEL[t.bandTo]}
            </span>
          )}
          {t.topMover && (
            <span className="text-[10px] text-text-4 truncate">
              {t.topMover.label} {signed(t.topMover.delta)}
            </span>
          )}
        </div>
      </div>

      <Sparkline seq={t.sequence} />

      {/* first → latest, with the signed delta in the verdict colour. */}
      <div className="flex items-baseline gap-1.5 shrink-0 font-mono tabular-nums">
        <span className="text-[12px]" style={{ color: scoreColor(t.firstOverall) }}>{t.firstOverall.toFixed(1)}</span>
        <span className="text-[10px] text-text-4" aria-hidden>→</span>
        <span className="text-[13px] font-semibold" style={{ color: scoreColor(t.latestOverall) }}>{t.latestOverall.toFixed(1)}</span>
        <span className="text-[11px] font-semibold w-10 text-right" style={{ color: v.color }}>
          {signed(t.delta)}
        </span>
      </div>
    </li>
  )
}

// Compact line of the chronological Overall path. Width fixed so rows align;
// the path is normalized to the listing's own min/max so even a small absolute
// move reads as a visible slope. A single flat span (peak == trough) draws a
// centered baseline. Verdict colour ties the slope to the headline read.
function Sparkline({ seq }: { seq: Array<{ date: string; overall: number }> }) {
  const W = 64
  const H = 22
  const PAD = 2
  if (seq.length < 2) return <div style={{ width: W }} className="shrink-0" aria-hidden />

  const vals = seq.map(s => s.overall)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min
  const last = vals[vals.length - 1]
  const first = vals[0]
  const stroke = last > first + 0.25 ? '#007D1E' : last < first - 0.25 ? '#C80A28' : '#8595A4'

  const x = (i: number) => PAD + (i / (seq.length - 1)) * (W - PAD * 2)
  const y = (val: number) =>
    range === 0 ? H / 2 : PAD + (1 - (val - min) / range) * (H - PAD * 2)

  const d = seq.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(s.overall).toFixed(1)}`).join(' ')

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(seq.length - 1)} cy={y(last)} r={2} fill={stroke} />
    </svg>
  )
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function CardHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 pb-2 border-b border-border-default/60">
      <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">{title}</span>
      {right && <span className="text-[11px] font-mono tabular-nums text-text-4">{right}</span>}
    </div>
  )
}

function NoReevalCard() {
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <CardHeader title="Re-evaluated Listings" />
      <p className="text-[11px] text-text-4 leading-snug py-2">
        No company + role has been evaluated more than once yet. When you re-run a
        listing through scouting — after your CV improves, the role is reposted, or
        you recalibrate — its score movement will show up here.
      </p>
    </div>
  )
}

// "2026-06-25" → "Jun 25". Score-history dates are YYYY-MM-DD ISO, so this
// string split is TZ-stable (no local-midnight drift). Matches TrendsView's
// fmtDay so dates read identically across both analytics views.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}` : iso
}
