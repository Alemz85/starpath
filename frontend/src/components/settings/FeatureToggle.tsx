'use client'

import { useId } from 'react'
import { Switch } from '@/components/ui'

// A deactivatable feature is on or off, so its control is a switch (HIG ›
// Toggles: "Use a toggle to help people choose between two opposing values").
// Same row anatomy as the other Settings rows: title and description on the
// left, the control on the right, centred on the title line.
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
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="min-w-0" id={descId}>
        <div className="text-body font-medium text-text-1">{label}</div>
        <div className="text-label text-text-3 mt-0.5">{sub}</div>
      </div>
      <div className="shrink-0 pt-0.5" title={title}>
        <Switch
          checked={value}
          onChange={onChange}
          disabled={disabled}
          label={label}
          labelHidden
          aria-describedby={descId}
        />
      </div>
    </div>
  )
}
