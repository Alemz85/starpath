'use client'

import { useEffect, useState, useCallback } from 'react'
import { X, FileText, Database as DatabaseIcon, ExternalLink } from 'lucide-react'
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
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setTimeout(onClose, 260)
  }, [onClose])

  const loadReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    setContent(null)

    if (!repoPath) {
      setError('No repo path set.')
      setLoading(false)
      return
    }

    // Try to find the report by scanning known tier directories
    const tierDirs = ['tier-1', 'tier-2', 'tier-3', 'tier-4']
    let found: string | null = null

    for (const dir of tierDirs) {
      const path = `reports/${dir}/${company} - ${role}.md`
      const exists = await ipc.fileExists(path)
      if (exists) { found = path; break }
    }

    // Fallback: flat reports/
    if (!found) {
      const flat = `reports/${company} - ${role}.md`
      const exists = await ipc.fileExists(flat)
      if (exists) found = flat
    }

    if (!found) {
      setError('Report not found for this entry.')
      setLoading(false)
      return
    }

    const text = await ipc.readFile(found)
    if (text) {
      setContent(text)
    } else {
      setError('Could not read report file.')
    }
    setLoading(false)
  }, [company, role, repoPath])

  useEffect(() => {
    loadReport()
  }, [loadReport])

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
          {scoreEntry.source && /^https?:\/\//i.test(scoreEntry.source) && (
            <button
              onClick={() => ipc.openExternal(scoreEntry.source)}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-pill border border-border-default bg-bg-elevated text-text-2 hover:text-text-1 hover:border-border-strong text-[12px] transition-colors"
            >
              <ExternalLink size={11} />
              Open URL
            </button>
          )}
          <div className="flex-1" />
          <FilesStrip company={company} role={role} size="md" />
        </div>

        {/* Score mini-bar — only when we have real score data */}
        {scoreEntry.overall > 0 && <ScoreMiniBar entry={scoreEntry} />}

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
          {content && <ReportBody content={content} tier={tierKey} />}
        </div>
      </div>
    </>
  )
}

// ─── Report body — promotes the dimensional-scoring table into a hero +
// grouped sections. Falls back to plain markdown when parsing fails so
// older / custom report formats still render readably. ──────────────────────

function ReportBody({ content, tier }: { content: string; tier: TierKey }) {
  const { before, dims, after } = parseDimensionalScoring(content)
  if (!dims) {
    return (
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    )
  }
  return (
    <>
      <div className="prose-report">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{before}</ReactMarkdown>
      </div>
      <DimensionalScoring dims={dims} tier={tier} />
      {after && (
        <div className="prose-report">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{after}</ReactMarkdown>
        </div>
      )}
    </>
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
          className="relative rounded-2xl px-6 py-7 text-center overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${heroColor}1F 0%, ${heroColor}0A 100%)`,
            border: `1px solid ${heroColor}33`,
          }}
        >
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-text-4 mb-2">
            Overall
          </div>
          <div
            className="font-mono font-bold tabular-nums leading-none"
            style={{
              fontSize: '52px',
              color: heroColor,
              textShadow: `0 0 28px ${heroColor}55`,
            }}
          >
            {dims.overall.score}
          </div>
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
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 pb-1.5 mb-2 border-b border-border-default">
        <h3 className="text-[13.5px] font-semibold text-text-1">{title}</h3>
        {rollup && (
          <span className="text-[17px] font-mono font-semibold tabular-nums text-text-2 leading-none">
            {rollup}
          </span>
        )}
      </div>
      <div className="divide-y divide-border-default/60">
        {rows.map((row, i) => {
          const isText = !/^\d/.test(row.score)
          return (
            <div key={i} className="py-2">
              <div className="flex items-baseline gap-3">
                <div className="flex-1 min-w-0 text-[13px] text-text-1 font-medium">
                  {row.label}
                </div>
                <div
                  className={cn(
                    'shrink-0 font-mono tabular-nums text-right',
                    isText
                      ? 'text-[13px] text-text-4'
                      : 'text-[14px] font-semibold text-text-1',
                  )}
                  style={{ minWidth: '2.5em' }}
                >
                  {row.score || '—'}
                </div>
              </div>
              {row.reasoning && row.reasoning !== '—' && (
                <div className="text-[11.5px] text-text-3 leading-snug mt-1 pr-12">
                  {row.reasoning}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
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
