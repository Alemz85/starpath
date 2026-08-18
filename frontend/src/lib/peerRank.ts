// Peer context for the Reports slide-over — the frontend twin of
// scripts/peer-rank.mjs.
//
// Reports carry an OPTIONAL static "Rank vs {archetype} peers" block that is
// frozen at evaluation time (and, in the current renderer, silently dropped
// because it sits inside the dimensional-scoring section slice). This module
// recomputes the same signal LIVE from the score-history rows the app already
// has in the data store, so the panel always reflects today's landscape —
// a role evaluated in April is ranked against everything scored since.
//
// Semantics follow scripts/peer-rank.mjs with two deliberate divergences,
// both documented here so the twins don't drift silently:
//   1. Re-evaluated listings are deduped to their LATEST row per entity
//      (the script ranks raw rows, so a listing re-evaluated 3× counts 3×).
//   2. Dimension averages are computed over the OTHER peers (excluding this
//      entity), so "vs peer avg" means "vs the rest of the cohort" rather
//      than an average that includes the score being explained.
// Rank / percentile / minPeers / the ±1.5 outlier threshold / the
// same-company exclusion for comparables all mirror the script.
//
// STATISTICAL CONTRACT: docs/scoring-statistical-design.md § 3.2.
//
// A peer rank is a claim about a pool of LLM judgments, and its resolution is
// set by the pool size: at 5 peers one peer is 20 percentile points, so only
// the half-split is readable; at 20 one peer is 5 points, the resolution the
// rendered percentile already rounds to. The omission gate (below 5 peers the
// block is omitted ENTIRELY, never a placeholder) and the ±1.5 outlier
// threshold both predate this contract and are unchanged — the gate value now
// comes from scoringStats.GATES rather than a local literal, and every result
// additionally carries the n it rests on plus its confidence tier so no
// renderer can state a rank without stating its sample.

import type { ScoreEntry } from '@/types'
import { entityId, parseCities } from '@/lib/entityId'
import { GATES, confidenceTier, type ConfidenceTier } from '@/lib/scoringStats'

export const PEER_DIMS = [
  { key: 'skills_match',     label: 'Skills Match' },
  { key: 'ease_of_entry',    label: 'Ease of Entry' },
  { key: 'strategic_fit',    label: 'Strategic Fit' },
  { key: 'growth_mobility',  label: 'Growth/Mobility' },
  { key: 'optionality_exit', label: 'Optionality/Exit' },
  { key: 'brand_value',      label: 'Brand Value' },
] as const

export type PeerDimKey = (typeof PEER_DIMS)[number]['key']

/** |Δ| from the peer average at which a dimension counts as an outlier —
 *  same threshold as scripts/peer-rank.mjs. Deliberately expressed in RAW
 *  rubric points (a full step and a half, comfortably above one-step judge
 *  wobble), not in Overall points, so it is never confused with the 0.30
 *  Overall noise floor (docs § 3.2). */
export const OUTLIER_THRESHOLD = 1.5

/** Below this cohort size the panel is omitted entirely (never rendered
 *  with a "not enough data" placeholder) — same rule as the script,
 *  modes/scouting.md § Peer ranking, and docs § 3.2. Sourced from the
 *  contract's gate table so the renderer can't drift from the CLIs. */
export const MIN_PEERS = GATES.peerMinPeers

export interface PeerDimDelta {
  dim: PeerDimKey
  label: string
  /** This entity's score on the dimension. */
  value: number
  /** Mean of the OTHER peers' scores on the dimension (2 decimals). */
  peerAvg: number
  /** value − peerAvg, rounded to 1 decimal. */
  delta: number
  /** |delta| ≥ OUTLIER_THRESHOLD — the load-bearing "stands out / lags" flag. */
  outlier: boolean
  /** ADDED (docs § 3.2) — peers that actually scored THIS dimension. A
   *  dimension can be sparser than the cohort, so it carries its own n. */
  peerN: number
  /** ADDED — tier over `peerN` with the peer gate. An outlier computed
   *  against fewer peers than the block is weaker than the block, and says so. */
  confidence: ConfidenceTier
}

