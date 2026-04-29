'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { X, FileText, Database as DatabaseIcon, ExternalLink, BookOpen } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { useNavStore } from '@/store/nav'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import type { ScoreEntry } from '@/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CompanyLogo } from '@/components/shared/CompanyLogo'
import { ApplyAction } from '@/components/shared/ApplyAction'
import { FilesStrip } from '@/components/shared/FilesStrip'

type Tab = 'scouting' | 'application'

interface ReportSlideOverProps {
  company: string
  role: string
  scoreEntry: ScoreEntry
  /** Hide the "View in Database" pill — used when the slide-over is opened
   *  from inside the Database itself (where the shortcut is redundant). */
  hideDatabaseLink?: boolean
  onClose: () => void
}

export function ReportSlideOver({ company, role, scoreEntry, hideDatabaseLink, onClose }: ReportSlideOverProps) {
  const { repoPath } = useAppStore()
  const navigate = useNavStore(s => s.navigate)
  const [scoutingContent, setScoutingContent] = useState<string | null>(null)
  const [applicationContent, setApplicationContent] = useState<string | null>(null)
  const [scoutingMissing, setScoutingMissing] = useState(false)
  const [applicationMissing, setApplicationMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('scouting')

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setTimeout(onClose, 260)
  }, [onClose])

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    setScoutingContent(null)
    setApplicationContent(null)
    setScoutingMissing(false)
    setApplicationMissing(false)

    if (!repoPath) {
      setError('No repo path set.')
      setLoading(false)
      return
    }

    // 1. Scouting report — search known tier dirs, fall back to flat
    //    reports/. The report file is the same `{Company} - {Role}.md`
    //    naming, so we pair the two files by (company, role).
    let scoutingPath: string | null = null
    for (const dir of ['tier-1', 'tier-2', 'tier-3', 'tier-4']) {
      const p = `reports/${dir}/${company} - ${role}.md`
      if (await ipc.fileExists(p)) { scoutingPath = p; break }
    }
    if (!scoutingPath) {
      const flat = `reports/${company} - ${role}.md`
      if (await ipc.fileExists(flat)) scoutingPath = flat
    }

    // 2. Application prep — written by modes/interview-prep.md and the
    //    "Prep Application" button. Mirrors the report naming so the pair
    //    joins on (company, role).
    const prepPath = `interview-prep/${company} - ${role}.md`
    const prepExists = await ipc.fileExists(prepPath)

    // Read whichever exist; tabs render from the populated state.
    if (scoutingPath) {
      const text = await ipc.readFile(scoutingPath)
      if (text) setScoutingContent(text)
      else setScoutingMissing(true)
    } else {
      setScoutingMissing(true)
    }
    if (prepExists) {
      const text = await ipc.readFile(prepPath)
      if (text) setApplicationContent(text)
      else setApplicationMissing(true)
    } else {
      setApplicationMissing(true)
    }

    // Default to the scouting tab when the file exists; otherwise show the
    // application tab if THAT exists. If neither exists, surface an error.
    if (scoutingPath) setActiveTab('scouting')
    else if (prepExists) setActiveTab('application')
    else setError('No report or application prep found for this entry.')

    setLoading(false)
  }, [company, role, repoPath])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const tierKey = (scoreEntry.tier as TierKey) in TIER_COLORS ? (scoreEntry.tier as TierKey) : 'T4'
  const { text: tierText } = TIER_COLORS[tierKey]

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/50 backdrop-blur-[2px] transition-opacity duration-[260ms]',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={handleClose}
      />

      {/* Panel */}
      <div className={cn(
        'fixed right-0 top-0 bottom-0 z-40 w-[720px] max-w-full bg-bg-panel border-l border-border-strong flex flex-col shadow-2xl',
        'transition-[transform,opacity] duration-[260ms] ease-out',
        open ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0',
      )}>
        {/* Header */}
        <div className="titlebar-drag h-11 shrink-0 border-b border-border-default" />
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default shrink-0">
          <CompanyLogo company={company} size={40} className="shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-text-1 leading-tight truncate">{company}</h2>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className={cn('text-micro font-mono font-semibold', tierText)}>
                {tierKey === 'T2-high' ? 'T2+' : tierKey}
              </span>
              {scoreEntry.overall > 0 && (
                <>
                  <span className="text-micro text-text-4">·</span>
                  <span className="text-micro text-text-4 font-mono">{scoreEntry.overall.toFixed(1)} / 10</span>
                </>
              )}
              {scoreEntry.location && (
                <>
                  <span className="text-micro text-text-4">·</span>
                  <span className="text-micro text-text-4">{scoreEntry.location}</span>
                </>
              )}
            </div>
            <p className="text-label text-text-3 truncate mt-1">{role}</p>
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Action pills */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-default shrink-0 flex-wrap">
          <ApplyAction company={company} role={role} scoreEntry={scoreEntry} size="sm" />
          {!hideDatabaseLink && (
            <button
              onClick={() => {
                navigate('database', company)
                handleClose()
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
            >
              <DatabaseIcon size={11} />
              View in Database
            </button>
          )}
          {/* URL pill — prefer scoreEntry.url; fall back to extracting
              **URL:** from the loaded scouting report markdown for orphan
              reports that don't have a matching score-history row. */}
          {(() => {
            const url =
              (scoreEntry.url && /^https?:\/\//i.test(scoreEntry.url) && scoreEntry.url) ||
              (scoutingContent ? (scoutingContent.match(/^\*\*URL:\*\*\s*(\S+)/im)?.[1] ?? '') : '')
            if (!url || !/^https?:\/\//i.test(url)) return null
            return (
              <button
                onClick={() => ipc.openExternal(url)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
              >
                <ExternalLink size={11} />
                Open URL
              </button>
            )
          })()}
          <div className="flex-1" />
          <FilesStrip company={company} role={role} size="md" />
        </div>

        {/* Tabs — Scouting / Application prep. Greyed out when the
            corresponding file isn't on disk. Each one lazy-renders its
            own content so the parser only runs for the visible tab. */}
        <div className="flex border-b border-border-default shrink-0">
          <TabButton
            icon={FileText}
            label="Scouting report"
            active={activeTab === 'scouting'}
            disabled={!scoutingContent}
            onClick={() => setActiveTab('scouting')}
          />
          <TabButton
            icon={BookOpen}
            label="Application prep"
            active={activeTab === 'application'}
            disabled={!applicationContent}
            onClick={() => setActiveTab('application')}
          />
        </div>

        {/* Score mini-bar — only when the scouting tab is active and we
            have real score data. The application-prep tab doesn't carry
            a score on its own; it inherits from the scouting evaluation. */}
        {activeTab === 'scouting' && scoreEntry.overall > 0 && <ScoreMiniBar entry={scoreEntry} />}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="space-y-3">
              {[80, 60, 90, 50, 70].map((w, i) => (
                <div key={i} className="shimmer h-3 rounded" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-text-4">
              <FileText size={32} className="opacity-30" />
              <p className="text-label">{error}</p>
            </div>
          )}
          {!loading && !error && activeTab === 'scouting' && (
            scoutingContent
              ? <ReportBody content={scoutingContent} tier={tierKey} />
              : <EmptyTab message="No scouting report yet — click Generate report from the Database popover to create one." />
          )}
          {!loading && !error && activeTab === 'application' && (
            applicationContent
              ? <div className="prose-report"><ReactMarkdown remarkPlugins={[remarkGfm]}>{applicationContent}</ReactMarkdown></div>
              : <EmptyTab message="No application prep yet — click Prep application from the Database popover to research interview intel + STAR mapping for this role." />
          )}
        </div>
      </div>
    </>
  )
}

function TabButton({
  icon: Icon, label, active, disabled, onClick,
}: {
  icon: React.ElementType
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${label} — not generated yet` : label}
      className={cn(
        'flex items-center gap-1.5 px-4 py-2 text-label transition-colors border-b-2 -mb-px',
        active
          ? 'text-text-1 border-accent'
          : disabled
            ? 'text-text-4 border-transparent opacity-50 cursor-not-allowed'
            : 'text-text-3 border-transparent hover:text-text-1 hover:border-border-default',
      )}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-40 gap-3 text-text-4 text-center px-6">
      <FileText size={32} className="opacity-30" />
      <p className="text-label leading-relaxed">{message}</p>
    </div>
  )
}

// ─── Report body — promotes the dimensional-scoring table into a hero +
// grouped sections. Falls back to plain markdown when parsing fails so
// older / custom report formats still render readably. ──────────────────────

function ReportBody({ content, tier }: { content: string; tier: TierKey }) {
  // Parse once per content change, not on every render. The slide-over
  // re-renders frequently (animation flag, parent state) and the regex /
  // line-walk parsers were running every time, causing a visible flicker.
  const parsed = useMemo(() => {
    const { before, dims, after } = parseDimensionalScoring(content)
    if (!dims) return { dims: null as ParsedDimensions | null, before: '', after: '', meta: [] as Array<{ key: string; value: string }>, beforeWithoutMeta: '' }
    const { meta, rest: beforeWithoutMeta } = extractMetadata(before)
    return { dims, before, after, meta, beforeWithoutMeta }
  }, [content])

  if (!parsed.dims) {
    return (
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    )
  }
  const { dims, after, meta, beforeWithoutMeta } = parsed
  return (
    <>
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{beforeWithoutMeta}</ReactMarkdown>
      </div>
      {meta.length > 0 && <ReportMeta items={meta} />}
      <DimensionalScoring dims={dims} tier={tier} />
      {after && (
        <div className="prose-report">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
        </div>
      )}
    </>
  )
}

// Header metadata: keep contextual fields (Date / Mode / Location /
// Archetype) and drop the duplicated ones — URL has its own pill, the score
// fields are now visually prominent in the hero + section rollups, and Tier
// is in the slide-over header. The whitelist is case-insensitive on key.
const META_KEEP = new Set(['date', 'mode', 'location', 'archetype'])

function extractMetadata(text: string): {
  meta: Array<{ key: string; value: string }>
  rest: string
} {
  const lines = text.split('\n')
  const kept: Array<{ key: string; value: string }> = []
  const out: string[] = []
  // Match "**Key:** value" anywhere in the line (the metadata block has one
  // pair per line in current reports, but we forgive trailing whitespace).
  const metaRe = /^\s*\*\*([^*:]+?):\*\*\s*(.+?)\s*$/
  for (const line of lines) {
    const m = metaRe.exec(line)
    if (m) {
      const key = m[1].trim()
      const value = m[2].trim()
      if (META_KEEP.has(key.toLowerCase())) {
        kept.push({ key, value })
      }
      // Either way, the line is consumed — we don't want to re-render the
      // dropped fields as a stray paragraph.
      continue
    }
    out.push(line)
  }
  // Collapse the run of blank lines the removed metadata block leaves behind.
  const rest = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { meta: kept, rest }
}

function ReportMeta({ items }: { items: Array<{ key: string; value: string }> }) {
  return (
    <div className="my-4 grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 rounded-lg bg-bg-elevated/50 border border-border-default">
      {items.map(({ key, value }) => (
        <div key={key} className="flex flex-col min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-4">
            {key}
          </span>
          <span className="text-[12.5px] text-text-1 truncate" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  )
}

interface DimensionRow {
  label: string
  score: string
  reasoning: string
}
interface ParsedDimensions {
  overall: { score: string } | null
  currentFit: { rollup: string; rows: DimensionRow[] }
  aspirationalFit: { rollup: string; rows: DimensionRow[] }
  context: { rows: DimensionRow[] }
}

// Split the markdown around the "## Dimensional scoring" section, parse the
// table inside it, and categorise the rows. Phase walks: rows before the
// Current Fit rollup → CF dimensions; between CF rollup and AF rollup → AF
// dimensions; after Overall → context. Rows tagged `(context)` are routed
// to the context group regardless of position. The arithmetic on rollup /
// Overall rows is intentionally discarded — section grouping replaces it.
function parseDimensionalScoring(md: string): {
  before: string
  dims: ParsedDimensions | null
  after: string
} {
  const headingRe = /^##\s+Dimensional\s+scoring\s*$/im
  const m = headingRe.exec(md)
  if (!m) return { before: md, dims: null, after: '' }

  const before = md.slice(0, m.index)
  const rest = md.slice(m.index + m[0].length)

  const nextHeadingRe = /\n##\s+\S/m
  const nextMatch = nextHeadingRe.exec(rest)
  const tableSection = nextMatch ? rest.slice(0, nextMatch.index) : rest
  const after = nextMatch ? rest.slice(nextMatch.index + 1) : ''

  const tableLines = tableSection
    .split('\n')
    .filter(l => l.trim().startsWith('|'))
    .filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l))

  if (tableLines.length < 2) return { before: md, dims: null, after: '' }

  const rows = tableLines.slice(1).map(parseRow).filter(Boolean) as Array<{
    label: string
    score: string
    reasoning: string
    tag: 'rollup' | 'signal' | 'context' | null
  }>

  const dims: ParsedDimensions = {
    overall: null,
    currentFit:      { rollup: '', rows: [] },
    aspirationalFit: { rollup: '', rows: [] },
    context:         { rows: [] },
  }

  type Phase = 'cf' | 'af' | 'post-overall'
  let phase: Phase = 'cf'

  for (const row of rows) {
    const labelLower = row.label.toLowerCase()

    if (labelLower === 'overall' || labelLower.startsWith('overall ')) {
      dims.overall = { score: row.score }
      phase = 'post-overall'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('current fit')) {
      dims.currentFit.rollup = row.score
      phase = 'af'
      continue
    }
    if (row.tag === 'rollup' && labelLower.startsWith('aspirational fit')) {
      dims.aspirationalFit.rollup = row.score
      continue
    }
    if (row.tag === 'context' || phase === 'post-overall') {
      dims.context.rows.push({ label: row.label, score: row.score, reasoning: row.reasoning })
      continue
    }

    const dimRow: DimensionRow = { label: row.label, score: row.score, reasoning: row.reasoning }
    if (phase === 'cf') dims.currentFit.rows.push(dimRow)
    else                dims.aspirationalFit.rows.push(dimRow)
  }

  // Sanity: if we found no group rows at all, abort and fall back.
  if (
    !dims.overall &&
    dims.currentFit.rows.length === 0 &&
    dims.aspirationalFit.rows.length === 0 &&
    dims.context.rows.length === 0
  ) {
    return { before: md, dims: null, after: '' }
  }

  return { before, dims, after }
}

function parseRow(line: string) {
  // "| a | b | c |" → ['', ' a ', ' b ', ' c ', ''] → ['a','b','c']
  const cells = line.split('|').slice(1, -1).map(c => c.trim())
  if (cells.length < 2) return null
  let [label, score, reasoning = ''] = cells
  // Strip surrounding markdown bold (whole-cell only — keeps inline emphasis)
  label = label.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  score = score.replace(/^\*\*(.+)\*\*$/, '$1').trim()
  // Strip "/N" suffix (handles both 1–10 and the old 1–5 reports)
  score = score.replace(/\s*\/\s*\d+\s*$/, '').trim()
  // Detect and strip the trailing parenthetical tag
  const tagMatch = label.match(/\(\s*(rollup|signal|context)\s*\)\s*$/i)
  const tag = tagMatch ? (tagMatch[1].toLowerCase() as 'rollup' | 'signal' | 'context') : null
  const cleanLabel = label.replace(/\s*\(\s*(rollup|signal|context)\s*\)\s*$/i, '').trim()
  return { label: cleanLabel, score, reasoning, tag }
}

function tierHex(t: TierKey): string {
  switch (t) {
    case 'T1':      return '#3D2BB5'
    case 'T2-high':
    case 'T2':      return '#7C5CFF'
    case 'T3':      return '#A89CD9'
    default:        return '#94A3B8'
  }
}

function DimensionalScoring({ dims, tier }: { dims: ParsedDimensions; tier: TierKey }) {
  const heroColor = tierHex(tier)
  return (
    <div className="my-5 space-y-6">
      {dims.overall && (
        <div
          className="flex items-center justify-between gap-3 px-3 py-2 rounded-md"
          style={{
            background: `${heroColor}10`,
            border: `1px solid ${heroColor}30`,
          }}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
            Overall
          </span>
          <span
            className="font-mono font-semibold tabular-nums leading-none text-[18px]"
            style={{ color: heroColor }}
          >
            {dims.overall.score}
          </span>
        </div>
      )}

      {dims.currentFit.rows.length > 0 && (
        <DimensionGroup
          title="Current Fit"
          rollup={dims.currentFit.rollup}
          rows={dims.currentFit.rows}
        />
      )}
      {dims.aspirationalFit.rows.length > 0 && (
        <DimensionGroup
          title="Aspirational Fit"
          rollup={dims.aspirationalFit.rollup}
          rows={dims.aspirationalFit.rows}
        />
      )}
      {dims.context.rows.length > 0 && (
        <DimensionGroup title="Context" rows={dims.context.rows} />
      )}
    </div>
  )
}

function DimensionGroup({
  title,
  rollup,
  rows,
}: {
  title: string
  rollup?: string
  rows: DimensionRow[]
}) {
  const rollupNum = rollup ? parseFloat(rollup) : NaN
  const rollupColor = !Number.isNaN(rollupNum) ? scoreColor(rollupNum) : '#6B7280'
  return (
    <div>
      {/* Group header — same visual rhythm as the prose-report h2 (Fit/gaps,
          Verdict, Path forward) so the slide-over reads with one type
          system across the body. Title left, rollup score right (tinted by
          the score-color galaxy palette to match the Overall band). */}
      <div className="flex items-baseline justify-between gap-3 pb-2 mb-3 border-b border-border-default">
        <h3 className="text-[14px] font-semibold text-text-1">{title}</h3>
        {rollup && (
          <span
            className="text-[18px] font-mono font-semibold tabular-nums leading-none"
            style={{ color: rollupColor }}
          >
            {rollup}
          </span>
        )}
      </div>
      <div className="divide-y divide-border-default/40">
        {rows.map((row, i) => {
          const numScore = parseFloat(row.score)
          const isNumeric = !Number.isNaN(numScore)
          const cellColor = isNumeric ? scoreColor(numScore) : '#6B7280'
          return (
            <div
              key={i}
              className="grid grid-cols-[140px_1fr] gap-5 py-3.5 items-start"
            >
              {/* Left col: stacked Category label / large score */}
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-3 leading-tight">
                  {row.label}
                </div>
                <div
                  className="font-mono font-semibold tabular-nums leading-none mt-1.5"
                  style={{
                    fontSize: isNumeric ? '22px' : '15px',
                    color: cellColor,
                  }}
                >
                  {row.score || '—'}
                </div>
              </div>
              {/* Right col: reasoning at body-text size (was 11.5px — too
                  small to read comfortably; now 13px with relaxed leading). */}
              <div className="text-[13px] text-text-2 leading-[1.55] pt-0.5">
                {row.reasoning && row.reasoning !== '—' ? row.reasoning : (
                  <span className="text-text-4 italic">No reasoning provided.</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Scale-tier color used for both numeric scores and rollup totals. Matches
// the galaxy palette used by Database/Reports so the same number reads as
// the same color everywhere it appears.
function scoreColor(v: number): string {
  if (v >= 8.5) return '#3D2BB5'   // tier-1 — deep galaxy indigo
  if (v >= 7)   return '#7C5CFF'   // tier-2 — galaxy violet
  if (v >= 5)   return '#A89CD9'   // tier-3 — muted lavender
  return '#94A3B8'                 // tier-4 — faded slate
}

function ScoreMiniBar({ entry }: { entry: ScoreEntry }) {
  const dims: Array<{ key: keyof ScoreEntry; label: string }> = [
    { key: 'skills_match',     label: 'Skills' },
    { key: 'strategic_fit',    label: 'Strategy' },
    { key: 'growth_mobility',  label: 'Growth' },
    { key: 'brand_value',      label: 'Brand' },
    { key: 'work_life_balance', label: 'WLB' },
    { key: 'salary_adj_city',  label: 'Comp' },
  ]

  return (
    <div className="flex gap-3 px-5 py-3 border-b border-border-default bg-bg-elevated/50 shrink-0 overflow-x-auto">
      {dims.map(({ key, label }) => {
        const raw = entry[key]
        const val = typeof raw === 'number' ? raw : 0
        const pct = Math.min(100, (val / 10) * 100)
        const color =
          val >= 8 ? 'bg-success' :
          val >= 6 ? 'bg-accent' :
          val >= 4 ? 'bg-warning' : 'bg-danger'
        return (
          <div key={key} className="flex flex-col gap-1 items-center min-w-[56px]">
            <span className="text-micro text-text-4 uppercase whitespace-nowrap">{label}</span>
            <div className="w-full h-1 bg-bg-elevated rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-micro font-mono text-text-3">{val.toFixed(1)}</span>
          </div>
        )
      })}
    </div>
  )
}
