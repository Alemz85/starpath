'use client'

// One editable offer in the comparison: a label field + the six 1-10 factor
// scales. Stateless / controlled — the OffersView owns the draft array and
// passes mutators down. Shows the live weighted total once a comparison is
// running so the user sees each edit move the number.

import { X, GripVertical, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { scoreColor } from '@/lib/tier'
import { FACTORS, FACTOR_LABELS, FACTOR_HELP, type Factor } from '@/lib/offerCompare'
import type { OfferDraft } from '@/lib/offerDrafts'
import { FactorScale } from './FactorScale'

interface OfferCardProps {
  draft: OfferDraft
  /** Rank among the compared offers (1-based) when a comparison is live. */
  rank?: number
  /** Weighted total when a comparison is live. */
  total?: number
  /** True for the #1 offer so the card can wear a subtle winner accent. */
  isWinner?: boolean
  duplicateLabel?: boolean
  onLabelChange: (label: string) => void
  onScoreChange: (factor: Factor, value: number) => void
  onRemove: () => void
  /** Only allow removal down to the 2-offer floor in the parent; the button is
   *  hidden when false so the user can't delete below a comparable set. */
  canRemove: boolean
}

export function OfferCard({
  draft,
  rank,
  total,
  isWinner,
  duplicateLabel,
  onLabelChange,
  onScoreChange,
  onRemove,
  canRemove,
}: OfferCardProps) {
  const blank = draft.label.trim().length === 0

  return (
    <div
      className={cn(
        'rounded-2xl border bg-bg-base p-4 flex flex-col gap-3 shadow-subtle transition-colors',
        isWinner ? 'border-accent/50' : 'border-border-default',
      )}
    >
      {/* Header: rank chip · label field · remove */}
      <div className="flex items-center gap-2.5">
        <GripVertical size={14} className="text-text-4 shrink-0" aria-hidden />
        {typeof rank === 'number' && (
          <span
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-medium tabular-nums"
            style={
              isWinner
                ? { background: '#7C5CFF', color: '#fff' }
                : { background: 'var(--dolly-bg-grey)', color: 'var(--dolly-text-secondary)' }
            }
            title={`Rank #${rank}`}
          >
            {rank}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <input
            type="text"
            value={draft.label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="Company — Role"
            aria-label="Offer label"
            spellCheck={false}
            className={cn(
              'w-full bg-transparent outline-none text-section text-text-1 placeholder:text-text-4',
              'border-b transition-colors pb-0.5',
              duplicateLabel
                ? 'border-danger/60'
                : blank
                  ? 'border-warning/50'
                  : 'border-transparent hover:border-border-default focus:border-accent/50',
            )}
          />
        </div>
        {typeof total === 'number' && (
          <span
            className="shrink-0 text-section font-mono tabular-nums font-medium"
            style={{ color: scoreColor(total) }}
            title="Weighted total"
          >
            {total.toFixed(2)}
          </span>
        )}
        {canRemove && (
          <button
            onClick={onRemove}
            aria-label={`Remove ${draft.label || 'offer'}`}
            className="shrink-0 p-1 rounded-md text-text-4 hover:text-danger hover:bg-danger/5 transition-colors"
            title="Remove offer"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {duplicateLabel && (
        <p className="text-[11px] text-danger -mt-1">Labels must be unique — rename this offer.</p>
      )}

      {/* Factor rows */}
      <div className="flex flex-col gap-2">
        {FACTORS.map((f: Factor) => (
          <div key={f} className="grid grid-cols-[120px_1fr] items-center gap-3">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-label text-text-2 truncate">{FACTOR_LABELS[f]}</span>
              <span className="text-text-4 shrink-0 cursor-help" title={FACTOR_HELP[f]} aria-hidden>
                <Info size={11} />
              </span>
            </div>
            <FactorScale
              value={draft.scores[f]}
              onChange={(v) => onScoreChange(f, v)}
              ariaLabel={`${FACTOR_LABELS[f]} score for ${draft.label || 'offer'}`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
