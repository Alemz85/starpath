'use client'

import { forwardRef, useId, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// The one on/off control (DESIGN-meta § 7). A choice between named options
// stays a segmented control; a setting that is simply on or off is a Switch,
// so its two states read at a glance: filled `action` track with the knob on
// the right when on, hairline-grey track with the knob on the left when off.
// Rendered as a native button with role="switch" so Space and Enter toggle it
// and the focus ring matches every other control.

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role'> {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Accessible name. Visible beside the track unless `labelHidden`. */
  label: string
  /** Render the label for assistive tech only. */
  labelHidden?: boolean
  disabled?: boolean
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, labelHidden = false, disabled, className, id, ...rest },
  ref,
) {
  const autoId = useId()
  const labelId = `${id ?? autoId}-label`
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <button
        ref={ref}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'titlebar-no-drag relative inline-flex h-4 w-7 shrink-0 items-center rounded-pill',
          'transition-colors duration-150 ease-quart',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-base',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-action' : 'bg-border-strong',
        )}
        {...rest}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none block h-3 w-3 rounded-full bg-bg-base shadow-subtle',
            'transition-transform duration-150 ease-quart',
            checked ? 'translate-x-[14px]' : 'translate-x-[2px]',
          )}
        />
      </button>
      <span id={labelId} className={labelHidden ? 'sr-only' : 'text-body text-text-1'}>
        {label}
      </span>
    </span>
  )
})
