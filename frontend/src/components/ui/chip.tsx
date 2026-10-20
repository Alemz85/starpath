import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { tierColor, tierLabel, TIER_BG, type TierKey } from '@/lib/tier'
import type { AppStatus } from '@/types'

// Chips: one shape (20px tall, 6px radius) and a handful of tones. Lifecycle
// badges use `pill`. Text is sentence case; never uppercase.
export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted' | 'plain'

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone
  size?: 'sm' | 'md'
  pill?: boolean
  icon?: ReactNode
  children?: ReactNode
}

// Literal class map so Tailwind's content scanner sees every tone class.
const TONE_CLASS: Record<ChipTone, string> = {
  neutral: '',
  accent:  'chip-accent',
  success: 'chip-success',
  warning: 'chip-warning',
  danger:  'chip-danger',
  muted:   'chip-muted',
  plain:   'chip-plain',
}

export function Chip({ tone = 'neutral', size = 'sm', pill, icon, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cn(
        'chip',
        TONE_CLASS[tone],
        size === 'md' && 'chip-md',
        pill && 'chip-pill',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  )
}

// Tier chip — the only chip that carries the tier ladder colour. Same shape
// as every other chip so a T1 and an "Applied" badge sit on one baseline.
export function TierChip({ tier, size = 'sm', className, title }: { tier: TierKey | string | null | undefined; size?: 'sm' | 'md'; className?: string; title?: string }) {
  const key = tier as TierKey
  const color = tierColor(key)
  const bg = TIER_BG[key] ?? TIER_BG.T4
  return (
    <span
      className={cn('chip font-semibold', size === 'md' && 'chip-md', className)}
      style={{ color, background: bg, borderColor: tierColor(key, 0.2) }}
      title={title}
    >
      {tierLabel(key)}
    </span>
  )
}

// Application-lifecycle badge. Semantic colour only where the state has one;
// the violet "in motion" states (Applied / Responded) use the accent tone.
const STATUS_TONE: Record<AppStatus, ChipTone> = {
  Evaluated: 'neutral',
  Applied:   'accent',
  Responded: 'accent',
  Interview: 'warning',
  Offer:     'success',
  Rejected:  'danger',
  Discarded: 'muted',
  SKIP:      'muted',
}

export function StatusChip({ status, size = 'sm', className }: { status: AppStatus; size?: 'sm' | 'md'; className?: string }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? 'neutral'} size={size} pill className={className}>
      {status === 'SKIP' ? 'Skipped' : status}
    </Chip>
  )
}
