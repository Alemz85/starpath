'use client'

import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { scoreColor, NEUTRAL_SCORE_COLOR } from '@/lib/tier'
import { ScoreNumber } from '@/components/ui'
import type { ReportSummary } from './reportFacts'

// Pieces of the report dossier's header and summary card (DESIGN-meta § 6,
// Report dossier; § 7, Score tile). Self-contained so the dossier can mount
// anywhere (the Database today, the Applying board next).

// ─── Job facts ───────────────────────────────────────────────────────────────
//
// The listing's own facts (where, how, contract, pay, when it appeared) as a
// stacked label/value list: one fact per line, labels in a fixed column so
// the values line up. Facts the data doesn't have are left out, never "—".

export interface JobFact {
  label: string
  value: ReactNode
  /** Full text on hover when the value is shortened. */
  title?: string
}

export function JobFacts({ facts, className }: { facts: JobFact[]; className?: string }) {
  if (facts.length === 0) return null
  return (
    <dl className={cn('grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-label', className)} aria-label="Job facts">
      {facts.map(f => (
        <div key={f.label} className="contents">
          <dt className="text-text-3">{f.label}</dt>
          <dd className="text-text-1 min-w-0 truncate" title={f.title ?? (typeof f.value === 'string' ? f.value : undefined)}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ─── Score tile ──────────────────────────────────────────────────────────────
//
// One of the two scores as a filled tile: the tile itself takes a faint wash
// of the score's ladder colour, the number sits at stat size beside its
// label, and a ten-segment meter under both fills to the score (partial last
// segment for decimals). The two tiles stack in the summary card's left third.
// Match and Ease each get their own tile and their own ladder colour; there is
// never a combined tile.

export function ScoreTile({ label, value }: { label: string; value: number | null | undefined }) {
  const n = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(10, value) : null
  const color = n != null ? scoreColor(n) : NEUTRAL_SCORE_COLOR
  return (
    <div
      className="min-w-0 rounded-lg border px-3.5 py-3"
      style={{
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 20%, transparent)`,
      }}
      title={`${label} ${n != null ? n.toFixed(2) : '—'} / 10`}
    >
      <div className="flex items-end justify-between gap-3">
        <span className="min-w-0 text-body font-medium text-text-1">{label}</span>
        <div className="shrink-0 flex items-baseline gap-1">
          <ScoreNumber value={n} size="lg" decimals={2} />
          <span className="text-micro text-text-4">/10</span>
        </div>
      </div>
      <ScoreMeter value={n} color={color} className="mt-2.5" />
    </div>
  )
}

function ScoreMeter({ value, color, className }: { value: number | null; color: string; className?: string }) {
  return (
    <div className={cn('flex gap-[3px]', className)} aria-hidden>
      {Array.from({ length: 10 }, (_, i) => {
        const fill = value == null ? 0 : Math.max(0, Math.min(1, value - i))
        return (
          <span key={i} className="relative flex-1 h-1.5 rounded-full bg-bar-track overflow-hidden">
            {fill > 0 && <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${fill * 100}%`, background: color }} />}
          </span>
        )
      })}
    </div>
  )
}

// ─── Summary card ────────────────────────────────────────────────────────────
//
// The dossier's first card, in thirds: the two score tiles on the left, the
// report's own TL;DR on the right two thirds, verbatim. When the report has
// no TL;DR line the Recommendation's opening paragraph stands in, labelled as
// such; when it has neither, the card says so rather than writing one.

export function SummaryCard({ match, ease, blockedReason, summary }: {
  match: number | null
  ease: number | null
  blockedReason: string | null
  summary: ReportSummary | null
}) {
  return (
    <section data-slug="summary" data-label="Summary" className="card p-4 grid grid-cols-3 gap-5 scroll-mt-4">
      <div className="col-span-1 min-w-0">
        {blockedReason ? (
          <div className="h-full rounded-lg border border-danger/25 bg-danger/5 px-3.5 py-3 flex flex-col gap-1">
            <span className="label">Blocked</span>
            <span className="text-body text-danger leading-snug">{blockedReason}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <ScoreTile label="Match" value={match} />
            <ScoreTile label="Ease" value={ease} />
          </div>
        )}
      </div>
      <div className="col-span-2 min-w-0 flex flex-col justify-center py-1 pr-2">
        <span className="label">{summary?.source === 'recommendation' ? 'From the recommendation' : 'TL;DR'}</span>
        {summary ? (
          <p className="mt-1.5 text-section font-normal text-text-1 leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ p: ({ children }: { children?: ReactNode }) => <>{children}</> }}
            >
              {summary.text}
            </ReactMarkdown>
          </p>
        ) : (
          <p className="mt-1.5 text-body text-text-3">This report has no TL;DR line.</p>
        )}
      </div>
    </section>
  )
}
