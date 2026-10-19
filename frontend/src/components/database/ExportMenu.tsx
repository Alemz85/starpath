'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Copy, FileDown, Check, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '@/components/ui'
import type { ScoreEntry } from '@/types'
import { serializeRows, downloadText, exportFilename } from '@/lib/export'

// Title-bar export control for the Database lens. Opens a small dropdown
// (mirrors the RowActionPopover styling) with two outputs: copy a TSV blob
// to the clipboard, or download a CSV. `rows` is the already-filtered,
// entity-flattened list — what export produces is exactly what the user
// is looking at.
export function ExportMenu({ rows }: { rows: ScoreEntry[] }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const disabled = rows.length === 0

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Defer the click listener a tick so the opening click doesn't also
    // close the menu (same trick as RowActionPopover).
    const t = window.setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(serializeRows(rows, 'tsv'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (rare in Electron) — fail quietly; Download still works.
    }
    setOpen(false)
  }

  const handleDownload = () => {
    downloadText(exportFilename('csv'), serializeRows(rows, 'csv'), 'text/csv')
    setOpen(false)
  }

  return (
    <div
      ref={ref}
      className="titlebar-no-drag relative"
      // A disabled <button> swallows hover, so the reason lives on the wrapper.
      title={disabled ? 'No rows to export' : undefined}
    >
      <Button
        tone="ghost"
        size="sm"
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        disabled={disabled}
        title={disabled ? 'No rows to export' : 'Export the filtered table'}
        aria-haspopup="menu"
        aria-expanded={open}
        icon={copied ? <Check size={13} className="text-success" aria-hidden /> : <Download size={13} aria-hidden />}
        trailing={
          <ChevronDown
            size={12}
            className={clsx('text-text-4 transition-transform duration-150', open && 'rotate-180')}
            aria-hidden
          />
        }
      >
        {copied ? 'Copied' : 'Export'}
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-60 rounded-lg border border-border-default bg-bg-base shadow-menu p-1 z-50"
          style={{ animation: 'chip-appear 160ms ease both' }}
        >
          <div className="label px-2 pt-1.5 pb-2">
            Export {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          </div>
          <MenuItem
            icon={Copy}
            label="Copy to clipboard"
            hint="TSV · paste into Sheets / Excel"
            onClick={handleCopy}
          />
          <MenuItem
            icon={FileDown}
            label="Download CSV"
            hint={exportFilename('csv')}
            onClick={handleDownload}
          />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon, label, hint, onClick,
}: {
  icon: React.ElementType
  label: string
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded text-left text-text-2 hover:bg-bg-elevated hover:text-text-1 transition-colors duration-150"
    >
      <Icon size={14} className="shrink-0 text-text-3 group-hover:text-text-2" aria-hidden />
      <span className="flex-1 min-w-0">
        <span className="block text-body truncate">{label}</span>
        {hint && <span className="block text-label text-text-4 truncate">{hint}</span>}
      </span>
    </button>
  )
}
