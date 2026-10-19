'use client'

// A compact 1–10 segmented selector for one factor score. Ten numbered cells;
// the chosen value fills with the accent, the cells below it carry the accent
// wash (so the row still reads like a level meter), the rest stay as quiet
// track. Keyboard-operable (arrow keys nudge ±1) and announces its value for
// screen readers.
//
// Discrete cells rather than a native <input type="range"> on purpose: factor
// scores are integers 1–10, the bands are meaningful, and the segmented strip
// matches the design system's segmented-control language.

import { cn } from '@/lib/utils'

interface FactorScaleProps {
  value: number
  onChange: (v: number) => void
  /** Accessible name, e.g. "Compensation score for Stripe — Analyst". */
  ariaLabel: string
  /** Dim the control (used while a draft has a blank label, etc.). */
  disabled?: boolean
}

const CELLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

export function FactorScale({ value, onChange, ariaLabel, disabled }: FactorScaleProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      onChange(Math.min(10, value + 1))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      onChange(Math.max(1, value - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onChange(1)
    } else if (e.key === 'End') {
      e.preventDefault()
      onChange(10)
    }
  }

  return (
    <div
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={1}
      aria-valuemax={10}
      aria-valuenow={value}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKeyDown}
      className={cn(
        // Font size lives here, not on the cells: cn() would let the cells'
        // text colour swallow a custom `text-micro` size.
        'flex gap-0.5 rounded outline-none text-micro',
        'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-base',
        disabled && 'opacity-50',
      )}
    >
      {CELLS.map((cell) => {
        const selected = cell === value
        const below = cell < value
        return (
          <button
            key={cell}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => onChange(cell)}
            aria-hidden
            title={`${cell}`}
            className={cn(
              'h-6 flex-1 min-w-0 rounded tabular-nums transition-colors duration-150 ease-quart',
              selected
                ? 'bg-accent text-white'
                : below
                  ? 'bg-accent-soft text-accent-text hover:bg-accent/20'
                  : 'bg-bg-elevated text-text-4 hover:bg-bg-panel hover:text-text-2',
              !disabled && 'cursor-pointer',
            )}
          >
            {cell}
          </button>
        )
      })}
    </div>
  )
}
