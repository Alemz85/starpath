import type { ScoreEntry } from '@/types'
import {
  assignVerdict,
  computePriority,
  normalizeEligibility,
  normalizeTier,
  normalizeVerdict,
  VERDICT_TIER,
} from '../scoreBands'

// data/score-history.tsv, v2 header (docs/scoring-v2.md §8.1). Parsed BY
// HEADER NAME — column order is not load-bearing. v1 history was archived on
// the switch (data/archive/scoring-v1/), so no v1 compatibility here.

/** Empty / non-numeric cell → null. Blocked rows leave every dimension,
 *  Want, Ease and Priority empty — those must read as missing, never as 0. */
function num(v: string | undefined): number | null {
  const t = (v ?? '').trim()
  if (!t) return null
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : null
}

export function parseScoreHistory(tsv: string): ScoreEntry[] {
  const lines = tsv.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split('\t').map(h => h.trim())

  return lines.slice(1).flatMap(line => {
    const cols = line.split('\t').map(c => c.trim())
    if (cols.length === 0) return []
    // Pad short rows with '' so a header column added later doesn't silently
    // drop the whole pre-existing dataset.
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = cols[i] ?? '' })

    if (!row.company || !row.role) return []

    const eligibility = normalizeEligibility(row.eligibility)
    const want = num(row.want)
    const ease = num(row.ease)
    // Verdict cell first; replay the grid only when it's empty.
    const verdict = normalizeVerdict(row.verdict)
      ?? assignVerdict({ want, ease, eligibility })?.verdict
      ?? null
    const tier = normalizeTier(row.tier) ?? (verdict ? VERDICT_TIER[verdict] : (row.tier ?? ''))
    const blocked = eligibility === 'red' || verdict === 'blocked'

    return [{
      date:              row.date ?? '',
      archetype:         row.archetype ?? '',
      skills_match:      num(row.skills_match),
      experience_bar:    num(row.experience_bar),
      competition:       num(row.competition),
      ease,
      growth_mobility:   num(row.growth_mobility),
      optionality_exit:  num(row.optionality_exit),
      brand_value:       num(row.brand_value),
      role_content:      num(row.role_content),
      best_cities:       num(row.best_cities),
      salary_adj_city:   num(row.salary_adj_city),
      work_life_balance: num(row.work_life_balance),
      want,
      priority:          blocked ? null : (num(row.priority) ?? computePriority(want, ease)),
      eligibility,
      eligibility_flags: row.eligibility_flags ?? '',
      verdict,
      best_fit_roles:    row.best_fit_roles ?? '',
      mode:              (row.mode === 'oferta' ? 'oferta' : 'scouting') as ScoreEntry['mode'],
      company:           row.company,
      role:              row.role,
      tier,
      source:            row.source ?? '',
      location:          row.location ?? '',
      employment_type:   row.employment_type ?? '',
      duration:          row.duration ?? '',
      salary_raw:        row.salary_raw ?? '',
      url:               row.url ?? '',
    } satisfies ScoreEntry]
  })
}
