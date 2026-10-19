'use client'

// Score Trend — the re-evaluation sub-tab of the Trends view. Rendered by
// TrendsView inside its scoretrend tabpanel (no longer a standalone routed
// view); the host owns the title bar + tab strip, this panel owns the body.

import { useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { CompanyLink } from '@/components/shared/CompanyLink'
import { EmptyState } from '@/components/shared/EmptyState'
import { Chip, Panel, ScoreNumber, type ChipTone } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  analyzeScoreTrend,
  type Trajectory, type LandscapeTrend, type TrajectorySummary,
  type TrendRecommendation, type MovementClass, type MetricTrend, type MetricSummary,
  type MetricMove, type TrendMetric, type WindowStats, TREND_METRICS,
} from '@/lib/scoreTrend'
import { VerdictChip } from '@/components/shared/EligibilityChip'
import { formatWithinNoise } from '@/lib/scoringStats'

// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.3 + § 4.
//
// This panel is the app's loudest score-movement surface, so it obeys the
// presentation rules literally:
//   - scoring v2: every claim is stated on Want and Ease separately, each
//     against its own floor (Want 0.30, Ease 0.35, docs/scoring-v2.md §9);
//   - a move under its floor renders as "flat within noise" — no arrow, no
//     sign colour, no directional verb (§ 4 rule 5);
//   - a corpus verdict under the ≥10-evals-per-window gate renders as an
//     explicit withheld line with the shortfall, never a weaker direction
//     (§ 4 rule 4);
//   - every claim states the n behind it (§ 4 rule 1).
// It reads `movementClass` / `reportableVerdict`, never the legacy `verdict`.

// Movement vocabulary, keyed to the semantic tones (DESIGN-meta § Semantic) —
// the same success / danger / muted the Overview tab's momentum card uses, so
// "improving / declining" reads identically across the two Trends tabs.
// 'within-noise' carries the muted tone and NO arrow: it is a stated finding,
// not a direction.
const MOVEMENT_META: Record<MovementClass, { label: string; arrow: string; color: string; tone: ChipTone }> = {
  improving:      { label: 'Improving',         arrow: '↑', color: '#007D1E', tone: 'success' },
  declining:      { label: 'Declining',         arrow: '↓', color: '#C80A28', tone: 'danger' },
  'within-noise': { label: 'Flat within noise', arrow: '',  color: '#8595A4', tone: 'muted' },
  unknown:        { label: 'Unknown',           arrow: '',  color: '#8595A4', tone: 'muted' },
}

