'use client'

import { useMemo, useState } from 'react'
import { useDataStore } from '@/store/data'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { canonicalizeArchetype } from '@/lib/archetype'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { EmptyState } from '@/components/shared/EmptyState'
import { scoreColor as galaxyScoreColor } from '@/lib/tier'
import type { ScoreEntry } from '@/types'

// Multi-series chart palette — sourced from the documented categorical
// chart tokens (DESIGN-meta.md § Data Viz palette). Aurora-tuned cousins
// of galaxy violet so adjacent lines actually contrast instead of
// collapsing into one violet ladder.
//
// Series order maps to the DIMENSIONS array below: Overall (deep indigo)
// reads as the rolled-up "headline" number; Current Fit gets the brand
// galaxy violet because it's the day-to-day reachability driver of the
// rollup (CF×0.70 + AF×0.30) — the line the user watches most. The
// remaining slots fan out warm/cool/warm/cool so adjacent series
// contrast at first glance.
const DIM_COLORS = [
  '#3D2BB5',  // chart-2 — deep indigo, Overall (the rollup)
  '#7C5CFF',  // chart-1 — galaxy violet, Current Fit (brand anchor; primary driver)
  '#2EB8A8',  // chart-3 — aurora teal, Aspirational Fit
  '#E84F8E',  // chart-4 — nebula pink, Skills Match
  '#F2A837',  // chart-5 — cosmic amber, Brand Value
  '#4D8DFF',  // chart-6 — azure, Growth
  '#8595A4',  // chart-7 — slate, Work-Life (intentionally muted)
]

type DimKey = 'avg_overall' | 'avg_current_fit' | 'avg_aspirational_fit' | 'avg_skills_match' | 'avg_brand_value' | 'avg_growth' | 'avg_wlb'

const DIMENSIONS: Array<{ key: DimKey; label: string; field: keyof ScoreEntry }> = [
  { key: 'avg_overall',          label: 'Overall',          field: 'overall' },
  { key: 'avg_current_fit',      label: 'Current Fit',      field: 'current_fit' },
  { key: 'avg_aspirational_fit', label: 'Aspirational Fit', field: 'aspirational_fit' },
  { key: 'avg_skills_match',     label: 'Skills Match',     field: 'skills_match' },
  { key: 'avg_brand_value',      label: 'Brand Value',      field: 'brand_value' },
  { key: 'avg_growth',           label: 'Growth',           field: 'growth_mobility' },
  { key: 'avg_wlb',              label: 'Work-Life',        field: 'work_life_balance' },
]

type TimeRange = 'all' | '1y' | '6m' | '1m'

const TIME_RANGE_DAYS: Record<TimeRange, number | null> = {
  all: null, '1y': 365, '6m': 182, '1m': 30,
}

const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time', '1y': '1y', '6m': '6mo', '1m': '1mo',
}

