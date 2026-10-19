'use client'

// One editable offer in the comparison: a label field + the six 1-10 factor
// scales. Stateless / controlled — the OffersView owns the draft array and
// passes mutators down. Shows the live weighted total once a comparison is
// running so the user sees each edit move the number.

import { X, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FACTORS, FACTOR_LABELS, FACTOR_HELP, type Factor } from '@/lib/offerCompare'
import type { OfferDraft } from '@/lib/offerDrafts'
import { Button, Chip, ScoreNumber } from '@/components/ui'
import { FactorScale } from './FactorScale'

interface OfferCardProps {
  draft: OfferDraft
  /** Rank among the compared offers (1-based) when a comparison is live. */
  rank?: number
  /** How many offers are ranked, for the "#1 of 3" chip. Optional. */
  rankOf?: number
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
  rankOf,
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
    <div className="card p-4 flex flex-col gap-3">
      {/* Header: label field · rank chip · total · remove */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <input
            type="text"
            value={draft.label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="Company — Role"
            aria-label="Offer label"
            spellCheck={false}
            className={cn(
              'input font-medium',
              duplicateLabel
                ? 'border-danger/60'
                : blank
                  ? 'border-warning/60'
                  : undefined,
            )}
          />
        </div>
        {typeof rank === 'number' && (
          <Chip
            tone={isWinner ? 'success' : 'accent'}
            size="sm"
            className="shrink-0"
            title={`Rank #${rank}`}
          >
            #{rank}{typeof rankOf === 'number' && rankOf > 0 ? ` of ${rankOf}` : ''}
          </Chip>
        )}
        {typeof total === 'number' && (
          <ScoreNumber
            value={total}
            size="md"
            decimals={2}
            className="shrink-0 min-w-10 text-right"
            title="Weighted total"
          />
        )}
        {canRemove && (
          <Button
            tone="ghost"
            size="xs"
            iconOnly
            icon={<X size={14} aria-hidden />}
            onClick={onRemove}
            aria-label={`Remove ${draft.label || 'offer'}`}
            title="Remove offer"
            className="shrink-0 hover:text-danger"
          />
        )}
      </div>

      {duplicateLabel && (
        <p className="text-label text-danger -mt-1.5">Labels must be unique — rename this offer.</p>
      )}

      {/* Factor rows */}
      <div className="flex flex-col gap-1.5">
        {FACTORS.map((f: Factor) => (
          <div key={f} className="grid grid-cols-[112px_1fr] items-center gap-3">
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-label text-text-2 truncate">{FACTOR_LABELS[f]}</span>
              <span className="text-text-4 shrink-0 cursor-help" title={FACTOR_HELP[f]} aria-hidden>
                <Info size={12} />
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
