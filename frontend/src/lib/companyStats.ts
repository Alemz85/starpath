// Aggregate stats for the per-company dossier (CompanyView). Pure over the
// company's score-history rows so the numbers are testable in isolation —
// the view layers application status + the roles table on top.
//
// Scoring v2: Want and Ease are reported separately (no Overall); "best" is
// the row with the highest Priority (the sort key) and its verdict; blocked
// rows count as evaluations but never as scored.

import type { ScoreEntry, Verdict } from '@/types'
import { parseCities } from './entityId'
import { isScored, normalizeTier, priorityOf, verdictOf, VERDICT_RANK } from './scoreBands'

export interface CompanyStats {
  /** Total score-history rows on disk for this company. */
  evalCount: number
  /** Distinct roles evaluated (case-insensitive). */
  roleCount: number
  /** Rows carrying Want and Ease (blocked excluded) — the average base. */
  scoredCount: number
  /** Blocked (eligibility red) evaluations. */
  blockedCount: number
  /** Want / Ease of the highest-Priority row (null when nothing is scored). */
  best: { want: number; ease: number; verdict: Verdict | null } | null
  /** Mean Want / Ease across scored rows (null when none). */
  avgWant: number | null
  avgEase: number | null
  /** Best verdict present (blocked counts — it is a verdict). null when none. */
  bestVerdict: Verdict | null
  /** Strongest storage tier present. null when none. */
  bestTier: string | null
  /** Distinct cities across every evaluation, sorted. */
  cities: string[]
}

const TIER_RANK: Record<string, number> = { T1: 4, T2: 2, T3: 1, T4: 0 }

export function computeCompanyStats(history: ScoreEntry[]): CompanyStats {
  const roles = new Set<string>()
  const cities = new Set<string>()
  let wantSum = 0
  let easeSum = 0
  let scoredCount = 0
  let blockedCount = 0
  let best: CompanyStats['best'] = null
  let bestPriority = -1
  let bestVerdict: Verdict | null = null
  let bestTier: string | null = null
  let bestTierRank = -1

  for (const e of history) {
    if (e.role.trim()) roles.add(e.role.trim().toLowerCase())
    for (const c of parseCities(e.location).cities) cities.add(c)

    const v = verdictOf(e)
    if (v && (bestVerdict == null || VERDICT_RANK[v] > VERDICT_RANK[bestVerdict])) bestVerdict = v
    if (v === 'blocked') blockedCount += 1

    if (isScored(e)) {
      scoredCount += 1
      wantSum += e.want as number
      easeSum += e.ease as number
      const p = priorityOf(e) ?? 0
      if (p > bestPriority) {
        bestPriority = p
        best = { want: e.want as number, ease: e.ease as number, verdict: v }
      }
    }

    const tier = normalizeTier(e.tier)
    const rank = tier ? TIER_RANK[tier] : -1
    if (tier && rank > bestTierRank) {
      bestTierRank = rank
      bestTier = tier
    }
  }

  return {
    evalCount: history.length,
    roleCount: roles.size,
    scoredCount,
    blockedCount,
    best,
    avgWant: scoredCount > 0 ? wantSum / scoredCount : null,
    avgEase: scoredCount > 0 ? easeSum / scoredCount : null,
    bestVerdict,
    bestTier,
    cities: [...cities].sort(),
  }
}
