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
//      than an average that includes the score being explained. The same
//      applies to the Match / Ease peer averages.
// Rank / percentile / minPeers / the ±1.5 outlier threshold / the rank-label
// bands / the same-company exclusion for comparables all mirror the script.
// (Minor: a dimension cell of 0 is read as "not scored" — v2 rubric dims are
// 1–10, so a 0 can only be a legacy placeholder, never a real judgment.)
//
// Scoring v2 (docs/scoring-v2.md §5, §9): peers are ranked on PRIORITY
// (sqrt(Match × Ease)) — the sort key, never a headline score. The listing's
// Match and its Ease are ALSO each placed among the same peers — two separate
// claims, never combined (mirrors the script's `match` / `ease` blocks). The
// dimension outliers run over all ten v2 dimensions, the script's
// targeting-core DIMENSIONS (salary_adj_city included: it is script-computed,
// not a lever, but "salary for the city sits 2 below peers" is still a true
// and useful comparison). A blocked target (eligibility red / verdict
// blocked) gets no block; blocked rows never enter a cohort.
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

import type { ScoreEntry, Verdict } from '@/types'
import { entityId, parseCities } from '@/lib/entityId'
import { GATES, confidenceTier, type ConfidenceTier } from '@/lib/scoringStats'
import { DIM_LABELS, V2_DIMS, isBlocked, priorityOf, verdictOf, type V2DimKey } from '@/lib/scoreBands'

/** All ten v2 dimensions in report row order (motivators, hygiene, Ease) —
 *  the same set and order as targeting-core's DIMENSIONS, which the script
 *  iterates for its outliers. */
export const PEER_DIMS: ReadonlyArray<{ key: V2DimKey; label: string }> =
  V2_DIMS.map(key => ({ key, label: DIM_LABELS[key] }))

export type PeerDimKey = V2DimKey

/** |Δ| from the peer average at which a dimension counts as an outlier —
 *  same threshold as scripts/peer-rank.mjs. Deliberately expressed in RAW
 *  rubric points (a full step and a half, comfortably above one-step judge
 *  wobble), not in Priority points, so it is never confused with the 0.30
 *  Priority noise floor (docs § 3.2). */
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

/** Where the listing's Match (or its Ease) sits among the same peers — the
 *  twin of the script's `match` / `ease` blocks. One claim per metric; Match
 *  and Ease are never combined into one placement. */
export interface PeerPlacement {
  /** This entity's Match (or Ease). */
  value: number
  /** Mean of the OTHER peers' values (2 decimals). */
  peerAvg: number
  /** % of the peers carrying this metric (self included) strictly below. */
  percentile: number
  /** Same bands and wording as the Priority rank label. */
  rankLabel: string
  /** 1 = top. Ties rank below. */
  rankPosition: number
  /** Peers carrying this metric, INCLUDING this entity. Can be smaller than
   *  `nPeers` when a peer row has a Priority but no stored Match / Ease. */
  peerN: number
  /** Tier over `peerN` with the peer gate. */
  confidence: ConfidenceTier
}

