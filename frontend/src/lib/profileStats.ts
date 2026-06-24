// Profile gamification stats — pure aggregations over the evaluation corpus
// that drive the Profile tab's activity heatmap, streak, badges, and
// personal-records highlights.
//
// Extracted from ProfileView so the logic is testable in isolation (the
// component keeps only its profile.yml parsing + JSX). The two date-sensitive
// functions take an injectable `now`, defaulting to the real clock, so tests
// can pin "today" and assert exact streak/window behaviour. ARCHITECTURE.md
// flags these as the functions to swap for a `db:profile-stats` query if
// score_history ever outgrows in-memory aggregation.

import { TIER_HEX } from './tier'
import type { ScoreEntry, ApplicationEntry } from '@/types'

const TIER_RANK: Record<string, number> = { T1: 5, 'T2-high': 4, T2: 3, T3: 2, T4: 1 }

// ─── Activity heatmap ────────────────────────────────────────────────────────

// Heatmap cell color — maps the day's best tier onto the galaxy-violet
// tier scale. Empty days fall back to bg-panel so the grid reads as a
// quiet surface, not a default-T4 wash. T2-high uses accent-hover, the
// stop between T1 and T2 in the wordmark gradient (the design system
// doesn't formally define a T2-high color).
export function tierHeatColor(tier: string, count: number): string {
  if (count === 0) return '#F1F4F7' // bg-panel
  const map: Record<string, string> = {
    T1:        TIER_HEX.T1,
    'T2-high': TIER_HEX['T2-high'],
    T2:        TIER_HEX.T2,
    T3:        TIER_HEX.T3,
    T4:        TIER_HEX.T4,
  }
  return map[tier] ?? TIER_HEX.T4
}

export interface HeatCell { date: string; count: number; bestTier: string }

export function buildHeatmap(history: ScoreEntry[], now: Date = new Date()): HeatCell[][] {
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

  const today = new Date(now)
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

// ─── Streak ──────────────────────────────────────────────────────────────────

// Current evaluation streak — consecutive days up to and including `now` that
// have at least one evaluation. Returns 0 unless an evaluation landed today
// (the streak is the one you're actively on, so it resets if you skip a day).
export function computeStreak(history: ScoreEntry[], now: Date = new Date()): number {
  const dates = [...new Set(history.map(e => e.date.slice(0, 10)))].sort().reverse()
  let streak = 0
  const check = new Date(now)
  for (const d of dates) {
    const iso = check.toISOString().slice(0, 10)
    if (d === iso) {
      streak++
      check.setDate(check.getDate() - 1)
    } else if (d < iso) break
  }
  return streak
}

// ─── Achievements ─────────────────────────────────────────────────────────────

export interface Badge {
  id: string; icon: string; label: string; desc: string
  unlocked: boolean; rarity: 'common' | 'rare' | 'epic'
}

export function badges(history: ScoreEntry[], apps: ApplicationEntry[], now: Date = new Date()): Badge[] {
  const t1 = history.filter(e => e.tier === 'T1').length
  const streak = computeStreak(history, now)
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

// ─── Highlights ───────────────────────────────────────────────────────────────

export interface Highlight { label: string; value: string; sub: string }

// Personal-records pulled from the evaluation corpus — the proudest find, the
// company you've dug into hardest, and your busiest scouting day. Aggregates
// (averages, tier mix) already live in the cards above; these are the single
// standout facts that fit Profile's showcase-and-badges theme. Counts use raw
// score-history rows (re-evaluations included) so "most explored" reflects
// actual digging, not deduped entities.
export function buildHighlights(history: ScoreEntry[]): Highlight[] | null {
  const scored = history.filter(e => typeof e.overall === 'number' && e.overall > 0)
  if (scored.length < 3) return null  // too thin to celebrate

  const top = scored.reduce((best, e) => (e.overall > best.overall ? e : best))

  const byCompany = new Map<string, number>()
  for (const e of history) if (e.company) byCompany.set(e.company, (byCompany.get(e.company) ?? 0) + 1)
  let topCompany = ''; let topCompanyN = 0
  for (const [c, n] of byCompany) if (n > topCompanyN) { topCompany = c; topCompanyN = n }

  const byDay = new Map<string, number>()
  for (const e of history) { const d = e.date.slice(0, 10); if (d) byDay.set(d, (byDay.get(d) ?? 0) + 1) }
  let peakDay = ''; let peakN = 0
  for (const [d, n] of byDay) if (n > peakN) { peakDay = d; peakN = n }

  const shortDate = (iso: string) => {
    const t = new Date(iso)
    return Number.isNaN(t.getTime()) ? iso : t.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return [
    { label: 'Top score',     value: top.overall.toFixed(1), sub: top.company || 'a listing' },
    { label: 'Most explored', value: topCompany || '—',      sub: `${topCompanyN} evaluation${topCompanyN === 1 ? '' : 's'}` },
    { label: 'Busiest day',   value: shortDate(peakDay),     sub: `${peakN} in one day` },
  ]
}
