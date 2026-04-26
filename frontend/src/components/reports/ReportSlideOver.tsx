'use client'

import { useEffect, useState, useCallback } from 'react'
import { X, FileText } from 'lucide-react'
import { useAppStore } from '@/store/app'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { TIER_COLORS, type TierKey } from '@/types'
import type { ScoreEntry } from '@/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface ReportSlideOverProps {
  company: string
  role: string
  scoreEntry: ScoreEntry
  onClose: () => void
}

export function ReportSlideOver({ company, role, scoreEntry, onClose }: ReportSlideOverProps) {
  const { repoPath } = useAppStore()
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
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border-default shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={cn('text-micro font-mono font-semibold', tierText)}>
                {tierKey === 'T2-high' ? 'T2+' : tierKey}
              </span>
              <span className="text-micro text-text-4">·</span>
              <span className="text-micro text-text-4 font-mono">{scoreEntry.overall.toFixed(1)} / 10</span>
              {scoreEntry.location && (
                <>
                  <span className="text-micro text-text-4">·</span>
                  <span className="text-micro text-text-4">{scoreEntry.location}</span>
                </>
              )}
            </div>
            <h2 className="text-section text-text-1 font-semibold leading-tight truncate">{company}</h2>
            <p className="text-label text-text-3 truncate">{role}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-text-4 hover:text-text-2 hover:bg-bg-elevated transition-colors"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Score mini-bar */}
        <ScoreMiniBar entry={scoreEntry} />

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
          {content && (
            <div className="prose-report">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </>
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
