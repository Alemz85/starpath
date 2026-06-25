'use client'

import { useEffect, useState, useMemo } from 'react'
import { MapPin, Briefcase, Zap, Award, Target, Calendar, TrendingUp, Flame, Sparkles } from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import { TIER_HEX } from '@/lib/tier'
import { buildHeatmap, computeStreak, badges, buildHighlights, tierHeatColor } from '@/lib/profileStats'
import { CareerConstellation } from './CareerConstellation'

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

// ─── Skeleton shimmer block ───────────────────────────────────────────────────

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-md bg-bg-panel animate-pulse',
        className,
      )}
    />
  )
}

// ─── Loading skeleton for the hero card ──────────────────────────────────────

function HeroSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading profile"
      className="rounded-xl bg-bg-panel border border-border-default p-6 shadow-cosmos"
    >
      <div className="flex items-start gap-5">
        <Shimmer className="w-16 h-16 rounded-full shrink-0" />
        <div className="flex-1 min-w-0 pt-0.5 space-y-2">
          <Shimmer className="h-4 w-36" />
          <Shimmer className="h-3 w-52" />
          <Shimmer className="h-3 w-28" />
        </div>
      </div>
    </div>
  )
}

// ─── Empty-state card (zero evaluations) ─────────────────────────────────────

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-border-strong bg-bg-panel p-8 text-center"
    >
      <p className="text-body text-text-3">
        No evaluations yet — run a scan or paste a job listing to get started.
      </p>
    </div>
  )
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return (
    <p className="text-micro text-text-4 italic mt-1">No score data yet</p>
  )

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
    <div className="w-full" aria-label={`Score trend over last ${values.length} evaluations`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-12 overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#sg)" />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last.x} cy={last.y} r="3" fill="var(--accent)" />
        <text x={last.x + 6} y={last.y + 1} fontSize="9" fill="#5D6C7B" dominantBaseline="middle">
          {values[values.length - 1].toFixed(1)}
        </text>
      </svg>
      <div className="flex justify-between mt-0.5" aria-hidden="true">
        <span className="text-micro text-text-4">earliest</span>
        <span className="text-micro text-text-4">most recent</span>
      </div>
    </div>
  )
}

// ─── Section heading ─────────────────────────────────────────────────────────

