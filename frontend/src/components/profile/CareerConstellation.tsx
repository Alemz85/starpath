'use client'

// CareerConstellation — your career rendered as a galaxy. The center
// is you (avatar). The inner orbit holds the companies you've engaged
// with most — sized by # of evaluations, glow tinted by avg score so
// "high-quality" companies project a brighter halo. The outer orbit
// holds the role archetypes you target. Hover anywhere pauses the
// system; clicking an orbiter drills into the relevant view.
//
// The orbit metaphor isn't decoration — distance from center = how
// abstract (companies are concrete; archetypes are categorical), and
// glow temperature = how the user's evaluations have averaged out for
// that node. Removing the visualization would lose information.

import { useMemo } from 'react'
import { useDataStore } from '@/store/data'
import { useNavStore } from '@/store/nav'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { OrbitingSystem, type OrbiterConfig } from '@/components/ui/orbiting'
import { canonicalizeArchetype } from '@/lib/archetype'
import { scoreColor } from '@/lib/tier'

interface Props {
  initials: string
}

export function CareerConstellation({ initials }: Props) {
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const navigate = useNavStore(s => s.navigate)

  const { companies, archetypes } = useMemo(() => {
    const companyMap = new Map<string, { count: number; sumScore: number }>()
    for (const e of scoreHistory) {
      if (!e.company) continue
      const cur = companyMap.get(e.company) ?? { count: 0, sumScore: 0 }
      cur.count += 1
      if (typeof e.overall === 'number' && e.overall > 0) cur.sumScore += e.overall
      companyMap.set(e.company, cur)
    }
    const companies = [...companyMap.entries()]
      .map(([name, { count, sumScore }]) => ({
        name,
        count,
        avg: count > 0 ? sumScore / count : 0,
      }))
      .sort((a, b) => b.count - a.count || b.avg - a.avg)
      .slice(0, 5)

    const archMap = new Map<string, { count: number; sumScore: number }>()
    for (const e of scoreHistory) {
      const a = canonicalizeArchetype(e.archetype)
      if (!a || a === 'Unknown' || a === 'unknown') continue
      const cur = archMap.get(a) ?? { count: 0, sumScore: 0 }
      cur.count += 1
      if (typeof e.overall === 'number' && e.overall > 0) cur.sumScore += e.overall
      archMap.set(a, cur)
    }
    const archetypes = [...archMap.entries()]
      .map(([name, { count, sumScore }]) => ({
        name,
        count,
        avg: count > 0 ? sumScore / count : 0,
      }))
      .sort((a, b) => b.avg - a.avg || b.count - a.count)
      .slice(0, 4)

    return { companies, archetypes }
  }, [scoreHistory])

  if (companies.length < 2) return null

  // Click handlers route into the Database with the appropriate
  // tokenized filter (`company:Foo` / `archetype:Foo`). The
  // applyCommandKFilter receiver in databaseFilters.ts forces showClosed
  // on so the filter always returns rows.
  const innerOrbit: OrbiterConfig[] = companies.map((c, i) => {
    const sizeBoost = Math.min(c.count, 8)
    const orbiterSize = 38 + sizeBoost * 1.4
    return {
      id: `c-${c.name}`,
      size: orbiterSize,
      glow: scoreColor(c.avg),
      phase: (i * 2 * Math.PI) / Math.max(companies.length, 1),
      label: `${c.name} · ${c.count} ${c.count === 1 ? 'eval' : 'evals'}${c.avg > 0 ? ` · avg ${c.avg.toFixed(1)}` : ''}`,
      onClick: () => navigate('database', `company:${c.name}`),
      content: <CompanyLogo company={c.name} size={Math.min(28, 22 + sizeBoost * 0.8)} />,
    }
  })

  const outerOrbit: OrbiterConfig[] = archetypes.map((a, i) => ({
    id: `a-${a.name}`,
    size: 70,
    glow: scoreColor(a.avg),
    phase: (i * 2 * Math.PI) / Math.max(archetypes.length, 1),
    label: `${a.name} · ${a.count} ${a.count === 1 ? 'eval' : 'evals'}${a.avg > 0 ? ` · avg ${a.avg.toFixed(1)}` : ''}`,
    onClick: () => navigate('database', `archetype:${a.name}`),
    content: (
      <span className="text-[9.5px] text-text-2 font-medium tracking-tight px-2 leading-[1.15] text-center">
        {shortLabel(a.name)}
      </span>
    ),
  }))

  return (
    <div className="relative rounded-xl bg-bg-panel border border-border-default overflow-hidden">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-1">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">
          Your career constellation
        </span>
        <span className="text-micro text-text-4">
          {companies.length} {companies.length === 1 ? 'company' : 'companies'} · {archetypes.length} {archetypes.length === 1 ? 'archetype' : 'archetypes'}
        </span>
      </div>
      <div className="relative flex items-center justify-center py-6">
        {/* Soft galaxy wash behind the orbit — accent radial that fades
            so the rings sit on a tinted surface rather than flat panel */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at center, rgba(124, 92, 255, 0.08) 0%, transparent 65%)',
          }}
        />
        <OrbitingSystem
          size={420}
          innerOrbit={innerOrbit}
          outerOrbit={outerOrbit.length > 0 ? outerOrbit : undefined}
          innerRadius={94}
          outerRadius={172}
          innerSpeed={0.20}
          outerSpeed={-0.12}
          center={(
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-accent/35 blur-md scale-110" />
              <div className="relative w-[60px] h-[60px] rounded-full bg-gradient-to-br from-accent via-accent-hover to-accent-press flex items-center justify-center text-white font-semibold text-[18px] shadow-lift">
                {initials}
              </div>
            </div>
          )}
        />
      </div>
    </div>
  )
}

function shortLabel(name: string): string {
  if (name.length <= 16) return name
  // Drop trailing parenthetical or trailing words past the first 16 chars
  const trimmed = name.slice(0, 15).replace(/\s+\S*$/, '')
  return `${trimmed}…`
}