export interface PeerComparable {
  company: string
  role: string
  overall: number
  tier: string
  location: string
}

export interface PeerContext {
  /** Primary archetype segment the cohort was matched on. */
  archetype: string
  /** Cohort size INCLUDING this entity. */
  nPeers: number
  /** 1 = top. Ties rank below (same convention as the script). */
  rankPosition: number
  /** % of the cohort scoring strictly below this entity. */
  percentile: number
  /** Human label: "top 5%" / "top 10%" / "top quartile" / "top half" / "bottom half". */
  rankLabel: string
  /** This entity's overall score (echoed for the renderer). */
  overall: number
  /** The OTHER peers' overall scores — feeds the distribution strip. */
  peerOveralls: number[]
  /** All comparable dimensions, sorted by delta descending (strongest
   *  advantage first, biggest lag last). */
  deltas: PeerDimDelta[]
  /** Up to 3 closest peers by overall score, other companies only. */
  comparables: PeerComparable[]
  /** ADDED (docs § 3.2) — the tier over `nPeers` with gate `minPeers`:
   *  5–9 peers `low`, 10–19 `moderate`, 20+ `high`. At `low` the rank label
   *  is a bucket NAME and only the half-split reading is supported. */
  confidence: ConfidenceTier
  /** ADDED — the gate this cohort had to clear, so a renderer can print the
   *  rule without re-deriving it. */
  minPeers: number
}

/** First segment of a hybrid archetype ("A + B" → "A"). "&" and "/" are NOT
 *  separators — "Strategy & Operations" stays whole. Mirrors the script. */
export function primaryArchetype(raw: string | null | undefined): string {
  return (raw ?? '').split(' + ')[0].trim()
}

/** Latest row per entity (company + role-canonical + city), so re-evaluated
 *  listings count once. Rows without a usable overall are dropped. */
export function dedupeLatestPerEntity(rows: ScoreEntry[]): Map<string, ScoreEntry> {
  const byEntity = new Map<string, ScoreEntry>()
  for (const r of rows) {
    if (!Number.isFinite(r.overall) || r.overall <= 0) continue
    const id = entityId(r.company, r.role, parseCities(r.location))
    const prev = byEntity.get(id)
    if (!prev || r.date.localeCompare(prev.date) >= 0) byEntity.set(id, r)
  }
  return byEntity
}

/** Percentile band — the shared vocabulary between the slide-over panel's
 *  prose label and the Database column's compact chip. Both render from the
 *  SAME band so the two surfaces can never disagree about which bucket a
 *  role falls in. Thresholds mirror scripts/peer-rank.mjs. */
export type PeerBand = 'top5' | 'top10' | 'quartile' | 'half' | 'bottom'

export function peerBand(percentile: number): PeerBand {
  if (percentile >= 95) return 'top5'
  if (percentile >= 90) return 'top10'
  if (percentile >= 75) return 'quartile'
  if (percentile >= 50) return 'half'
  return 'bottom'
}

const BAND_LABELS: Record<PeerBand, string> = {
  top5:     'top 5%',
  top10:    'top 10%',
  quartile: 'top quartile',
  half:     'top half',
  bottom:   'bottom half',
}

/** Compact form for tight surfaces (the Database "Peers" column):
 *  "top 5%" / "top 10%" / "top 25%" / "top 50%" / "#7/12". */
export function compactRankLabel(band: PeerBand, position: number, total: number): string {
  switch (band) {
    case 'top5':     return 'top 5%'
    case 'top10':    return 'top 10%'
    case 'quartile': return 'top 25%'
    case 'half':     return 'top 50%'
    case 'bottom':   return `#${position}/${total}`
  }
}