export interface PeerComparable {
  company: string
  role: string
  match: number | null
  ease: number | null
  /** Sort key the comparables were matched on. */
  priority: number
  verdict: Verdict | null
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
  /** This entity's Priority (the rank key, echoed for the renderer). */
  priority: number
  /** Where this entity's Match sits among the same peers; null when the
   *  entity (or every peer) has no Match. */
  match: PeerPlacement | null
  /** Where this entity's Ease sits among the same peers; null likewise. */
  ease: PeerPlacement | null
  /** The OTHER peers' Priorities — feeds the distribution strip. */
  peerPriorities: number[]
  /** All comparable dimensions, sorted by delta descending (strongest
   *  advantage first, biggest lag last). */
  deltas: PeerDimDelta[]
  /** Up to 3 closest peers by Priority, other companies only. */
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
 *  listings count once. Blocked rows (eligibility red / verdict blocked) and
 *  rows without a Priority are dropped — the script's peer filter. */
export function dedupeLatestPerEntity(rows: ScoreEntry[]): Map<string, ScoreEntry> {
  const byEntity = new Map<string, ScoreEntry>()
  for (const r of rows) {
    if (isBlocked(r) || priorityOf(r) == null) continue
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

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v)

/** Place `value` among `others` (self counted as the +1), script math. */
function placement(value: number, others: number[], minPeers: number): PeerPlacement {
  const peerN = others.length + 1
  const beats = others.filter(v => v < value).length
  const percentile = Math.round((beats / peerN) * 100)
  const rankPosition = peerN - beats
  const avg = others.reduce((a, b) => a + b, 0) / others.length
  return {
    value,
    peerAvg: Number(avg.toFixed(2)),
    percentile,
    rankLabel: rankLabel(percentile, rankPosition, peerN),
    rankPosition,
    peerN,
    confidence: confidenceTier(peerN, minPeers),
  }
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
  if (!entry || isBlocked(entry)) return null
  const selfPriority = priorityOf(entry)
  if (selfPriority == null) return null
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
  const pr = (o: ScoreEntry) => priorityOf(o) as number // dedupe guarantees non-null
  const beats = others.filter(o => pr(o) < selfPriority).length
  const percentile = Math.round((beats / nPeers) * 100)
  const rankPosition = nPeers - beats

  // Match and Ease, each placed among the same peers — separate claims.
  const metricPlacement = (metric: 'match' | 'ease'): PeerPlacement | null => {
    const value = entry[metric]
    if (!finite(value)) return null
    const vals = others.map(o => o[metric]).filter(finite)
    if (vals.length === 0) return null
    return placement(value, vals, minPeers)
  }

  // Dimension deltas vs the rest of the cohort. Dims missing on this entity
  // (null = not scored) are skipped rather than rendered as a fake gap.
  const deltas: PeerDimDelta[] = []
  for (const { key, label } of PEER_DIMS) {
    const value = entry[key]
    if (value == null || !Number.isFinite(value) || value <= 0) continue
    const peerVals = others.map(o => o[key]).filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
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
  // same company is dedup noise, not a comparable), closest Priority first.
  const comparables: PeerComparable[] = others
    .filter(o => !sameCompany(o.company, entry.company))
    .map(o => ({
      company:  o.company,
      role:     o.role,
      match:     o.match,
      ease:     o.ease,
      priority: Number(pr(o).toFixed(2)),
      verdict:  verdictOf(o),
      tier:     o.tier,
      location: o.location,
      _delta:   Math.abs(pr(o) - selfPriority),
    }))
    .sort((a, b) => a._delta - b._delta || b.priority - a.priority)
    .slice(0, 3)
    .map(({ _delta, ...rest }) => rest)

  return {
    archetype: seg,
    nPeers,
    rankPosition,
    percentile,
    rankLabel: rankLabel(percentile, rankPosition, nPeers),
    priority: selfPriority,
    match: metricPlacement('match'),
    ease: metricPlacement('ease'),
    peerPriorities: others.map(pr),
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
// MIN_PEERS omit rule. rankOf(entry) ranks the entry's OWN priority — exactly
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
   *  blocked / unscored / archetype-less / the cohort is under minPeers (omit rule —
   *  the caller renders nothing, never a placeholder). */
  rankOf(entry: ScoreEntry): PeerRankSummary | null
}

interface CohortIndex {
  /** Deduped cohort priorities, sorted ascending — binary-search substrate. */
  priorities: number[]
  /** entityId → that entity's deduped priority, for self-exclusion. */
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
      cohort = { priorities: [], byId: new Map() }
      cohorts.set(seg, cohort)
    }
    const p = priorityOf(row) as number
    cohort.priorities.push(p)
    cohort.byId.set(id, p)
  }
  for (const cohort of cohorts.values()) cohort.priorities.sort((a, b) => a - b)

  return {
    rankOf(entry: ScoreEntry): PeerRankSummary | null {
      const selfP = entry && !isBlocked(entry) ? priorityOf(entry) : null
      if (selfP == null) return null
      const seg = primaryArchetype(entry.archetype)
      if (!seg) return null
      const cohort = cohorts.get(seg.toLowerCase())

      // Others = the deduped cohort minus this entity (when present).
      const selfId = entityId(entry.company, entry.role, parseCities(entry.location))
      const selfStored = cohort?.byId.get(selfId)
      const othersCount = (cohort?.priorities.length ?? 0) - (selfStored !== undefined ? 1 : 0)
      const nPeers = othersCount + 1
      if (nPeers < minPeers) return null

      let beats = countBelow(cohort?.priorities ?? [], selfP)
      if (selfStored !== undefined && selfStored < selfP) beats -= 1
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
