'use client'

import { useState, useRef, useEffect } from 'react'
import { useDataStore } from '@/store/data'
import { ChevronDown, Check, Plus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
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
          overall: scoreEntry?.overall ?? 0,
          tier: scoreEntry?.tier ?? 'T4',
        })
      } finally {
        setBusy(false)
      }
    }
    return (
      <button
        onClick={handleApply}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill border-2 border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-60',
          size === 'sm' ? 'px-3 py-1 text-[12px]' : 'px-4 py-1.5 text-[13px]',
        )}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
        Apply
      </button>
    )
  }

  return (
    <StatusDropdown
      current={existing.status}
      busy={busy}
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
  current, busy, onChange, size,
}: {
  current: AppStatus
  busy: boolean
  onChange: (s: AppStatus) => void
  size: 'sm' | 'md'
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
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill border transition-colors',
          statusToneClasses(current),
          size === 'sm' ? 'px-3 py-1 text-[12px]' : 'px-4 py-1.5 text-[13px]',
          busy && 'opacity-60',
        )}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        {current}
        <ChevronDown size={11} className="opacity-70" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-50 min-w-[180px] rounded-md border border-border-default bg-bg-base shadow-card overflow-hidden"
        >
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={() => { onChange(s); setOpen(false) }}
              className={cn(
                'w-full flex items-center justify-between gap-3 px-3 py-1.5 text-[12px] text-left transition-colors',
                s === current
                  ? 'bg-accent/10 text-text-1'
                  : 'text-text-2 hover:bg-bg-elevated',
              )}
            >
              <span>{s}</span>
              {s === current && <Check size={12} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function statusToneClasses(s: AppStatus): string {
  switch (s) {
    case 'Offer':     return 'border-success/40 bg-success/10 text-success'
    case 'Interview': return 'border-warning/40 bg-warning/10 text-warning'
    case 'Rejected':
    case 'Discarded':
    case 'SKIP':      return 'border-border-default bg-bg-elevated text-text-3'
    case 'Applied':
    case 'Responded': return 'border-accent/40 bg-accent/10 text-accent'
    default:          return 'border-border-strong bg-bg-elevated text-text-2'
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
