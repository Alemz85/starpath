'use client'

import { useEffect, useState, useMemo } from 'react'
import { MapPin, Briefcase, Zap, Award, Target, Calendar, TrendingUp, Flame } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import type { ScoreEntry, ApplicationEntry } from '@/types'

// ─── Profile YAML helpers ────────────────────────────────────────────────────

function extract(yaml: string, key: string): string {
  return yaml.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim() ?? ''
}

function extractRoles(yaml: string): string[] {
  // Find target_roles.primary or targeting.roles block
  const idx = yaml.search(/^\s+(primary|roles):/m)
  if (idx === -1) return []
  const after = yaml.slice(idx)
  const matches = [...after.matchAll(/^\s+-\s+["']?([^"'\n\[\]]+)["']?/gm)]
  return matches.map(m => m[1].trim()).filter(Boolean).slice(0, 8)
}

function extractList(yaml: string, key: string): string[] {
  const idx = yaml.search(new RegExp(`^\\s+${key}:`, 'm'))
  if (idx === -1) return []
  const after = yaml.slice(idx)
  // stop at next same-level key
  const blockEnd = after.slice(key.length).search(/\n\s{0,4}\w/)
  const block = blockEnd > -1 ? after.slice(0, blockEnd + key.length) : after.slice(0, 600)
  return [...block.matchAll(/^\s+-\s+["']?([^"'\n\[\]]+)["']?/gm)]
    .map(m => m[1].trim()).filter(Boolean)
}

// ─── Activity heatmap ────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { T1: 5, 'T2-high': 4, T2: 3, T3: 2, T4: 1 }

function tierHeatColor(tier: string, count: number): string {
  if (count === 0) return '#F1F4F7'
  const map: Record<string, string> = {
    T1: '#C99518', 'T2-high': '#2ABBA7', T2: '#7C5CFF', T3: '#A0612C', T4: '#CED0D4',
  }
  return map[tier] ?? '#CED0D4'
}

interface HeatCell { date: string; count: number; bestTier: string }

function buildHeatmap(history: ScoreEntry[]): HeatCell[][] {
  const map = new Map<string, HeatCell>()
  for (const e of history) {
    const d = e.date.slice(0, 10)
    const prev = map.get(d)
    const rank = TIER_RANK[e.tier] ?? 1
    if (!prev) {
      map.set(d, { date: d, count: 1, bestTier: e.tier })
    } else {
      map.set(d, {
        date: d,
        count: prev.count + 1,
        bestTier: rank > (TIER_RANK[prev.bestTier] ?? 1) ? e.tier : prev.bestTier,
      })
    }
  }

  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - 90)
  start.setDate(start.getDate() - start.getDay()) // rewind to Sunday

  const weeks: HeatCell[][] = []
  const cur = new Date(start)
  while (cur <= today) {
    const week: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const iso = cur.toISOString().slice(0, 10)
      week.push(map.get(iso) ?? { date: iso, count: 0, bestTier: '' })
      cur.setDate(cur.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="text-micro text-text-4 italic">No data yet</p>

  const W = 260; const H = 52
  const min = Math.min(...values); const max = Math.max(...values)
  const range = max - min || 1

  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * W,
    y: H - ((v - min) / range) * (H - 6) - 3,
  }))

  const linePath = `M${pts.map(p => `${p.x},${p.y}`).join(' L')}`
  const areaPath = `${linePath} L${W},${H} L0,${H} Z`
  const last = pts[pts.length - 1]

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12 overflow-visible">
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7C5CFF" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#7C5CFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#sg)" />
        <path d={linePath} fill="none" stroke="#7C5CFF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last.x} cy={last.y} r="3" fill="#7C5CFF" />
        <text x={last.x + 6} y={last.y + 1} fontSize="9" fill="#5D6C7B" dominantBaseline="middle">
          {values[values.length - 1].toFixed(1)}
        </text>
      </svg>
      <div className="flex justify-between mt-0.5">
        <span className="text-micro text-text-4">earliest</span>
        <span className="text-micro text-text-4">most recent</span>
      </div>
    </div>
  )
}

// ─── Achievements ─────────────────────────────────────────────────────────────

interface Badge {
  id: string; icon: string; label: string; desc: string
  unlocked: boolean; rarity: 'common' | 'rare' | 'epic'
}

function computeStreak(history: ScoreEntry[]): number {
  const dates = [...new Set(history.map(e => e.date.slice(0, 10)))].sort().reverse()
  let streak = 0
  const today = new Date()
  let check = new Date(today)
  for (const d of dates) {
    const iso = check.toISOString().slice(0, 10)
    if (d === iso) {
      streak++
      check.setDate(check.getDate() - 1)
    } else if (d < iso) break
  }
  return streak
}

