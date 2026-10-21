'use client'

import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NEUTRAL_SCORE_COLOR } from '@/lib/tier'
import { MatchEase } from '@/components/shared/MatchEase'
import type { PeerContext, PeerPlacement } from '@/lib/peerRank'
import { type ConfidenceTier } from '@/lib/scoringStats'
import { Chip, SectionHeading } from '@/components/ui'

// Peer context — where this evaluation sits among every other evaluated role
// sharing its archetype, computed live from data/score-history.tsv (see
// lib/peerRank.ts). Omitted entirely under the cohort gate; the parent checks.
//
// The distribution strip ranks on Priority (√(Match × Ease), the v2 sort key).
// Priority is a rank axis here, never a headline score, so the strip is drawn
// in neutral slate and comparables show their Match · Ease pair. Under the
// rank, a quiet line says where the role's Match and its Ease each sit among
// the same peers: two separate placements, never folded into one.
//
// Statistical contract (docs/scoring-statistical-design.md § 3.2 + § 4): every
// claim prints the n it rests on and its confidence tier; at `low` confidence
// the band label is a bucket name and the caption says so.

interface PeerContextCardProps {
  peer: PeerContext
  onOpenComparable?: (company: string, role: string) => void
}

export function PeerContextCard({ peer, onOpenComparable }: PeerContextCardProps) {
  // Neutral, not scoreColor: Priority must never read as a headline score.
  const selfColor = NEUTRAL_SCORE_COLOR

  return (
    <section data-slug="peer-context" data-label="Peer context" className="scroll-mt-4">
      <SectionHeading
        title="Peer context"
        size="md"
        rule={false}
        meta={<span title={`${peer.nPeers} evaluated roles share the primary archetype "${peer.archetype}" (cohort gate: ${peer.minPeers})`}>{peer.nPeers} {peer.archetype} roles</span>}
      />

      <div className="card p-4 flex flex-col gap-4">
        {/* Rank + distribution */}
        <div>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="flex items-baseline gap-2">
              <span className="label">Rank among archetype peers</span>
              <ConfidenceChip confidence={peer.confidence} n={peer.nPeers} gate={peer.minPeers} />
            </div>
            <div className="text-body tabular-nums">
              <span className="font-semibold" style={{ color: selfColor }}>#{peer.rankPosition}</span>
              <span className="text-text-4"> of {peer.nPeers}</span>
              <span className="text-text-3"> · {peer.rankLabel}</span>
            </div>
          </div>
          <PlacementLine match={peer.match} ease={peer.ease} nPeers={peer.nPeers} />
          <DistributionStrip priority={peer.priority} peerPriorities={peer.peerPriorities} selfColor={selfColor} />
          {peer.confidence === 'low' && (
            <p className="mt-1.5 text-label text-text-4 leading-snug">
              At {peer.nPeers} peers one role is about {Math.round(100 / peer.nPeers)} percentile points, so read this as which half the role sits in, not as a quartile.
            </p>
          )}
        </div>

        {/* Dimension deltas vs cohort average */}
        {peer.deltas.length > 0 && (
          <div>
            <div className="label mb-1.5">Versus the cohort average</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              {peer.deltas.map(d => {
                const sparser = d.peerN < peer.nPeers - 1
                const signed = `${d.delta > 0 ? '+' : ''}${d.delta.toFixed(1)}`
                return (
                  <div key={d.dim} className="flex items-baseline justify-between gap-2 min-w-0 text-label">
                    <span className="text-text-3 truncate" title={d.label}>{d.label}</span>
                    <span className="tabular-nums whitespace-nowrap">
                      <span className="text-text-2">{formatScore(d.value)}</span>
                      <span className="text-text-4"> vs {d.peerAvg.toFixed(1)}</span>
                      <span
                        className={cn('ml-1.5 font-medium', d.outlier ? (d.delta > 0 ? 'text-success' : 'text-danger') : 'text-text-4')}
                        title={d.outlier
                          ? `${signed} vs the average of ${d.peerN} peers scored on this dimension: an outlier (|Δ| ≥ 1.5 rubric points), ${d.confidence} confidence`
                          : `${signed} vs the average of ${d.peerN} peers scored on this dimension, ${d.confidence} confidence`}
                      >
                        {signed}
                      </span>
                      {sparser && <span className="ml-1 text-text-4">n{d.peerN}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Closest comparables at other companies */}
        {peer.comparables.length > 0 && (
          <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap text-label">
            <span className="label">Closest</span>
            {peer.comparables.map(c => {
              const tooltip = [c.role, c.location, c.tier].filter(Boolean).join(' · ')
              const label = (
                <>
                  <span>{c.company}</span>
                  <MatchEase match={c.match} ease={c.ease} size="sm" bare className="ml-1" />
                </>
              )
              return onOpenComparable ? (
                <button
                  key={`${c.company}|${c.role}`}
                  onClick={() => onOpenComparable(c.company, c.role)}
                  title={tooltip}
                  className="inline-flex items-baseline gap-0.5 text-accent-text hover:underline underline-offset-2"
                >
                  {label}
                  <ArrowUpRight size={11} className="self-center" />
                </button>
              ) : (
                <span key={`${c.company}|${c.role}`} title={tooltip} className="text-text-2">{label}</span>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

// "Match top quartile · Ease bottom half (#7 of 12)". Each placement prints its
// own n only when fewer peers carry that score than the cohort holds.
function PlacementLine({ match, ease, nPeers }: {
  match: PeerPlacement | null
  ease: PeerPlacement | null
  nPeers: number
}) {
  const parts = [
    match ? { name: 'Match', p: match } : null,
    ease ? { name: 'Ease', p: ease } : null,
  ].filter((x): x is { name: string; p: PeerPlacement } => x != null)
  if (parts.length === 0) return null
  return (
    <p className="mt-1 text-label text-text-3 tabular-nums">
      {parts.map(({ name, p }, i) => (
        <span
          key={name}
          title={`${name} ${p.value.toFixed(2)} vs the average of the other peers ${p.peerAvg.toFixed(2)}: #${p.rankPosition} of ${p.peerN}, ${p.confidence} confidence`}
        >
          {i > 0 && <span className="text-text-4" aria-hidden> · </span>}
          {name} {p.rankLabel}
          {p.peerN < nPeers && <span className="ml-1 text-text-4">n{p.peerN}</span>}
        </span>
      ))}
    </p>
  )
}

function ConfidenceChip({ confidence, n, gate }: { confidence: ConfidenceTier; n: number; gate: number }) {
  return (
    <Chip
      tone="plain"
      title={`${confidence} confidence: ${n} peers in the cohort (gate ${gate}: below ${gate} this panel is omitted; ${gate}–${gate * 2 - 1} low, ${gate * 2}–${gate * 4 - 1} moderate, ${gate * 4}+ high)`}
    >
      {confidence} confidence · n = {n}
    </Chip>
  )
}

// One-axis cohort distribution: a hairline spanning the cohort's Priority
// range, one tick per peer, and a filled dot for this role.
function DistributionStrip({ priority, peerPriorities, selfColor }: {
  priority: number
  peerPriorities: number[]
  selfColor: string
}) {
  const all = [...peerPriorities, priority]
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
      aria-label={`Priority distribution (√(Match × Ease)): this role at ${priority.toFixed(1)}, ${peerPriorities.length} peers between ${lo.toFixed(1)} and ${hi.toFixed(1)}`}
      title="Rank axis: Priority = √(Match × Ease), the sort key, not a score"
    >
      <div className="relative h-5 mt-2">
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-border-default" aria-hidden />
        {peerPriorities.map((v, i) => (
          <div key={i} className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-px h-2.5 bg-text-4 opacity-50" style={{ left: pos(v) }} aria-hidden />
        ))}
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full ring-2 ring-bg-base" style={{ left: pos(priority), background: selfColor }} aria-hidden />
      </div>
      <div className="relative h-3 text-micro font-normal tabular-nums text-text-4 leading-none">
        <span className="absolute left-0">{min.toFixed(1)}</span>
        <span className="absolute -translate-x-1/2 font-medium whitespace-nowrap" style={{ color: selfColor, left: `clamp(14%, ${((priority - min) / span) * 100}%, 86%)` }}>
          {priority.toFixed(1)} this role
        </span>
        <span className="absolute right-0">{max.toFixed(1)}</span>
      </div>
    </div>
  )
}

function formatScore(v: number): string {
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)
}
