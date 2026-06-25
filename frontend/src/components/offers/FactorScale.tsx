'use client'

// A compact 1–10 segmented selector for one factor score. Ten cells; the
// chosen value and everything below it fills with the score color (so the row
// reads like a level meter), the rest stays as quiet track. Keyboard-operable
// (arrow keys nudge ±1) and announces its value for screen readers.
//
// Discrete cells rather than a native <input type="range"> on purpose: factor
// scores are integers 1–10, the bands are meaningful, and the segmented strip
// matches the design system's pill/segmented language (no new control idiom).

import { cn } from '@/lib/utils'
import { scoreColor } from '@/lib/tier'

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
  const color = scoreColor(value)

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
    <div className="flex items-center gap-2">
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
          'flex-1 flex gap-[3px] rounded-md outline-none',
          'focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-base',
          disabled && 'opacity-50',
        )}
      >
        {CELLS.map((cell) => {
          const filled = cell <= value
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
                'h-5 flex-1 rounded-[3px] transition-[background-color,transform] duration-150 ease-quart',
                !disabled && 'hover:scale-y-110 cursor-pointer',
              )}
              style={{
                backgroundColor: filled ? color : 'var(--dolly-bg-grey)',
              }}
            />
          )
        })}
      </div>
      <span
        className="w-6 text-right text-label font-mono tabular-nums font-medium shrink-0"
        style={{ color }}
      >
        {value}
      </span>
    </div>
  )
}
