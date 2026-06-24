// Aggregate stats for the per-company dossier (CompanyView). Pure over the
// company's score-history rows so the numbers are testable in isolation —
// the view layers application status + the roles table on top.

import type { ScoreEntry } from '@/types'
import { parseCities } from './entityId'

export interface CompanyStats {
  /** Total score-history rows on disk for this company. */
  evalCount: number
  /** Distinct roles evaluated (case-insensitive). */
  roleCount: number
  /** Rows carrying a real score (> 0) — the denominator for averages. */
  scoredCount: number
  /** Highest overall seen (0 when nothing is scored yet). */
  bestScore: number
  /** Mean overall across scored rows (0 when none). */
  avgScore: number
  /** Strongest tier present, normalized (T2-high → T2). null when none. */
  bestTier: string | null
  /** Distinct cities across every evaluation, sorted. */
  cities: string[]
}

// T1 is strongest; T2-high sits just under T1 in the backend scoring math
// but collapses to T2 for display (matches the ingest normalization).
const TIER_RANK: Record<string, number> = {
  'T1': 4, 'T2-high': 3, 'T2': 2, 'T3': 1, 'T4': 0,
}

function normalizeTier(tier: string): string {
  return tier === 'T2-high' ? 'T2' : tier
}

export function computeCompanyStats(history: ScoreEntry[]): CompanyStats {
  const roles = new Set<string>()
  const cities = new Set<string>()
  let bestScore = 0
  let scoreSum = 0
  let scoredCount = 0
  let bestTier: string | null = null
  let bestTierRank = -1

  for (const e of history) {
    if (e.role.trim()) roles.add(e.role.trim().toLowerCase())
    for (const c of parseCities(e.location).cities) cities.add(c)

    if (e.overall > 0) {
      scoredCount += 1
      scoreSum += e.overall
      if (e.overall > bestScore) bestScore = e.overall
    }

    const rank = TIER_RANK[e.tier] ?? -1
    if (rank > bestTierRank) {
      bestTierRank = rank
      bestTier = normalizeTier(e.tier)
    }
  }

  return {
    evalCount: history.length,
    roleCount: roles.size,
    scoredCount,
    bestScore,
    avgScore: scoredCount > 0 ? scoreSum / scoredCount : 0,
    bestTier,
    cities: [...cities].sort(),
  }
}