export function TrendsView() {
  const loaded = useDataStore(s => s.loaded)
  const scoreHistory = useDataStore(s => s.scoreHistory)
  const [activeDims, setActiveDims] = useState<Set<DimKey>>(new Set(['avg_overall', 'avg_current_fit', 'avg_aspirational_fit']))
  const [timeRange, setTimeRange] = useState<TimeRange>('all')

  // Filter once by time range; everything else (chart, top-X panels, stats)
  // derives from this. Computing client-side from scoreHistory (already in
  // the data store) instead of an IPC trends() call eliminates the empty-
  // chart flash that fired on every Scan→Trends tab switch.
  const filtered = useMemo(() => {
    const days = TIME_RANGE_DAYS[timeRange]
    if (days == null) return scoreHistory
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffIso = cutoff.toISOString().slice(0, 10)
    return scoreHistory.filter(s => (s.date ?? '') >= cutoffIso)
  }, [scoreHistory, timeRange])

  const byDate         = useMemo(() => buildByDate(filtered),                                      [filtered])
  const topCompanies   = useMemo(() => buildTopBy(filtered, e => e.company, 6),                    [filtered])
  const topLocations   = useMemo(() => buildTopBy(filtered, e => e.location, 6),                   [filtered])
  const topArchetypes  = useMemo(() => buildTopBy(filtered, e => canonicalizeArchetype(e.archetype), 6), [filtered])

  const stats = useMemo(() => {
    if (filtered.length === 0) return null
    return {
      total:      filtered.length,
      avgOverall: avg(filtered, 'overall').toFixed(2),
      avgCF:      avg(filtered, 'current_fit').toFixed(2),
      avgAF:      avg(filtered, 'aspirational_fit').toFixed(2),
    }
  }, [filtered])

  const toggleDim = (key: DimKey) => {
    setActiveDims(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) } else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium">Trends</h1>
        {stats && (
          <span className="text-label text-text-4 font-mono">{stats.total} evaluations</span>
        )}
        <div className="flex-1" />
        <div className="titlebar-no-drag flex rounded-md overflow-hidden border border-border-default">
          {(['all', '1y', '6m', '1m'] as const).map(r => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={cn(
                'px-2.5 py-1 text-label transition-colors',
                timeRange === r ? 'bg-accent/20 text-accent-text' : 'text-text-4 hover:text-text-2',
              )}
            >
              {TIME_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {stats && (
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Total evaluated',      value: stats.total },
              { label: 'Avg overall',          value: stats.avgOverall },
              { label: 'Avg current fit',      value: stats.avgCF },
              { label: 'Avg aspirational fit', value: stats.avgAF },
            ].map(({ label, value }) => (
              <div key={label} className="bg-bg-panel border border-border-default rounded-lg p-3">
                <div className="text-micro text-text-4 uppercase mb-1">{label}</div>
                <div className="text-section font-mono text-text-1 font-medium">{value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {DIMENSIONS.map(({ key, label }, i) => (
            <button
              key={key}
              onClick={() => toggleDim(key)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-label border transition-colors',
                activeDims.has(key)
                  ? 'border-transparent text-white'
                  : 'border-border-default text-text-4 hover:text-text-2',
              )}
              style={activeDims.has(key) ? {
                backgroundColor: DIM_COLORS[i % DIM_COLORS.length] + '33',
                borderColor: DIM_COLORS[i % DIM_COLORS.length] + '80',
                color: DIM_COLORS[i % DIM_COLORS.length],
              } : {}}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: activeDims.has(key) ? DIM_COLORS[i % DIM_COLORS.length] : 'var(--divider-gray)' }}
              />
              {label}
            </button>
          ))}
        </div>

        {!loaded ? (
          <div className="h-64 shimmer rounded-lg" />
        ) : byDate.length === 0 ? (
          <div className="flex items-center justify-center h-64 rounded-lg border border-border-default bg-bg-panel/40">
            <EmptyState
              title="No score history yet"
              hint="Run a Filter to Database scan to populate the trend chart."
            />
          </div>
        ) : (
          <div className="galaxy-bg border border-border-default rounded-lg p-4" style={{ height: 340 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={byDate} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="#DEE3E9" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#5D6C7B', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: '#DEE3E9' }}
                />
                <YAxis
                  domain={[0, 10]}
                  tick={{ fill: '#5D6C7B', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <Tooltip
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #DEE3E9', borderRadius: 12, fontSize: 12, boxShadow: '0 12px 28px 0 rgba(0,0,0,0.08), 0 2px 4px 0 rgba(0,0,0,0.04)' }}
                  labelStyle={{ color: '#1C2B33', fontWeight: 600 }}
                  itemStyle={{ color: '#5D6C7B' }}
                />
                {DIMENSIONS.map(({ key }, i) =>
                  activeDims.has(key) ? (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={DIM_COLORS[i % DIM_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ) : null
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Top-X panels: separate rhythms for archetype (horizontal bars,
            structural shape) vs companies/locations (logo + count, more
            scannable). Time-series chart and these panels share the same
            time range so the cross-section reads cleanly. */}
        {loaded && filtered.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <TopCompaniesCard items={topCompanies} />
            <TopLocationsCard items={topLocations} />
            <TopArchetypesCard items={topArchetypes} />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Aggregations ────────────────────────────────────────────────────────────

interface DateBucket {
  label: string; count: number
  avg_overall: number; avg_current_fit: number; avg_aspirational_fit: number
  avg_skills_match: number; avg_brand_value: number
  avg_growth: number; avg_wlb: number
}

function buildByDate(rows: ScoreEntry[]): DateBucket[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const s of rows) {
    if (!s.date) continue
    const date = s.date.slice(0, 10)
    const list = map.get(date)
    if (list) list.push(s)
    else map.set(date, [s])
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({
      label: date,
      count: entries.length,
      avg_overall:          avg(entries, 'overall'),
      avg_current_fit:      avg(entries, 'current_fit'),
      avg_aspirational_fit: avg(entries, 'aspirational_fit'),
      avg_skills_match:     avg(entries, 'skills_match'),
      avg_brand_value:      avg(entries, 'brand_value'),
      avg_growth:           avg(entries, 'growth_mobility'),
      avg_wlb:              avg(entries, 'work_life_balance'),
    }))
}

interface TopRow { label: string; count: number; avgScore: number }

// Skip useless labels — the score-history TSV uses "n/d" for unstated values
// and most files have a few legacy rows with empty / dash entries.
const isNoiseLabel = (s: string): boolean => {
  const t = s.trim().toLowerCase()
  return !t || t === 'n/d' || t === '—' || t === '-' || t === 'unknown'
}

function buildTopBy(rows: ScoreEntry[], key: (e: ScoreEntry) => string, limit: number): TopRow[] {
  const map = new Map<string, ScoreEntry[]>()
  for (const e of rows) {
    const k = (key(e) ?? '').trim()
    if (isNoiseLabel(k)) continue
    const list = map.get(k)
    if (list) list.push(e)
    else map.set(k, [e])
  }
  return [...map.entries()]
    .map(([label, entries]) => ({ label, count: entries.length, avgScore: avg(entries, 'overall') }))
    // Rank by avg score primarily — the user wants "what scored high",
    // not "what showed up the most." Count is the tiebreaker.
    .filter(r => r.avgScore > 0)
    .sort((a, b) => b.avgScore - a.avgScore || b.count - a.count)
    .slice(0, limit)
}

// ─── Country flag mapping ────────────────────────────────────────────────────
//
// Score-history `location` strings vary: "Dublin, Ireland (on-site)",
// "Madrid", "Multi-location (UK, UAE, ...)", "Remote / multi-hub (London /
// Barcelona)". Best-effort: match the first recognized city or country in
// the string, fall back to no flag if nothing matches.

const CITY_TO_ISO: Record<string, string> = {
  // Ireland
  'dublin': 'IE', 'cork': 'IE', 'galway': 'IE',
  // UK
  'london': 'GB', 'manchester': 'GB', 'edinburgh': 'GB', 'birmingham': 'GB', 'cambridge': 'GB',
  // Spain
  'madrid': 'ES', 'barcelona': 'ES', 'valencia': 'ES', 'seville': 'ES', 'bilbao': 'ES', 'malaga': 'ES',
  // Italy
  'milan': 'IT', 'milano': 'IT', 'rome': 'IT', 'roma': 'IT', 'turin': 'IT', 'torino': 'IT', 'florence': 'IT', 'naples': 'IT',
  // Netherlands
  'amsterdam': 'NL', 'rotterdam': 'NL', 'utrecht': 'NL', 'the hague': 'NL', 'eindhoven': 'NL',
  // Germany
  'berlin': 'DE', 'munich': 'DE', 'münchen': 'DE', 'frankfurt': 'DE', 'hamburg': 'DE', 'cologne': 'DE', 'köln': 'DE', 'düsseldorf': 'DE', 'stuttgart': 'DE',
  // France
  'paris': 'FR', 'lyon': 'FR', 'marseille': 'FR', 'toulouse': 'FR',
  // Austria
  'vienna': 'AT', 'wien': 'AT', 'salzburg': 'AT', 'graz': 'AT',
  // Portugal
  'lisbon': 'PT', 'lisboa': 'PT', 'porto': 'PT',
  // Switzerland
  'zurich': 'CH', 'zürich': 'CH', 'geneva': 'CH', 'bern': 'CH', 'basel': 'CH', 'lausanne': 'CH',
  // Belgium
  'brussels': 'BE', 'antwerp': 'BE', 'ghent': 'BE',
  // Nordics
  'copenhagen': 'DK', 'aarhus': 'DK',
  'stockholm': 'SE', 'gothenburg': 'SE', 'malmö': 'SE',
  'oslo': 'NO', 'bergen': 'NO',
  'helsinki': 'FI', 'espoo': 'FI', 'tampere': 'FI',
  'reykjavik': 'IS',
  // Eastern Europe
  'warsaw': 'PL', 'krakow': 'PL', 'kraków': 'PL', 'wroclaw': 'PL',
  'prague': 'CZ', 'brno': 'CZ',
  'budapest': 'HU',
  'bucharest': 'RO',
  // North America
  'new york': 'US', 'nyc': 'US', 'san francisco': 'US', 'sf': 'US', 'boston': 'US',
  'los angeles': 'US', 'la': 'US', 'austin': 'US', 'seattle': 'US', 'chicago': 'US', 'denver': 'US', 'atlanta': 'US',
  'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA',
  // LATAM
  'mexico city': 'MX', 'cdmx': 'MX',
  'são paulo': 'BR', 'sao paulo': 'BR', 'rio de janeiro': 'BR',
  'buenos aires': 'AR',
  'heredia': 'CR', 'san josé': 'CR', 'san jose': 'CR',
  // Asia + Oceania
  'singapore': 'SG',
  'tokyo': 'JP', 'osaka': 'JP',
  'hong kong': 'HK',
  'sydney': 'AU', 'melbourne': 'AU',
  'bangalore': 'IN', 'bengaluru': 'IN', 'mumbai': 'IN', 'delhi': 'IN',
  // Middle East
  'dubai': 'AE', 'abu dhabi': 'AE',
}

const COUNTRY_TO_ISO: Record<string, string> = {
  ireland: 'IE',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', 'great britain': 'GB',
  spain: 'ES', italy: 'IT', netherlands: 'NL', germany: 'DE', france: 'FR',
  austria: 'AT', portugal: 'PT', switzerland: 'CH', belgium: 'BE',
  denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI', iceland: 'IS',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', hungary: 'HU', romania: 'RO',
  'united states': 'US', usa: 'US', us: 'US', america: 'US',
  canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR', 'costa rica': 'CR',
  singapore: 'SG', japan: 'JP', 'hong kong': 'HK',
  australia: 'AU', india: 'IN', uae: 'AE',
}

// ISO 3166-1 alpha-2 → flag emoji via regional indicator code points.
const isoToFlag = (iso: string): string =>
  iso.replace(/[A-Z]/g, c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)))

function locationFlag(location: string): string | null {
  const lower = location.toLowerCase()
  for (const [city, iso] of Object.entries(CITY_TO_ISO)) {
    if (lower.includes(city)) return isoToFlag(iso)
  }
  for (const [country, iso] of Object.entries(COUNTRY_TO_ISO)) {
    if (lower.includes(country)) return isoToFlag(iso)
  }
  return null
}

function avg(rows: ScoreEntry[], field: keyof ScoreEntry): number {
  let sum = 0, n = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number') { sum += v; n++ }
  }
  return n === 0 ? 0 : sum / n
}

// ─── Top-X panels ────────────────────────────────────────────────────────────

// Each card uses the same header rhythm: title on the left, "AVG / N"
// column hints on the right. The header doubles as the column legend so
// the user knows what the two right-side numbers mean without hovering.

function TopCompaniesCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Companies">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default/40">
          {items.map(({ label, count, avgScore }) => {
            const color = scoreTierColor(avgScore)
            return (
              <li key={label} className="flex items-center gap-2.5 py-2">
                <CompanyLogo company={label} size={22} className="shrink-0" />
                <span className="flex-1 min-w-0 text-[12.5px] text-text-1 font-medium truncate">{label}</span>
                <span
                  className="text-[12px] font-mono font-semibold tabular-nums shrink-0 w-9 text-right"
                  style={{ color }}
                >
                  {avgScore.toFixed(1)}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-text-4 shrink-0 w-6 text-right">{count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function TopLocationsCard({ items }: { items: TopRow[] }) {
  return (
    <PanelCard title="Top Locations">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="divide-y divide-border-default/40">
          {items.map(({ label, count, avgScore }) => {
            const flag = locationFlag(label)
            const color = scoreTierColor(avgScore)
            return (
              <li key={label} className="flex items-center gap-2.5 py-2">
                <span className="text-[16px] leading-none w-5 text-center shrink-0" aria-hidden>
                  {flag ?? '🌐'}
                </span>
                <span className="flex-1 min-w-0 text-[12.5px] text-text-1 truncate">{label}</span>
                <span
                  className="text-[12px] font-mono font-semibold tabular-nums shrink-0 w-9 text-right"
                  style={{ color }}
                >
                  {avgScore.toFixed(1)}
                </span>
                <span className="text-[11px] font-mono tabular-nums text-text-4 shrink-0 w-6 text-right">{count}</span>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function TopArchetypesCard({ items }: { items: TopRow[] }) {
  const max = items.length ? Math.max(...items.map(i => i.avgScore)) : 0
  return (
    <PanelCard title="Top Archetypes">
      {items.length === 0 ? <EmptyHint /> : (
        <ul className="space-y-2.5 mt-1">
          {items.map(({ label, count, avgScore }) => {
            const pct = max ? (avgScore / max) * 100 : 0
            const color = scoreTierColor(avgScore)
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[12px] text-text-1 truncate">{label}</span>
                  <span className="text-[11px] font-mono tabular-nums shrink-0">
                    <span style={{ color }} className="font-semibold">{avgScore.toFixed(1)}</span>
                    <span className="text-text-4"> · {count}</span>
                  </span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-pill overflow-hidden">
                  <div
                    className="h-full rounded-pill"
                    style={{ width: `${pct}%`, background: color, transition: 'width 320ms ease' }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </PanelCard>
  )
}

function PanelCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-panel border border-border-default rounded-lg p-3.5">
      <div className="flex items-baseline justify-between mb-2 pb-1.5 border-b border-border-default/60">
        <span className="text-[10.5px] text-text-3 uppercase tracking-[0.08em] font-semibold">{title}</span>
        <span className="text-[9.5px] font-mono uppercase tracking-[0.08em] text-text-4 shrink-0">
          AVG · N
        </span>
      </div>
      {children}
    </div>
  )
}

function EmptyHint() {
  return <p className="text-[11px] text-text-4 py-4 text-center">No data</p>
}

// Same galaxy palette as the rest of the app (Database scoreColor,
// ReportSlideOver hero, etc) — sourced from the shared `lib/tier.ts`
// module so a number reads as the same color everywhere it appears.
const scoreTierColor = galaxyScoreColor
