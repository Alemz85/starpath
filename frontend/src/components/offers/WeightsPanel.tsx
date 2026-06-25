'use client'

// The priority weights panel: one 0–5 importance dial per factor. Weights are
// relative — the engine normalizes them to sum to 1 — so the panel shows the
// resulting normalized share next to each so the user sees how their priorities
// translate into the ranking. A "Reset to equal" returns to the neutral
// fallback. Nothing here encodes a candidate's priorities as a default; the
// view seeds it with uniform weights (modes/ofertas.md keeps the system
// fallback neutral on purpose).

import { Scale, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FACTORS, FACTOR_LABELS, normalizeWeights, type Factor, type FactorScores } from '@/lib/offerCompare'

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
    <div className="rounded-2xl border border-border-default bg-bg-panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <Scale size={14} className="text-accent" />
        <h2 className="text-section text-text-1">Your priorities</h2>
        <span className="text-label text-text-4">— how much each factor counts</span>
        <div className="flex-1" />
        <button
          onClick={onReset}
          disabled={isUniform}
          className={cn(
            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] transition-colors',
            isUniform
              ? 'text-text-4 cursor-not-allowed'
              : 'text-text-3 hover:text-text-1 hover:bg-bg-elevated',
          )}
          title="Weight every factor equally"
        >
          <RotateCcw size={11} />
          Reset to equal
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
        {FACTORS.map((f: Factor) => {
          const share = Math.round(normalized[f] * 100)
          return (
            <div key={f} className="flex items-center gap-3">
              <span className="text-label text-text-2 w-[108px] shrink-0 truncate">{FACTOR_LABELS[f]}</span>
              <div className="flex gap-1 flex-1" role="radiogroup" aria-label={`${FACTOR_LABELS[f]} importance`}>
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
                        'h-4 flex-1 rounded-[3px] transition-colors duration-150 ease-quart cursor-pointer',
                        active
                          ? 'bg-accent'
                          : isZeroSelected
                            ? 'bg-border-strong'
                            : 'bg-[var(--dolly-bg-grey)] hover:bg-border-default',
                      )}
                      title={step === 0 ? 'Ignore this factor' : `Importance ${step}`}
                    />
                  )
                })}
              </div>
              <span
                className={cn(
                  'w-9 text-right text-label font-mono tabular-nums shrink-0',
                  share === 0 ? 'text-text-4' : 'text-text-3',
                )}
                title="Normalized share of the ranking"
              >
                {share}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
