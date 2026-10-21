'use client'

import { useEffect, useState, useMemo } from 'react'
import {
  MapPin, Briefcase, Flame, Award, Rocket, Compass, Layers, Search, Star, Gem,
  Gamepad2, MessageSquare, Trophy, type LucideIcon,
} from 'lucide-react'
import { ipc } from '@/lib/ipc'
import { useDataStore } from '@/store/data'
import { useAppStore } from '@/store/app'
import { cn } from '@/lib/utils'
import { TIER_COLOR } from '@/lib/tier'
import { buildHeatmap, computeStreak, badges, buildHighlights, tierHeatColor } from '@/lib/profileStats'
import { PageHeader, Panel, StatStrip, Stat, Chip, TierChip } from '@/components/ui'
import { CareerConstellation } from './CareerConstellation'
import { themeColor } from '@/lib/themes'

// ─── Profile YAML helpers ────────────────────────────────────────────────────

function extract(yaml: string, key: string): string {
  return yaml.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim() ?? ''
}

function extractRoles(yaml: string): string[] {
  // Find the target_roles.primary (or targeting.roles) key, then read only
  // its own list: the capture ends at the next two-space key or top-level
  // comment (same bound as extractPrimaryRoles in SettingsView) and at the
  // first line that is not a list item, so it never runs on into
  // dream_companies: and picks up its `- name:` entries.
  const lines = yaml.split('\n')
  const start = lines.findIndex(l => /^\s+(primary|roles):/.test(l))
  if (start === -1) return []
  const inline = lines[start].match(/:\s*\[([^\]]*)\]/)
  if (inline) {
    return inline[1].split(',')
      .map(r => r.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean).slice(0, 8)
  }
  const roles: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s+#/.test(line)) continue   // blank / indented comment
    if (/^ {2}\w/.test(line) || /^#/.test(line)) break  // next key or top-level comment
    const m = line.match(/^\s*-\s+["']?([^"'\n\[\]]+)["']?/)
    if (!m) break                                        // not a list item
    roles.push(m[1].trim())
  }
  return roles.filter(Boolean).slice(0, 8)
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
      className={cn('rounded bg-bg-panel animate-pulse', className)}
    />
  )
}

// ─── Loading skeleton for the identity card ──────────────────────────────────

function HeroSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading profile" className="card p-5">
      <div className="flex items-start gap-4">
        <Shimmer className="w-12 h-12 rounded-full shrink-0" />
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
    <div role="status" className="card border-dashed border-border-strong p-8 text-center">
      <p className="text-body text-text-3">
        No evaluations yet. Run a scan or paste a job listing to get started.
      </p>
    </div>
  )
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return (
    <p className="text-label text-text-4">No score data yet</p>
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
    <div className="w-full" aria-label={`Match trend over last ${values.length} evaluations`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-12 overflow-visible"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={themeColor('accent')} stopOpacity="0.18" />
            <stop offset="100%" stopColor={themeColor('accent')} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#sg)" />
        <path d={linePath} fill="none" stroke={themeColor('accent')} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last.x} cy={last.y} r="3" fill={themeColor('accent')} />
        <text x={last.x + 6} y={last.y + 1} fontSize="9" fill={themeColor('text-3')} dominantBaseline="middle">
          {values[values.length - 1].toFixed(1)}
        </text>
      </svg>
      <div className="flex justify-between mt-1" aria-hidden="true">
        <span className="text-micro text-text-4">Earliest</span>
        <span className="text-micro text-text-4">Most recent</span>
      </div>
    </div>
  )
}

// ─── Achievement icons ───────────────────────────────────────────────────────
//
// One lucide glyph per badge id from profileStats.badges(); unknown ids fall
// back to Award so a new badge never renders blank.

