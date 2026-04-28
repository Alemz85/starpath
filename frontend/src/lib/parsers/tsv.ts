import type { ScoreEntry } from '@/types'

function num(v: string): number {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

function normalizeTier(raw: string): ScoreEntry['tier'] {
  const t = raw.toLowerCase().trim()
  if (t === 't1' || t === 'tier-1') return 'T1'
  if (t === 't2-high' || t === 'short-high') return 'T2-high'
  if (t === 't2' || t === 'short') return 'T2'
  if (t === 't3' || t === 'gap') return 'T3'
  if (t === 't4' || t === 'skip' || t === 'growth' || t === 'pipeline') return 'T4'
  return raw
}

export function parseScoreHistory(tsv: string): ScoreEntry[] {
  const lines = tsv.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split('\t').map(h => h.trim())

  return lines.slice(1).flatMap(line => {
    const cols = line.split('\t').map(c => c.trim())
    // Pad short rows with '' so a header column added later (e.g. `url`)
    // doesn't silently skip the entire pre-existing dataset.
    if (cols.length === 0) return []
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = cols[i] ?? '' })

    // Skip rows with no meaningful data
    if (!row.company || !row.role) return []

    return [{
      date:            row.date ?? '',
      archetype:       row.archetype ?? '',
      skills_match:    num(row.skills_match),
      ease_of_entry:   num(row.ease_of_entry),
      strategic_fit:   num(row.strategic_fit),
      current_fit:     num(row.current_fit),
      growth_mobility: num(row.growth_mobility),
      optionality_exit:num(row.optionality_exit),
      brand_value:     num(row.brand_value),
      sales_trap_risk: num(row.sales_trap_risk),
      aspirational_fit:num(row.aspirational_fit),
      overall:         num(row.overall),
      best_cities:     num(row.best_cities),
      salary_adj_city: num(row.salary_adj_city),
      work_life_balance:num(row.work_life_balance),
      best_fit_roles:  row.best_fit_roles ?? '',
      mode:            (row.mode === 'oferta' ? 'oferta' : 'scouting') as ScoreEntry['mode'],
      company:         row.company,
      role:            row.role,
      tier:            normalizeTier(row.tier ?? ''),
      source:          row.source ?? '',
      location:        row.location ?? '',
      employment_type: row.employment_type ?? '',
      duration:        row.duration ?? '',
      salary_raw:      row.salary_raw ?? '',
      url:             row.url ?? '',
    } satisfies ScoreEntry]
  })
}
