'use client'

import { Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { scoreColor } from '@/lib/tier'
import type { PeerContext } from '@/lib/peerRank'
import { type ConfidenceTier } from '@/lib/scoringStats'

// Peer context — the live "how does this score sit vs. the archetype
// landscape" panel, rendered between the dimensional-scoring table and the
// Why-this-score callout. Everything here is computed fresh from
// data/score-history.tsv (via lib/peerRank.ts), NOT read from the report —
// a role evaluated months ago is ranked against everything scored since.
//
// Three reads, top to bottom:
//   1. Rank plate + distribution strip — where this overall score sits in
//      the cohort (every tick is a peer role; the dot is this one).
//   2. Dimension deltas — this role vs. the cohort average, dim by dim,
//      sorted strongest advantage → biggest lag. Outliers (|Δ| ≥ 1.5, same
//      threshold as scripts/peer-rank.mjs) carry the semantic color.
//   3. Closest comparables — the nearest-scored roles at OTHER companies,
//      clickable to hop the slide-over to that evaluation.
//
// The panel is omitted entirely below 5 cohort members (rule shared with
// modes/scouting.md § Peer ranking) — the parent checks `peer == null`.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.2 + § 4.
// Every claim here states the n it rests on and its confidence tier, because
// a rank over 5 peers resolves to ±20 percentile points and one over 20 to
// ±5. At `low` confidence the band label ("top quartile") is a bucket NAME —
// the caveat line under the strip says so in full, since the only supported
// reading at that sample is which half the role sits in.

interface PeerContextCardProps {
  peer: PeerContext
  /** Hop the slide-over to a comparable's evaluation. Omit to render the
   *  comparables as plain text. */
  onOpenComparable?: (company: string, role: string) => void
}

export function PeerContextCard({ peer, onOpenComparable }: PeerContextCardProps) {
  const selfColor = scoreColor(peer.overall)

  return (
    <section className="my-5">
      <div className="flex items-baseline justify-between gap-3 pb-2.5 mb-3.5 border-b border-border-default">
        <h3 className="flex items-center gap-2 text-[16px] font-semibold text-text-1 leading-none tracking-[-0.005em]">
          <Users size={14} className="shrink-0 text-accent" aria-hidden />
          <span>Peer context</span>
        </h3>
        <span
          className="text-[11px] font-mono text-text-4 truncate max-w-[280px]"
          title={`${peer.nPeers} evaluated roles share the primary archetype “${peer.archetype}” (cohort gate: ${peer.minPeers})`}
        >
          {peer.nPeers} {peer.archetype} roles
        </span>
      </div>

      {/* Rank plate + distribution strip */}
      <div className="px-4 py-3 rounded-lg bg-bg-elevated/60 border border-border-default">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-4">
              Rank vs archetype peers
            </span>
            <ConfidenceChip confidence={peer.confidence} n={peer.nPeers} gate={peer.minPeers} />
          </div>
          <div className="text-[13px] font-mono tabular-nums">
            <span className="font-semibold" style={{ color: selfColor }}>#{peer.rankPosition}</span>
            <span className="text-text-4"> of {peer.nPeers}</span>
            <span className="text-text-3"> · {peer.rankLabel}</span>
          </div>
        </div>
        <DistributionStrip
          overall={peer.overall}
          peerOveralls={peer.peerOveralls}
          selfColor={selfColor}
        />
        {peer.confidence === 'low' && (
          <p className="mt-1.5 text-[10.5px] text-text-4 leading-snug">
            At {peer.nPeers} peers one role is ~{Math.round(100 / peer.nPeers)} percentile points —
            read this as which half the role sits in, not as a quartile.
          </p>
        )}
      </div>

      {/* Dimension deltas vs cohort average */}
      {peer.deltas.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
          {peer.deltas.map(d => {
            // A dimension can be scored by fewer peers than the cohort has
            // members. When it is, the row shows its OWN n — an outlier
            // computed against 4 peers is weaker than the block it sits in
            // (docs § 3.2) and has to say so, not just in a tooltip.
            const sparser = d.peerN < peer.nPeers - 1
            const signedDelta = `${d.delta > 0 ? '+' : ''}${d.delta.toFixed(1)}`
            return (
              <div key={d.dim} className="flex items-baseline justify-between gap-2 min-w-0">
                <span className="text-[11px] text-text-3 truncate" title={d.label}>{d.label}</span>
                <span className="text-[11.5px] font-mono tabular-nums whitespace-nowrap">
                  <span className="text-text-2">{formatScore(d.value)}</span>
                  <span className="text-text-4"> vs {d.peerAvg.toFixed(1)}</span>
                  <span
                    className={cn(
                      'ml-1.5',
                      d.outlier
                        ? d.delta > 0 ? 'text-success font-semibold' : 'text-danger font-semibold'
                        : 'text-text-4',
                    )}
                    title={d.outlier
                      ? `${signedDelta} vs the average of ${d.peerN} peers scored on this dimension — an outlier (|Δ| ≥ 1.5 raw rubric points), ${d.confidence} confidence`
                      : `${signedDelta} vs the average of ${d.peerN} peers scored on this dimension, ${d.confidence} confidence`}
                  >
                    {signedDelta}
                  </span>
                  {sparser && <span className="ml-1 text-text-4">n{d.peerN}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Closest comparables — other companies only */}
      {peer.comparables.length > 0 && (
        <div className="mt-3 flex items-baseline gap-2 flex-wrap text-[11.5px]">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-4">
            Closest
          </span>
          {peer.comparables.map((c, i) => {
            const tooltip = [c.role, c.location, c.tier].filter(Boolean).join(' · ')
            const label = (
              <>
                <span>{c.company}</span>
                <span className="font-mono tabular-nums text-text-3 ml-1">{c.overall.toFixed(2)}</span>
              </>
            )
            return (
              <span key={`${c.company}|${c.role}`} className="inline-flex items-baseline">
                {i > 0 && <span className="text-text-4 mr-2">·</span>}
                {onOpenComparable ? (
                  <button
                    onClick={() => onOpenComparable(c.company, c.role)}
                    title={tooltip}
                    className="inline-flex items-baseline gap-0.5 text-accent-text hover:underline transition-colors"
                  >
                    {label}
                    <span className="text-text-4">↗</span>
                  </button>
                ) : (
                  <span title={tooltip} className="text-text-2">{label}</span>
                )}
              </span>
            )
          })}
        </div>
      )}
    </section>
  )
}

// Confidence tier chip — the § 3.1 tier over the cohort size, printed beside
// the claim it qualifies (docs § 4 rule 1: never a rank without its sample).
// Deliberately monochrome: confidence is about resolution, not about whether
// the role is good, so it must not borrow the score / tier / status scales.
function ConfidenceChip({ confidence, n, gate }: { confidence: ConfidenceTier; n: number; gate: number }) {
  return (
    <span
      className="shrink-0 inline-flex items-center rounded-pill border border-border-default bg-bg-panel px-1.5 py-px text-[9px] font-mono lowercase tracking-normal text-text-4"
      title={`${confidence} confidence — ${n} peers in the cohort (gate ${gate}: <${gate} and this panel is omitted; ${gate}–${gate * 2 - 1} low, ${gate * 2}–${gate * 4 - 1} moderate, ${gate * 4}+ high)`}
    >
      {confidence} · n={n}
    </span>
  )
}

// One-axis cohort distribution: a hairline track spanning the cohort's score
// range, one tick per peer, and a filled dot for this role. Domain is the
// cohort min/max (padded), not 0–10 — peers cluster within ~2 points and a
// fixed axis would compress every strip into an unreadable clump.
function DistributionStrip({
  overall, peerOveralls, selfColor,
}: {
  overall: number
  peerOveralls: number[]
  selfColor: string
}) {
  const all = [...peerOveralls, overall]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = Math.max((hi - lo) * 0.08, 0.15)
  const min = Math.max(0, lo - pad)
  const max = Math.min(10, hi + pad)
  const span = max - min || 1
  const pos = (v: number) => `${((v - min) / span) * 100}%`

  return (
    <div
      role="img"
      aria-label={`Score distribution: this role at ${overall.toFixed(1)}, ${peerOveralls.length} peers between ${lo.toFixed(1)} and ${hi.toFixed(1)}`}
    >
      <div className="relative h-5 mt-2">
        {/* baseline */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-border-default" aria-hidden />
        {/* peer ticks */}
        {peerOveralls.map((v, i) => (
          <div
            key={i}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-px h-2.5 bg-text-4 opacity-50"
            style={{ left: pos(v) }}
            aria-hidden
          />
        ))}
        {/* self marker */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full ring-2 ring-bg-base"
          style={{ left: pos(overall), background: selfColor }}
          aria-hidden
        />
      </div>
      <div className="relative h-3 text-[10px] font-mono tabular-nums text-text-4 leading-none">
        <span className="absolute left-0">{min.toFixed(1)}</span>
        {/* value caption tracks the marker, clamped so it never collides
            with the min/max labels at the edges */}
        <span
          className="absolute -translate-x-1/2 font-semibold whitespace-nowrap"
          style={{ color: selfColor, left: `clamp(14%, ${((overall - min) / span) * 100}%, 86%)` }}
        >
          {overall.toFixed(1)} this role
        </span>
        <span className="absolute right-0">{max.toFixed(1)}</span>
      </div>
    </div>
  )
}

function formatScore(v: number): string {
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)
}
