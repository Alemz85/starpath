'use client'

import { useId } from 'react'
import { cn } from '@/lib/utils'

// On/Off pair for a deactivatable feature — same row anatomy and segmented
// control as ModelChoice so the General tab reads as one system.
export function FeatureToggle({ label, sub, value, onChange, disabled = false, title }: {
  label: string
  sub: string
  value: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
  /** Why the switch is disabled (tooltip). */
  title?: string
}) {
  const descId = useId()
  const options: Array<{ id: boolean; name: string }> = [
    { id: true,  name: 'On'  },
    { id: false, name: 'Off' },
  ]
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="min-w-0" id={descId}>
        <div className="text-body font-medium text-text-1">{label}</div>
        <div className="text-label text-text-3 mt-0.5">{sub}</div>
      </div>
      <div
        className="flex rounded border border-border-default overflow-hidden divide-x divide-border-default shrink-0"
        role="group"
        aria-label={label}
        aria-describedby={descId}
        title={title}
      >
        {options.map(opt => (
          <button
            key={String(opt.id)}
            type="button"
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            aria-pressed={value === opt.id}
            className={cn(
              'btn btn-xs rounded-none focus-visible:ring-inset',
              value === opt.id ? 'btn-tinted' : 'btn-ghost',
            )}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  )
}