const BADGE_ICON: Record<string, LucideIcon> = {
  first:     Rocket,         // Launched
  ten:       Compass,        // Getting started
  fifty:     Layers,         // Pipeline builder
  hundred:   Search,         // Power searcher
  t1first:   Star,           // First T1
  t1five:    Gem,            // Elite finder
  applied:   Gamepad2,       // In the game
  interview: MessageSquare,  // Interview ready
  offer:     Trophy,         // Offer received
  streak:    Flame,          // 3-day streak
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
    const t1 = byTier('T1'); const t2 = byTier('T2')
    const t3 = byTier('T3'); const t4 = byTier('T4')
    // Mean Match over scored rows (blocked rows carry no scores).
    const matchScores = scoreHistory.map(e => e.match).filter((w): w is number => w != null && Number.isFinite(w))
    const avg = matchScores.length > 0 ? matchScores.reduce((s, w) => s + w, 0) / matchScores.length : 0
    const applied    = applications.filter(a => ['Applied','Responded','Interview','Offer'].includes(a.status)).length
    const interviews = applications.filter(a => ['Interview','Offer'].includes(a.status)).length
    const streak = computeStreak(scoreHistory)
    return { total, t1, t2, t3, t4, avg, applied, interviews, streak }
  }, [scoreHistory, applications])

  const heatWeeks = useMemo(() => buildHeatmap(scoreHistory), [scoreHistory])
  const sparkValues = useMemo(() =>
    [...scoreHistory].filter(e => e.match != null).sort((a, b) => a.date.localeCompare(b.date)).slice(-20).map(e => e.match as number),
    [scoreHistory])
  const badgeList = useMemo(() => badges(scoreHistory, applications), [scoreHistory, applications])
  const highlights = useMemo(() => buildHighlights(scoreHistory), [scoreHistory])

  const initials = profile?.name
    ? profile.name.split(' ').slice(0, 2).map((n: string) => n[0]).join('').toUpperCase()
    : '?'

  const tierPct = (n: number) => stats.total > 0 ? Math.max(2, (n / stats.total) * 100) : 0

  const unlockedCount = badgeList.filter(b => b.unlocked).length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Profile" />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-5 py-5 flex flex-col gap-4">

          {/* ── Identity ── */}
          {profileLoading ? (
            <HeroSkeleton />
          ) : (
            /* Identity block: avatar + who you are on the left, the T1 count on
               the right. The data panels below carry the full numerics. */
            <section aria-label="Profile summary" className="card p-5">
              <div className="flex items-start gap-4">
                <div
                  className="w-12 h-12 rounded-full bg-accent text-white text-section font-semibold flex items-center justify-center shrink-0 select-none"
                  aria-hidden="true"
                >
                  {initials}
                </div>

                <div className="flex-1 min-w-0">
                  <h2 className="text-title text-text-1 truncate">
                    {profile?.name || 'Your name'}
                  </h2>
                  {profile?.headline && (
                    <p className="text-body text-text-3 mt-0.5">{profile.headline}</p>
                  )}
                  <div className="flex items-center gap-x-3 gap-y-1 mt-2 flex-wrap text-label text-text-3" aria-label="Profile details">
                    {profile?.location && (
                      <span className="flex items-center gap-1">
                        <MapPin size={12} className="text-text-4 shrink-0" aria-hidden="true" />
                        {profile.location}
                      </span>
                    )}
                    {profile?.comp && (
                      <span className="flex items-center gap-1">
                        <Briefcase size={12} className="text-text-4 shrink-0" aria-hidden="true" />
                        {profile.comp} {profile.currency}
                      </span>
                    )}
                    {stats.streak > 0 && (
                      <span
                        className="flex items-center gap-1 font-medium text-text-2"
                        aria-label={`${stats.streak}-day evaluation streak`}
                      >
                        <Flame size={12} className="text-warning-text shrink-0" aria-hidden="true" />
                        {stats.streak}-day streak
                      </span>
                    )}
                  </div>

                  {/* Activity summary sentence */}
                  {stats.total > 0 ? (
                    <p className="text-label text-text-3 mt-3 max-w-[58ch]">
                      <span className="text-text-1 font-medium">{stats.total}</span>{' '}
                      {stats.total === 1 ? 'evaluation' : 'evaluations'}.{' '}
                      {stats.applied > 0 && (
                        <>
                          <span className="text-text-1 font-medium">{stats.applied}</span>{' '}
                          {stats.applied === 1 ? 'application' : 'applications'} sent
                          {stats.interviews > 0 ? `, ${stats.interviews} reached interviews.` : '.'}
                        </>
                      )}
                      {stats.applied === 0 && stats.avg > 0 && (
                        <>Average Match <span className="text-text-1 font-medium">{stats.avg.toFixed(1)}</span>.</>
                      )}
                    </p>
                  ) : (
                    <p className="text-label text-text-4 mt-3">No evaluations yet</p>
                  )}
                </div>

                {/* T1 figure, only when meaningful */}
                {stats.t1 > 0 && (
                  <div
                    className="shrink-0 self-center pl-5 border-l border-border-default"
                    aria-label={`${stats.t1} Tier 1 matches`}
                  >
                    <Stat value={<span className="text-tier-1">{stats.t1}</span>} label="T1 matches" />
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── Career constellation ── */}
          <CareerConstellation initials={initials} />

          {/* ── Zero-data state, once we know the profile loaded ── */}
          {!profileLoading && stats.total === 0 && <EmptyState />}

          {/* ── The rest only renders when there's data to display ── */}
          {stats.total > 0 && (
            <>
              {/* ── Activity heatmap ── */}
              <Panel
                title="Activity"
                meta={`Last 13 weeks · ${stats.total} evaluation${stats.total === 1 ? '' : 's'}`}
              >
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
                          className="w-[11px] h-[11px] rounded-[2px] transition-opacity duration-150 hover:opacity-75 cursor-default"
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
                    { color: themeColor('bg-panel'),  label: 'None' },
                    { color: TIER_COLOR.T4, label: 'T4'   },
                    { color: TIER_COLOR.T3, label: 'T3'   },
                    { color: TIER_COLOR.T2, label: 'T2'   },
                    { color: TIER_COLOR.T1, label: 'T1'   },
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
              </Panel>

              {/* ── Match trend + Tier breakdown ── */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Panel title="Match trend" meta={sparkValues.length > 1 ? `Last ${sparkValues.length} evaluations` : undefined}>
                  <Sparkline values={sparkValues} />
                </Panel>

                <Panel title="Tier breakdown">
                  <div className="space-y-2.5" role="list" aria-label="Evaluations by tier">
                    {[
                      { tier: 'T1', n: stats.t1, bar: 'bg-tier-1' },
                      { tier: 'T2', n: stats.t2, bar: 'bg-tier-2' },
                      { tier: 'T3', n: stats.t3, bar: 'bg-tier-3' },
                      { tier: 'T4', n: stats.t4, bar: 'bg-tier-4' },
                    ].map(({ tier, n, bar }) => (
                      <div
                        key={tier}
                        role="listitem"
                        aria-label={`${tier}: ${n} evaluation${n === 1 ? '' : 's'} (${tierPct(n).toFixed(0)}%)`}
                        className="flex items-center gap-2.5"
                      >
                        <TierChip tier={tier} size="sm" className="w-7 justify-center shrink-0" />
                        <div className="flex-1 h-[5px] bg-bg-elevated rounded-full overflow-hidden" aria-hidden="true">
                          <div
                            className={cn('h-full rounded-full transition-all duration-500 ease-quart', bar)}
                            style={{ width: `${tierPct(n)}%` }}
                          />
                        </div>
                        <span className="text-label text-text-3 w-6 text-right" aria-hidden="true">
                          {n}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>

              {/* ── Highlights: personal records ── */}
              {highlights && (
                <Panel title="Highlights">
                  <div role="list" aria-label="Personal records">
                    <StatStrip>
                      {highlights.map(h => (
                        <div key={h.label} role="listitem" className="flex-1 min-w-0 px-5 first:pl-0 last:pr-0">
                          <Stat
                            value={<span title={h.value}>{h.value}</span>}
                            label={h.label}
                            hint={<span title={h.sub}>{h.sub}</span>}
                            className="[&_.text-stat]:min-w-0 [&_.text-stat]:truncate"
                          />
                        </div>
                      ))}
                    </StatStrip>
                  </div>
                </Panel>
              )}

              {/* ── Target roles + Superpowers ── */}
              {((profile?.roles?.length ?? 0) > 0 || (profile?.powers?.length ?? 0) > 0) && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {(profile?.roles?.length ?? 0) > 0 && (
                    <Panel title="Target roles">
                      <div className="flex flex-wrap gap-1.5" role="list" aria-label="Target roles">
                        {profile!.roles.map(role => (
                          <Chip key={role} role="listitem" tone="accent" size="md">
                            {role}
                          </Chip>
                        ))}
                      </div>
                    </Panel>
                  )}
                  {(profile?.powers?.length ?? 0) > 0 && (
                    <Panel title="Superpowers">
                      <ul className="space-y-1.5" aria-label="Key superpowers">
                        {profile!.powers.slice(0, 5).map((p, i) => (
                          <li key={i} className="flex items-start gap-2 text-label text-text-2">
                            <span className="w-1 h-1 rounded-full bg-text-4 mt-[7px] shrink-0" aria-hidden="true" />
                            {p}
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Achievements: always shown (locked badges encourage engagement) ── */}
          <Panel title="Achievements" meta={`${unlockedCount} of ${badgeList.length} unlocked`}>
            <div
              className="grid grid-cols-4 gap-2 sm:grid-cols-5"
              role="list"
              aria-label={`Achievements: ${unlockedCount} of ${badgeList.length} unlocked`}
            >
              {badgeList.map(badge => {
                const Icon = BADGE_ICON[badge.id] ?? Award
                const highlight = badge.unlocked && badge.rarity !== 'common'
                return (
                  <div
                    key={badge.id}
                    role="listitem"
                    aria-label={`${badge.label}${badge.unlocked ? ' — unlocked' : ' — locked'}: ${badge.desc}`}
                    title={badge.desc}
                    className={cn(
                      'card p-2.5 flex flex-col items-center gap-1.5 text-center',
                      !badge.unlocked && 'opacity-40',
                    )}
                  >
                    <span
                      className={cn(
                        'w-7 h-7 rounded flex items-center justify-center shrink-0',
                        highlight ? 'bg-accent-soft text-accent-text' : 'bg-bg-elevated text-text-2',
                      )}
                      aria-hidden="true"
                    >
                      <Icon size={14} />
                    </span>
                    <span className="text-micro text-text-2 leading-tight">
                      {badge.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </Panel>

        </div>
      </div>
    </div>
  )
}
