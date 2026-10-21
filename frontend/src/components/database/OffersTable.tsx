'use client'

import { Fragment, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowUpDown, ArrowUp, ArrowDown, Search, ExternalLink, ChevronRight, FileText, TrendingUp } from 'lucide-react'
// clsx, not cn(): twMerge reads the custom `text-label` / `text-body` sizes as
// colours and would silently drop them next to a `text-text-*` class.
import { clsx } from 'clsx'
import type { ScoreEntry, AppStatus } from '@/types'
import { ENGAGED_STATUSES } from '@/types'
import { CompanyLink } from '@/components/shared/CompanyLink'
import { Button, Chip, ScoreBar, ScoreNumber, StatusChip, type ChipTone } from '@/components/ui'
import { formatLocation, variantLabel } from '@/lib/entityId'
import { livenessKey } from '@/lib/scanHistory'
import { useDataStore } from '@/store/data'
import { ipc } from '@/lib/ipc'
import { canonicalizeArchetype } from '@/lib/archetype'
import { tierVerdict } from '@/lib/tier'
import { rowLever } from '@/lib/tierLevers'
import {
  blockedReason, eligibilityCheckLabel, isBlocked, parseEligibilityFlags, priorityOf,
  DIM_LABELS, EASE_DIMS, HYGIENE_DIMS, MOTIVATOR_DIMS, type V2DimKey,
} from '@/lib/scoreBands'
import { WantEase } from '@/components/shared/WantEase'
import { EligibilityChip, VerdictChip } from '@/components/shared/EligibilityChip'

interface OffersTableProps {
  rows: ScoreEntry[]
  onRowClick: (entry: ScoreEntry, evt: React.MouseEvent) => void
  onOpenReport: (entry: ScoreEntry) => void
  selectedId: string | null
}

const col = createColumnHelper<ScoreEntry>()

// ─── Layout ─────────────────────────────────────────────────────────────────
//
// `table-layout: fixed`: every column but Listing has a fixed width and Listing
// takes the rest (never below LISTING_MIN_WIDTH). The fixed columns sum to
// 564px, so the table fits a ~850px container (a 1280px window with the app
// sidebar and the facet rail) without scrolling; narrower windows scroll
// horizontally with the caret + Listing columns pinned on the left.
const LISTING_MIN_WIDTH = 280
const CARET_WIDTH = 28
const STATUS_WIDTH = 104
const RIGHT_ALIGNED = new Set(['score', 'date'])

// Per-column cell padding. Listing hugs the caret; the action icons need the
// full 56px for two 24px buttons; Status keeps 24px of air before the scores
// so the chip and the numbers never read as one cluster.
const CELL_PAD: Record<string, string> = {
  breakdown: 'px-0.5',
  company:   'pl-1 pr-3',
  status:    'pl-2 pr-6',
  actions:   'px-1',
}

// Lifecycle order for the Status column's sort.
const STATUS_RANK: Partial<Record<AppStatus, number>> = {
  Applied: 1, Responded: 2, Interview: 3, Offer: 4, Rejected: 5,
}
const cellPad = (id: string) => CELL_PAD[id] ?? 'px-2'

// Sticky-left offsets for the pinned columns (caret, then Listing).
const STICKY_LEFT: Record<string, string> = {
  breakdown: 'sticky left-0',
  company:   'sticky left-7',
}

// Row surface. Applied to every cell (not the <tr>) so the pinned cells are
// opaque and the scrolled columns never show through them: translucent tints
// ride on a white base as a flat gradient layer.
function cellSurface(isSelected: boolean, isExpanded: boolean): string {
  if (isSelected) return 'bg-bg-base bg-gradient-to-r from-accent-soft to-accent-soft'
  if (isExpanded) return 'bg-bg-base bg-gradient-to-r from-bg-elevated/60 to-bg-elevated/60 group-hover:from-bg-elevated group-hover:to-bg-elevated'
  return 'bg-bg-base group-hover:bg-bg-elevated'
}

