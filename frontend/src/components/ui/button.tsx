'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// The one button. Tones map to the `.btn-*` classes in globals.css so a
// plain `className="btn btn-primary"` on a raw element renders identically.
export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'tinted' | 'danger' | 'stop'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone
  size?: ButtonSize
  /** Leading icon element (already sized by the caller, 12–14px). */
  icon?: ReactNode
  /** Trailing icon element. */
  trailing?: ReactNode
  /** Square icon-only button; pass the label through `aria-label`. */
  iconOnly?: boolean
  loading?: boolean
  /** Fully rounded; used for the page-level action row. */
  pill?: boolean
}

// Literal class maps: Tailwind only emits `@layer components` classes it can
// see in source, so the tone/size class names must appear verbatim here.
const TONE_CLASS: Record<ButtonTone, string> = {
  primary:   'btn-primary',
  secondary: 'btn-secondary',
  ghost:     'btn-ghost',
  tinted:    'btn-tinted',
  danger:    'btn-danger',
  stop:      'btn-stop',
}
const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'secondary', size = 'md', icon, trailing, iconOnly, loading, pill, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'btn titlebar-no-drag',
        TONE_CLASS[tone],
        SIZE_CLASS[size],
        iconOnly && 'btn-icon',
        pill && !iconOnly && (size === 'lg' ? 'rounded-pill px-5' : 'rounded-pill px-4'),
        pill && iconOnly && 'rounded-pill',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'xs' ? 11 : 13} className="animate-spin shrink-0" aria-hidden /> : icon}
      {!iconOnly && children}
      {!loading && trailing}
    </button>
  )
})