function badges(history: ScoreEntry[], apps: ApplicationEntry[]): Badge[] {
  const t1 = history.filter(e => e.tier === 'T1').length
  const streak = computeStreak(history)
  const hasApplied  = apps.some(a => ['Applied','Responded','Interview','Offer'].includes(a.status))
  const hasInterview = apps.some(a => ['Interview','Offer'].includes(a.status))
  const hasOffer     = apps.some(a => a.status === 'Offer')

  return [
    { id: 'first',     icon: '🚀', label: 'Launched',       desc: 'First evaluation done',         unlocked: history.length >= 1,   rarity: 'common' },
    { id: 'ten',       icon: '🎯', label: 'Getting Started', desc: 'Evaluated 10+ opportunities',   unlocked: history.length >= 10,  rarity: 'common' },
    { id: 'fifty',     icon: '⚡', label: 'Pipeline Builder', desc: '50+ evaluations',              unlocked: history.length >= 50,  rarity: 'rare'   },
    { id: 'hundred',   icon: '💫', label: 'Power Searcher',  desc: '100+ evaluations',              unlocked: history.length >= 100, rarity: 'epic'   },
    { id: 't1first',   icon: '⭐', label: 'First T1',        desc: 'First Tier 1 opportunity',      unlocked: t1 >= 1,               rarity: 'rare'   },
    { id: 't1five',    icon: '🌟', label: 'Elite Finder',    desc: '5+ T1 hits',                    unlocked: t1 >= 5,               rarity: 'epic'   },
    { id: 'applied',   icon: '📨', label: 'In the Game',     desc: 'First application submitted',   unlocked: hasApplied,            rarity: 'common' },
    { id: 'interview', icon: '🤝', label: 'Interview Ready', desc: 'Landed an interview',           unlocked: hasInterview,          rarity: 'rare'   },
    { id: 'offer',     icon: '🎉', label: 'Offer Received',  desc: 'Got a job offer',               unlocked: hasOffer,              rarity: 'epic'   },
    { id: 'streak',    icon: '🔥', label: '3-Day Streak',    desc: 'Evaluated 3 days in a row',     unlocked: streak >= 3,           rarity: 'rare'   },
  ]
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function ProfileView() {
  const { repoPath } = useAppStore()
  const { scoreHistory, applications } = useDataStore()
  const [profileRaw, setProfileRaw] = useState<string | null>(null)

  useEffect(() => {
    if (!repoPath) return
    ipc.readFile('user/profile.yml').then(raw => setProfileRaw(raw))
  }, [repoPath])

  const profile = useMemo(() => {
    if (!profileRaw) return null
    return {
      name:      extract(profileRaw, 'full_name'),
      location:  extract(profileRaw, 'location'),
      headline:  extract(profileRaw, 'headline'),
      comp:      extract(profileRaw, 'target_range'),
      currency:  extract(profileRaw, 'currency') || 'USD',
      // `phase` is the canonical key; `current_mode` is read for legacy
      // profile.yml files until the launch routine rewrites them.
      phase:     (extract(profileRaw, 'phase') || extract(profileRaw, 'current_mode') || 'exploring')
                   .replace(/^scouting$/, 'exploring')
                   .replace(/^job-seeking$/, 'applying'),
      roles:     extractRoles(profileRaw),
      powers:    extractList(profileRaw, 'superpowers'),
    }
  }, [profileRaw])

  const stats = useMemo(() => {
    const total = scoreHistory.length
    const byTier = (t: string) => scoreHistory.filter(e => e.tier === t).length
    const t1 = byTier('T1'); const t2h = byTier('T2-high'); const t2 = byTier('T2')
    const t3 = byTier('T3'); const t4 = byTier('T4')
    const avg = total > 0 ? scoreHistory.reduce((s, e) => s + e.overall, 0) / total : 0
    const applied    = applications.filter(a => ['Applied','Responded','Interview','Offer'].includes(a.status)).length
    const interviews = applications.filter(a => ['Interview','Offer'].includes(a.status)).length
    const streak = computeStreak(scoreHistory)
    return { total, t1, t2h, t2, t3, t4, avg, applied, interviews, streak }
  }, [scoreHistory, applications])

  const heatWeeks = useMemo(() => buildHeatmap(scoreHistory), [scoreHistory])
  const sparkValues = useMemo(() =>
    [...scoreHistory].sort((a, b) => a.date.localeCompare(b.date)).slice(-20).map(e => e.overall),
    [scoreHistory])
  const badgeList = useMemo(() => badges(scoreHistory, applications), [scoreHistory, applications])

  const initials = profile?.name
    ? profile.name.split(' ').slice(0, 2).map((n: string) => n[0]).join('').toUpperCase()
    : '?'

  const tierPct = (n: number) => stats.total > 0 ? Math.max(2, (n / stats.total) * 100) : 0

  const unlockedCount = badgeList.filter(b => b.unlocked).length

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-base">
      {/* Top bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Profile</h1>
      </div>

      <div className="flex-1 overflow-y-auto max-w-[740px] mx-auto w-full px-5 pb-10 pt-4 space-y-4">

        {/* ── Hero ── */}
        <div className="relative rounded-xl bg-bg-panel border border-border-default p-5 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-accent/6 via-transparent to-[#E8B547]/3 pointer-events-none" />
          <div className="relative flex items-start gap-4">
            {/* Avatar with glow */}
            <div className="relative shrink-0">
              <div className="absolute inset-0 rounded-full bg-accent/30 blur-md scale-110" />
              <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-accent via-[#6B48E8] to-[#4A2FA8] flex items-center justify-center text-white font-semibold text-xl shadow-lg">
                {initials}
              </div>
              <div className={cn(
                'absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-bg-panel',
                profile?.phase === 'exploring' ? 'bg-info' : 'bg-success',
              )} title={profile?.phase === 'exploring' ? 'Exploring' : 'Applying'} />
            </div>

            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[16px] font-semibold text-text-1 leading-tight">
                  {profile?.name || 'Your Name'}
                </h1>
                <span className={cn(
                  'text-[10px] font-mono font-medium px-2 py-0.5 rounded-full border',
                  profile?.phase === 'exploring'
                    ? 'text-info border-info/30 bg-info/10'
                    : 'text-success border-success/30 bg-success/10',
                )}>
                  {profile?.phase === 'exploring' ? '● Exploring' : '● Applying'}
                </span>
              </div>
              {profile?.headline && (
                <p className="text-body text-text-3 mt-0.5">{profile.headline}</p>
              )}
              <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                {profile?.location && (
                  <span className="flex items-center gap-1 text-label text-text-4">
                    <MapPin size={10} />{profile.location}
                  </span>
                )}
                {profile?.comp && (
                  <span className="flex items-center gap-1 text-label text-text-4">
                    <Briefcase size={10} />{profile.comp} {profile.currency}
                  </span>
                )}
                {stats.streak > 0 && (
                  <span className="flex items-center gap-1 text-label text-warning">
                    <Flame size={10} />{stats.streak}-day streak
                  </span>
                )}
              </div>
            </div>

            {/* XP pill */}
            <div className="shrink-0 flex flex-col items-center gap-0.5 pt-1">
              <span className="text-2xl font-semibold font-mono text-tier-1">{stats.total}</span>
              <span className="text-micro text-text-4 uppercase tracking-wider">evals</span>
            </div>
          </div>
        </div>

        {/* ── Stats bar ── */}
        <div className="grid grid-cols-5 gap-2.5">
          {[
            { label: 'T1 Hits',     value: stats.t1,             sub: 'top tier',  color: 'text-tier-1'  },
            { label: 'Avg Score',   value: stats.avg.toFixed(1), sub: '/ 10.0',    color: 'text-accent'  },
            { label: 'Applied',     value: stats.applied,        sub: 'sent',      color: 'text-info'    },
            { label: 'Interviews',  value: stats.interviews,     sub: 'reached',   color: 'text-warning' },
            { label: 'Badges',      value: `${unlockedCount}/10`, sub: 'unlocked', color: 'text-tier-1'  },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="rounded-lg bg-bg-panel border border-border-default p-3 flex flex-col items-center gap-0.5 text-center">
              <span className={cn('text-[22px] font-semibold font-mono leading-none', color)}>{value}</span>
              <span className="text-[11px] text-text-2 font-medium mt-1">{label}</span>
              <span className="text-micro text-text-4">{sub}</span>
            </div>
          ))}
        </div>

        {/* Edit panel was here briefly — moved to the dedicated
            Configuration tab so this Profile remains a clean read-only
            showcase. To edit anything (identity / comp / languages /
            target roles / portals) navigate to Configuration. */}

        {/* ── Activity heatmap ── */}
        <div className="rounded-xl bg-bg-panel border border-border-default p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5">
              <Calendar size={11} className="text-text-4" />
              Activity — last 13 weeks
            </h2>
            <span className="text-micro text-text-4">{stats.total} evaluations total</span>
          </div>
          <div className="flex gap-[3px]">
            {heatWeeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((cell, di) => (
                  <div
                    key={di}
                    title={cell.count > 0 ? `${cell.date}: ${cell.count} eval${cell.count > 1 ? 's' : ''} (${cell.bestTier || 'T4'})` : cell.date}
                    className="w-[11px] h-[11px] rounded-[2px] transition-opacity hover:opacity-75"
                    style={{ backgroundColor: tierHeatColor(cell.bestTier, cell.count) }}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-3">
            <span className="text-micro text-text-4">Less</span>
            {[
              { color: '#F1F4F7', label: 'none' },
              { color: '#CED0D4', label: 'T4'   },
              { color: '#A0612C', label: 'T3'   },
              { color: '#7C5CFF', label: 'T2'   },
              { color: '#2ABBA7', label: 'T2+'  },
              { color: '#C99518', label: 'T1'   },
            ].map(({ color, label }) => (
              <span key={label} className="flex items-center gap-1">
                <span className="w-[11px] h-[11px] rounded-[2px] inline-block" style={{ backgroundColor: color }} />
                <span className="text-micro text-text-4">{label}</span>
              </span>
            ))}
            <span className="text-micro text-text-4">More</span>
          </div>
        </div>

        {/* ── Sparkline + Tier distribution ── */}
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl bg-bg-panel border border-border-default p-4">
            <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5 mb-3">
              <TrendingUp size={11} className="text-text-4" />
              Score trend
            </h2>
            <Sparkline values={sparkValues} />
          </div>

          <div className="rounded-xl bg-bg-panel border border-border-default p-4">
            <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5 mb-3">
              <Target size={11} className="text-text-4" />
              Tier breakdown
            </h2>
            {stats.total > 0 ? (
              <div className="space-y-2.5">
                {[
                  { label: 'T1',  n: stats.t1,  bar: 'bg-tier-1',  txt: 'text-tier-1'  },
                  { label: 'T2+', n: stats.t2h, bar: 'bg-success',  txt: 'text-success'  },
                  { label: 'T2',  n: stats.t2,  bar: 'bg-accent',   txt: 'text-accent'   },
                  { label: 'T3',  n: stats.t3,  bar: 'bg-tier-3',   txt: 'text-tier-3'   },
                  { label: 'T4',  n: stats.t4,  bar: 'bg-text-4/40',txt: 'text-text-4'   },
                ].map(({ label, n, bar, txt }) => (
                  <div key={label} className="flex items-center gap-2">
                    <span className={cn('text-micro font-mono w-5 shrink-0 font-semibold', txt)}>{label}</span>
                    <div className="flex-1 h-[5px] bg-bg-elevated rounded-full overflow-hidden">
                      <div className={cn('h-full rounded-full', bar)} style={{ width: `${tierPct(n)}%` }} />
                    </div>
                    <span className="text-micro font-mono text-text-4 w-5 text-right">{n}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-micro text-text-4 italic">No evaluations yet</p>
            )}
          </div>
        </div>

        {/* ── Target roles + Superpowers ── */}
        {((profile?.roles?.length ?? 0) > 0 || (profile?.powers?.length ?? 0) > 0) && (
          <div className="grid grid-cols-2 gap-2.5">
            {(profile?.roles?.length ?? 0) > 0 && (
              <div className="rounded-xl bg-bg-panel border border-border-default p-4">
                <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5 mb-3">
                  <Zap size={11} className="text-text-4" />
                  Target roles
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {profile!.roles.map(role => (
                    <span key={role} className="px-2.5 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent text-label font-medium">
                      {role}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(profile?.powers?.length ?? 0) > 0 && (
              <div className="rounded-xl bg-bg-panel border border-border-default p-4">
                <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5 mb-3">
                  <Flame size={11} className="text-text-4" />
                  Superpowers
                </h2>
                <ul className="space-y-1.5">
                  {profile!.powers.slice(0, 5).map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-label text-text-3">
                      <span className="text-accent mt-0.5 shrink-0">·</span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ── Achievements ── */}
        <div className="rounded-xl bg-bg-panel border border-border-default p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5">
              <Award size={11} className="text-text-4" />
              Achievements
            </h2>
            <span className="text-micro text-text-4">{unlockedCount} / {badgeList.length} unlocked</span>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {badgeList.map(badge => (
              <div
                key={badge.id}
                title={badge.desc}
                className={cn(
                  'flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-center transition-all duration-200',
                  badge.unlocked ? (
                    badge.rarity === 'epic'
                      ? 'border-tier-1/40 bg-tier-1/6 shadow-[0_0_12px_rgba(232,181,71,0.08)]'
                      : badge.rarity === 'rare'
                      ? 'border-accent/25 bg-accent/6'
                      : 'border-border-default bg-bg-elevated'
                  ) : 'border-border-default bg-bg-base opacity-25 grayscale',
                )}
              >
                <span className="text-[20px] leading-none">{badge.icon}</span>
                <span className={cn(
                  'text-[9.5px] leading-tight font-medium text-center',
                  badge.unlocked ? 'text-text-2' : 'text-text-4',
                )}>
                  {badge.label}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}
