'use client'

// The priority weights panel: one 0–5 importance dial per factor. Weights are
// relative — the engine normalizes them to sum to 1 — so the panel shows the
// resulting normalized share next to each so the user sees how their priorities
// translate into the ranking. A "Reset" returns to the neutral equal-weight
// fallback. Nothing here encodes a candidate's priorities as a default; the
// view seeds it with uniform weights (modes/ofertas.md keeps the system
// fallback neutral on purpose).

import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FACTORS, FACTOR_LABELS, normalizeWeights, type Factor, type FactorScores } from '@/lib/offerCompare'
import { Button, Panel } from '@/components/ui'

interface WeightsPanelProps {
  weights: FactorScores
  onChange: (factor: Factor, value: number) => void
  onReset: () => void
}

// Importance steps shown under each factor. 0 = "ignore this factor entirely".
const STEPS = [0, 1, 2, 3, 4, 5]

export function WeightsPanel({ weights, onChange, onReset }: WeightsPanelProps) {
  const normalized = normalizeWeights(weights)
  const isUniform = FACTORS.every((f) => weights[f] === weights.comp)

  return (
    <Panel
      title="Weights"
      meta="How much each factor counts"
      action={
        <Button
          tone="ghost"
          size="xs"
          icon={<RotateCcw size={12} aria-hidden />}
          onClick={onReset}
          disabled={isUniform}
          title="Weight every factor equally"
        >
          Reset
        </Button>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {FACTORS.map((f: Factor) => {
          const share = Math.round(normalized[f] * 100)
          return (
            <div key={f} className="flex items-center gap-3">
              <span className="text-label text-text-2 w-[108px] shrink-0 truncate">{FACTOR_LABELS[f]}</span>
              <div className="flex gap-0.5 flex-1" role="radiogroup" aria-label={`${FACTOR_LABELS[f]} importance`}>
                {STEPS.map((step) => {
                  const active = weights[f] >= step && step > 0
                  const isZeroSelected = weights[f] === 0 && step === 0
                  return (
                    <button
                      key={step}
                      type="button"
                      role="radio"
                      aria-checked={weights[f] === step}
                      aria-label={`${FACTOR_LABELS[f]} importance ${step}`}
                      onClick={() => onChange(f, step)}
                      className={cn(
                        'h-4 flex-1 rounded-sm transition-colors duration-150 ease-quart cursor-pointer',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        active
                          ? 'bg-accent hover:bg-accent-hover'
                          : isZeroSelected
                            ? 'bg-border-strong'
                            : 'bg-bg-panel hover:bg-border-default',
                      )}
                      title={step === 0 ? 'Ignore this factor' : `Importance ${step}`}
                    />
                  )
                })}
              </div>
              <span
                className={`w-9 text-right text-label tabular-nums shrink-0 ${share === 0 ? 'text-text-4' : 'text-text-3'}`}
                title="Normalized share of the ranking"
              >
                {share}%
              </span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
