'use client'

// Score Trend — the re-evaluation sub-tab of the Trends view. Rendered by
// TrendsView inside its scoretrend tabpanel (no longer a standalone routed
// view); the host owns the title bar + tab strip, this panel owns the body.

import { useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { CompanyLink } from '@/components/shared/CompanyLink'
import { EmptyState } from '@/components/shared/EmptyState'
import { scoreColor } from '@/lib/tier'
import {
  analyzeScoreTrend,
  type Trajectory, type LandscapeTrend, type TrajectorySummary,
  type TrendRecommendation, type Band, type MovementClass,
} from '@/lib/scoreTrend'
import { formatWithinNoise } from '@/lib/scoringStats'

// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.3 + § 4.
//
// This panel is the app's loudest score-movement surface, so it obeys the
// presentation rules literally:
//   - a move under the 0.30 Overall noise floor renders as "flat within
//     noise" — no arrow, no sign colour, no directional verb (§ 4 rule 5);
//   - a corpus verdict under the ≥10-evals-per-window gate renders as an
//     explicit withheld line with the shortfall, never a weaker direction
//     (§ 4 rule 4);
//   - every claim states the n behind it (§ 4 rule 1).
// It reads `movementClass` / `reportableVerdict`, never the legacy `verdict`.

// Movement vocabulary, keyed to the semantic palette (DESIGN-meta § Status
// scale) — same hexes the Overview tab's momentum card uses, so "improving /
// declining" reads identically across the two Trends tabs. 'within-noise'
// carries the muted slate and NO arrow: it is a stated finding, not a
// direction.
const MOVEMENT_META: Record<MovementClass, { label: string; arrow: string; color: string }> = {
  improving:      { label: 'Improving',        arrow: '↑', color: '#007D1E' }, // success green
  declining:      { label: 'Declining',        arrow: '↓', color: '#C80A28' }, // danger red
  'within-noise': { label: 'Flat within noise', arrow: '',  color: '#8595A4' }, // muted slate
  unknown:        { label: 'Unknown',          arrow: '',  color: '#8595A4' },
}

// Band → short label, used in the band-transition chip.
const BAND_LABEL: Record<Band, string> = {
  strong: 'strong', solid: 'solid', pass: 'pass', weak: 'weak', unknown: '—',
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0')

export function ScoreTrendPanel() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)

  // The whole panel derives from one analysis pass over the score history
  // already in the store — no IPC, no shelling out to score-trend.mjs. Mirrors
  // how the Overview tab computes everything client-side from the same source.
  const analysis = useMemo(() => analyzeScoreTrend(scoreHistory), [scoreHistory])

  const reevaluated = analysis.trajectorySummary?.reevaluated ?? 0

  return (
    // p-4 space-y-4 mirrors the Overview tabpanel so switching tabs doesn't
    // shift the content edge. The host's tabpanel wrapper stays unpadded.
    <div className="p-4 space-y-4">
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
          {/* Recommendations first — the act-now layer, like the Overview and
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
            {/* A withheld-verdict marker is NOT a recommendation — it wears a
                neutral "withheld" chip instead of an impact colour, so no
                reader mistakes a gate for a call to act (docs § 4 rule 4). */}
            <span
              className={r.insufficientData
                ? 'mt-0.5 shrink-0 inline-flex items-center rounded-pill border border-border-default bg-bg-elevated px-1.5 py-px text-[9px] uppercase tracking-[0.06em] font-semibold text-text-4'
                : 'mt-0.5 shrink-0 inline-flex items-center rounded-pill px-1.5 py-px text-[9px] uppercase tracking-[0.06em] font-semibold'}
              style={r.insufficientData ? undefined : { color: IMPACT_COLOR[r.impact], background: `${IMPACT_COLOR[r.impact]}1f` }}
              title={r.sampleSize != null ? `n=${r.sampleSize}${r.gate != null ? ` · gate ${r.gate}` : ''} · ${r.confidence ?? 'n/a'} confidence` : undefined}
            >
              {r.insufficientData ? 'withheld' : r.impact}
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

  // The verdict a renderer is allowed to show, in three states (docs § 3.3):
  // a direction only when BOTH gates pass, flat when the window-mean delta is
  // under the noise floor, withheld otherwise (under the per-window gate, or
  // on an unclassifiable delta — anything that isn't an earned direction).
  const directional = trend.reportableVerdict === 'improving' || trend.reportableVerdict === 'declining'
  const flat = trend.reportableVerdict === 'flat-within-noise'
  const withheld = !directional && !flat
  const v = directional
    ? MOVEMENT_META[trend.reportableVerdict === 'improving' ? 'improving' : 'declining']
    : flat
      ? MOVEMENT_META['within-noise']
      : MOVEMENT_META.unknown
  const withheldReason = trend.verdictGate.reason
    ?? `Corpus verdict withheld: the window means don't resolve into a direction.`
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
          {withheld ? (
            <span
              className="inline-flex items-center rounded-pill px-2 py-0.5 text-[11px] font-semibold text-text-4 bg-bg-elevated border border-border-default"
              title={withheldReason}
            >
              Verdict withheld
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] font-semibold"
              style={{ color: v.color, background: `${v.color}1f` }}
              title={flat ? formatWithinNoise(trend.delta, { floor: trend.noiseFloor }) : undefined}
            >
              {v.arrow && <span aria-hidden>{v.arrow}</span>}{v.label}
            </span>
          )}
          <span className="text-[10px] font-mono tabular-nums text-text-4">
            {/* No sign below the floor or under the gate — an unsigned |Δ|
                states the gap without claiming a direction (§ 4 rule 5). */}
            {withheld || flat ? `|Δ| ${Math.abs(trend.delta).toFixed(2)} avg` : `${signed(trend.delta)} avg`}
          </span>
        </div>
        <WindowBlock
          title="Recent"
          avg={trend.recent.avgOverall}
          share={trend.recent.strongSolidShare}
          from={trend.recent.dateRange.from}
          to={trend.recent.dateRange.to}
          accent={withheld ? undefined : v.color}
        />
      </div>

      {/* The gate line — states the shortfall (or the sample + tier that
          backs the verdict) in words, never a hedged direction. */}
      <p className="mt-3 text-[10.5px] text-text-4 leading-snug">
        {withheld
          ? `${withheldReason} A window mean built on fewer evaluations can be pushed past the ${trend.noiseFloor} noise floor by one role, so no direction is claimed here yet.`
          : flat
            ? `The gap between the two windows is under the ${trend.noiseFloor} Overall noise floor — the resolution limit of the rubric. Neither sharpening nor sliding on ${trend.verdictGate.olderCount} vs ${trend.verdictGate.recentCount} evals (${trend.verdictConfidence} confidence).`
            : `${trend.verdictGate.olderCount} earlier vs ${trend.verdictGate.recentCount} recent evals · ${trend.verdictConfidence} confidence. What moved, not why: the scanner may have pulled a different segment on either side of ${trend.splitDate}.`}
      </p>

      {/* Strong/solid share movement — the cleanest "am I sourcing better
          roles?" number. */}
      <div className="flex items-baseline justify-between gap-3 mt-3 pt-2.5 border-t border-border-default/60 text-[11px]">
        <span className="text-text-3">Strong/solid share</span>
        <span className="font-mono tabular-nums">
          <span className="text-text-4">{trend.older.strongSolidShare}%</span>
          <span className="text-text-4 px-1">→</span>
          <span className="text-text-2 font-semibold">{trend.recent.strongSolidShare}%</span>
          {trend.strongSolidShareDelta !== 0 && (
            // Same window gate as the verdict: under it, the share move is one
            // role's worth of share and gets no sign or colour (§ 4 rule 5).
            <span
              className={withheld ? 'ml-1.5 text-text-4' : 'ml-1.5'}
              style={withheld ? undefined : { color: trend.strongSolidShareDelta > 0 ? '#007D1E' : '#C80A28' }}
              title={withheld ? `Direction withheld: ${withheldReason}` : undefined}
            >
              {withheld
                ? `(|Δ| ${Math.abs(trend.strongSolidShareDelta)}pt)`
                : `(${trend.strongSolidShareDelta > 0 ? '+' : '−'}${Math.abs(trend.strongSolidShareDelta)}pt)`}
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
  const { movement, withinNoise, avgDelta, noiseFloor, reevaluated, bandUpgrades, bandDowngrades } = summary
  // Counted against the noise floor, not the legacy ±0.25 dead-band: the
  // "Flat within noise" cell is the honest home of every sub-floor move, and
  // the average move loses its colour when it is itself sub-floor.
  const avgDetectable = Math.abs(avgDelta) >= noiseFloor
  const cells: Array<{ label: string; value: string; color: string; title: string }> = [
    { label: 'Improving', value: String(movement.improving), color: '#007D1E',
      title: `Listings whose first→latest Overall rose by at least the ${noiseFloor} noise floor` },
    { label: 'Declining', value: String(movement.declining), color: '#C80A28',
      title: `Listings whose first→latest Overall fell by at least the ${noiseFloor} noise floor` },
    { label: 'Flat within noise', value: String(withinNoise), color: '#5D6C7B',
      title: `Listings whose |Δ| is under the ${noiseFloor} floor — the resolution limit of the rubric, not a small move` },
    { label: 'Avg move', value: avgDetectable ? signed(avgDelta) : `|Δ| ${Math.abs(avgDelta).toFixed(2)}`,
      color: avgDetectable ? (avgDelta > 0 ? '#007D1E' : '#C80A28') : '#5D6C7B',
      title: avgDetectable
        ? `Mean first→latest Overall move across ${reevaluated} re-evaluated listings`
        : `Mean move across ${reevaluated} re-evaluated listings is under the ${noiseFloor} floor — no direction claimed` },
  ]
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-4">
      <CardHeader
        title="Re-evaluated Listings"
        right={`${reevaluated} listing${reevaluated === 1 ? '' : 's'} · ${bandUpgrades} band upgrade${bandUpgrades === 1 ? '' : 's'} · ${bandDowngrades} downgrade${bandDowngrades === 1 ? '' : 's'}`}
      />
      <div className="grid grid-cols-4 gap-3 mt-2">
        {cells.map(c => (
          <div key={c.label} className="rounded-md border border-border-default/70 bg-bg-elevated/60 px-3 py-2.5" title={c.title}>
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
  const v = MOVEMENT_META[t.movementClass]
  const flat = t.movementClass === 'within-noise'
  return (
    <li className="flex items-center gap-3 py-2.5">
      <CompanyLink company={t.company} size={22} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] text-text-1 font-medium truncate">{t.company}</span>
          <span className="text-[11px] text-text-4 truncate">{t.role}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className="text-[10px] font-mono tabular-nums text-text-4"
            title={`${t.evals} evaluations on distinct dates · ${t.confidence} confidence`}
          >
            {t.evals} evals · {t.confidence}
          </span>
          {t.bandChanged && (
            <span className="inline-flex items-center rounded-pill bg-bg-elevated border border-border-default/70 px-1.5 py-px text-[9.5px] font-mono text-text-3">
              {BAND_LABEL[t.bandFrom]} → {BAND_LABEL[t.bandTo]}
            </span>
          )}
          {/* A per-dimension delta is only shown as the DRIVER of an Overall
              move that itself cleared the floor (docs § 2) — under the floor
              there is no move for it to drive. */}
          {t.topMover && !flat && (
            <span className="text-[10px] text-text-4 truncate">
              {t.topMover.label} {signed(t.topMover.delta)}
            </span>
          )}
        </div>
      </div>

      <Sparkline seq={t.sequence} movement={t.movementClass} />

      {/* first → latest. The delta carries a sign and a movement colour ONLY
          when it cleared the noise floor; below it the row states the flat
          result with an unsigned |Δ| (§ 4 rules 3 and 5). */}
      <div className="flex items-baseline gap-1.5 shrink-0 font-mono tabular-nums">
        <span className="text-[12px]" style={{ color: scoreColor(t.firstOverall) }}>{t.firstOverall.toFixed(1)}</span>
        <span className="text-[10px] text-text-4" aria-hidden>→</span>
        <span className="text-[13px] font-semibold" style={{ color: scoreColor(t.latestOverall) }}>{t.latestOverall.toFixed(1)}</span>
        <span
          className="text-[11px] font-semibold w-14 text-right"
          style={{ color: v.color }}
          title={flat ? `${formatWithinNoise(t.delta, { floor: t.noiseFloor })} across ${t.evals} evals` : `${v.label} across ${t.evals} evals`}
        >
          {flat ? `flat ${Math.abs(t.delta).toFixed(2)}` : signed(t.delta)}
        </span>
      </div>
    </li>
  )
}

// Compact line of the chronological Overall path. Width fixed so rows align;
// the path is normalized to the listing's own min/max so even a small absolute
// move reads as a visible slope. A single flat span (peak == trough) draws a
// centered baseline.
//
// The stroke colour comes from the row's `movementClass`, NOT from a local
// ±0.25 comparison: a sub-floor path is drawn in muted slate so the eye can
// read the shape without the colour asserting a direction the data can't
// support (docs § 4 rule 5).
function Sparkline({ seq, movement }: {
  seq: Array<{ date: string; overall: number }>
  movement: MovementClass
}) {
  const W = 64
  const H = 22
  const PAD = 2
  if (seq.length < 2) return <div style={{ width: W }} className="shrink-0" aria-hidden />

  const vals = seq.map(s => s.overall)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min
  const last = vals[vals.length - 1]
  const stroke = MOVEMENT_META[movement].color

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
// fmtDay so dates read identically across both Trends tabs.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number(d)}` : iso
}