// Keyboard focus ring, drawn by the cells (an outline on the <tr> would be
// covered by the opaque pinned cells): top + bottom on every cell, plus the
// outer edge on the first and last.
const FOCUS_MID   = 'group-focus-visible:shadow-[inset_0_1px_0_0_theme(colors.accent),inset_0_-1px_0_0_theme(colors.accent)]'
const FOCUS_FIRST = 'group-focus-visible:shadow-[inset_1px_0_0_0_theme(colors.accent),inset_0_1px_0_0_theme(colors.accent),inset_0_-1px_0_0_theme(colors.accent)]'
const FOCUS_LAST  = 'group-focus-visible:shadow-[inset_-1px_0_0_0_theme(colors.accent),inset_0_1px_0_0_theme(colors.accent),inset_0_-1px_0_0_theme(colors.accent)]'

// Liveness → chip tone (process state, so semantic hues are allowed).
const LIVENESS_CHIP: Record<'active' | 'stale' | 'closed', { tone: ChipTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  stale:  { tone: 'warning', label: 'Stale' },
  closed: { tone: 'muted',   label: 'Closed' },
}

// DIM_LABELS (lib/scoreBands) is shared with the report engine and keeps its
// own casing; the UI renders labels in sentence case (DESIGN-meta § 3).
const sentence = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

// ─── Want · Ease ────────────────────────────────────────────────────────────
//
// Scoring v2: the eligibility dot + the Want · Ease pair (shared WantEase,
// bare — the column header names the two numbers). A blocked row shows its
// red reason in place of the scores. Sorted by Priority, which is never shown.

function ScoreCell({ entry }: { entry: ScoreEntry }) {
  const blocked = isBlocked(entry)
  const flags = parseEligibilityFlags(entry.eligibility_flags).filter(f => f.status !== 'green')
  const reason = flags.map(f => `${eligibilityCheckLabel(f.check)}: ${f.reason}`).join('; ')
  return (
    <div className="flex items-center justify-end gap-1.5 min-w-0">
      <EligibilityChip status={entry.eligibility} reason={reason || null} compact className="shrink-0" />
      <WantEase
        want={entry.want}
        ease={entry.ease}
        blockedReason={blocked ? blockedReason(entry) : null}
        size="md"
        bare
        className="min-w-0"
      />
    </div>
  )
}

// ─── Relative date ──────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return dateStr
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days < 0) return 'soon'
  if (days === 0) return 'today'
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

// ─── Inline row breakdown ───────────────────────────────────────────────────
//
// Click the chevron on a row → that row expands inline, revealing the v2
// breakdown directly below: the dimensions grouped Want (motivators +
// hygiene) / Ease, and the eligibility checks. Multiple rows can be open at
// once. The chevron rotates 90° to signal open state.

const BREAKDOWN_GROUPS: Array<{ title: 'Want' | 'Ease'; keys: readonly V2DimKey[] }> = [
  { title: 'Want', keys: [...MOTIVATOR_DIMS, ...HYGIENE_DIMS] },
  { title: 'Ease', keys: EASE_DIMS },
]