function rankLabel(percentile: number, position: number, total: number): string {
  const band = peerBand(percentile)
  return band === 'bottom'
    ? `${BAND_LABELS.bottom} (#${position} of ${total})`
    : BAND_LABELS[band]
}

function sameCompany(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function peerContext(
  entry: ScoreEntry,
  history: ScoreEntry[],
  { minPeers = MIN_PEERS }: { minPeers?: number } = {},
): PeerContext | null {
  if (!entry || !Number.isFinite(entry.overall) || entry.overall <= 0) return null
  const seg = primaryArchetype(entry.archetype)
  if (!seg) return null
  const segLower = seg.toLowerCase()

  const selfId = entityId(entry.company, entry.role, parseCities(entry.location))
  const others: ScoreEntry[] = []
  for (const [id, row] of dedupeLatestPerEntity(history)) {
    if (id === selfId) continue
    if (primaryArchetype(row.archetype).toLowerCase() !== segLower) continue
    others.push(row)
  }

  const nPeers = others.length + 1
  if (nPeers < minPeers) return null

  // Rank / percentile — script math: beats = peers scoring strictly below;
  // ties (and self) count as at-or-above, so rankPosition is conservative.
  const beats = others.filter(o => o.overall < entry.overall).length
  const percentile = Math.round((beats / nPeers) * 100)
  const rankPosition = nPeers - beats

  // Dimension deltas vs the rest of the cohort. Dims missing on this entity
  // (0 = not scored) are skipped rather than rendered as a fake 0-vs-avg gap.
  const deltas: PeerDimDelta[] = []
  for (const { key, label } of PEER_DIMS) {
    const value = entry[key]
    if (!Number.isFinite(value) || value <= 0) continue
    const peerVals = others.map(o => o[key]).filter(v => Number.isFinite(v) && v > 0)
    if (peerVals.length === 0) continue
    const peerAvg = peerVals.reduce((a, b) => a + b, 0) / peerVals.length
    const delta = Number((value - peerAvg).toFixed(1))
    deltas.push({
      dim: key,
      label,
      value,
      peerAvg: Number(peerAvg.toFixed(2)),
      delta,
      outlier: Math.abs(delta) >= OUTLIER_THRESHOLD,
      peerN: peerVals.length,
      confidence: confidenceTier(peerVals.length, minPeers),
    })
  }
  deltas.sort((a, b) => b.delta - a.delta)

  // Closest comparables — other companies only (a sibling posting at the
  // same company is dedup noise, not a comparable), closest overall first.
  const comparables: PeerComparable[] = others
    .filter(o => !sameCompany(o.company, entry.company))
    .map(o => ({
      company:  o.company,
      role:     o.role,
      overall:  Number(o.overall.toFixed(2)),
      tier:     o.tier,
      location: o.location,
      _delta:   Math.abs(o.overall - entry.overall),
    }))
    .sort((a, b) => a._delta - b._delta || b.overall - a.overall)
    .slice(0, 3)
    .map(({ _delta, ...rest }) => rest)

  return {
    archetype: seg,
    nPeers,
    rankPosition,
    percentile,
    rankLabel: rankLabel(percentile, rankPosition, nPeers),
    overall: entry.overall,
    peerOveralls: others.map(o => o.overall),
    deltas,
    comparables,
    confidence: confidenceTier(nPeers, minPeers),
    minPeers,
  }
}

// ─── Batched rank index (Database "Peers" column) ───────────────────────────
//
// The Database table needs the rank/percentile signal for HUNDREDS of rows at
// once. Calling peerContext per row would re-dedupe the full score history and
// re-walk every cohort for each row — O(rows × history). buildPeerRankIndex
// does the expensive part ONCE (dedupe + group by primary archetype + sort),
// then rankOf() answers per-row in O(log cohort) via binary search.
//
// Semantics are IDENTICAL to peerContext's rank math (pinned by parity tests
// in peerRank.test.ts): same latest-row-per-entity dedupe, same self-exclusion
// by entityId, same strictly-below "beats" counting (ties rank below), same
// MIN_PEERS omit rule. rankOf(entry) ranks the entry's OWN overall — exactly
// what peerContext does — so the column and the slide-over panel agree even
// when the passed row differs from the deduped-latest row for its entity.

export interface PeerRankSummary {
  /** Primary archetype segment the cohort was matched on. */
  archetype: string
  /** Cohort size INCLUDING this entity. */
  nPeers: number
  /** 1 = top. Ties rank below (same convention as peerContext). */
  rankPosition: number
  /** % of the cohort scoring strictly below this entity. */
  percentile: number
  band: PeerBand
  /** Panel-style label ("top quartile", "bottom half (#7 of 12)"). */
  rankLabel: string
  /** Chip-style label ("top 25%", "#7/12"). */
  compactLabel: string
  /** ADDED (docs § 3.2) — tier over `nPeers`, identical to peerContext's. */
  confidence: ConfidenceTier
  /** ADDED — the omit gate this cohort cleared. */
  minPeers: number
}

export interface PeerRankIndex {
  /** Rank the entry vs. its live archetype cohort, or null when the entry is
   *  unscored / archetype-less / the cohort is under minPeers (omit rule —
   *  the caller renders nothing, never a placeholder). */
  rankOf(entry: ScoreEntry): PeerRankSummary | null
}

interface CohortIndex {
  /** Deduped cohort overalls, sorted ascending — binary-search substrate. */
  overalls: number[]
  /** entityId → that entity's deduped overall, for self-exclusion. */
  byId: Map<string, number>
}

/** Count of values in the ascending-sorted array strictly below `target`. */
function countBelow(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function buildPeerRankIndex(
  history: ScoreEntry[],
  { minPeers = MIN_PEERS }: { minPeers?: number } = {},
): PeerRankIndex {
  const cohorts = new Map<string, CohortIndex>()
  for (const [id, row] of dedupeLatestPerEntity(history)) {
    const seg = primaryArchetype(row.archetype).toLowerCase()
    if (!seg) continue
    let cohort = cohorts.get(seg)
    if (!cohort) {
      cohort = { overalls: [], byId: new Map() }
      cohorts.set(seg, cohort)
    }
    cohort.overalls.push(row.overall)
    cohort.byId.set(id, row.overall)
  }
  for (const cohort of cohorts.values()) cohort.overalls.sort((a, b) => a - b)

  return {
    rankOf(entry: ScoreEntry): PeerRankSummary | null {
      if (!entry || !Number.isFinite(entry.overall) || entry.overall <= 0) return null
      const seg = primaryArchetype(entry.archetype)
      if (!seg) return null
      const cohort = cohorts.get(seg.toLowerCase())

      // Others = the deduped cohort minus this entity (when present).
      const selfId = entityId(entry.company, entry.role, parseCities(entry.location))
      const selfOverall = cohort?.byId.get(selfId)
      const othersCount = (cohort?.overalls.length ?? 0) - (selfOverall !== undefined ? 1 : 0)
      const nPeers = othersCount + 1
      if (nPeers < minPeers) return null

      let beats = countBelow(cohort?.overalls ?? [], entry.overall)
      if (selfOverall !== undefined && selfOverall < entry.overall) beats -= 1
      const percentile = Math.round((beats / nPeers) * 100)
      const rankPosition = nPeers - beats
      const band = peerBand(percentile)
      return {
        archetype: seg,
        nPeers,
        rankPosition,
        percentile,
        band,
        rankLabel: rankLabel(percentile, rankPosition, nPeers),
        compactLabel: compactRankLabel(band, rankPosition, nPeers),
        confidence: confidenceTier(nPeers, minPeers),
        minPeers,
      }
    },
  }
}