const METRIC_LABEL: Record<TrendMetric, string> = { want: 'Want', ease: 'Ease' }

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0')
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function ScoreTrendPanel() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)

  // The whole panel derives from one analysis pass over the score history
  // already in the store — no IPC, no shelling out to score-trend.mjs. Mirrors
  // how the Overview tab computes everything client-side from the same source.
  const analysis = useMemo(() => analyzeScoreTrend(scoreHistory), [scoreHistory])

  const reevaluated = analysis.trajectorySummary?.reevaluated ?? 0

  return (
    // Same body padding and rhythm as the Overview tab so switching tabs
    // doesn't shift the content edge. The host's tabpanel stays unpadded.
    <div className="p-5 flex flex-col gap-4">
      {!loaded ? (
        <>
          <div className="h-40 shimmer rounded-lg" />
          <div className="h-32 shimmer rounded-lg" />
        </>
      ) : analysis.error ? (
        <div className="card h-64 flex items-center justify-center">
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

const IMPACT_TONE: Record<TrendRecommendation['impact'], ChipTone> = {
  high:   'danger', // re-check now
  medium: 'accent',
  low:    'muted',
}

function MovesCard({ recs }: { recs: TrendRecommendation[] }) {
  return (
    <Panel title="Moves" meta={`${recs.length} flagged`}>
      <ul className="flex flex-col gap-3">
        {recs.map((r, i) => (
          <li key={i} className="flex gap-3">
            {/* A withheld-verdict marker is NOT a recommendation — it wears a
                neutral "Withheld" chip instead of an impact tone, so no reader
                mistakes a gate for a call to act (docs § 4 rule 4). */}
            <span className="w-16 shrink-0 pt-px">
              <Chip
                tone={r.insufficientData ? 'neutral' : IMPACT_TONE[r.impact]}
                className={r.insufficientData ? 'text-text-4' : undefined}
                title={r.sampleSize != null ? `n=${r.sampleSize}${r.gate != null ? ` · gate ${r.gate}` : ''} · ${r.confidence ?? 'n/a'} confidence` : undefined}
              >
                {r.insufficientData ? 'Withheld' : capitalize(r.impact)}
              </Chip>
            </span>
            <div className="min-w-0">
              <p className="text-body text-text-1">{r.action}</p>
              <p className="text-label text-text-3 mt-0.5">{r.reasoning}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ─── Landscape trend ─────────────────────────────────────────────────────────

function LandscapeTrendCard({ trend }: { trend: LandscapeTrend }) {
  if (trend.insufficientData) {
    return (
      <Panel title="Landscape trend" meta="Earlier vs recent">
        <p className="text-label text-text-3">
          {trend.reason} Once you have enough evaluations across distinct dates, this
          shows whether the roles you score lately are more wanted, and more reachable, than your earlier ones.
        </p>
      </Panel>
    )
  }

  // The corpus gate is shared by both axes: under it, neither Want nor Ease
  // may speak a direction (docs § 3.3). Above it, each axis reads its own
  // `reportableVerdict` against its own floor.
  const withheld = !trend.verdictGate.met
  const withheldReason = trend.verdictGate.reason
    ?? `Corpus verdict withheld: the window means don't resolve into a direction.`
  return (
    <Panel
      title="Landscape trend"
      meta={`${trend.older.count} earlier · ${trend.recent.count} recent`}
    >
      {/* Scoring v2: one row per axis, Want and Ease each against their own
          noise floor (docs/scoring-v2.md §9). */}
      <div className="grid grid-cols-[3rem_1fr_1fr_auto_5rem] items-center gap-x-3 gap-y-2">
        <span />
        <WindowHeading title="Earlier" w={trend.older} />
        <WindowHeading title="Recent" w={trend.recent} />
        <span />
        <span />
        {TREND_METRICS.map(m => (
          <MetricTrendRow
            key={m}
            label={METRIC_LABEL[m]}
            older={m === 'want' ? trend.older.avgWant : trend.older.avgEase}
            recent={m === 'want' ? trend.recent.avgWant : trend.recent.avgEase}
            mt={trend[m]}
            withheld={withheld}
            withheldReason={withheldReason}
          />
        ))}
      </div>

      {/* The gate line — states the shortfall (or the sample + tier that
          backs the verdict) in words, never a hedged direction. */}
      <p className="mt-3 text-label text-text-3">
        {withheld
          ? `${withheldReason} A window mean built on fewer evaluations can be pushed past the noise floor by one role, so no direction is claimed here yet.`
          : `${trend.verdictGate.olderCount} earlier vs ${trend.verdictGate.recentCount} recent evals · ${trend.verdictConfidence} confidence. What moved, not why: the scanner may have pulled a different segment on either side of ${trend.splitDate}.`}
      </p>

      {/* Apply-worthy share movement (verdict Go / Stretch / Solid) — the
          cleanest "am I sourcing better roles?" number. */}
      <div className="flex items-baseline justify-between gap-3 mt-3 pt-2.5 border-t border-border-default text-label">
        <span className="text-text-3">Apply-worthy share (Go / Stretch / Solid)</span>
        <span className="tabular-nums">
          <span className="text-text-4">{trend.older.applyWorthyShare}%</span>
          <span className="text-text-4 px-1">→</span>
          <span className="text-text-2 font-medium">{trend.recent.applyWorthyShare}%</span>
          {trend.applyWorthyShareDelta !== 0 && (
            // Same window gate as the verdict: under it, the share move is one
            // role's worth of share and gets no sign or colour (§ 4 rule 5).
            <span
              className={cn(
                'ml-1.5',
                withheld ? 'text-text-4' : trend.applyWorthyShareDelta > 0 ? 'text-success' : 'text-danger',
              )}
              title={withheld ? `Direction withheld: ${withheldReason}` : undefined}
            >
              {withheld
                ? `(|Δ| ${Math.abs(trend.applyWorthyShareDelta)}pt)`
                : `(${trend.applyWorthyShareDelta > 0 ? '+' : '−'}${Math.abs(trend.applyWorthyShareDelta)}pt)`}
            </span>
          )}
        </span>
      </div>
    </Panel>
  )
}

// Column heading for one calendar window: its name and date span.
function WindowHeading({ title, w }: { title: string; w: WindowStats }) {
  const { from, to } = w.dateRange
  const span = from && to ? (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`) : '—'
  return (
    <div className="min-w-0">
      <div className="label">{title}</div>
      <div className="text-micro text-text-4 truncate" title={span}>{span}</div>
    </div>
  )
}

// One axis of the landscape trend: earlier avg → recent avg, the verdict chip
// and the delta. The recent figure takes the verdict colour only when a
// direction was earned; the earlier one stays muted so the eye reads
// left→right as "from → to".
function MetricTrendRow({
  label, older, recent, mt, withheld, withheldReason,
}: {
  label: string; older: number; recent: number; mt: MetricTrend; withheld: boolean; withheldReason: string
}) {
  const directional = !withheld && (mt.reportableVerdict === 'improving' || mt.reportableVerdict === 'declining')
  const flat = !withheld && mt.reportableVerdict === 'flat-within-noise'
  const v = directional
    ? MOVEMENT_META[mt.reportableVerdict === 'improving' ? 'improving' : 'declining']
    : flat ? MOVEMENT_META['within-noise'] : MOVEMENT_META.unknown
  const undirected = !directional
  return (
    <>
      <span className="label">{label}</span>
      <span className="text-stat tabular-nums text-text-3">{older.toFixed(1)}</span>
      <span
        className="text-stat tabular-nums"
        style={{ color: undirected ? '#5D6C7B' : v.color }}
      >
        {recent.toFixed(1)}
      </span>
      {withheld || (!directional && !flat) ? (
        <Chip size="md" className="text-text-4 justify-self-start" title={withheldReason}>
          Verdict withheld
        </Chip>
      ) : (
        <Chip
          tone={v.tone}
          size="md"
          className="justify-self-start"
          title={flat ? formatWithinNoise(mt.delta, { floor: mt.noiseFloor }) : undefined}
        >
          {v.arrow && <span aria-hidden>{v.arrow}</span>}{v.label}
        </Chip>
      )}
      <span className="text-micro tabular-nums text-text-4 text-right">
        {/* No sign below the floor or under the gate — an unsigned |Δ|
            states the gap without claiming a direction (§ 4 rule 5). */}
        {undirected ? `|Δ| ${Math.abs(mt.delta).toFixed(2)} avg` : `${signed(mt.delta)} avg`}
      </span>
    </>
  )
}

// ─── Re-evaluated summary ────────────────────────────────────────────────────

function ReevalSummaryCard({ summary }: { summary: TrajectorySummary }) {
  const { reevaluated, verdictUpgrades, verdictDowngrades } = summary
  return (
    <Panel
      title="Re-evaluated listings"
      meta={`${reevaluated} listing${reevaluated === 1 ? '' : 's'} · ${verdictUpgrades} verdict upgrade${verdictUpgrades === 1 ? '' : 's'} · ${verdictDowngrades} downgrade${verdictDowngrades === 1 ? '' : 's'}`}
    >
      <div className="flex flex-col gap-3">
        {TREND_METRICS.map(m => (
          <MetricSummaryRow key={m} label={METRIC_LABEL[m]} s={summary[m]} reevaluated={reevaluated} />
        ))}
      </div>
    </Panel>
  )
}

// One axis of the re-evaluation roll-up. Counted against that axis's noise
// floor: the "Flat within noise" cell is the honest home of every sub-floor
// move, and the average move loses its colour when it is itself sub-floor.
function MetricSummaryRow({ label, s, reevaluated }: { label: string; s: MetricSummary; reevaluated: number }) {
  const { movement, withinNoise, avgDelta, noiseFloor } = s
  const avgDetectable = Math.abs(avgDelta) >= noiseFloor
  const cells: Array<{ label: string; value: string; className: string; title: string }> = [
    { label: 'Improving', value: String(movement.improving), className: 'text-success',
      title: `Listings whose first→latest ${label} rose by at least the ${noiseFloor} noise floor` },
    { label: 'Declining', value: String(movement.declining), className: 'text-danger',
      title: `Listings whose first→latest ${label} fell by at least the ${noiseFloor} noise floor` },
    { label: 'Flat within noise', value: String(withinNoise), className: 'text-text-3',
      title: `Listings whose ${label} |Δ| is under the ${noiseFloor} floor — the resolution limit, not a small move` },
    { label: 'Avg move', value: avgDetectable ? signed(avgDelta) : `|Δ| ${Math.abs(avgDelta).toFixed(2)}`,
      className: avgDetectable ? (avgDelta > 0 ? 'text-success' : 'text-danger') : 'text-text-3',
      title: avgDetectable
        ? `Mean first→latest ${label} move across ${reevaluated} re-evaluated listings`
        : `Mean ${label} move across ${reevaluated} re-evaluated listings is under the ${noiseFloor} floor — no direction claimed` },
  ]
  return (
    <div>
      <div className="text-section text-text-1 mb-1.5">{label}</div>
      <div className="grid grid-cols-4 gap-3">
        {cells.map(c => (
          <div key={c.label} className="rounded-lg bg-bg-elevated px-3 py-2.5" title={c.title}>
            <div className="label mb-1.5 truncate">{c.label}</div>
            <div className={cn('text-stat tabular-nums', c.className)}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Trajectory list (biggest movers) ────────────────────────────────────────

function TrajectoryListCard({ trajectories }: { trajectories: Trajectory[] }) {
  return (
    <Panel title="Biggest movers" meta="First → latest">
      <ul className="divide-y divide-border-default">
        {trajectories.map(t => <TrajectoryRow key={t.key} t={t} />)}
      </ul>
    </Panel>
  )
}

function TrajectoryRow({ t }: { t: Trajectory }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <CompanyLink company={t.company} size={24} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-body text-text-1 font-medium truncate">{t.company}</span>
          <span className="text-label text-text-3 truncate">{t.role}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 min-w-0">
          <span
            className="text-micro tabular-nums text-text-4 shrink-0"
            title={`${t.evals} evaluations on distinct dates · ${t.confidence} confidence`}
          >
            {t.evals} evals · {t.confidence}
          </span>
          {t.verdictChanged && (
            <span className="inline-flex items-center gap-1 shrink-0">
              <VerdictChip verdict={t.verdictFrom} />
              <span className="text-micro text-text-4" aria-hidden>→</span>
              <VerdictChip verdict={t.verdictTo} />
            </span>
          )}
          {/* A per-dimension delta is only shown as the DRIVER of a move that
              cleared its floor (docs § 2) — under the floor there is no move
              for it to drive. */}
          {t.topMover && t.detectable && (
            <span className="text-micro text-text-4 truncate">
              {t.topMover.label} {signed(t.topMover.delta)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1 shrink-0">
        {TREND_METRICS.map(m => (
          <MoveCell key={m} label={METRIC_LABEL[m]} mv={t[m]} seq={t.sequence.map(p => p[m])} evals={t.evals} />
        ))}
      </div>
    </li>
  )
}

// One axis of a trajectory: sparkline + first → latest + the delta. The delta
// carries a sign and a movement colour ONLY when it cleared that axis's noise
// floor; below it the row states the flat result with an unsigned |Δ|
// (§ 4 rules 3 and 5).
function MoveCell({ label, mv, seq, evals }: { label: string; mv: MetricMove; seq: number[]; evals: number }) {
  const v = MOVEMENT_META[mv.movementClass]
  const flat = mv.movementClass === 'within-noise'
  return (
    <div className="flex items-center gap-2 tabular-nums">
      <span className="text-micro text-text-3 w-8">{label}</span>
      <Sparkline vals={seq} movement={mv.movementClass} />
      <ScoreNumber value={mv.first} size="sm" />
      <span className="text-micro text-text-4" aria-hidden>→</span>
      <ScoreNumber value={mv.latest} size="md" />
      <span
        className="text-label font-medium w-16 text-right"
        style={{ color: v.color }}
        title={flat ? `${formatWithinNoise(mv.delta, { floor: mv.noiseFloor })} across ${evals} evals` : `${v.label} across ${evals} evals`}
      >
        {flat ? `Flat ${Math.abs(mv.delta).toFixed(2)}` : signed(mv.delta)}
      </span>
    </div>
  )
}

// Compact line of one axis's chronological path. Width fixed so rows align;
// the path is normalized to the listing's own min/max so even a small absolute
// move reads as a visible slope. A single flat span (peak == trough) draws a
// centered baseline.
//
// The stroke colour comes from the axis's `movementClass`, NOT from a local
// comparison: a sub-floor path is drawn in muted slate so the eye can read
// the shape without the colour asserting a direction the data can't support
// (docs § 4 rule 5).
function Sparkline({ vals, movement }: { vals: number[]; movement: MovementClass }) {
  const W = 64
  const H = 18
  const PAD = 2
  if (vals.length < 2) return <div style={{ width: W }} className="shrink-0" aria-hidden />

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min
  const last = vals[vals.length - 1]
  const stroke = MOVEMENT_META[movement].color

  const x = (i: number) => PAD + (i / (vals.length - 1)) * (W - PAD * 2)
  const y = (val: number) =>
    range === 0 ? H / 2 : PAD + (1 - (val - min) / range) * (H - PAD * 2)

  const d = vals.map((val, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(val).toFixed(1)}`).join(' ')

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(vals.length - 1)} cy={y(last)} r={2} fill={stroke} />
    </svg>
  )
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function NoReevalCard() {
  return (
    <Panel title="Re-evaluated listings">
      <p className="text-label text-text-3">
        No company + role has been evaluated more than once yet. When you re-run a
        listing through scouting — after your CV improves, the role is reposted, or
        you recalibrate — its score movement will show up here.
      </p>
    </Panel>
  )
}

// "2026-06-25" → "Jun 25". Score-history dates are YYYY-MM-DD ISO, so this
// string split is TZ-stable (no local-midnight drift). Matches TrendsView's
// fmtDay so dates read identically across both Trends tabs.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  const mi = Number(m) - 1
  return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${Number((d ?? '').slice(0, 2))}` : iso
}