function SectionHeading({
  icon: Icon,
  label,
  meta,
}: {
  icon: React.ElementType
  label: string
  meta?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-label font-medium text-text-2 flex items-center gap-1.5">
        <Icon size={12} className="text-text-4 shrink-0" aria-hidden="true" />
        {label}
      </h2>
      {meta && <span className="text-micro text-text-4">{meta}</span>}
    </div>
  )
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl bg-bg-panel border border-border-default p-4', className)}>
      {children}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function ProfileView() {
  const repoPath = useAppStore(s => s.repoPath)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const applications = useDataStore(s => s.applications)
  const [profileRaw, setProfileRaw] = useState<string | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)

  useEffect(() => {
    if (!repoPath) return
    setProfileLoading(true)
    ipc.readFile('user/profile.yml').then(raw => {
      setProfileRaw(raw)
      setProfileLoading(false)
    }).catch(() => setProfileLoading(false))
  }, [repoPath])

  const profile = useMemo(() => {
    if (!profileRaw) return null
    return {
      name:      extract(profileRaw, 'full_name'),
      location:  extract(profileRaw, 'location'),
      headline:  extract(profileRaw, 'headline'),
      comp:      extract(profileRaw, 'target_range'),
      currency:  extract(profileRaw, 'currency') || 'USD',
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
  const highlights = useMemo(() => buildHighlights(scoreHistory), [scoreHistory])

  const initials = profile?.name
    ? profile.name.split(' ').slice(0, 2).map((n: string) => n[0]).join('').toUpperCase()
    : '?'

  const tierPct = (n: number) => stats.total > 0 ? Math.max(2, (n / stats.total) * 100) : 0

  const unlockedCount = badgeList.filter(b => b.unlocked).length

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-base">
      {/* Title bar — extends to y=0 with pt-7 clearing the macOS traffic-light zone */}
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Profile</h1>
      </div>

      <div className="flex-1 overflow-y-auto max-w-[740px] mx-auto w-full px-5 pb-10 pt-4 space-y-4">

        {/* ── Hero card ── */}
        {profileLoading ? (
          <HeroSkeleton />
        ) : (
          /* Editorial profile card: avatar + identity left, hero figure (T1 hits) right.
             The richer data sections below carry the full numerics so a stat-card
             row here would be redundant. */
          <section
            aria-label="Profile summary"
            className="relative rounded-xl bg-bg-panel border border-border-default p-6 overflow-hidden shadow-cosmos"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-accent/6 via-transparent to-tier-1/5 pointer-events-none" aria-hidden="true" />
            <div className="relative flex items-start gap-5">
              {/* Avatar */}
              <div className="relative shrink-0" aria-hidden="true">
                <div className="absolute inset-0 rounded-full bg-accent/30 blur-md scale-110" />
                <div className="relative w-16 h-16 rounded-full bg-gradient-to-br from-accent via-accent-hover to-accent-press flex items-center justify-center text-white font-semibold text-xl shadow-lift select-none">
                  {initials}
                </div>
              </div>

              {/* Identity */}
              <div className="flex-1 min-w-0 pt-0.5">
                <h2 className="text-[17px] font-semibold text-text-1 leading-tight tracking-[-0.01em]">
                  {profile?.name || 'Your Name'}
                </h2>
                {profile?.headline && (
                  <p className="text-body text-text-3 mt-1">{profile.headline}</p>
                )}
                <div className="flex items-center gap-3 mt-2 flex-wrap" aria-label="Profile details">
                  {profile?.location && (
                    <span className="flex items-center gap-1 text-label text-text-4">
                      <MapPin size={10} aria-hidden="true" />
                      {profile.location}
                    </span>
                  )}
                  {profile?.comp && (
                    <span className="flex items-center gap-1 text-label text-text-4">
                      <Briefcase size={10} aria-hidden="true" />
                      {profile.comp} {profile.currency}
                    </span>
                  )}
                  {stats.streak > 0 && (
                    <span
                      className="flex items-center gap-1 text-label text-warning font-medium"
                      aria-label={`${stats.streak}-day evaluation streak`}
                    >
                      <Flame size={10} aria-hidden="true" />
                      {stats.streak}-day streak
                    </span>
                  )}
                </div>

                {/* Activity summary prose */}
                {stats.total > 0 ? (
                  <p className="text-label text-text-3 mt-3 max-w-[58ch]">
                    <span className="text-text-1 font-medium tabular-nums">{stats.total}</span>{' '}
                    {stats.total === 1 ? 'evaluation' : 'evaluations'}.{' '}
                    {stats.applied > 0 && (
                      <>
                        <span className="text-text-1 font-medium tabular-nums">{stats.applied}</span>{' '}
                        {stats.applied === 1 ? 'application' : 'applications'} sent
                        {stats.interviews > 0 ? `, ${stats.interviews} reached interviews.` : '.'}
                      </>
                    )}
                    {stats.applied === 0 && stats.avg > 0 && (
                      <>Average score <span className="text-text-1 font-medium tabular-nums">{stats.avg.toFixed(1)}</span>.</>
                    )}
                  </p>
                ) : (
                  <p className="text-label text-text-4 mt-3 italic">No evaluations yet</p>
                )}
              </div>

              {/* T1 hero figure — only when meaningful */}
              {stats.t1 > 0 && (
                <div
                  className="shrink-0 self-stretch flex flex-col items-center justify-center pl-4 border-l border-border-default/60"
                  aria-label={`${stats.t1} Tier 1 matches`}
                >
                  <span className="text-display-2 font-mono font-semibold tabular-nums leading-none text-tier-1">
                    {stats.t1}
                  </span>
                  <span className="text-micro text-text-4 uppercase tracking-wider mt-2" aria-hidden="true">
                    T1 hits
                  </span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Career constellation ── */}
        <CareerConstellation initials={initials} />

        {/* ── Zero-data state — show once we know the profile loaded ── */}
        {!profileLoading && stats.total === 0 && <EmptyState />}

        {/* ── The rest only renders when there's data to display ── */}
        {stats.total > 0 && (
          <>
            {/* ── Activity heatmap ── */}
            <Card>
              <SectionHeading
                icon={Calendar}
                label="Activity — last 13 weeks"
                meta={`${stats.total} evaluation${stats.total === 1 ? '' : 's'} total`}
              />
              <div
                role="img"
                aria-label={`Activity heatmap: ${stats.total} evaluations across the last 13 weeks`}
                className="flex gap-[3px]"
              >
                {heatWeeks.map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-[3px]">
                    {week.map((cell, di) => (
                      <div
                        key={di}
                        role="presentation"
                        aria-label={
                          cell.count > 0
                            ? `${cell.date}: ${cell.count} eval${cell.count > 1 ? 's' : ''}, best tier ${cell.bestTier || 'T4'}`
                            : `${cell.date}: no evaluations`
                        }
                        title={cell.count > 0 ? `${cell.date}: ${cell.count} eval${cell.count > 1 ? 's' : ''} (${cell.bestTier || 'T4'})` : cell.date}
                        className="w-[11px] h-[11px] rounded-[2px] transition-all duration-150 hover:opacity-75 hover:scale-110 cursor-default"
                        style={{ backgroundColor: tierHeatColor(cell.bestTier, cell.count) }}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-3 mt-3 flex-wrap" aria-label="Heatmap legend: tier colors">
                <span className="text-micro text-text-4">Less</span>
                {[
                  { color: '#F1F4F7',              label: 'none' },
                  { color: TIER_HEX.T4,         label: 'T4'   },
                  { color: TIER_HEX.T3,         label: 'T3'   },
                  { color: TIER_HEX.T2,         label: 'T2'   },
                  { color: TIER_HEX['T2-high'], label: 'T2+'  },
                  { color: TIER_HEX.T1,         label: 'T1'   },
                ].map(({ color, label }) => (
                  <span key={label} className="flex items-center gap-1">
                    <span
                      className="w-[11px] h-[11px] rounded-[2px] inline-block shrink-0"
                      style={{ backgroundColor: color }}
                      aria-hidden="true"
                    />
                    <span className="text-micro text-text-4">{label}</span>
                  </span>
                ))}
                <span className="text-micro text-text-4">More</span>
              </div>
            </Card>

            {/* ── Score trend + Tier breakdown ── */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <Card>
                <SectionHeading icon={TrendingUp} label="Score trend" />
                <Sparkline values={sparkValues} />
              </Card>

              <Card>
                <SectionHeading icon={Target} label="Tier breakdown" />
                {/* T2-high uses accent-hover (the gradient stop between T1 and T2)
                    — bg-success is reserved for offer/positive status, not tier
                    strength. Gradient runs T1 indigo → T2-high → T2 → T3 → T4. */}
                <div className="space-y-2.5" role="list" aria-label="Evaluations by tier">
                  {[
                    { label: 'T1',  n: stats.t1,  bar: 'bg-tier-1',      txt: 'text-tier-1'      },
                    { label: 'T2+', n: stats.t2h, bar: 'bg-accent-hover', txt: 'text-accent-hover' },
                    { label: 'T2',  n: stats.t2,  bar: 'bg-accent',       txt: 'text-accent'       },
                    { label: 'T3',  n: stats.t3,  bar: 'bg-tier-3',       txt: 'text-tier-3'       },
                    { label: 'T4',  n: stats.t4,  bar: 'bg-tier-4',       txt: 'text-tier-4'       },
                  ].map(({ label, n, bar, txt }) => (
                    <div
                      key={label}
                      role="listitem"
                      aria-label={`${label}: ${n} evaluation${n === 1 ? '' : 's'} (${tierPct(n).toFixed(0)}%)`}
                      className="flex items-center gap-2"
                    >
                      <span className={cn('text-micro font-mono w-5 shrink-0 font-semibold', txt)}>
                        {label}
                      </span>
                      <div className="flex-1 h-[5px] bg-bg-elevated rounded-full overflow-hidden" aria-hidden="true">
                        <div
                          className={cn('h-full rounded-full transition-all duration-500 ease-quart', bar)}
                          style={{ width: `${tierPct(n)}%` }}
                        />
                      </div>
                      <span className="text-micro font-mono text-text-4 w-5 text-right" aria-hidden="true">
                        {n}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {/* ── Highlights — personal records ── */}
            {highlights && (
              <Card>
                <SectionHeading icon={Sparkles} label="Highlights" />
                <div className="grid grid-cols-3 gap-2.5" role="list" aria-label="Personal records">
                  {highlights.map(h => (
                    <div
                      key={h.label}
                      role="listitem"
                      className="rounded-lg bg-bg-elevated border border-border-default px-3 py-2.5"
                    >
                      <div className="text-micro text-text-4 uppercase tracking-wider">{h.label}</div>
                      <div
                        className="text-[15px] font-semibold text-text-1 tabular-nums mt-1 truncate"
                        title={h.value}
                      >
                        {h.value}
                      </div>
                      <div
                        className="text-micro text-text-4 mt-0.5 truncate"
                        title={h.sub}
                      >
                        {h.sub}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* ── Target roles + Superpowers ── */}
            {((profile?.roles?.length ?? 0) > 0 || (profile?.powers?.length ?? 0) > 0) && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {(profile?.roles?.length ?? 0) > 0 && (
                  <Card>
                    <SectionHeading icon={Zap} label="Target roles" />
                    <div className="flex flex-wrap gap-1.5" role="list" aria-label="Target roles">
                      {profile!.roles.map(role => (
                        <span
                          key={role}
                          role="listitem"
                          className="px-2.5 py-1 rounded-md bg-accent/10 border border-accent/20 text-accent text-label font-medium"
                        >
                          {role}
                        </span>
                      ))}
                    </div>
                  </Card>
                )}
                {(profile?.powers?.length ?? 0) > 0 && (
                  <Card>
                    <SectionHeading icon={Flame} label="Superpowers" />
                    <ul className="space-y-1.5" aria-label="Key superpowers">
                      {profile!.powers.slice(0, 5).map((p, i) => (
                        <li key={i} className="flex items-start gap-2 text-label text-text-3">
                          <span className="text-accent mt-0.5 shrink-0" aria-hidden="true">·</span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Achievements — always shown (locked badges encourage engagement) ── */}
        <Card>
          <SectionHeading
            icon={Award}
            label="Achievements"
            meta={`${unlockedCount} / ${badgeList.length} unlocked`}
          />
          <div
            className="grid grid-cols-4 gap-2 sm:grid-cols-5"
            role="list"
            aria-label={`Achievements: ${unlockedCount} of ${badgeList.length} unlocked`}
          >
            {badgeList.map(badge => (
              <div
                key={badge.id}
                role="listitem"
                aria-label={`${badge.label}${badge.unlocked ? ' — unlocked' : ' — locked'}: ${badge.desc}`}
                title={badge.desc}
                className={cn(
                  'flex flex-col items-center gap-1.5 p-2.5 rounded-lg border text-center transition-all duration-200',
                  badge.unlocked ? (
                    badge.rarity === 'epic'
                      // Epic: tier-1 indigo glow (matches the badge tint, not gold — DESIGN-meta §7)
                      ? 'border-tier-1/40 bg-tier-1/6 shadow-[0_0_12px_rgba(61,43,181,0.18)]'
                      : badge.rarity === 'rare'
                      ? 'border-accent/25 bg-accent/6'
                      : 'border-border-default bg-bg-elevated'
                  ) : 'border-border-default bg-bg-base opacity-30 grayscale',
                )}
              >
                <span className="text-[20px] leading-none" aria-hidden="true">{badge.icon}</span>
                <span className={cn(
                  'text-[9.5px] leading-tight font-medium text-center',
                  badge.unlocked ? 'text-text-2' : 'text-text-4',
                )}>
                  {badge.label}
                </span>
              </div>
            ))}
          </div>
        </Card>

      </div>
    </div>
  )
}
