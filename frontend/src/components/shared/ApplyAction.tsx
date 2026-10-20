'use client'

import { useState, useRef, useEffect } from 'react'
import { useDataStore } from '@/store/data'
import { useWriteGate } from '@/store/dataRoot'
import { ChevronDown, Check, Plus, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '@/components/ui'
import type { AppStatus, ScoreEntry, ApplicationEntry } from '@/types'

const STATUSES: AppStatus[] = [
  'Evaluated', 'Applied', 'Responded', 'Interview', 'Offer',
  'Rejected', 'Discarded', 'SKIP',
]

interface Props {
  company: string
  role: string
  // Optional: used when promoting to fill in score, tier, report link.
  scoreEntry?: ScoreEntry
  size?: 'sm' | 'md'
}

export function ApplyAction({ company, role, scoreEntry, size = 'md' }: Props) {
  const applications = useDataStore(s => s.applications)
  const promote = useDataStore(s => s.promoteToApplication)
  const setStatus = useDataStore(s => s.setApplicationStatus)
  const { canWrite, readOnlyTitle } = useWriteGate()
  const [busy, setBusy] = useState(false)

  const existing = findApplication(applications, company, role)

  if (!existing) {
    const handleApply = async () => {
      if (busy) return
      setBusy(true)
      try {
        await promote({
          company,
          role,
          // Score cell is written as `W8.3 E5.6` (scoring v2 §8.3).
          want: scoreEntry?.want ?? null,
          ease: scoreEntry?.ease ?? null,
          tier: scoreEntry?.tier ?? 'T4',
        })
      } finally {
        setBusy(false)
      }
    }
    return (
      <Button
        tone="tinted"
        size={size === 'sm' ? 'sm' : 'md'}
        icon={<Plus size={13} aria-hidden />}
        loading={busy}
        onClick={handleApply}
        disabled={!canWrite}
        title={readOnlyTitle}
      >
        Apply
      </Button>
    )
  }

  return (
    <StatusDropdown
      current={existing.status}
      busy={busy}
      readOnlyTitle={readOnlyTitle}
      onChange={async (next) => {
        if (busy || next === existing.status) return
        setBusy(true)
        try { await setStatus(company, role, next) }
        finally { setBusy(false) }
      }}
      size={size}
    />
  )
}

function StatusDropdown({
  current, busy, onChange, size, readOnlyTitle,
}: {
  current: AppStatus
  busy: boolean
  onChange: (s: AppStatus) => void
  size: 'sm' | 'md'
  /** Set in demo mode: the dropdown shows the status but can't change it. */
  readOnlyTitle?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={busy || !!readOnlyTitle}
        title={readOnlyTitle}
        className={clsx('btn btn-secondary titlebar-no-drag', size === 'sm' && 'btn-sm')}
      >
        {busy
          ? <Loader2 size={12} className="animate-spin shrink-0" aria-hidden />
          : <StatusDot status={current} />}
        {statusLabel(current)}
        <ChevronDown
          size={12}
          className={clsx('shrink-0 text-text-4 transition-transform duration-150', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-border-default bg-bg-base shadow-menu p-1"
        >
          {STATUSES.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => { onChange(s); setOpen(false) }}
              className={clsx(
                'w-full h-8 flex items-center gap-2 px-2 rounded text-body text-left transition-colors duration-150',
                s === current
                  ? 'text-text-1 font-medium bg-bg-elevated'
                  : 'text-text-2 hover:bg-bg-elevated hover:text-text-1',
              )}
            >
              <StatusDot status={s} />
              <span className="flex-1 truncate">{statusLabel(s)}</span>
              {s === current && <Check size={13} className="shrink-0 text-accent-text" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Display label — sentence case, matching <StatusChip> ("SKIP" reads as
// "Skipped"). The stored status value is unchanged.
function statusLabel(s: AppStatus): string {
  return s === 'SKIP' ? 'Skipped' : s
}

// Small lifecycle dot: semantic colour only where the state has one (Offer
// green, Interview amber, Rejected red); Applied / Responded carry the accent
// like <StatusChip>; everything else stays neutral.
function StatusDot({ status }: { status: AppStatus }) {
  return (
    <span
      className={clsx('inline-block w-1.5 h-1.5 rounded-full shrink-0', statusDotClass(status))}
      aria-hidden
    />
  )
}

function statusDotClass(s: AppStatus): string {
  switch (s) {
    case 'Offer':     return 'bg-success'
    case 'Interview': return 'bg-warning'
    case 'Rejected':  return 'bg-danger'
    case 'Applied':
    case 'Responded': return 'bg-accent'
    case 'Evaluated': return 'bg-text-3'
    default:          return 'bg-text-4'
  }
}

function findApplication(
  apps: ApplicationEntry[],
  company: string,
  role: string,
): ApplicationEntry | undefined {
  const c = company.trim().toLowerCase()
  const r = role.trim().toLowerCase()
  return apps.find(a => a.company.toLowerCase() === c && a.role.toLowerCase() === r)
}