function BreakdownRow({
  entry, colSpan, onSelectSibling,
}: {
  entry: ScoreEntry
  colSpan: number
  onSelectSibling: (sibling: ScoreEntry, evt: React.MouseEvent) => void
}) {
  // Parent representation: dim bars for the parent (this row) + a
  // Cities sub-list when sibling entities exist in the same group
  // (one firm hiring the same role in two cities). Each sibling sub-row is clickable —
  // opens its own slide-over rather than the parent's.
  const siblings = entry.siblings ?? []
  // Show the parent in the city list too so the user sees explicitly
  // "the row above is this one". Sort: active first (best to worst),
  // historical last (in their own greyed visual treatment).
  const allCities = [entry, ...siblings]
  const cityRows = [...allCities].sort((a, b) => {
    const liveA = a.livenessState ?? 'active'
    const liveB = b.livenessState ?? 'active'
    const isHistA = liveA !== 'active' ? 1 : 0
    const isHistB = liveB !== 'active' ? 1 : 0
    if (isHistA !== isHistB) return isHistA - isHistB
    return (priorityOf(b) ?? -1) - (priorityOf(a) ?? -1)
  })
  const showCityList = siblings.length > 0
  // The nested rows are labelled by what sets each variant apart: its market
  // or language when the title names one, else its location.
  const labels = new Map(allCities.map(s => [s, variantLabel(s.role, s.location)]))
  const allByPlace = allCities.every(s => labels.get(s) === (s.location ? formatLocation(s.location) : s.role))

  // Cheapest verdict-improving lever for this row — the "what would move it
  // up" line, shown above the dim bars so the expanded view leads with the
  // action.
  const lever = rowLever(entry)
  const flags = parseEligibilityFlags(entry.eligibility_flags)

  return (
    <tr>
      <td
        colSpan={colSpan}
        className="bg-bg-base bg-gradient-to-r from-bg-elevated/60 to-bg-elevated/60 border-b border-border-default/70 py-3 pr-6"
      >
        {/* Pinned with the Listing column so the breakdown stays in view
            when a narrow window scrolls the table sideways. Indent lines the
            content up with the company name above it. */}
        <div className="sticky left-0 pl-[74px] max-w-[794px]">
          {lever.best && (
            <p className="mb-3 flex items-start gap-1.5 text-label text-text-2">
              <TrendingUp
                size={12}
                className={clsx('shrink-0 mt-[3px]', lever.nearMiss ? 'text-accent-text' : 'text-text-4')}
                aria-hidden
              />
              <span>
                Cheapest upgrade:{' '}
                <span className="font-medium text-text-1">
                  {lever.best.kind === 'amber'
                    ? lever.best.label
                    : `${sentence(lever.best.label)} ${lever.best.from} → ${lever.best.to}`}
                </span>
                {lever.best.kind === 'amber' ? ' (+0.5 Ease)' : ` (+${lever.best.lift})`} moves this from{' '}
                {tierVerdict(lever.best.fromVerdict, { short: true })} to{' '}
                <span className="font-medium text-text-1">{tierVerdict(lever.best.toVerdict, { short: true })}</span>.
              </span>
            </p>
          )}

          {/* Eligibility checks — every non-green check with its reason; a
              clean gate reads as one quiet line. */}
          <div className="mb-3">
            <div className="label mb-1.5">Eligibility</div>
            {flags.length === 0 ? (
              <div className="flex items-center gap-2 text-label text-text-3">
                <EligibilityChip status={entry.eligibility} />
                {entry.eligibility === 'green' && <span>All checks clear</span>}
              </div>
            ) : (
              <div className="space-y-1">
                {flags.map((f, i) => (
                  <div key={`${f.check}-${i}`} className="flex items-center gap-2 min-w-0">
                    <EligibilityChip status={f.status} className="shrink-0" />
                    <span className="text-label text-text-2 font-medium w-[124px] shrink-0">{eligibilityCheckLabel(f.check)}</span>
                    <span className="text-label text-text-3 min-w-0 truncate" title={f.reason}>{f.reason || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!isBlocked(entry) && (
            <div className="grid grid-cols-2 gap-x-8">
              {BREAKDOWN_GROUPS.map(group => {
                const rollup = group.title === 'Want' ? entry.want : entry.ease
                return (
                  <div key={group.title} className="min-w-0">
                    <div className="flex items-baseline justify-between mb-1.5">
                      <span className="label">{group.title}</span>
                      <ScoreNumber value={rollup} size="sm" />
                    </div>
                    <div className="space-y-1.5">
                      {group.keys.map(key => {
                        const raw = entry[key]
                        const val = typeof raw === 'number' ? raw : null
                        return (
                          <div key={key} className="flex items-center gap-3 min-w-0">
                            <span className="text-label text-text-3 w-[120px] shrink-0 truncate">{sentence(DIM_LABELS[key])}</span>
                            <ScoreBar value={val} className="flex-1" />
                            <ScoreNumber value={val} size="sm" decimals={0} className="w-7 shrink-0 text-right" />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {showCityList && (
            <div className="mt-4 pt-3 border-t border-border-default">
              <div className="label mb-1.5">{allByPlace ? 'Locations' : 'Variants'} ({allCities.length})</div>
              <div>
                {cityRows.map(s => {
                  const isPrimary = s === entry
                  const isHistorical = (s.livenessState ?? 'active') !== 'active'
                  const live = LIVENESS_CHIP[s.livenessState ?? 'active']
                  return (
                    <button
                      key={`${s.company}|${s.role}`}
                      type="button"
                      onClick={(evt) => onSelectSibling(s, evt)}
                      className={clsx(
                        'w-full h-8 flex items-center gap-3 px-2 rounded text-left transition-colors duration-150',
                        'hover:bg-bg-panel',
                        isHistorical && 'opacity-60',
                      )}
                    >
                      <span
                        className={clsx(
                          'flex-1 min-w-0 truncate text-body',
                          isPrimary ? 'text-text-1 font-medium' : 'text-text-2',
                        )}
                        title={[s.role, s.location].filter(Boolean).join(' · ')}
                      >
                        {labels.get(s)}
                        {isPrimary && <span className="ml-2 text-label font-normal text-text-4">Primary</span>}
                      </span>
                      <VerdictChip verdict={s.verdict} />
                      <WantEase
                        want={s.want}
                        ease={s.ease}
                        blockedReason={isBlocked(s) ? blockedReason(s) : null}
                        size="sm"
                        bare
                        className="w-[120px] shrink-0 justify-end text-right"
                      />
                      <span className="w-[60px] shrink-0 flex justify-end">
                        <Chip tone={live.tone}>{live.label}</Chip>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ─── Table ──────────────────────────────────────────────────────────────────

// Stable per-entry key for both selection and the expanded-row Set.
const entryKey = (e: ScoreEntry) => `${e.company}|${e.role}`

export function OffersTable({ rows, onRowClick, onOpenReport, selectedId }: OffersTableProps) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'score', desc: true }])
  // (liveness was used for the row-fading rule that's now gone — kept the
  // store unsubscribed since nothing in this table needs it anymore.)
  const reports = useDataStore(s => s.reports)
  const applications = useDataStore(s => s.applications)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Batched peer-rank index — built ONCE per score-history change (dedupe +
  // cohort grouping + sort), then each row's "Peers" cell is an O(log n)
  // lookup. Cohorts come from the FULL raw score history — the same input the
  // slide-over's peerContext uses — not the filtered rows, so filtering the
  // table never changes a row's percentile.

  // Refs that always mirror the latest state so the column-cell closures
  // can read fresh values without `expanded` / `toggleExpanded` being in
  // the columns useMemo deps. Without this, every chevron toggle would
  // rebuild the columns array, causing tanstack-table to recompute the
  // entire table layout — that's the source of the visible flicker on
  // expand. With the refs the columns array stays stable; the cell
  // function is called fresh each render and reads current state.
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const toggleExpanded = (entry: ScoreEntry) => {
    const k = entryKey(entry)
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  const toggleExpandedRef = useRef(toggleExpanded)
  toggleExpandedRef.current = toggleExpanded

  // Fast lookup: which entries already have a report file on disk?
  // Match on URL primarily — that's the stable join key when both the
  // score-history row and the report markdown have one. Fall back to
  // (company, role) for legacy reports written before URL tracking.
  const reportSet = useMemo(() => {
    const byUrl  = new Set<string>()
    const byPair = new Set<string>()
    for (const r of reports) {
      if (r.url) byUrl.add(r.url)
      byPair.add(livenessKey(r.company, r.role))
    }
    return { byUrl, byPair }
  }, [reports])

  const hasReport = (entry: ScoreEntry): boolean => {
    if (entry.url && reportSet.byUrl.has(entry.url)) return true
    return reportSet.byPair.has(livenessKey(entry.company, entry.role))
  }

  // Listing → application status, keyed company|role (same key the liveness /
  // discard maps use). Drives the per-row StatusChip. Last row wins if the
  // same listing somehow appears twice in applications.md.
  const statusByKey = useMemo(() => {
    const m = new Map<string, AppStatus>()
    for (const a of applications) {
      m.set(livenessKey(a.company, a.role), a.status)
    }
    return m
  }, [applications])
  const statusOf = (entry: ScoreEntry): AppStatus | undefined => {
    const status = statusByKey.get(livenessKey(entry.company, entry.role))
    return status != null && ENGAGED_STATUSES.has(status) ? status : undefined
  }

  const columns = useMemo(() => [
    col.display({
      id: 'breakdown',
      header: '',
      size: CARET_WIDTH,
      cell: info => {
        const entry = info.row.original
        const isOpen = expandedRef.current.has(entryKey(entry))
        const sibCount = entry.siblings?.length ?? 0
        const titleSuffix = sibCount > 0 ? ` · ${sibCount} more in this group` : ''
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleExpandedRef.current(entry) }}
            title={(isOpen ? 'Hide score breakdown' : 'Show score breakdown') + titleSuffix}
            aria-label={(isOpen ? 'Hide score breakdown' : 'Show score breakdown') + titleSuffix}
            aria-expanded={isOpen}
            className="inline-flex items-center justify-center w-6 h-6 rounded text-text-4 hover:text-text-1 hover:bg-bg-panel transition-colors duration-150"
          >
            <ChevronRight
              size={14}
              className="shrink-0 transition-transform duration-150 ease-quart"
              style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              aria-hidden
            />
          </button>
        )
      },
      enableSorting: false,
    }),
    col.accessor('company', {
      header: 'Listing',
      cell: info => {
        const company = info.getValue()
        const entry = info.row.original
        const role = entry.role
        const sibCount = entry.siblings?.length ?? 0
        return (
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyLink company={company} size={32} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-tight font-semibold text-text-1 truncate" title={company}>
                {company}
              </div>
              <div className="text-label text-text-3 truncate" title={role}>{role}</div>
            </div>
            {sibCount > 0 && (
              <span
                className="shrink-0 text-label text-text-4 tabular-nums"
                title={`${sibCount} more ${sibCount === 1 ? 'variant' : 'variants'} of this listing: expand the row to see them`}
              >
                +{sibCount} {sibCount === 1 ? 'variant' : 'variants'}
              </span>
            )}
          </div>
        )
      },
    }),
    // The listing's application status in its own column, so Applied /
    // Responded / Interview line up down the table instead of trailing each
    // role. Sorts in lifecycle order; untouched listings always sort last.
    col.accessor(e => { const st = statusOf(e); return st ? STATUS_RANK[st] : undefined }, {
      id: 'status',
      header: 'Status',
      size: STATUS_WIDTH,
      sortUndefined: 'last',
      enableSorting: true,
      cell: info => {
        const status = statusOf(info.row.original)
        return status ? <StatusChip status={status} /> : null
      },
    }),
    col.display({
      id: 'score',
      header: 'Want · Ease',
      size: 100,
      // Sorted by Priority (sqrt(Want × Ease)) — the v2 sort key, never shown
      // as a number. Blocked / unscored rows sit at -1 → bottom on desc.
      sortingFn: (a, b) => (priorityOf(a.original) ?? -1) - (priorityOf(b.original) ?? -1),
      sortDescFirst: true,
      enableSorting: true,
      cell: info => <ScoreCell entry={info.row.original} />,
    }),
    col.accessor('location', {
      header: 'Location',
      size: 108,
      cell: info => {
        const raw = info.getValue() || ''
        // "City, Country" reads as the city; single-URL multi-city listings
        // read as "City +N" (formatLocation). Grouped sibling evaluations of
        // the same role in other cities add a muted "+N" — the caret expands
        // them. Hover shows the full string.
        // Only variants in OTHER places count here; a language/market variant
        // in the same city is shown by the Listing cell's "+N variants".
        const sibs = info.row.original.siblings ?? []
        const here = formatLocation(raw)
        const elsewhere = [...new Set(sibs.map(s => formatLocation(s.location)).filter(l => l !== here && l !== '—'))]
        const title = elsewhere.length > 0
          ? [raw, ...sibs.map(s => s.location)].filter(Boolean).join(' · ')
          : raw || undefined
        return (
          <span className="block truncate text-label text-text-2" title={title}>
            {here}
            {elsewhere.length > 0 && <span className="text-text-4"> +{elsewhere.length}</span>}
          </span>
        )
      },
    }),
    col.accessor('archetype', {
      header: 'Archetype',
      size: 112,
      cell: info => {
        const display = canonicalizeArchetype(info.getValue())
        if (!display) return <span className="text-label text-text-4">—</span>
        return (
          <span className="block truncate text-label text-text-3" title={display}>
            {display}
          </span>
        )
      },
    }),
    col.accessor('date', {
      header: 'Added',
      size: 56,
      cell: info => {
        const v = info.getValue()
        return (
          <span className="text-label text-text-4 whitespace-nowrap" title={v || undefined}>
            {relativeTime(v)}
          </span>
        )
      },
    }),
    col.display({
      id: 'actions',
      header: '',
      size: 56,
      enableSorting: false,
      cell: info => {
        const entry = info.row.original
        const url = entry.url
        const validUrl = !!url && /^https?:\/\//i.test(url)
        return (
          <div className="flex items-center justify-end">
            {hasReport(entry) ? (
              <Button
                tone="ghost"
                size="xs"
                iconOnly
                onClick={(e) => { e.stopPropagation(); onOpenReport(entry) }}
                title="Open scouting report"
                aria-label="Open scouting report"
                icon={<FileText size={13} aria-hidden />}
              />
            ) : (
              <span className="block w-6 h-6 shrink-0" aria-hidden />
            )}
            {validUrl ? (
              <Button
                tone="ghost"
                size="xs"
                iconOnly
                onClick={(e) => { e.stopPropagation(); ipc.openExternal(url) }}
                title="Open job posting in browser"
                aria-label="Open job posting in browser"
                icon={<ExternalLink size={13} aria-hidden />}
              />
            ) : (
              <span className="block w-6 h-6 shrink-0" aria-hidden />
            )}
          </div>
        )
      },
    }),
  ], [reportSet, onOpenReport, statusByKey])

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  // Below this width the table scrolls sideways instead of squeezing Listing.
  const visibleColumns = table.getVisibleLeafColumns()
  const tableMinWidth = visibleColumns.reduce(
    (sum, c) => sum + (c.id === 'company' ? LISTING_MIN_WIDTH : c.getSize()),
    0,
  )
  const lastColumnId = visibleColumns[visibleColumns.length - 1]?.id

  return (
    <div className="h-full overflow-auto relative bg-bg-base rounded-lg">
      <table
        className="w-full table-fixed border-separate border-spacing-0 text-left"
        style={{ minWidth: tableMinWidth }}
      >
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(header => {
                const id = header.column.id
                const canSort = header.column.getCanSort()
                const sorted = header.column.getIsSorted()
                const isRight = RIGHT_ALIGNED.has(id)
                const headerTitle =
                  id === 'fixability' ? 'Cheapest single change — one dimension raised, or one amber eligibility check resolved — that moves this listing into a better verdict. Sort ascending = easiest to upgrade first.'
                  : id === 'peer' ? 'Where this listing\'s Priority (√(Want × Ease)) ranks among all evaluated roles of the same archetype (live cohort), followed by the cohort size. Blank = fewer than 5 peers evaluated, where no rank is publishable. Bold = 10+ peers back the band; muted = 5–9 peers, read as top/bottom half only. Sort descending = strongest standouts first.'
                  : id === 'score' ? 'Eligibility dot, then Want (how much you want it) · Ease (how realistic it is to get in). Blocked listings show their reason instead. Sorted by √(Want × Ease).'
                  : id === 'verdict' ? 'Where Want × Ease lands on the verdict grid. Sort descending = Go first, Blocked last.'
                  : undefined
                const ariaSortVal: 'ascending' | 'descending' | 'none' = sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                const toggleSort = canSort ? header.column.getToggleSortingHandler() : undefined
                return (
                  <th
                    key={header.id}
                    style={id === 'company' ? undefined : { width: header.getSize() }}
                    aria-sort={canSort ? ariaSortVal : undefined}
                    title={headerTitle}
                    className={clsx(
                      'th h-10 bg-bg-base border-b border-border-default sticky top-0',
                      cellPad(id),
                      STICKY_LEFT[id] ? clsx(STICKY_LEFT[id], 'z-30') : 'z-20',
                      canSort && 'cursor-pointer hover:text-text-1 transition-colors duration-150',
                    )}
                    onClick={toggleSort}
                    onKeyDown={canSort ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleSort?.(e as unknown as React.MouseEvent)
                      }
                    } : undefined}
                    tabIndex={canSort ? 0 : undefined}
                  >
                    <div className={clsx('flex items-center gap-1', isRight && 'flex-row-reverse')}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className={clsx('shrink-0', sorted ? 'text-accent-text' : 'text-text-4')} aria-hidden>
                          {sorted === 'asc' ? <ArrowUp size={12} /> :
                           sorted === 'desc' ? <ArrowDown size={12} /> :
                           <ArrowUpDown size={12} className="opacity-50" />}
                        </span>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => {
            const entry = row.original
            const id = `${entry.company}-${entry.role}`
            const isSelected = id === selectedId
            const isExpanded = expanded.has(entryKey(entry))
            const surface = cellSurface(isSelected, isExpanded)
            // Rows stay at full strength whatever the score: the Want · Ease
            // numbers carry the band colour, so company and role always read cleanly.
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={(evt) => onRowClick(entry, evt)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick(entry, e as unknown as React.MouseEvent)
                    }
                  }}
                  tabIndex={0}
                  aria-selected={isSelected}
                  role="row"
                  className="group cursor-pointer focus-visible:outline-none"
                >
                  {row.getVisibleCells().map((cell, i) => {
                    const colId = cell.column.id
                    return (
                      <td
                        key={cell.id}
                        className={clsx(
                          'h-[52px] align-middle border-b border-border-default/50 transition-colors duration-150',
                          cellPad(colId),
                          surface,
                          STICKY_LEFT[colId] && clsx(STICKY_LEFT[colId], 'z-10'),
                          RIGHT_ALIGNED.has(colId) && 'text-right',
                          i === 0 ? FOCUS_FIRST : colId === lastColumnId ? FOCUS_LAST : FOCUS_MID,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )
                  })}
                </tr>
                {isExpanded && (
                  <BreakdownRow
                    entry={entry}
                    colSpan={row.getVisibleCells().length}
                    onSelectSibling={onRowClick}
                  />
                )}
              </Fragment>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <div className="py-20 px-6 flex flex-col items-center justify-center gap-3">
                  <Search size={24} className="text-text-4" aria-hidden />
                  <div className="text-center max-w-xs">
                    <p className="text-section text-text-1">No listings match</p>
                    <p className="text-label text-text-3 mt-1.5">
                      Try relaxing a filter or searching a different keyword.
                      Use the <span className="font-medium text-text-2">Liveness</span> chips to include stale or closed listings,
                      or turn off <span className="font-medium text-text-2">Untapped</span> to see roles already in your pipeline.
                    </p>
                  </div>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
